/**
 * Decides whether a finished turn's text should reach the owner's phone.
 *
 * Kept as a pure function of a {@link TurnSummary} so the whole decision matrix is
 * unit-testable without a session, a clock, or a network. The caller owns IO.
 */

import type { TurnSummary } from './turn-tracker.js'

/**
 * The `source.kind` values whose turns are addressed to the owner.
 *
 * `weixin-link` is a conversation the owner started from the phone, so the answer
 * belongs there. `schedule` is a task firing on the owner's behalf.
 *
 * Everything else is excluded on purpose:
 * - `user` — typed in the terminal or web UI, where the answer is already visible;
 *   pushing it to the phone would double-notify and train the owner to mute the bot.
 * - `runtime-context`, `skill-catalog`, `time-context` — injected context, not speech.
 * - `compact-checkpoint`, `provider`, `fallback` — internal maintenance (session
 *   compaction and title generation) that produces `assistant/message` events the
 *   owner must never see. Sending those would be pure noise.
 */
export const DELIVERABLE_SOURCES: ReadonlySet<string> = new Set(['schedule', 'weixin-link'])

/**
 * Hard cap on one outbound message, in characters.
 *
 * iLink rate-limits or drops payloads beyond roughly this size, and the failure is not
 * a clean rejection: the send can return a message id and still never arrive. The
 * scheduled prompts already say "Weixin payload ≤2200 characters" and keep the full
 * report in the HTML file, so honouring the cap here matches what the prompts promise.
 *
 * Enforced in code rather than trusted to the model because delivery no longer depends
 * on the model at all — an over-long report would otherwise be sent verbatim and lost.
 */
export const MAX_DELIVERY_CHARS = 2200

/** Suffix appended when a message had to be cut, so the owner knows to open the link. */
export const TRUNCATION_SUFFIX = '\n\n…（超出微信长度上限，已截断，完整内容见上方网页链接）'

/**
 * Marker phrase for a deliverable turn that produced no text.
 *
 * A turn that emitted nothing is only worth a notification when it *should* have said
 * something. A weekly memory compaction that decides there is nothing to compact is
 * not a failure — its prompt explicitly says "output nothing, do not notify" — and
 * waking the owner at 01:30 on a Saturday to report "no output" is worse than silence.
 *
 * So the opt-out is explicit: a prompt that may legitimately be silent emits
 * {@link SILENT_MARKER} as its only text, and delivery is skipped. Every other empty
 * turn is reported, because there silence is indistinguishable from a crash — which is
 * the failure mode that made a whole day of reports disappear unnoticed.
 */
export const EMPTY_TURN_NOTICE = '本次无产出'

/**
 * Text a prompt uses to ask for deliberate silence.
 *
 * The `[SILENT]` token is already the harness convention in these prompts, so reusing
 * it avoids inventing a second dialect.
 */
export const SILENT_MARKER = '[SILENT]'

export function isDeliverableSource(kind: string | undefined): boolean {
  return kind !== undefined && DELIVERABLE_SOURCES.has(kind)
}

export type SkipReason =
  | 'source-unknown'
  | 'source-not-deliverable'
  | 'not-completed'
  | 'already-pushed'
  | 'deliberately-silent'

export type Decision =
  | { action: 'send'; text: string }
  | { action: 'skip'; reason: SkipReason }

/**
 * Format the notice for an empty deliverable turn.
 *
 * Only a timestamp, deliberately: the task title lives in the schedule domain,
 * which this plugin does not read. Reaching into another plugin's storage to make
 * the message friendlier would couple two independent lifecycles, and the timestamp
 * is enough for the owner to recognise which report is missing.
 *
 * The offset is a parameter rather than read from the host clock so the formatting
 * is testable; production passes the configured time zone offset.
 */
export function formatEmptyNotice(at: Date, offsetHours: number): string {
  const shifted = new Date(at.getTime() + offsetHours * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}`
  return `${EMPTY_TURN_NOTICE}（${stamp}）`
}

/**
 * Cut an over-long message at the cap, preferring a line boundary.
 *
 * Cutting mid-line leaves a half-sentence that reads like corruption; cutting at the
 * last newline before the cap keeps every retained line whole. If there is no newline
 * in range (one enormous paragraph) the cut falls back to the exact cap.
 *
 * The suffix is appended after the cut and *not* counted against the cap, so the total
 * can exceed it by the suffix length. That is deliberate: the suffix is what tells the
 * owner the message is incomplete, and dropping it to save 30 characters would leave a
 * silently truncated report.
 */
export function truncateForDelivery(text: string, maxChars = MAX_DELIVERY_CHARS): string {
  if (text.length <= maxChars) return text
  const budget = maxChars
  const slice = text.slice(0, budget)
  const lastBreak = slice.lastIndexOf('\n')
  // Only honour a line break that keeps most of the budget; a newline at position 40
  // would throw away 2160 usable characters.
  const cut = lastBreak > budget * 0.8 ? slice.slice(0, lastBreak) : slice
  return `${cut.trimEnd()}${TRUNCATION_SUFFIX}`
}

/**
 * Decide what to do with a finished turn.
 *
 * Order is significant and pinned by tests: source first, then completion, then
 * the manual-push check. Putting the manual-push check first would let a terminal
 * turn that called the tool report `already-pushed` instead of the real reason,
 * which makes the log misleading about why nothing was sent.
 */
export function decide(summary: TurnSummary, now: Date = new Date(), offsetHours = 8): Decision {
  if (summary.firstUserSource === undefined) return { action: 'skip', reason: 'source-unknown' }
  if (!isDeliverableSource(summary.firstUserSource)) return { action: 'skip', reason: 'source-not-deliverable' }
  // A turn without a terminal `completed` reason was interrupted, errored, or is
  // still running; its text is partial and must not be presented as a result.
  if (summary.reason !== 'completed') return { action: 'skip', reason: 'not-completed' }
  if (summary.pushedManually) return { action: 'skip', reason: 'already-pushed' }

  const text = summary.lastText.trim()
  // A prompt opts out of delivery by ending with the silent marker; see SILENT_MARKER.
  if (text === SILENT_MARKER) return { action: 'skip', reason: 'deliberately-silent' }

  if (text === '') {
    return { action: 'send', text: formatEmptyNotice(now, offsetHours) }
  }
  return { action: 'send', text: truncateForDelivery(summary.lastText) }
}
