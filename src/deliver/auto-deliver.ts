/**
 * Turns finished conversational turns into Weixin pushes.
 *
 * This is the seam that makes delivery a transport concern instead of something the
 * model has to remember: the plugin observes every session's events, and when a turn
 * that belongs to the owner ends, it sends the text itself.
 *
 * Before this existed, delivery was a sentence in each task prompt — "you must call
 * weixin_push when done". That failed in a way no log recorded: the agent answered
 * correctly, the turn ended `completed`, and the owner received nothing, because from
 * the model's point of view answering in-session was the right thing to do.
 *
 * All judgement lives in `policy.ts`; all accumulation lives in `turn-tracker.ts`.
 * This module only glues them to IO, and it never throws into the caller's dispatch.
 */

import type { PushOutcome, PushTarget } from '../delivery/push.js'
import type { DeliveryDedupe } from '../delivery/dedupe.js'
import { decide } from './policy.js'
import { TurnTracker, type SessionEventLike } from './turn-tracker.js'

/**
 * How long one session may go between failure notices.
 *
 * A task that fails in a retry loop would otherwise page the owner every time it
 * ends. An hour is long enough that the loop is visible as a pattern rather than as
 * one long scream, and still short enough that the next scheduled slot reports its
 * own failure.
 */
export const DEFAULT_FAILURE_NOTICE_COOLDOWN_MS = 60 * 60_000

/** Where a message goes once the plugin decides to send it. */
export interface AutoDeliverTarget {
  toUserId: string
  contextToken: string
}

export interface AutoDeliverDeps {
  /**
   * The current send target, or `undefined` when no inbound message has ever been
   * received (so no `context_token` exists and no send can succeed).
   *
   * Called per delivery rather than captured at construction: the credential and
   * the first inbound token both arrive later, so a captured value would freeze
   * `undefined`. Being a callback is what makes that lazy; no setter is needed.
   */
  resolveTarget: () => AutoDeliverTarget | undefined
  /** Send one message, going through the plugin's normal retry/park/receipt path. */
  push: (target: PushTarget) => Promise<PushOutcome>
  log: {
    warn: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
  }
  /**
   * Local time offset used in the empty-turn notice.
   *
   * Constructor config, not a setter: it is deployment identity and never changes
   * for the life of a process. A setter would make "unset" a silent, plausible
   * state — a test that forgot to set it would still pass, just with a UTC timestamp.
   */
  timeZoneOffset?: number
  /**
   * Optional durable trace of every delivery decision.
   *
   * Exists because cordis' logger only buffers in memory for a running instance: a
   * `log.warn` from this plugin is invisible from outside the process. Without a
   * file sink, "did auto-delivery run at 07:00?" cannot be answered after the fact,
   * which is exactly the question every delivery incident starts with.
   */
  trace?: (line: string) => void
  /**
   * The second filter level: text that already went out is not sent again.
   *
   * Optional because the unit tests that exercise policy in isolation have no
   * delivery history to consult; a caller that omits it simply loses the guard.
   */
  dedupe?: DeliveryDedupe
  /** Announced when a deliverable turn ends without completing. See policy. */
  notifyFailures?: boolean
  /** Per-session floor between failure notices. */
  failureNoticeCooldownMs?: number
}

export class AutoDeliver {
  private readonly tracker = new TurnTracker()
  private readonly timeZoneOffset: number
  private readonly failureNoticeCooldownMs: number
  /** sessionId → when its last failure notice was sent. */
  private readonly lastFailureNotice = new Map<string, number>()

  constructor(private readonly deps: AutoDeliverDeps) {
    this.timeZoneOffset = deps.timeZoneOffset ?? 8
    this.failureNoticeCooldownMs = deps.failureNoticeCooldownMs ?? DEFAULT_FAILURE_NOTICE_COOLDOWN_MS
  }

