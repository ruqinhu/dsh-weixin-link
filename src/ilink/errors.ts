export type IlinkErrorCode = 'NEEDS_INBOUND' | 'RATE_LIMITED' | 'UNKNOWN'

export class IlinkError extends Error {
  constructor(
    readonly code: IlinkErrorCode,
    readonly ret: number,
    message: string,
  ) {
    super(message)
    this.name = 'IlinkError'
  }
}

/**
 * Whether a `sendmessage` response means the message was accepted.
 *
 * Success is identified by the presence of `message_id`, NOT by `ret === 0`.
 * A real successful response is `{"message_id": 7520807369715385000}` — there is
 * no `ret` field at all, so `ret === 0` is false and every successfully
 * delivered message was previously classified as `UNKNOWN` and retried. Failures
 * are the opposite: they carry `ret` (non-zero) and `errmsg`, and no
 * `message_id`.
 *
 * `message_id` arrives as a JSON number large enough to lose precision in a
 * double, so it is compared loosely as a number-or-string and never parsed for
 * value, only for presence.
 */
export function isSendAccepted(response: { message_id?: unknown }): boolean {
  const id = response.message_id
  if (id === undefined || id === null || id === '') return false
  if (typeof id === 'number') return Number.isFinite(id) && id !== 0
  if (typeof id === 'string') return id.trim() !== ''
  return false
}

/** The bot token or the account is wrong; retrying cannot help. */
export function classifyIlinkError(ret: number, errmsg?: string): IlinkError | undefined {
  if (ret === 0) return undefined
  const text = errmsg === undefined || errmsg === '' ? `iLink ret=${ret}` : errmsg
  const lower = text.toLowerCase()

  // ret=-2 is a parameter error, and errmsg says which one. `prepare failed` has
  // no token-ish words in it, so keyword matching missed it and it fell through to
  // UNKNOWN — while being, in the protocol's own words, the case where the peer's
  // iLink session is not ready because there is no inbound message yet. That is
  // precisely NEEDS_INBOUND, and classifying it as UNKNOWN made the outbox retry
  // something that cannot clear until the owner sends a message.
  //
  // `unknown error` with ret=-2 is the expired-session variant; it needs the same
  // treatment for the same reason.
  if (ret === -2) {
    const label = lower.includes('prepare') || lower.includes('unknown error') ? 'session' : 'other'
    if (label === 'session') {
      return new IlinkError('NEEDS_INBOUND', ret, text)
    }
  }

  const mentionsContext = lower.includes('context')
  const mentionsToken = lower.includes('token')
  const mentionsExpiry =
    lower.includes('invalid') ||
    lower.includes('expire') ||
    lower.includes('stale') ||
    lower.includes('missing')

  // A token that is invalid, expired, or absent cannot be repaired by retrying —
  // only a fresh inbound message supplies a new one. Treating it as UNKNOWN
  // instead would retry once and then drop the message, which is exactly how a
  // scheduled report gets swallowed.
  if (mentionsContext && (mentionsToken || mentionsExpiry)) {
    return new IlinkError('NEEDS_INBOUND', ret, text)
  }
  if (mentionsToken && mentionsExpiry) {
    return new IlinkError('NEEDS_INBOUND', ret, text)
  }

  if (ret === 429 || lower.includes('rate limit') || lower.includes('too many') || lower.includes('cooldown')) {
    return new IlinkError('RATE_LIMITED', ret, text)
  }

  return new IlinkError('UNKNOWN', ret, text)
}

/**
 * Interpret one `sendmessage` response, splitting success from failure.
 *
 * Kept together with {@link classifyIlinkError} so the two cannot drift: a caller
 * asks one question and gets either an id or an error, never both and never
 * neither. `ret` is optional in the type because a success response omits it.
 */
export function readSendResponse(response: {
  message_id?: unknown
  ret?: number
  errmsg?: string
}): { msgid: string } | { error: IlinkError } {
  if (isSendAccepted(response)) {
    // The id is only ever reported back to the caller; a number beyond
    // Number.MAX_SAFE_INTEGER is stringified as the server sent it so a receipt
    // does not carry a silently rounded id.
    const raw = response.message_id
    return { msgid: typeof raw === 'string' ? raw : String(raw) }
  }
  // No id and no ret: the server answered with something this client does not
  // understand. Surface it as an error rather than pretending the message landed.
  const ret = response.ret ?? -1
  return { error: classifyIlinkError(ret, response.errmsg) ?? new IlinkError('UNKNOWN', ret, 'iLink returned no message_id') }
}
