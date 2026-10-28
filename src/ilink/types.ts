/**
 * Wire types for Tencent's iLink Bot protocol.
 *
 * Only the subset this plugin drives is modelled: text messages out, inbound
 * message polling in. Media items are recognised by `type` but never sent.
 */

/** Inbound item kinds. Only `1` (text) carries a payload this plugin reads. */
export const ITEM_TYPE_TEXT = 1

/** `message_type` for messages the bot sends. */
export const MESSAGE_TYPE_BOT = 2

/** `message_state` meaning the message is complete. */
export const MESSAGE_STATE_FINISH = 2

export interface ItemListEntry {
  /** 1 = text, 2 = image, 3 = file, 4 = voice, 5 = video */
  type: number
  text_item?: { text: string }
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
