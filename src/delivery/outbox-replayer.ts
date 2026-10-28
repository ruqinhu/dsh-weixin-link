import type { IlinkErrorCode } from '../ilink/errors.js'
import type { PushOutcome, PushTarget } from './push.js'

/**
 * A parked message that is eligible for replay.
 *
 * The `contextToken` is resolved by the caller, not stored with the entry: a token
 * only ever arrives with an inbound message, so it cannot be captured at park time.
 * An entry whose recipient has no token yet is simply absent from the list — that
 * is a "not yet sendable", not a failure.
 */
export interface ReplayTarget {
  id: string
  target: PushTarget
}

/**
 * The decision layer for replaying parked messages.
 *
 * This lives outside the plugin class because it is the part that actually lost a
 * report: `replayOutbox` used to treat "not NEEDS_INBOUND and not RATE_LIMITED" as
 * permanent and delete the entry. The failure that really happens here is
 * `ret:-2 prepare failed`, classified UNKNOWN, which is transient. A 12:40 noon
 * report was deleted by that rule while the receipt said `ok:false` and the outbox
 * was already empty.
 *
 * Keeping the rule here, behind `isPermanentlyUnsendable`, makes it testable: the
 * classifier is injected, so a test can assert what happens for each class without
 * standing up a plugin host or a network.
 */
export interface OutboxReplayerDeps {
  list: () => Promise<ReplayTarget[]>
  push: (target: PushTarget, options: { parkOnFailure: boolean }) => Promise<PushOutcome>
  markSent: (id: string) => Promise<void>
  pruneSent: (maxAgeMs: number) => Promise<number>
  /** True only for failures that will never succeed, e.g. a malformed recipient. */
  isPermanentlyUnsendable: (errorCode: IlinkErrorCode | undefined) => boolean
  log: { warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void }
}

/** How long delivered records are kept as an audit trail. */
export const SENT_RETENTION_MS = 14 * 24 * 60 * 60_000

export class OutboxReplayer {
  constructor(private readonly deps: OutboxReplayerDeps) {}

  /**
   * Deliver everything parked, then prune delivered records.
   *
   * Replay suppresses parking and owns each entry's fate itself: a replayed
   * message is already in the outbox, so letting `push` park it again would write
   * a second file for the same text, and every copy would be sent once the token
   * recovers.
   */
  async replay(): Promise<void> {
    for (const { id, target } of await this.deps.list()) {
      try {
        const outcome = await this.deps.push(target, { parkOnFailure: false })
        if (outcome.ok) {
          await this.deps.markSent(id)
          continue
        }

        // Keeping the entry is the default. Only a failure we can prove is
        // permanent may drop it, because retrying costs a little traffic and
        // deleting costs the report.
        if (this.deps.isPermanentlyUnsendable(outcome.errorCode)) {
          this.deps.log.warn('dropping permanently unsendable outbox entry %s: %s', id, outcome.errorCode)
          await this.deps.markSent(id)
        }
      } catch (error) {
        // One unsendable entry must not abort the rest of the batch. The caller
        // also routes inbound messages in this poll round, so a throw here would
        // take those down too.
        this.deps.log.warn('outbox replay failed for %s: %s', id, String(error))
      }
    }

    // `sent/` is an audit trail, not a queue: keeping a fortnight answers "did this
    // go out?" without growing for the life of the install.
    try {
      const removed = await this.deps.pruneSent(SENT_RETENTION_MS)
      if (removed > 0) this.deps.log.debug('pruned %d delivered outbox record(s)', removed)
    } catch (error) {
      // Housekeeping must never break delivery.
      this.deps.log.warn('outbox prune failed: %s', String(error))
    }
  }
}
