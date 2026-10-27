import type { IlinkClient, PostOptions } from './client.js'
import { classifyIlinkError } from './errors.js'
import type { GetUpdatesResponse, WeixinMessage } from './types.js'

/**
 * The server holds `getupdates` for up to this long before returning empty.
 * The client budget must exceed it or every quiet poll aborts as a timeout.
 */
export const SERVER_HOLD_MS = 35_000

/** Default client budget: the server hold plus slack for transfer. */
export const DEFAULT_POLL_TIMEOUT_MS = 40_000

export interface PollArgs {
  getUpdatesBuf: string
}

export interface PollResult {
  messages: WeixinMessage[]
  /** Cursor for the next round. Echoes the input when the server omits one. */
  nextBuf: string
  /** True when the server returned no message, which is the normal idle case. */
  idle: boolean
}

/**
 * One long-poll round.
 *
 * An empty `msgs` array is the expected result of an idle hold, not an error, so
 * it is reported as `idle` rather than thrown.
 */
export async function pollUpdates(
  client: IlinkClient,
  args: PollArgs,
  options: PostOptions = {},
): Promise<PollResult> {
  const response = await client.post<GetUpdatesResponse>(
    'getupdates',
    {
      get_updates_buf: args.getUpdatesBuf,
      base_info: { channel_version: '1.0.0' },
    },
    { timeoutMs: options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS },
  )
  // A successful `getupdates` omits `ret` entirely — an idle hold answers with
  // just `msgs` and the cursor. Only an absent-or-zero `ret` with a message list
  // is success; a real failure carries a non-zero `ret` and `errmsg`.
  if (response.ret !== undefined && response.ret !== 0) {
    const error = classifyIlinkError(response.ret, response.errmsg)
    if (error) throw error
  }

  const messages = response.msgs ?? []
  return {
    messages,
    nextBuf: response.sync_buf ?? response.get_updates_buf ?? args.getUpdatesBuf,
    idle: messages.length === 0,
  }
}
