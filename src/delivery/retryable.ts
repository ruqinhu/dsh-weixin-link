/**
 * Deciding whether a parked message may be dropped.
 *
 * This logic used to live inline in `replayOutbox` and it was inverted: anything
 * that was not `NEEDS_INBOUND` or `RATE_LIMITED` was treated as permanently
 * unsendable and deleted. But `ret:-2 prepare failed`, the failure that actually
 * occurs with this API, is classified `UNKNOWN` and is transient — so the replay
 * deleted the messages it existed to rescue. A live noon report was lost that way:
 * the send failed, the entry vanished from the outbox, and the only record was a
 * receipt saying `ok: false`.
 *
 * The asymmetry is severe enough to deserve its own function and its own tests. A
 * message retried forever costs a little traffic; a message deleted early is the
 * thing this whole outbox exists to prevent. When the two are confused, the safe
 * error is the one that keeps trying.
 */

import type { IlinkErrorCode } from '../ilink/errors.js'

/**
 * Codes that will never succeed. Empty, and that is the point.
 *
 * Every code this client can currently produce is retryable:
 *
 *   NEEDS_INBOUND — the owner sends a message, and a fresh context token arrives
 *   RATE_LIMITED  — the limit expires
 *   UNKNOWN       — covers `ret:-2 prepare failed`, which clears by itself
 *
 * When a genuinely permanent failure appears, add it here. Until then the default
 * is to keep the message, because retrying costs a little traffic and deleting
 * costs the report.
 */
const PERMANENT: ReadonlySet<IlinkErrorCode> = new Set<IlinkErrorCode>()

/**
 * True when a replayed entry should be dropped instead of kept for another try.
 *
 * Almost always false. Only a code explicitly listed as permanent allows dropping,
 * and no such code exists today. An unrecognised code is treated as retryable,
 * because a code this version does not know is far more likely to be a new
 * transient failure than proof that a message can never be delivered.
 */
export function isPermanentlyUnsendable(code: IlinkErrorCode | undefined): boolean {
  if (code === undefined) return false
  return PERMANENT.has(code)
}
