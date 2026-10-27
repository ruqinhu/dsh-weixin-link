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
import { ContextTokenStore } from './store/context-token.js'
import { ReceiptStore } from './store/receipts.js'
import { resolveCredential, type ResolvedCredential } from './store/credential.js'
import { collectInbound, deliverToAgent, type InboundText } from './bridge/session.js'
import { registerTools, type StatusReport } from './tools.js'

export const name = 'weixin-link'

/** Delay before retrying a failed poll round, so a transport blip cannot spin. */
const POLL_RETRY_MS = 5_000

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
  private readonly log: ReturnType<Context['logger']>

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'weixin')
    this.log = ctx.logger('weixin-link')
    this.dataDir = expandTilde(config.dataDir)
    this.contextTokens = new ContextTokenStore(this.dataDir)
    this.receipts = new ReceiptStore(join(this.dataDir, 'receipts'))
    this.outbox = new Outbox(this.dataDir)

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
        while (!stopped) {
          try {
            const round = await pollUpdates(
              client,
              { getUpdatesBuf: this.pollBuf },
              { timeoutMs: this.config.pollTimeoutMs },
            )
            this.pollBuf = round.nextBuf
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
            this.dispatchInbound(inbound)
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
   * A conversation needs a live agent. This plugin does not own one, so it uses
   * the most recently active root agent when one exists. Without it the token
   * cache is still refreshed — which is what unblocks delivery — so a deployment
   * that only pushes reports stays fully functional with no agent attached.
   */
  private dispatchInbound(inbound: readonly InboundText[]): void {
    const agent = this.pickAgent()
    if (agent === undefined) {
      for (const message of inbound) {
        this.log.info('inbound from %s (no agent to route to): %s', message.userId, message.text)
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
   * `ctx.agents` is optional: a profile without `dsh-agent` (a pure scheduler, for
   * example) has no registry at all, and reporting that as an error would make a
   * push-only deployment look broken.
   */
  private pickAgent(): Agent | undefined {
    const registry = (this.ctx as Context & { agents?: { roots?: () => Agent[] } }).agents
    if (registry?.roots === undefined) return undefined
    return registry.roots()[0]
  }

  private async replayOutbox(): Promise<void> {
    for (const { id, target } of await this.pendingTargets()) {
      const outcome = await this.push(target)
      if (outcome.ok) await this.outbox.markSent(id)
    }
  }

  async push(target: PushTarget): Promise<PushOutcome> {
    const client = this.client
    if (client === undefined) {
      // Not configured, reported as an ordinary failed outcome. Throwing here
      // would abort the agent turn that called the tool; the message is parked so
      // it is delivered once a credential is provided and an inbound token exists.
      await this.outbox.park({ toUserId: target.toUserId, text: target.text, reason: 'NO_CREDENTIAL' })
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

    if (outcome.shouldPark) {
      await this.outbox.park({
        toUserId: target.toUserId,
        text: target.text,
        reason: outcome.errorCode ?? 'UNKNOWN',
      })
    }

    await this.receipts.append({
      id: outcome.msgid !== undefined && outcome.msgid !== '' ? outcome.msgid : `fail-${Date.now()}`,
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

    return {
      loggedIn: this.credential !== undefined,
      accountId: this.credential?.accountId,
      contextTokenAgeHours: age,
      lastDelivery: last === undefined ? undefined : { id: last.id, ts: last.ts },
      outboxCount: await this.outbox.count(),
      pendingMessages: pending.length,
    }
  }
}
