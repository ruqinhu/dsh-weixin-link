import { IlinkError, type IlinkErrorCode } from '../ilink/errors.js'

export interface PushTarget {
  toUserId: string
  text: string
  contextToken: string
}

export interface PushOutcome {
  ok: boolean
  msgid?: string
  errorCode?: IlinkErrorCode
  retries: number
  /** True when the caller should park the message for replay after the next inbound message. */
  shouldPark: boolean
}

export interface PushDeps {
  send: (target: PushTarget) => Promise<{ msgid: string }>
  sleep: (ms: number) => Promise<void>
  /** Optional sink for non-fatal diagnostics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: IlinkError }) => void
}

/**
 * Backoff schedule for rate limiting. iLink cooldowns are observed in the 30s
 * range, so the ladder starts there and doubles.
 */
export const BACKOFF_MS = [30_000, 60_000, 120_000] as const

/**
 * Three-layer delivery policy.
 *
 * 1. Try once.
 * 2. Classify the failure:
 *    - stale `context_token` → park, do not retry (only a new inbound message helps)
 *    - rate limited → back off along {@link BACKOFF_MS}
 *    - anything else → one immediate retry, then give up
 * 3. Report a structured outcome for the receipt log.
 */
export async function pushWithRetry(target: PushTarget, deps: PushDeps): Promise<PushOutcome> {
  let retries = 0
  let unknownRetried = false

  for (let attempt = 0; ; attempt++) {
    try {
      const { msgid } = await deps.send(target)
      return { ok: true, msgid, retries, shouldPark: false }
    } catch (error) {
      const ilink =
        error instanceof IlinkError
          ? error
          : new IlinkError('UNKNOWN', -1, error instanceof Error ? error.message : String(error))

      // A stale token cannot be repaired by this process; stop and park.
      if (ilink.code === 'NEEDS_INBOUND') {
        return { ok: false, errorCode: 'NEEDS_INBOUND', retries, shouldPark: true }
      }

      if (ilink.code === 'RATE_LIMITED') {
        // Rate limited is recoverable, just not right now. Draining the backoff
        // ladder without parking is how a report gets silently swallowed, which
        // is the exact failure this policy exists to prevent.
        if (attempt < BACKOFF_MS.length) {
          const delayMs = BACKOFF_MS[attempt] as number
          deps.onRetry?.({ attempt, delayMs, error: ilink })
          await deps.sleep(delayMs)
          retries++
          continue
        }
        return { ok: false, errorCode: 'RATE_LIMITED', retries, shouldPark: true }
      }

      // Unknown failures get exactly one immediate retry.
      if (ilink.code === 'UNKNOWN' && !unknownRetried) {
        unknownRetried = true
        retries++
        continue
      }

      // Everything else — HTTP 5xx, timeouts, DNS failure — parks. A transient
      // outage is the most likely reason a scheduled report fails at 07:00, and
      // returning shouldPark:false here means the report is dropped with no
      // trace: nothing on disk, nothing replayed, and `status` only ever
      // reports the last *successful* delivery, so the loss is invisible. The
      // one-request risk is a duplicate if the server accepted a send whose
      // response was lost; a duplicate is recoverable, a missing morning report
      // is not.
      return { ok: false, errorCode: ilink.code, retries, shouldPark: true }
    }
  }
}
