import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Receipt {
  /** Server `msgid` on success, a local `fail-<ts>` id otherwise. */
  id: string
  ok: boolean
  /** ISO timestamp with offset. */
  ts: string
  /** Character count of the delivered text. */
  len: number
  errorCode?: string
  retries?: number
  toUserId?: string
}

/** Offset used to key receipts by the operator's local day rather than UTC. */
const LOCAL_OFFSET_MS = 8 * 3_600_000

/**
 * Append-only receipt log, one JSON line per delivery attempt.
 *
 * This replaces grepping the agent log for "delivered to weixin": the record is
 * structured, per-day, and readable by `weixin_status`.
 */
export class ReceiptStore {
  constructor(private readonly dir: string) {}

  private dayKey(date: Date): string {
    return new Date(date.getTime() + LOCAL_OFFSET_MS).toISOString().slice(0, 10)
  }

  private fileFor(date: Date): string {
    return join(this.dir, `${this.dayKey(date)}.jsonl`)
  }

  async append(receipt: Receipt): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await appendFile(this.fileFor(new Date(receipt.ts)), `${JSON.stringify(receipt)}\n`, 'utf8')
  }

  async readDay(date: Date): Promise<Receipt[]> {
    let text: string
    try {
      text = await readFile(this.fileFor(date), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const receipts: Receipt[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      // A crash mid-append leaves a partial trailing line. Skipping it keeps the
      // receipt log readable instead of failing the whole day on one torn row.
      try {
        const parsed = JSON.parse(line) as Receipt
        if (typeof parsed?.id === 'string' && typeof parsed?.ok === 'boolean') receipts.push(parsed)
      } catch {
        continue
      }
    }
    return receipts
  }

  /** The last successful delivery on that day, if any. */
  async lastDelivery(date: Date): Promise<Receipt | undefined> {
    const all = await this.readDay(date)
    for (let i = all.length - 1; i >= 0; i--) {
      const receipt = all[i]
      if (receipt !== undefined && receipt.ok) return receipt
    }
    return undefined
  }
}
