import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PushOutcome, PushTarget } from './delivery/push.js'

export interface StatusReport {
  loggedIn: boolean
  accountId?: string
  contextTokenAgeHours?: number
  lastDelivery?: { id: string; ts: string }
  outboxCount: number
  pendingMessages: number
}

export interface ToolDeps {
  push: (target: PushTarget) => Promise<PushOutcome>
  resolveContextToken: (userId: string) => string | undefined
  defaultUserId: () => string | undefined
  status: () => Promise<StatusReport>
}

const render = (_args: unknown, value: unknown) =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }] as never

export function registerTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'weixin_push',
      description:
        'Send a text message to the owner over Weixin iLink and return a delivery receipt. ' +
        'Fails with errorCode=NEEDS_INBOUND when the cached context token is stale; the message is ' +
        'then parked and replayed automatically after the owner next messages the bot. ' +
        'Keep the body under 2200 characters — longer payloads are rate-limited or dropped.',
      parameters: {
        text: { type: 'string', required: true, description: 'Message body.' },
        toUserId: {
          type: 'string',
          description: 'Override the recipient. Defaults to the configured owner.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            msgid: { type: 'string' },
            errorCode: { type: 'string' },
            retries: { type: 'number', required: true },
            parked: { type: 'boolean', required: true },
            reason: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const toUserId = args.toUserId ?? deps.defaultUserId()
        if (toUserId === undefined || toUserId === '') {
          return {
            ok: false,
            retries: 0,
            parked: false,
            errorCode: 'NEEDS_INBOUND',
            reason: 'No recipient known yet. Wait for an inbound message or set config.defaultUserId.',
          }
        }

        const contextToken = deps.resolveContextToken(toUserId)
        if (contextToken === undefined) {
          return {
            ok: false,
            retries: 0,
            parked: true,
            errorCode: 'NEEDS_INBOUND',
            reason: 'No cached context token for this recipient yet.',
          }
        }

        const outcome = await deps.push({ toUserId, text: args.text, contextToken })
        // Omit absent optional keys rather than setting them to undefined: the
        // output schema is validated for lossless JSON, and `undefined` is not a
        // JSON value.
        const result: {
          ok: boolean
          msgid?: string
          errorCode?: string
          retries: number
          parked: boolean
        } = {
          ok: outcome.ok,
          retries: outcome.retries,
          parked: outcome.shouldPark,
        }
        if (outcome.msgid !== undefined) result.msgid = outcome.msgid
        if (outcome.errorCode !== undefined) result.errorCode = outcome.errorCode
        return result
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'weixin_status',
      description:
        'Report Weixin channel health: whether a credential is loaded, the age of the cached context ' +
        'token, the last successful delivery, and how many messages are parked for replay. ' +
        'Use this instead of grepping logs to verify that a scheduled report was actually delivered.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loggedIn: { type: 'boolean', required: true },
            accountId: { type: 'string' },
            contextTokenAgeHours: { type: 'number' },
            lastDelivery: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ts: { type: 'string', required: true },
              },
            },
            outboxCount: { type: 'number', required: true },
            pendingMessages: { type: 'number', required: true },
          },
        },
        render,
      },
      async execute() {
        return stripUndefined(await deps.status())
      },
    }),
  )
}

/**
 * Drop `undefined`-valued keys before returning a status report.
 *
 * The tool output schema is validated for lossless JSON, and `undefined` is not a
 * JSON value: `JSON.stringify({a: undefined})` yields `{}`, so the harness sees a
 * shape that no longer matches what the tool declared and rejects the whole
 * result. Every optional field here is genuinely absent until the channel has
 * handled its first message, so absent-but-present-with-undefined is the common
 * case at boot, not an edge case.
 */
function stripUndefined(report: StatusReport): StatusReport {
  const cleaned: StatusReport = {
    loggedIn: report.loggedIn,
    outboxCount: report.outboxCount,
    pendingMessages: report.pendingMessages,
  }
  if (report.accountId !== undefined) cleaned.accountId = report.accountId
  if (report.contextTokenAgeHours !== undefined) {
    cleaned.contextTokenAgeHours = report.contextTokenAgeHours
  }
  if (report.lastDelivery !== undefined) cleaned.lastDelivery = report.lastDelivery
  return cleaned
}
