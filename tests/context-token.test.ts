import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextTokenStore } from '../src/store/context-token.js'

let dir: string
const USER = 'o9cq8022lwStYldNdpzuKiUJtqIw@im.wechat'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ctxtok-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ContextTokenStore', () => {
  it('bootstrap with no file yields no token', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    expect(store.get(USER)).toBeUndefined()
    expect(store.has(USER)).toBe(false)
  })

  it('round-trips a token through disk', async () => {
    const first = new ContextTokenStore(dir)
    await first.load()
    await first.record(USER, 'tok-1', new Date('2026-10-27T08:00:00+08:00'))

    const second = new ContextTokenStore(dir)
    await second.load()
    expect(second.get(USER)).toBe('tok-1')
    expect(second.has(USER)).toBe(true)
  })

  it('reports the age of a cached token in hours', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    await store.record(USER, 'tok-1', new Date('2026-10-27T08:00:00+08:00'))

    expect(store.ageHours(USER, new Date('2026-10-27T20:00:00+08:00'))).toBe(12)
  })

  it('reports undefined age for an uncached user', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    expect(store.ageHours('nobody@im.wechat', new Date())).toBeUndefined()
  })

  it('tracks the most recently refreshed user', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    await store.record('a@im.wechat', 'ta', new Date('2026-10-27T08:00:00+08:00'))
    await store.record('b@im.wechat', 'tb', new Date('2026-10-27T09:00:00+08:00'))

    expect(store.mostRecentUserId()).toBe('b@im.wechat')
  })

  it('overwrites an older token for the same user', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    await store.record(USER, 'old', new Date('2026-10-27T08:00:00+08:00'))
    await store.record(USER, 'new', new Date('2026-10-27T09:00:00+08:00'))

    expect(store.get(USER)).toBe('new')
  })

  it('recovers from a corrupt cache file instead of throwing', async () => {
    // The cache is rebuildable from the next inbound message, so failing the load
    // would take the whole plugin down over a file it can regenerate itself.
    const bad = await mkdtemp(join(tmpdir(), 'ctxtok-'))
    try {
      await writeFile(join(bad, 'context-tokens.json'), '{ truncated', 'utf8')
      const store = new ContextTokenStore(bad)
      await expect(store.load()).resolves.toBeUndefined()
      expect(store.get(USER)).toBeUndefined()
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  it('discards cache entries that lack a token', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'ctxtok-'))
    try {
      await writeFile(join(bad, 'context-tokens.json'), '{"u1":{"updatedAt":"now"}}', 'utf8')
      const store = new ContextTokenStore(bad)
      await store.load()
      expect(store.has('u1')).toBe(false)
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  it('leaves no temporary file behind after a write', async () => {
    const store = new ContextTokenStore(dir)
    await store.load()
    await store.record(USER, 'tok', new Date())

    expect(await readdir(dir)).toEqual(['context-tokens.json'])
  })
})
