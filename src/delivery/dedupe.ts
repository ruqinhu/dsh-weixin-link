/**
 * Suppresses a second delivery of text that just went out.
 *
 * The channel has two senders that do not know about each other: automatic
 * delivery fires when a turn ends, and the outbox replayer fires on its own timer
 * when a parked message becomes sendable again. Both are correct on their own, and
 * together they can put the same report on the owner's phone twice — the replayed
 * copy is the same text that a retry already delivered, or a turn emits the same
 * closing line twice after a session event is replayed across a reconnect.
 *
 * Deliberately a *window*, not a permanent set: a report that is genuinely run
 * again an hour later must still arrive, and a dedupe that never forgets would
 * silently eat it. Ten minutes is longer than any retry path in this plugin and
 * shorter than the gap between two scheduled runs of the same task.
 *
 * In-memory on purpose. Persisting would make a restart replay suppressed text as
 * a duplicate, and the failure this guards against — two sends seconds apart — is
 * a within-process event.
 */
export interface DedupeOptions {
  /** How long an identical text is considered already delivered. */
  windowMs?: number
  /** Bound on remembered texts, so a long-lived process cannot grow without limit. */
  maxEntries?: number
}

export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000

export class DeliveryDedupe {
  /** Text → the moment it was delivered. Insertion order doubles as age order. */
  private readonly delivered = new Map<string, number>()
  private readonly windowMs: number
  private readonly maxEntries: number

  constructor(options: DedupeOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS
    this.maxEntries = options.maxEntries ?? 64
  }

  get window(): number {
    return this.windowMs
  }

  /** Whether this exact text already went out inside the window. */
  isDuplicate(text: string, now: number = Date.now()): boolean {
    const key = normalise(text)
    const at = this.delivered.get(key)
    if (at === undefined) return false
    if (now - at > this.windowMs) {
      // Expired but still present: drop it now rather than growing the map until the
      // next prune, so a long process does not slowly accumulate dead entries.
      this.delivered.delete(key)
      return false
    }
    return true
  }

  /** Remember a successful send. Only successful sends count as delivered. */
  record(text: string, now: number = Date.now()): void {
    const key = normalise(text)
    if (key === '') return
    this.delivered.set(key, now)
    this.prune(now)
  }

  private prune(now: number): void {
    for (const [key, at] of this.delivered) {
      if (this.delivered.size <= this.maxEntries && now - at <= this.windowMs) continue
      this.delivered.delete(key)
    }
  }
}

/**
 * Comparison key.
 *
 * Trailing whitespace differs between a turn's text and the same text read back
 * from the outbox file, and an exact comparison would let those through as two
 * distinct messages.
 */
function normalise(text: string): string {
  return text.trim()
}
