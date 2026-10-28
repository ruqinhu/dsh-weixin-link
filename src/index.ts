import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.js'
import { IlinkClient } from './ilink/client.js'
import { sendText } from './ilink/send.js'
import { pollUpdates } from './ilink/updates.js'
import { pushWithRetry, type PushOutcome, type PushTarget } from './delivery/push.js'
import { Outbox } from './delivery/outbox.js'
import { isPermanentlyUnsendable } from './delivery/retryable.js'
import { ContextTokenStore } from './store/context-token.js'
import { ReceiptStore } from './store/receipts.js'
import { resolveCredential, type ResolvedCredential } from './store/credential.js'
import {
  collectInbound,
  deliverToAgent,
  resolveInboundAgent,
  type InboundTargetContext,
  type InboundText,
} from './bridge/session.js'
import { registerTools, type StatusReport } from './tools.js'
import { isDeliverable, undeliverableReason } from './health.js'

export const name = 'weixin-link'

/** Delay before retrying a failed poll round, so a transport blip cannot spin. */
const POLL_RETRY_MS = 5_000

/**
 * How often to retry parked messages without waiting for an inbound message.
 *
 * A parked message is usually a transient rejection (`ret:-2 prepare failed`
 * clears by itself), so the right trigger is time, not a human. Five minutes is
 * frequent enough that a brief 07:00 rejection still delivers the report while it
 * is still useful, and rare enough to cost nothing when the outbox is empty.
 */
const OUTBOX_RETRY_MS = 5 * 60_000

export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') || path.startsWith('~\\') ? join(homedir(), path.slice(2)) : path
}
export default class WeixinLink extends Service {
  static inject = ['tools', 'credentials']
  static Config = Config

