/**
 * The in-process watchdog: notices that the long poll has stopped moving.
 *
 * The poll loop is a `while (true)` around a network call, and every failure it
 * knows about is caught and retried. The failure it cannot handle is the one it
 * never sees: a round that hangs forever inside the transport, a promise that is
 * never settled, a loop that exited through a path nobody anticipated. In all of
 * those the process stays up, the heartbeat stops advancing, and every later
 * report is delivered into a channel that is no longer listening.
 *
 * So liveness is judged from the outside — the same loop that reads the heartbeat
 * file could, and the article's external Watchdog does, but a plugin that only
 * works when someone else is watching is not persistent on its own. This module is
 * the smallest version of that control loop: measure, decide, restart.
 *
 * The decision is a pure function so the thresholds can be tested without timers.
 */

export interface PollHealthInput {
  now: number
  /** When this process started polling. Used as the reference until one round succeeds. */
  startedAt: number
  /** When the last round succeeded, absent if none ever has. */
  lastOkAt?: number
  consecutiveFailures: number
}

export interface StallThresholds {
  /** The client budget for one round; a stall is measured in multiples of it. */
  pollTimeoutMs: number
  /** How many round budgets of silence count as a stall. */
  missFactor?: number
  /** Floor on the stall threshold, so a tiny configured timeout cannot restart-loop. */
  minStallMs?: number
}

export type WatchdogVerdict =
  | { action: 'healthy'; lagMs: number }
  | {
      action: 'restart'
      reason: 'never-polled' | 'stalled'
      lagMs: number
      failures: number
    }

/** Default multiplier: three missed long-polls, not one, so a slow server is tolerated. */
export const DEFAULT_MISS_FACTOR = 3

/**
 * A floor of ninety seconds.
 *
 * The shipped poll budget is forty seconds, so three missed rounds is two minutes
 * — already above the floor. The floor only matters for a deployment that shrinks
 * `pollTimeoutMs`; without it, a five-second budget and one dropped round would
 * restart the loop every fifteen seconds, and a restart that frequent turns a
 * transient network blip into a permanently churning channel.
 */
export const DEFAULT_MIN_STALL_MS = 90_000

export function stallThresholdMs(thresholds: StallThresholds): number {
  return Math.max(
    thresholds.minStallMs ?? DEFAULT_MIN_STALL_MS,
    thresholds.pollTimeoutMs * (thresholds.missFactor ?? DEFAULT_MISS_FACTOR),
  )
}

/**
 * Decide whether the poll loop has stopped making progress.
 *
 * Failures are not the trigger: a loop that keeps failing is still a loop that
 * keeps running, and it already backs off and retries. The trigger is silence —
 * no successful round for longer than the threshold.
 */
export function assessPollHealth(input: PollHealthInput, thresholds: StallThresholds): WatchdogVerdict {
  const reference = input.lastOkAt ?? input.startedAt
  const lagMs = Math.max(0, input.now - reference)
  const limit = stallThresholdMs(thresholds)
  if (lagMs <= limit) return { action: 'healthy', lagMs }
  return {
    action: 'restart',
    // Naming which of the two it is matters: "never polled" at boot usually means a
    // configuration or credential problem, while "stalled" after hours of good rounds
    // means the transport or the loop. They lead to different investigations.
    reason: input.lastOkAt === undefined ? 'never-polled' : 'stalled',
    lagMs,
    failures: input.consecutiveFailures,
  }
}

export interface WatchdogDeps {
  thresholds: StallThresholds
  read: () => PollHealthInput
  /** Restart the poll loop. The caller owns stopping the old one. */
  restart: (verdict: Extract<WatchdogVerdict, { action: 'restart' }>) => void
  /** Record the verdict's aftermath; the heartbeat persists on this cadence. */
  persist: () => Promise<void>
  log: { warn: (...args: unknown[]) => void }
  trace?: (line: string) => void
  /** Injected for tests; the timer is the only thing this class gives up. */
  now?: () => number
}

export const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000

/**
 * The timer around {@link assessPollHealth}.
 *
 * `tick()` is public so tests can drive it without waiting a minute; production
 * only ever calls `start`.
 */
export class Watchdog {
  private timer?: NodeJS.Timeout
  private readonly now: () => number

  constructor(private readonly deps: WatchdogDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  start(intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS): () => void {
    this.stop()
    const timer = setInterval(() => this.tick(), intervalMs)
    // A watchdog must never be the reason a process refuses to exit.
    timer.unref?.()
    this.timer = timer
    return () => this.stop()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  tick(): WatchdogVerdict {
    const verdict = assessPollHealth(this.deps.read(), this.deps.thresholds)
    if (verdict.action === 'restart') {
      this.deps.log.warn(
        'watchdog: poll loop %s (no successful round for %dms, %d consecutive failure(s)); restarting',
        verdict.reason,
        verdict.lagMs,
        verdict.failures,
      )
      this.deps.trace?.(
        `watchdog-restart reason=${verdict.reason} lagMs=${verdict.lagMs} failures=${verdict.failures}`,
      )
      try {
        this.deps.restart(verdict)
      } catch (error) {
        // A restart that throws must not take the watchdog down with it: the next
        // tick is the retry.
        this.deps.log.warn('watchdog: restart failed: %s', String(error))
        this.deps.trace?.(`watchdog-restart-failed err=${String(error)}`)
      }
    }
    void this.deps.persist().catch(() => undefined)
    return verdict
  }
}
