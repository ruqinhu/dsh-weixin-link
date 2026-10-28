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
import { decide } from './policy.js'
import { TurnTracker, type SessionEventLike } from './turn-tracker.js'

/** Where a message goes once the plugin decides to send it. */
export interface AutoDeliverTarget {
  toUserId: string
  contextToken: string
}

export interface AutoDeliverDeps {
  /**
   * The current send target, or `undefined` when no inbound message has ever been
   * received (so no `context_token` exists and no send can succeed).
   */
  resolveTarget: () => AutoDeliverTarget | undefined
  /** Send one message, going through the plugin's normal retry/park/receipt path. */
  push: (target: PushTarget) => Promise<PushOutcome>
  log: {
    warn: (...args: unknown[]) => void
    info: (...args: unknown[]) => void
  }
  /**
   * Optional durable trace of every delivery decision.
   *
   * Exists because cordis' logger only buffers in memory for a running instance: a
   * `log.warn` from this plugin is invisible from outside the process. Without a
   * file sink, "did auto-delivery run at 07:00?" cannot be answered after the fact,
   * which is exactly the question every delivery incident starts with.
   */
  trace?: (line: string) => void
}

export class AutoDeliver {
  private readonly tracker = new TurnTracker()
  private resolveTargetCb: () => AutoDeliverTarget | undefined
  private timeZoneOffset = 8

  constructor(private readonly deps: AutoDeliverDeps) {
    this.resolveTargetCb = deps.resolveTarget
  }

  /** Replace the target resolver; production rebinds it when credentials are (re)loaded. */
  setTargetResolver(resolve: () => AutoDeliverTarget | undefined): void {
    this.resolveTargetCb = resolve
  }

  /** Local time offset used in the empty-turn notice. */
  setTimeZoneOffset(hours: number): void {
    this.timeZoneOffset = hours
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

      const decision = decide(summary, new Date(), this.timeZoneOffset)
      if (decision.action === 'skip') {
        this.deps.log.info('auto-deliver skipped %s turn %d: %s', sessionId, turn, decision.reason)
        this.trace(`skip session=${sessionId} turn=${turn} reason=${decision.reason}`)
        return
      }

      this.trace(`send session=${sessionId} turn=${turn} len=${decision.text.length}`)
      // Defer one microtask so the emitting turn finishes its own bookkeeping first;
      // pushing synchronously inside `session/event` would make delivery latency part
      // of the agent's turn, and a slow or hanging send would stall it.
      queueMicrotask(() => {
        void this.deliver(decision.text, sessionId, turn!)
      })
    } catch (error) {
      this.deps.log.warn('auto-deliver observe failed: %s', String(error))
      this.trace(`error session=${sessionId} stage=observe err=${String(error)}`)
    }
  }

  private async deliver(text: string, sessionId: string, turn: number): Promise<void> {
    try {
      const target = this.resolveTargetCb()
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
