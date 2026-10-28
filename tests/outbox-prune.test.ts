import { mkdtemp, readFile, readdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Outbox } from '../src/delivery/outbox.js'

const dirs: string[] = []

async function makeOutbox(): Promise<{ outbox: Outbox; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-prune-'))
  dirs.push(dir)
  return { outbox: new Outbox(dir), dir }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('Outbox.pruneSent', () => {
  it('removes delivered records older than the cutoff and keeps newer ones', async () => {
    const { outbox, dir } = await makeOutbox()
    const old = await outbox.park({ toUserId: 'u', text: 'old', reason: 'X' })
    const fresh = await outbox.park({ toUserId: 'u', text: 'fresh', reason: 'X' })
    await outbox.markSent(old.id)
    await outbox.markSent(fresh.id)

    // The cutoff uses the millisecond stamp in the filename, not mtime, so a
    // record can be aged here without touching the filesystem clock.
    const sentDir = join(dir, 'sent')
    const oldName = join(sentDir, `${Date.now() - 10 * 24 * 60 * 60_000}-0000.json`)
    const body = await readFile(join(sentDir, `${old.id}.json`), 'utf8')
    await writeFile(oldName, body, 'utf8')
    const { unlink } = await import('node:fs/promises')
    await unlink(join(sentDir, `${old.id}.json`))

    const removed = await outbox.pruneSent(7 * 24 * 60 * 60_000)
    expect(removed).toBe(1)

    const left = await readdir(sentDir)
    expect(left).toEqual([`${fresh.id}.json`])
  })

  it('ignores mtime, so a restored copy is not pruned by its new timestamp', async () => {
    const { outbox, dir } = await makeOutbox()
    const parked = await outbox.park({ toUserId: 'u', text: 'x', reason: 'X' })
    await outbox.markSent(parked.id)
    const path = join(dir, 'sent', `${parked.id}.json`)
    // Make the file look ancient on disk; the name still says "now".
    const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60_000)
    await utimes(path, longAgo, longAgo)

    const removed = await outbox.pruneSent(7 * 24 * 60 * 60_000)
    expect(removed).toBe(0)
    expect(await readdir(join(dir, 'sent'))).toContain(`${parked.id}.json`)
  })

  it('removes nothing when the cutoff has not passed', async () => {
    const { outbox } = await makeOutbox()
    const parked = await outbox.park({ toUserId: 'u', text: 'x', reason: 'X' })
    await outbox.markSent(parked.id)
    expect(await outbox.pruneSent(7 * 24 * 60 * 60_000)).toBe(0)
  })

  it('leaves files it did not create alone', async () => {
    const { outbox, dir } = await makeOutbox()
    await outbox.park({ toUserId: 'u', text: 'x', reason: 'X' })
    await writeFile(join(dir, 'sent', 'not-ours.json'), '{}', 'utf8')
    await outbox.pruneSent(0)
    expect(await readdir(join(dir, 'sent'))).toContain('not-ours.json')
  })

  it('is a no-op when sent/ does not exist yet', async () => {
    const { outbox } = await makeOutbox()
    expect(await outbox.pruneSent(1_000)).toBe(0)
  })
})