  /**
   * Observe one session event.
   *
   * Called from a `{ global: true }` subscription, so it sees every session in the
   * process. It must not throw: the subscription runs inside the host's dispatch,
   * and an exception here would be reported as a failure of whoever emitted the
   * event.
   */
  observe(sessionId: string, event: SessionEventLike): void {
    try {
      this.tracker.observe(sessionId, event)
      if (event.type !== 'turn/end') return
      const turn = turnNumberOf(event)
      if (turn === undefined) return
      const summary = this.tracker.take(sessionId, turn!)
      // No summary means this plugin never saw the turn open — it started before the
      // process booted, or `turn/start` was missed. Delivering nothing is correct here:
      // without the opening message there is no way to know whether the turn belongs
      // to the owner or was internal maintenance, and guessing wrong either spams the
      // phone with session-title generation or drops a real report.
      if (summary === undefined) {
        this.trace(`skip session=${sessionId} turn=${turn} reason=untracked-turn`)
        return
      }

      const decision = decide(
        summary,
        new Date(),
        this.timeZoneOffset,
        this.deps.notifyFailures ?? true,
      )
      if (decision.action === 'skip') {
        this.deps.log.info('auto-deliver skipped %s turn %d: %s', sessionId, turn, decision.reason)
        this.trace(`skip session=${sessionId} turn=${turn} reason=${decision.reason}`)
        return
      }

      if (decision.kind === 'failure' && this.failureNoticeCoolingDown(sessionId)) {
        // One notice per hour per session. A task failing in a retry loop would
        // otherwise page the owner on every attempt, and the owner's response to
        // that is to mute the channel — which also mutes the reports that work.
        this.trace(`skip session=${sessionId} turn=${turn} reason=failure-notice-rate-limited`)
        return
      }

      if (this.deps.dedupe?.isDuplicate(decision.text) === true) {
        // The second filter level: the same text is already on the phone. Replay and
        // automatic delivery are independent senders, and a turn replayed across a
        // reconnect can end twice.
        this.deps.log.info('auto-deliver skipped %s turn %d: duplicate text', sessionId, turn)
        this.trace(`skip session=${sessionId} turn=${turn} reason=duplicate`)
        return
      }

      this.trace(`send session=${sessionId} turn=${turn} kind=${decision.kind} len=${decision.text.length}`)
      // Defer one microtask so the emitting turn finishes its own bookkeeping first;
      // pushing synchronously inside `session/event` would make delivery latency part
      // of the agent's turn, and a slow or hanging send would stall it.
      queueMicrotask(() => {
        void this.deliver(decision.text, sessionId, turn!, decision.kind)
      })
    } catch (error) {
      this.deps.log.warn('auto-deliver observe failed: %s', String(error))
      this.trace(`error session=${sessionId} stage=observe err=${String(error)}`)
    }
  }

  private failureNoticeCoolingDown(sessionId: string): boolean {
    const last = this.lastFailureNotice.get(sessionId)
    if (last === undefined) return false
    if (Date.now() - last >= this.failureNoticeCooldownMs) {
      this.lastFailureNotice.delete(sessionId)
      return false
    }
    return true
  }

  private async deliver(
    text: string,
    sessionId: string,
    turn: number,
    kind: 'turn' | 'failure',
  ): Promise<void> {
    try {
      const target = this.deps.resolveTarget()
      if (target === undefined) {
        // No context_token yet: a send is guaranteed to fail with NEEDS_INBOUND.
        // Deliberately not parked — replaying a stale report days later is worse
        // than dropping it, and the owner is told nothing because nothing was owed.
        this.deps.log.warn('auto-deliver skipped %s turn %d: no inbound context token', sessionId, turn)
        this.trace(`drop session=${sessionId} turn=${turn} reason=no-context-token`)
        return
      }

      const outcome = await this.deps.push({ toUserId: target.toUserId, contextToken: target.contextToken, text })
      if (outcome.ok) {
        this.deps.dedupe?.record(text)
        if (kind === 'failure') this.lastFailureNotice.set(sessionId, Date.now())
        this.deps.log.info('auto-delivered %s turn %d (%d chars)', sessionId, turn, text.length)
        this.trace(`ok session=${sessionId} turn=${turn} msgid=${String(outcome.msgid)}`)
      } else {
        this.deps.log.warn(
          'auto-deliver failed for %s turn %d: %s (parked=%s)',
          sessionId,
          turn,
          String(outcome.errorCode),
          String(outcome.shouldPark),
        )
        this.trace(
          `fail session=${sessionId} turn=${turn} code=${String(outcome.errorCode)} parked=${String(outcome.shouldPark)}`,
        )
      }
    } catch (error) {
      this.deps.log.warn('auto-deliver send threw for %s turn %d: %s', sessionId, turn, String(error))
      this.trace(`throw session=${sessionId} turn=${turn} err=${String(error)}`)
    }
  }

  private trace(line: string): void {
    try {
      this.deps.trace?.(line)
    } catch {
      // Tracing must never affect delivery.
    }
  }
}

function turnNumberOf(event: SessionEventLike): number | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as Record<string, unknown>).turn
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : undefined
}
