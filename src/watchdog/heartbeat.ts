import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The liveness record this plugin leaves on disk.
 *
 * A cordis logger only buffers in memory for a running instance, so from outside
 * the process "the bot is dead" and "the bot is fine but quiet" look identical —
 * the same ambiguity that once hid a whole day of undelivered reports. A file
 * written on every poll round is cheap, readable by an operator or an external
 * cron, and turns that question into a file read.
 */
export interface PollState {
  /** Last round attempted, successful or not. */
  lastRoundAt?: string
  /** Last round that returned without throwing. */
  lastOkAt?: string
  /** Message of the most recent failure, for the operator. */
  lastError?: string
  consecutiveFailures: number
  /** Times the watchdog has restarted the poll loop. */
  restarts: number
}

export interface InboundState {
  lastAt?: string
  count: number
}

export interface HeartbeatSnapshot {
  version: 1
  pid: number
  startedAt: string
  updatedAt: string
  poll: PollState
  inbound: InboundState
}

export const HEARTBEAT_FILE = 'heartbeat.json'

/**
 * Mutable liveness state with a write-through snapshot.
 *
 * Every mutator marks the record dirty and the caller persists on a cadence
 * (the watchdog tick), rather than on every event: a poll round every forty
 * seconds and an occasional inbound message do not need a write each, and a
 * heartbeat that costs an fsync per event is a heartbeat that ends up disabled.
 */
export class Heartbeat {
  private poll: PollState = { consecutiveFailures: 0, restarts: 0 }
  private inbound: InboundState = { count: 0 }
  private readonly startedAt: Date
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    startedAt?: Date,
  ) {
    this.startedAt = startedAt ?? now()
  }

  static pathFor(dataDir: string): string {
    return join(dataDir, 'state', HEARTBEAT_FILE)
  }

  markRound(ok: boolean, at: Date = this.now(), error?: unknown): void {
    this.poll.lastRoundAt = at.toISOString()
    if (ok) {
      this.poll.lastOkAt = at.toISOString()
      this.poll.consecutiveFailures = 0
      delete this.poll.lastError
    } else {
      this.poll.consecutiveFailures += 1
      this.poll.lastError = String(error ?? 'unknown')
    }
    this.dirty = true
  }

  markInbound(at: Date = this.now()): void {
    this.inbound.lastAt = at.toISOString()
    this.inbound.count += 1
    this.dirty = true
  }

  markRestart(): void {
    this.poll.restarts += 1
    this.dirty = true
  }

  /** Milliseconds since the poll loop last succeeded, or since start if it never has. */
  pollLagMs(now: Date = this.now()): number {
    const last = this.poll.lastOkAt === undefined ? this.startedAt : new Date(this.poll.lastOkAt)
    return Math.max(0, now.getTime() - last.getTime())
  }

  startedAtMs(): number {
    return this.startedAt.getTime()
  }

  lastOkAtMs(): number | undefined {
    return this.poll.lastOkAt === undefined ? undefined : new Date(this.poll.lastOkAt).getTime()
  }

  consecutiveFailures(): number {
    return this.poll.consecutiveFailures
  }

  restarts(): number {
    return this.poll.restarts
  }

  snapshot(now: Date = this.now()): HeartbeatSnapshot {
    return {
      version: 1,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      updatedAt: now.toISOString(),
      poll: { ...this.poll },
      inbound: { ...this.inbound },
    }
  }

  /**
   * Persist the snapshot, if anything changed.
   *
   * Write-then-rename: a truncated heartbeat reads as `JSON.parse` failure, and an
   * external watchdog that treats unreadable as dead would restart a healthy
   * process. Failures are the caller's to log — a full disk must not stop polling.
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    const snapshot = this.snapshot()
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
    this.dirty = false
  }

  /** Read a previous process's heartbeat, for diagnostics. Never throws. */
  static async read(dataDir: string): Promise<HeartbeatSnapshot | undefined> {
    try {
      const parsed = JSON.parse(await readFile(Heartbeat.pathFor(dataDir), 'utf8')) as HeartbeatSnapshot
      return parsed.version === 1 ? parsed : undefined
    } catch {
      return undefined
    }
  }
}
