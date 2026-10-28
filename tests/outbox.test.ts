import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Outbox } from '../src/delivery/outbox.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'outbox-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Outbox', () => {
  it('parks a message and lists it as pending', async () => {
    const box = new Outbox(dir)
    await box.park({ toUserId: 'u1', text: 'hello', reason: 'NEEDS_INBOUND' })

    const pending = await box.list()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.text).toBe('hello')
    expect(pending[0]?.reason).toBe('NEEDS_INBOUND')
  })

  it('moves a replayed message out of pending', async () => {
    const box = new Outbox(dir)
    const parked = await box.park({ toUserId: 'u1', text: 'hello', reason: 'NEEDS_INBOUND' })

    await box.markSent(parked.id)

    expect(await box.list()).toHaveLength(0)
    expect(await box.count()).toBe(0)
  })

  it('replays in oldest-first order even within one millisecond', async () => {
    const box = new Outbox(dir)
    await box.park({ toUserId: 'u1', text: 'first', reason: 'NEEDS_INBOUND' })
    await box.park({ toUserId: 'u1', text: 'second', reason: 'NEEDS_INBOUND' })
    await box.park({ toUserId: 'u1', text: 'third', reason: 'NEEDS_INBOUND' })

    expect((await box.list()).map((p) => p.text)).toEqual(['first', 'second', 'third'])
  })

  it('ignores a markSent for an unknown id', async () => {
    const box = new Outbox(dir)
    await expect(box.markSent('does-not-exist')).resolves.toBeUndefined()
  })

  it('survives a fresh instance reading the same directory', async () => {
    const first = new Outbox(dir)
    await first.park({ toUserId: 'u1', text: 'kept', reason: 'NEEDS_INBOUND' })

    const second = new Outbox(dir)
    expect((await second.list()).map((p) => p.text)).toEqual(['kept'])
  })

  it('skips a corrupt pending file instead of failing the whole read', async () => {
    // list() runs during bootstrap: throwing here used to keep the plugin from
    // ever starting until someone deleted the bad file by hand.
    const box = new Outbox(dir)
    const good = await box.park({ toUserId: 'u1', text: 'keep me', reason: 'NEEDS_INBOUND' })
    await writeFile(join(dir, 'outbox', '9999999999999-9999.json'), '{ not json', 'utf8')

    expect((await box.list()).map((m) => m.id)).toEqual([good.id])
  })

  it('skips valid JSON that is not a parked message', async () => {
    const box = new Outbox(dir)
    await box.park({ toUserId: 'u1', text: 'keep me', reason: 'NEEDS_INBOUND' })
    await writeFile(join(dir, 'outbox', '9999999999999-9999.json'), '{"unrelated":true}', 'utf8')

    expect(await box.count()).toBe(1)
  })

  it('reports skipped entries so a lost message is not silent', async () => {
    // A parked file that cannot be parsed is a report the user will never get.
    // Skipping it without a word is indistinguishable from "nothing was parked",
    // which is precisely the confusion this outbox exists to remove.
    const box = new Outbox(dir)
    const seen: string[][] = []
    box.onSkip = (names) => seen.push(names)
    await box.park({ toUserId: 'u1', text: 'keep me', reason: 'NEEDS_INBOUND' })
    await writeFile(join(dir, 'outbox', '9999999999999-9999.json'), '{ not json', 'utf8')

    await box.list()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(['9999999999999-9999.json'])
  })

  it('leaves no temp file behind after a park', async () => {
    // park() writes to a `.tmp` sibling and renames, so a kill mid-write cannot
    // leave a truncated `.json` that list() would skip forever. A stray `.tmp`
    // after a clean park would mean the rename never happened.
    const box = new Outbox(dir)
    const parked = await box.park({ toUserId: 'u1', text: 'hello', reason: 'NEEDS_INBOUND' })

    const { readdir } = await import('node:fs/promises')
    const names = await readdir(join(dir, 'outbox'))
    expect(names).toEqual([`${parked.id}.json`])
  })

  it('does not count a leftover temp file as pending', async () => {
    const box = new Outbox(dir)
    await box.park({ toUserId: 'u1', text: 'keep me', reason: 'NEEDS_INBOUND' })
    await writeFile(join(dir, 'outbox', '9999999999999-9999.json.tmp'), '{"partial":', 'utf8')

    expect(await box.count()).toBe(1)
  })
})
