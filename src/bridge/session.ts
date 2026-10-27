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
