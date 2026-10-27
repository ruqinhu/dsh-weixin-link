import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface Entry {
  token: string
  updatedAt: string
}

type FileShape = Record<string, Entry>

/**
 * Caches the `context_token` carried by inbound messages.
 *
 * Sending requires one and there is no other way to obtain it, so a stale cache
 * is the normal failure mode after a quiet night — not an exceptional one.
 */
export class ContextTokenStore {
  private data: FileShape = {}
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, 'context-tokens.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      // A corrupt cache must not stop the plugin from starting: the next inbound
      // message repopulates it. Failing here would take the whole plugin down
      // over a file it can rebuild by itself.
      this.data = isFileShape(parsed) ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.data = {}
        return
      }
      this.data = {}
    }
  }

  get(userId: string): string | undefined {
    return this.data[userId]?.token
  }

  has(userId: string): boolean {
    return this.data[userId] !== undefined
  }

  /** Hours since the token was last refreshed; `undefined` when uncached. */
  ageHours(userId: string, now: Date): number | undefined {
    const entry = this.data[userId]
    if (entry === undefined) return undefined
    return (now.getTime() - new Date(entry.updatedAt).getTime()) / 3_600_000
  }

  /** The most recently refreshed user id, used as the default recipient. */
  mostRecentUserId(): string | undefined {
    let best: { id: string; at: number } | undefined
    for (const [id, entry] of Object.entries(this.data)) {
      const at = new Date(entry.updatedAt).getTime()
      if (best === undefined || at > best.at) best = { id, at }
    }
    return best?.id
  }

  async record(userId: string, token: string, at: Date): Promise<void> {
    this.data[userId] = { token, updatedAt: at.toISOString() }
    await mkdir(dirname(this.file), { recursive: true })
    // Write-then-rename: a crash mid-write would otherwise leave a truncated
    // file, and this cache is the only thing standing between the deployment and
    // an undeliverable report.
    const temp = `${this.file}.tmp`
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.file)
  }
}

function isFileShape(value: unknown): value is FileShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const candidate = entry as { token?: unknown; updatedAt?: unknown } | null
    if (typeof candidate?.token !== 'string' || typeof candidate?.updatedAt !== 'string') return false
  }
  return true
}
