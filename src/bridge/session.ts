import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageItem } from '../ilink/media.js'
import type { MediaItem, WeixinMessage } from '../ilink/types.js'
import {
  describeMedia,
  ITEM_TYPE_IMAGE,
  mediaItems,
  messageText,
  MESSAGE_TYPE_BOT,
} from '../ilink/types.js'

export interface InboundText {
  userId: string
  /** 最终要交给模型的消息正文（媒体消息在无法读取内容时会带上占位说明）。 */
  text: string
  /**
   * owner 自己写下的原文，不含任何占位说明。
   *
   * 图片下载成功后，调用方要用它重建正文：`原文 + 图片已保存`，而不是把占位说明
   * 和真实图片路径拼在一起。
   */
  rawText: string
  contextToken: string
  /** Server-side id, used to de-duplicate a re-delivered poll batch. */
  messageId?: string
  /**
   * 这条消息里非文本 item 的形状（只有类型与字段名）。
   *
   * 带出来是为了两件事：把「收到了一条读不了的消息」这件事写进可观测的文件，以及为
   * 后续真正支持图片留下真实的协议骨架。
   */
  media?: readonly MediaItem[]
  /** 可直接下载的图片载荷；下载成功后由调用方替换 `text`。 */
  images?: readonly ImageItem[]
}

/**
 * Reduce one inbound wire message to the parts this plugin acts on.
 *
 * 非文本消息不再被丢掉。丢掉是上一版的写法，后果是**彻底静默**：用户以为发了，模型
 * 以为没发，日志一行都没有 —— 2026-11-04 一位用户发了两次图片，最后说「不改了就这样吧」，
 * 而服务端没有任何痕迹。
 *
 * 现在媒体消息会被折成一条模型看得懂的文本：只说收到了什么、内容没有读取、请对方改用
 * 文字或链接。真正的语义只能来自用户，因为这条通道今天确实读不了图片。
 *
 * 返回 `undefined` 只针对真正没有载荷的消息：bot 自己的回声（除非要求）、既无文本也
 * 无媒体、或缺少发送者/令牌。
 */
export function toInboundText(
  message: WeixinMessage,
  options: { echoOwnMessages: boolean },
): InboundText | undefined {
  if (message.message_type === MESSAGE_TYPE_BOT && !options.echoOwnMessages) return undefined

  const text = messageText(message)
  const media = mediaItems(message)
  if (text === '' && media.length === 0) return undefined

  const userId = message.from_user_id
  const contextToken = message.context_token
  if (userId === undefined || userId === '' || contextToken === undefined || contextToken === '') {
    return undefined
  }

  const composed =
    text === ''
      ? `（收到${describeMedia(media)}，但当前通道只能处理文本，内容未读取；请让用户改用文字描述或发链接。）`
      : media.length === 0
        ? text
        : `${text}\n\n（同一条消息还含${describeMedia(media)}，内容未读取）`

  const images = media
    .filter((item) => item.type === ITEM_TYPE_IMAGE && item.image !== undefined)
    .map((item) => item.image as ImageItem)

  return {
    userId,
    text: composed,
    rawText: text,
    contextToken,
    messageId: message.message_id,
    ...(media.length === 0 ? {} : { media }),
    ...(images.length === 0 ? {} : { images }),
  }
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
