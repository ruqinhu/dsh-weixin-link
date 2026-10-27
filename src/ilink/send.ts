import { readSendResponse } from './errors.js'
import type { IlinkClient, PostOptions } from './client.js'
import type { ItemListEntry, SendMessageBody, SendMessageResponse } from './types.js'
import { ITEM_TYPE_TEXT, MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT } from './types.js'

export interface SendTextArgs {
  toUserId: string
  contextToken: string
  text: string
}

/**
 * Send one text message.
 *
 * Success is decided by {@link readSendResponse}, not by inspecting `ret`: an
 * accepted send comes back as `{"message_id": ...}` with no `ret` at all.
 * Throws a classified {@link import('./errors.js').IlinkError} on failure so
 * callers branch on `code` instead of parsing message strings.
 */
export async function sendText(
  client: IlinkClient,
  args: SendTextArgs,
  options: PostOptions = {},
): Promise<{ msgid: string }> {
  const items: ItemListEntry[] = [{ type: ITEM_TYPE_TEXT, text_item: { text: args.text } }]
  const body: SendMessageBody = {
    msg: {
      to_user_id: args.toUserId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: args.contextToken,
      item_list: items,
    },
  }
  const response = await client.post<SendMessageResponse>('sendmessage', body, options)
  const outcome = readSendResponse(response)
  if ('error' in outcome) throw outcome.error
  return { msgid: outcome.msgid }
}