  private credential?: ResolvedCredential
  private client?: IlinkClient
  private readonly dataDir: string
  private readonly contextTokens: ContextTokenStore
  private readonly receipts: ReceiptStore
  private readonly outbox: Outbox
  private pollBuf = ''
  /** Disambiguates failure receipt ids that would otherwise collide within a millisecond. */
  private failureSeq = 0
  private readonly log: ReturnType<Context['logger']>

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'weixin')
    this.log = ctx.logger('weixin-link')
    this.dataDir = expandTilde(config.dataDir)
    this.contextTokens = new ContextTokenStore(this.dataDir)
    this.receipts = new ReceiptStore(join(this.dataDir, 'receipts'))
    this.outbox = new Outbox(this.dataDir)
    this.outbox.onSkip = (names) => {
      this.log.warn('outbox entries unreadable and never replayed: %s', names.join(', '))
    }

    ctx.effect(() => {
      let disposed = false
      void (async () => {
        await this.bootstrap()
        // The fiber may have been torn down while bootstrap was awaiting.
        if (disposed) return
        if (this.config.poll) this.startPolling()
      })()
      return () => {
        disposed = true
      }
    })
  }

  private async bootstrap(): Promise<void> {
    this.credential = await resolveCredential(this.ctx, {
      tokenEnv: this.config.tokenEnv,
      accountIdEnv: this.config.accountIdEnv,
      baseUrl: this.config.baseUrl,
    })

    if (this.credential === undefined) {
      // Registered but idle. The tools and status stay available so an operator
      // can see *why* nothing is being delivered, and the rest of the profile
      // keeps working without a channel credential.
      this.log.warn(
        'no Weixin credential; channel is idle. Set %s in $DSH_HOME/.credentials.yaml',
        this.config.tokenEnv,
      )
      await this.contextTokens.load()
      registerTools(this.ctx, {
        push: (target) => this.push(target),
        park: (entry) => this.outbox.park(entry),
        resolveContextToken: (userId) => this.contextTokens.get(userId),
        defaultUserId: () => this.defaultUserId(),
        status: () => this.status(),
      })
      return
    }

    this.client = new IlinkClient({ baseUrl: this.credential.baseUrl, token: this.credential.token })
    await this.contextTokens.load()

    registerTools(this.ctx, {
      push: (target) => this.push(target),
      park: (entry) => this.outbox.park(entry),
      resolveContextToken: (userId) => this.contextTokens.get(userId),
      defaultUserId: () => this.defaultUserId(),
      status: () => this.status(),
    })

    // A fresh process may find messages parked by a previous one. Replay them
    // now if a cached token still exists; otherwise they wait for an inbound.
    await this.replayOutbox()
  }

  private defaultUserId(): string | undefined {
    const configured = this.config.defaultUserId.trim()
    return configured === '' ? this.contextTokens.mostRecentUserId() : configured
  }

  /** Parked messages whose recipient has a usable cached token. */
  private async pendingTargets(): Promise<{ id: string; target: PushTarget }[]> {
    const ready: { id: string; target: PushTarget }[] = []
    for (const parked of await this.outbox.list()) {
      const contextToken = this.contextTokens.get(parked.toUserId)
      if (contextToken === undefined) continue
      ready.push({ id: parked.id, target: { toUserId: parked.toUserId, text: parked.text, contextToken } })
    }
    return ready
  }

  private startPolling(): void {
    this.ctx.effect(() => {
      let stopped = false
      const client = this.client as IlinkClient

      const loop = async (): Promise<void> => {
        let lastReplay = Date.now()
        while (!stopped) {
          try {
            const round = await pollUpdates(
              client,
              { getUpdatesBuf: this.pollBuf },
              { timeoutMs: this.config.pollTimeoutMs },
            )
            this.pollBuf = round.nextBuf

            // Retry the outbox on a timer, not only on inbound.
            //
            // Replaying solely when a message arrives assumes the owner will keep
            // talking to the bot. He may not: if the 07:00 report is parked and he
            // is asleep or busy, nothing is retried until he happens to send
            // something — possibly the next day, long after the report mattered.
            // The queue exists to survive a transient rejection, and a transient
            // rejection clears on its own, so waiting for a human is the wrong
            // trigger. This is cheap: `pendingTargets()` reads a directory that is
            // empty in the normal case.
            if (Date.now() - lastReplay >= OUTBOX_RETRY_MS) {
              lastReplay = Date.now()
              await this.replayOutbox()
            }

            if (round.idle) continue

            const inbound = collectInbound(round.messages, {
              echoOwnMessages: this.config.echoOwnMessages,
            })
            if (inbound.length === 0) continue

            // Record every token before replay so a single batch can both
            // refresh the cache and drain a backlog.
            const now = new Date()
            for (const message of inbound) {
              await this.contextTokens.record(message.userId, message.contextToken, now)
            }
            await this.replayOutbox()
            await this.dispatchInbound(inbound)
          } catch (error) {
            if (stopped) return
            this.log.warn('poll round failed: %s', String(error))
            await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_MS))
          }
        }
      }

      void loop()
      return () => {
        stopped = true
      }
    })
  }

  /**
   * Route inbound text into an agent session.
   *
   * A conversation needs a live agent, and after a restart there is none: the
   * registry only holds agents that are currently resident, so `roots()` is empty
   * until something asks for a session. `dsh-schedule` does not read the registry
   * for this reason — it calls `sessionController.resolveAgent(sessionId)`, which
   * resumes the session from disk and returns a live agent. Reading the registry
   * instead made every inbound message after a restart fall into the "no agent"
   * branch below, so the owner could send text and get nothing back while the
   * scheduled reports kept arriving.
   *
   * So: prefer the configured session (resuming it when cold), and fall back to an
   * already-live root agent only when no session is configured. A profile with no
   * `sessionController` at all — a push-only deployment — still refreshes the token
   * cache and pushes reports; it simply cannot hold a conversation.
   */
  private async dispatchInbound(inbound: readonly InboundText[]): Promise<void> {
    const agent = await this.pickAgent()
    if (agent === undefined) {
      for (const message of inbound) {
        this.log.warn('inbound from %s dropped (no agent to route to): %s', message.userId, message.text)
      }
      return
    }

    for (const message of inbound) {
      try {
        deliverToAgent(agent, message)
        this.log.info('routed inbound from %s to agent %s', message.userId, String(agent.id))
      } catch (error) {
        this.log.warn('failed to route inbound to agent %s: %s', String(agent.id), String(error))
      }
    }
  }

  /**
   * The agent to deliver inbound text to.
   *
   * Delegated to {@link resolveInboundAgent} so the interesting part — resuming a
   * cold session, and falling back when that fails — is testable without booting a
   * host. See that function for why the registry alone is not enough.
   */
  private async pickAgent(): Promise<Agent | undefined> {
    return resolveInboundAgent(
      this.ctx as unknown as InboundTargetContext,
      this.config.sessionId,
    )
  }

  private async replayOutbox(): Promise<void> {
    // Each replayed message is already in the outbox. `push()` parks on failure
    // so that a *new* message survives a dead token, but re-parking a replayed
    // entry would write a second file for the same text: one failed replay
    // doubles the outbox, and when the token finally works every copy is sent.
    // So replay suppresses parking and owns the entry's fate itself.
    for (const { id, target } of await this.pendingTargets()) {
      try {
        const outcome = await this.push(target, { parkOnFailure: false })
        if (outcome.ok) {
          await this.outbox.markSent(id)
          continue
        }
        // Keeping the entry is the default. Only a failure we can prove is
        // permanent may drop it.
        //
        // This used to be inverted: anything that was not NEEDS_INBOUND or
        // RATE_LIMITED was treated as permanent and deleted. But the failure that
        // actually happens here is `ret:-2 prepare failed`, classified UNKNOWN,
        // which is transient — and so the replay deleted the very messages it
        // existed to rescue. A 12:40 noon report was lost that way today: the send
        // failed, the entry was removed, and the receipt said ok:false while the
        // outbox was already empty. A retry loop that cannot distinguish
        // "unsendable" from "not yet sendable" must assume the latter, because
        // retrying costs a little traffic and deleting costs the report.
        if (isPermanentlyUnsendable(outcome.errorCode)) {
          this.log.warn('dropping permanently unsendable outbox entry %s: %s', id, outcome.errorCode)
          await this.outbox.markSent(id)
        }
      } catch (error) {
        // One unsendable entry must not abort the rest of the batch, and must
        // not stop the inbound messages in this poll round from being routed.
        this.log.warn('outbox replay failed for %s: %s', id, String(error))
      }
    }
    // `sent/` is an audit trail, not a queue: keeping a fortnight is enough to
    // answer "did this go out?" without growing for the life of the install.
    try {
      const removed = await this.outbox.pruneSent(14 * 24 * 60 * 60_000)
      if (removed > 0) {
        this.log.debug('pruned %d delivered outbox record(s)', removed)
      }
    } catch (error) {
      // Housekeeping must never break delivery.
      this.log.warn('outbox prune failed: %s', String(error))
    }
  }

  async push(target: PushTarget, options?: { parkOnFailure?: boolean }): Promise<PushOutcome> {
    const parkOnFailure = options?.parkOnFailure ?? true
    const client = this.client
    if (client === undefined) {
      // Not configured, reported as an ordinary failed outcome. Throwing here
      // would abort the agent turn that called the tool; the message is parked so
      // it is delivered once a credential is provided and an inbound token exists.
      if (parkOnFailure) {
        await this.outbox.park({ toUserId: target.toUserId, text: target.text, reason: 'NO_CREDENTIAL' })
      }
      await this.receipts.append({
        id: `fail-${Date.now()}`,
        ok: false,
        ts: new Date().toISOString(),
        len: target.text.length,
        errorCode: 'NO_CREDENTIAL',
        retries: 0,
        toUserId: target.toUserId,
      })
      return { ok: false, errorCode: 'UNKNOWN', retries: 0, shouldPark: true }
    }

    const outcome = await pushWithRetry(target, {
      send: (t) => sendText(client, { toUserId: t.toUserId, contextToken: t.contextToken, text: t.text }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onRetry: ({ attempt, delayMs, error }) => {
        this.log.warn('rate limited (attempt %d), retrying in %dms: %s', attempt, delayMs, error.message)
      },
    })

    if (outcome.shouldPark && parkOnFailure) {
      await this.outbox.park({
        toUserId: target.toUserId,
        text: target.text,
        reason: outcome.errorCode ?? 'UNKNOWN',
      })
    }

    // Failure ids must be unique per attempt: two failures in the same
    // millisecond would otherwise share `fail-<ts>` and read as one record to
    // anything that keys receipts by id.
    await this.receipts.append({
      id: outcome.msgid !== undefined && outcome.msgid !== '' ? outcome.msgid : `fail-${Date.now()}-${this.failureSeq++}`,
      ok: outcome.ok,
      ts: new Date().toISOString(),
      len: target.text.length,
      errorCode: outcome.errorCode,
      retries: outcome.retries,
      toUserId: target.toUserId,
    })

    return outcome
  }

  async status(): Promise<StatusReport> {
    const now = new Date()
    const owner = this.defaultUserId()
    const age = owner === undefined ? undefined : this.contextTokens.ageHours(owner, now)
    const last = await this.receipts.lastDelivery(now)
    const pending = await this.pendingTargets()
    const stuck = pending.length
    const health = {
      hasCredential: this.credential !== undefined,
      contextToken: owner === undefined ? undefined : this.contextTokens.get(owner),
      stuck,
    }
    // Report the real reason rather than a bare boolean: the field is read by a
    // human deciding whether the channel is usable, and "not logged in" without
    // the cause invites the wrong fix.
    const reason = undeliverableReason(health)
    if (reason !== undefined) this.log.warn('channel not deliverable: %s', reason)

    return {
      loggedIn: isDeliverable(health),
      accountId: this.credential?.accountId,
      contextTokenAgeHours: age,
      lastDelivery: last === undefined ? undefined : { id: last.id, ts: last.ts },
      outboxCount: await this.outbox.count(),
      pendingMessages: stuck,
    }
  }
}
