import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WeixinMessage } from '../ilink/types.js'
import { messageText, MESSAGE_TYPE_BOT } from '../ilink/types.js'

export interface InboundText {
  userId: string
  text: string
  contextToken: string
  /** Server-side id, used to de-duplicate a re-delivered poll batch. */
  messageId?: string
}

/**
 * Reduce one inbound wire message to the parts this plugin acts on.
 *
 * Returns `undefined` for anything unusable — the bot's own echo (unless asked
 * for), media-only messages, or messages with no text — so callers never branch
 * on item kinds.
 */
export function toInboundText(
  message: WeixinMessage,
  options: { echoOwnMessages: boolean },
): InboundText | undefined {
  if (message.message_type === MESSAGE_TYPE_BOT && !options.echoOwnMessages) return undefined

  const text = messageText(message)
  if (text === '') return undefined

  const userId = message.from_user_id
  const contextToken = message.context_token
  if (userId === undefined || userId === '' || contextToken === undefined || contextToken === '') {
    return undefined
  }

  return { userId, text, contextToken, messageId: message.message_id }
}

/**
 * Filter a poll batch into usable inbound texts, preserving wire order.
 *
 * The caller records tokens before replaying the outbox, so a single batch can
 * both refresh the cache and drain a backlog.
 */
export function collectInbound(
  messages: readonly WeixinMessage[],
  options: { echoOwnMessages: boolean },
): InboundText[] {
  const collected: InboundText[] = []
  for (const message of messages) {
    const inbound = toInboundText(message, options)
    if (inbound !== undefined) collected.push(inbound)
  }
  return collected
}

/**
 * Source tag recorded on messages this plugin injects into a session.
 *
 * `MessageSource` is a merge-extensible sum type: the harness documents that each
 * producer declares its own `kind` in its own module, and there is no shared
 * catch-all `plugin` kind. Declaring it here is what makes the tag type-check.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'weixin-link': { kind: 'weixin-link' }
  }
}

export const WEIXIN_SOURCE = { kind: 'weixin-link' } as const

/**
 * Build the user message that carries inbound Weixin text into an agent.
 *
 * `createUserMessage` mints the identity and freezes the result, so the message
 * is durable and replayable. The source is tagged `weixin-link` rather than
 * `user`: the text came from the owner, but the transport is this plugin, and the
 * harness's source field is meant to answer exactly that distinction.
 *
 * There is deliberately no reply instruction in the payload. Delivery is the plugin's
 * job now — it observes `turn/end` and sends the agent's own last text — so telling
 * the model "you must call weixin_push" would produce a second, redundant send and
 * replace the actual answer with a meta line like "已通过微信回复你了". The `source`
 * tag is what the delivery policy keys on, and it is already here.
 */
export function toUserMessage(message: InboundText) {
  return createUserMessage({
    content: [{ type: 'text', text: message.text }],
    source: WEIXIN_SOURCE,
  })
}

/**
 * Deliver one inbound message to an agent as an ordinary follow-up turn.
 *
 * `followup()` queues the message as the sole ordinary message of its own turn
 * and wakes the driver, which is the documented entry point for externally
 * originated input. The reply path is the agent's own `weixin_push` call, so this
 * function deliberately does not synthesize a response.
 */
export function deliverToAgent(agent: Agent, message: InboundText): void {
  agent.followup(toUserMessage(message))
}

/** The slice of host context that inbound routing needs. */
export interface InboundTargetContext {
  sessionController?: { resolveAgent?: (sessionId: string) => Promise<unknown> }
  agents?: { roots?: () => Agent[] }
}

/**
 * Pick the agent that inbound text should be delivered to.
 *
 * The registry (`agents.roots()`) lists only agents that are *currently resident*.
 * After a restart that list is empty until something asks for a session, so routing
 * on it alone silently drops every message the owner sends — while the scheduled
 * reports keep arriving, which makes the bot look alive but mute. That was the
 * observed failure: 31 sessions on disk, `agentAvailable: false` on all of them, and
 * inbound text reaching a branch that logged and returned.
 *
 * `sessionController.resolveAgent` is the same entry point `dsh-schedule` uses: it
 * resumes the session from disk and hands back a live agent. So a configured
 * `sessionId` is resumed on demand, and the registry remains only a fallback for
 * profiles that have no controller. Every failure path falls through to the
 * fallback rather than propagating, because dropping the whole batch is worse than
 * trying the next option.
 */
export async function resolveInboundAgent(
  context: InboundTargetContext,
  sessionId: string,
): Promise<Agent | undefined> {
  const wanted = sessionId.trim()
  if (wanted !== '' && context.sessionController?.resolveAgent !== undefined) {
    try {
      const resolved = await context.sessionController.resolveAgent(wanted)
      const agent = unwrapAgent(resolved)
      if (agent !== undefined) return agent
    } catch {
      // Fall through: a resume failure must not discard the message.
    }
  }
  if (context.agents?.roots === undefined) return undefined
  return context.agents.roots()[0]
}

/**
 * Unwrap whatever `resolveAgent` returned into an `Agent`, or `undefined`.
 *
 * The real return type is a three-way union — `Agent` when the session was already
 * live, `{ agent }` when it had to be resumed, and `{ error }` on failure. An early
 * version of this checked only for `followup` on the value itself, so the `{ agent }`
 * shape from every cold resume was rejected and the caller fell back to an empty
 * registry: the fix appeared deployed and still dropped every message after a
 * restart. Unwrapping explicitly is what makes the resumed case work.
 */
function unwrapAgent(value: unknown): Agent | undefined {
  if (isAgent(value)) return value
  if (typeof value === 'object' && value !== null && 'agent' in value) {
    const inner = (value as { agent: unknown }).agent
    if (isAgent(inner)) return inner
  }
  return undefined
}

/** Narrow the live-agent shape without importing the session-controller error type. */
function isAgent(value: unknown): value is Agent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !('error' in value) &&
    typeof (value as { followup?: unknown }).followup === 'function'
  )
}
