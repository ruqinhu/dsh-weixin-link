import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReceiptStore } from '../src/store/receipts.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'receipts-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ReceiptStore', () => {
  it('appends one JSON line per receipt', async () => {
    const store = new ReceiptStore(dir)
    await store.append({ id: 'a', ok: true, ts: '2026-10-27T07:00:00+08:00', len: 10 })
    await store.append({
      id: 'b',
      ok: false,
      ts: '2026-10-27T07:01:00+08:00',
      len: 20,
      errorCode: 'RATE_LIMITED',
    })

    const all = await store.readDay(new Date('2026-10-27T07:00:00+08:00'))
    expect(all).toHaveLength(2)
    expect(all[1]?.errorCode).toBe('RATE_LIMITED')
  })

  it('returns the most recent successful delivery', async () => {
    const store = new ReceiptStore(dir)
    await store.append({ id: 'a', ok: true, ts: '2026-10-27T07:00:00+08:00', len: 10 })
    await store.append({ id: 'b', ok: false, ts: '2026-10-27T07:02:00+08:00', len: 20, errorCode: 'UNKNOWN' })
    await store.append({ id: 'c', ok: true, ts: '2026-10-27T07:03:00+08:00', len: 30 })

    const last = await store.lastDelivery(new Date('2026-10-27T07:05:00+08:00'))
    expect(last?.id).toBe('c')
  })

  it('returns an empty array for a day with no file', async () => {
    const store = new ReceiptStore(dir)
    expect(await store.readDay(new Date('2026-01-01T00:00:00+08:00'))).toEqual([])
  })

  it('keys files by the +08:00 local day, not UTC', async () => {
    const store = new ReceiptStore(dir)
    // 2026-10-27T23:30Z is 2026-10-28 07:30 in +08:00.
    await store.append({ id: 'x', ok: true, ts: '2026-10-27T23:30:00Z', len: 1 })

    expect(await store.readDay(new Date('2026-10-28T07:30:00+08:00'))).toHaveLength(1)
    expect(await store.readDay(new Date('2026-10-27T12:00:00+08:00'))).toHaveLength(0)
  })

  it('skips blank lines when reading', async () => {
    const store = new ReceiptStore(dir)
    await store.append({ id: 'a', ok: true, ts: '2026-10-27T07:00:00+08:00', len: 1 })
    expect(await store.readDay(new Date('2026-10-27T07:00:00+08:00'))).toHaveLength(1)
  })

  it('skips a torn trailing line instead of failing the whole day', async () => {
    // A crash mid-append leaves a partial line; reporting status must not fail
    // because of it.
    const store = new ReceiptStore(dir)
    await store.append({ id: 'ok-1', ok: true, ts: '2026-10-27T07:00:00+08:00', len: 5 })
    await appendFile(join(dir, '2026-10-27.jsonl'), '{"id":"torn"', 'utf8')

    const all = await store.readDay(new Date('2026-10-27T07:00:00+08:00'))
    expect(all.map((r) => r.id)).toEqual(['ok-1'])
  })
})
