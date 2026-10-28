import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ParkedMessage {
  id: string
  toUserId: string
  text: string
  /** Why it could not be delivered, e.g. `NEEDS_INBOUND`. */
  reason: string
  parkedAt: string
}

export interface ParkInput {
  toUserId: string
  text: string
  reason: string
}

/**
 * Holds messages that could not be delivered.
 *
 * A stale `context_token` is the common cause, and it resolves itself: the next
 * inbound message carries a fresh token, which is why parked messages are
 * replayed at that moment rather than retried on a timer.
 */
export class Outbox {
  private readonly pendingDir: string
  private readonly sentDir: string
  private seq = 0

  constructor(dir: string) {
    this.pendingDir = join(dir, 'outbox')
    this.sentDir = join(dir, 'sent')
  }

  async park(input: ParkInput): Promise<ParkedMessage> {
    await mkdir(this.pendingDir, { recursive: true })
    await mkdir(this.sentDir, { recursive: true })
    // Zero-padded sequence keeps same-millisecond parks in insertion order.
    const id = `${Date.now()}-${String(this.seq++).padStart(4, '0')}`
    const message: ParkedMessage = {
      id,
      toUserId: input.toUserId,
      text: input.text,
      reason: input.reason,
      parkedAt: new Date().toISOString(),
    }
    // Write-then-rename, so a kill mid-write cannot leave a truncated file in
    // `pending/`. `list()` skips unparseable entries by design, so a partial
    // write would otherwise be invisible forever: never counted, never replayed,
    // and no error anywhere.
    const final = join(this.pendingDir, `${id}.json`)
    const temp = `${final}.tmp`
    await writeFile(temp, `${JSON.stringify(message, null, 2)}\n`, 'utf8')
    await rename(temp, final)
    return message
  }

  /** Pending messages, oldest first. Unreadable entries are skipped. */
  async list(): Promise<ParkedMessage[]> {
    let names: string[]
    try {
      names = await readdir(this.pendingDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const messages: ParkedMessage[] = []
    const skipped: string[] = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      // One truncated or hand-edited file must not make the whole outbox
      // unreadable: this runs during plugin bootstrap, so throwing here would
      // stop the plugin from starting until someone deletes the file by hand.
      try {
        const parsed = JSON.parse(await readFile(join(this.pendingDir, name), 'utf8')) as ParkedMessage
        if (typeof parsed?.toUserId === 'string' && typeof parsed?.text === 'string') {
          messages.push(parsed)
        } else {
          skipped.push(name)
        }
      } catch {
        skipped.push(name)
      }
    }
    // Surface skipped files rather than dropping them silently: an entry that is
    // on disk but unreplayable is a report the user will never receive, and the
    // only chance to notice is here.
    if (skipped.length > 0) {
      this.onSkip?.(skipped)
    }
    return messages
  }

  /** Injected by the plugin so `list()` can report corrupt entries through the logger. */
  onSkip?: (names: string[]) => void

  async count(): Promise<number> {
    return (await this.list()).length
  }

  /** Move a delivered message out of pending. Missing entries are ignored. */
  async markSent(id: string): Promise<void> {
    try {
      await rename(join(this.pendingDir, `${id}.json`), join(this.sentDir, `${id}.json`))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
