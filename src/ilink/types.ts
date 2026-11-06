/**
 * 腾讯 iLink Bot 协议的线上类型。
 *
 * 只建模本插件实际驱动的子集：出站文本、入站轮询。图片/文件/语音/视频按 `type`
 * 识别，但内容字段没有建模 —— 图片只保留字段名（诊断与后续实现用），不带值。
 */

import type { MediaPayload } from './media.js'

/** 入站 item 类型。官方 `weixin.py` 的 `ITEM_TEXT, ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO = 1,2,3,4,5`。 */
export const ITEM_TYPE_TEXT = 1
/** 图片。 */
export const ITEM_TYPE_IMAGE = 2
/** 语音（官方为 3，文件为 4 —— 与直觉相反，按官方常量写）。 */
export const ITEM_TYPE_VOICE = 3
/** 文件。 */
export const ITEM_TYPE_FILE = 4
/** 视频。 */
export const ITEM_TYPE_VIDEO = 5

/** `message_type` for messages the bot sends. */
export const MESSAGE_TYPE_BOT = 2

/** `message_state` meaning the message is complete. */
export const MESSAGE_STATE_FINISH = 2

export interface ItemListEntry {
  /** 1 = text, 2 = image, 3 = file, 4 = voice, 5 = video */
  type: number
  text_item?: { text: string }
  /** 图片载荷；形状来自 2026-11-06 的真实报文，不是猜测。 */
  image_item?: MediaPayload
  /** 文件载荷；字段名沿用同一 envelope，首次收到文件时会由日志确认。 */
  file_item?: MediaPayload
  /** 语音载荷；同上。 */
  voice_item?: MediaPayload
  /** 视频载荷；同上。 */
  video_item?: MediaPayload
  /**
   * 其他 item 的字段名不在类型里。
   *
   * 声称知道它们会写下一个从未被真实报文验证过的形状 —— 而猜错的代价是下一次静默
   * 失败。这里只保留键名，够诊断一次真实消息的骨架，也不会把内容或 CDN 地址写进日志。
   */
  [key: string]: unknown
}

/** One message as returned by `getupdates`. */
export interface WeixinMessage {
  from_user_id: string
  to_user_id: string
  message_type: number
  message_state: number
  /**
   * The token that authorises a reply to this sender. It is issued only on
   * inbound messages, which is why the plugin must cache it.
   */
  context_token?: string
  item_list: ItemListEntry[]
  message_id?: string
  create_time?: number
}

/** 一条消息里的非文本 item：类型、字段名与字段骨架，没有任何值。 */
export interface MediaItem {
  type: number
  /** 该 item 上的字段名（已排除 `type` 本身）。 */
  keys: string[]
  /**
   * 递归的字段骨架：键名 + 值类型，最多三层。
   *
   * 第一版只记了顶层字段名，结果只看到 `image_item` 这个名字，拿不到它里面的下载
   * 地址与密钥 —— 等于抓了个空。骨架把嵌套结构一起记下来，而值始终不出现。
   */
  shape: unknown
  /** 该项的媒体载荷；图片/文件/语音都带，视频暂不处理。 */
  payload?: MediaPayload
}

/** 把一个值折叠成「键 + 类型」的骨架，不含任何实际内容。 */
function shapeOf(value: unknown, depth: number): unknown {
  if (depth <= 0) return typeof value
  if (Array.isArray(value)) return value.length === 0 ? ['<empty>'] : [shapeOf(value[0], depth - 1)]
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shapeOf(child, depth - 1)
    }
    return out
  }
  return typeof value
}

/**
 * 列出消息里的非文本 item。
 *
 * 返回值只用于两件事：告诉模型「收到了一条看不到内容的消息」，以及把线上字段结构写进
 * 日志，好让下一轮据此建模。
 */
export function mediaItems(message: WeixinMessage): MediaItem[] {
  const out: MediaItem[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TYPE_TEXT) continue
    const payload = item.image_item ?? item.file_item ?? item.voice_item ?? item.video_item
    out.push({
      type: item.type,
      keys: Object.keys(item).filter((key) => key !== 'type'),
      shape: shapeOf(item, 3),
      ...(payload === undefined ? {} : { payload }),
    })
  }
  return out
}

const MEDIA_LABELS: Record<number, string> = {
  [ITEM_TYPE_IMAGE]: '张图片',
  [ITEM_TYPE_VOICE]: '条语音',
  [ITEM_TYPE_FILE]: '个文件',
  [ITEM_TYPE_VIDEO]: '段视频',
}

/** 人类可读的媒体摘要，例如 `2 张图片、1 个文件`。 */
export function describeMedia(items: readonly MediaItem[]): string {
  const counts = new Map<number, number>()
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  const parts: string[] = []
  for (const [type, count] of counts) {
    const label = MEDIA_LABELS[type] ?? `个未知类型(${type})`
    parts.push(`${count} ${label}`)
  }
  return parts.join('、')
}

export interface GetUpdatesResponse {
  /**
   * Absent on success. A real idle answer is `{"msgs":[],"sync_buf":"..."}` with
   * no `ret` at all, so this must stay optional — treating it as always-present
   * made every quiet poll look like a failure.
   */
  ret?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  /**
   * Opaque cursor to send back on the next poll.
   *
   * The server names this `sync_buf`; `get_updates_buf` is the request-side name
   * and is also accepted here in case a deployment echoes it back.
   */
  sync_buf?: string
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/**
 * Reply to `POST /ilink/bot/sendmessage`.
 *
 * The two shapes are disjoint, which is why both fields are optional here:
 * a success is `{"message_id": <number>}` with **no** `ret`, and a failure is
 * `{"ret": <non-zero>, "errmsg": "..."}` with no `message_id`. Treating `ret` as
 * always present made every successful send look like a failure.
 */
export interface SendMessageResponse {
  ret?: number
  errmsg?: string
  message_id?: number | string
}

/** Body of `POST /ilink/bot/sendmessage`. */
export interface SendMessageBody {
  msg: {
    to_user_id: string
    message_type: number
    message_state: number
    context_token: string
    item_list: ItemListEntry[]
    /**
     * Empty for a bot-originated message. The reference client always sends the
     * key, and omitting it changes how the server associates the message with the
     * peer's conversation.
     */
    from_user_id?: string
    /**
     * Per-message client identifier. The reference client generates a fresh one for
     * every send; the server uses it for its own duplicate suppression, so reusing a
     * value can make a legitimate message look like a replay.
     */
    client_id?: string
  }
}

/**
 * Extract the plain text of an inbound message. Returns an empty string for a
 * message carrying no text item, so callers can skip media without branching on
 * item kinds.
 */
export function messageText(message: WeixinMessage): string {
  const parts: string[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TYPE_TEXT && item.text_item?.text) parts.push(item.text_item.text)
  }
  return parts.join('').trim()
}
