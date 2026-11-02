import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Heartbeat } from '../src/watchdog/heartbeat.js'

async function withHeartbeat() {
  const dir = await mkdtemp(join(tmpdir(), 'hb-'))
  const heartbeat = new Heartbeat(Heartbeat.pathFor(dir), undefined, new Date('2026-11-02T00:00:00Z'))
  return { dir, heartbeat, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('Heartbeat', () => {
  it('measures lag from start until the first successful round', async () => {
    const { dir, cleanup } = await withHeartbeat()
    try {
      const heartbeat = new Heartbeat(Heartbeat.pathFor(dir), undefined, new Date('2026-11-02T00:00:00Z'))

      expect(heartbeat.pollLagMs(new Date('2026-11-02T00:01:00Z'))).toBe(60_000)

      heartbeat.markRound(true, new Date('2026-11-02T00:01:30Z'))
      expect(heartbeat.pollLagMs(new Date('2026-11-02T00:02:00Z'))).toBe(30_000)
    } finally {
      await cleanup()
    }
  })

  it('counts consecutive failures and clears them on success', async () => {
    const { heartbeat, cleanup } = await withHeartbeat()
    try {
      heartbeat.markRound(false, new Date(), new Error('ECONNRESET'))
      heartbeat.markRound(false, new Date(), new Error('ECONNRESET'))
      expect(heartbeat.consecutiveFailures()).toBe(2)

      heartbeat.markRound(true)
      expect(heartbeat.consecutiveFailures()).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('keeps the last error for the operator', async () => {
    const { dir, heartbeat, cleanup } = await withHeartbeat()
    try {
      heartbeat.markRound(false, new Date('2026-11-02T00:00:01Z'), new Error('ret:-2 prepare failed'))
      await heartbeat.save()

      const snapshot = await Heartbeat.read(dir)
      expect(snapshot?.poll.lastError).toContain('ret:-2')
      expect(snapshot?.poll.consecutiveFailures).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('records inbound traffic separately from poll health', async () => {
    // "The loop is polling" and "the owner is talking to us" are different facts, and
    // a stalled inbound path with a healthy poll is its own failure.
    const { dir, heartbeat, cleanup } = await withHeartbeat()
    try {
      heartbeat.markRound(true, new Date('2026-11-02T00:00:05Z'))
      heartbeat.markInbound(new Date('2026-11-02T00:00:06Z'))
      await heartbeat.save()

      const snapshot = await Heartbeat.read(dir)
      expect(snapshot?.inbound.count).toBe(1)
      expect(snapshot?.inbound.lastAt).toBe('2026-11-02T00:00:06.000Z')
      expect(snapshot?.poll.lastOkAt).toBe('2026-11-02T00:00:05.000Z')
    } finally {
      await cleanup()
    }
  })

  it('counts watchdog restarts', async () => {
    const { heartbeat, cleanup } = await withHeartbeat()
    try {
      heartbeat.markRestart()
      heartbeat.markRestart()

      expect(heartbeat.restarts()).toBe(2)
    } finally {
      await cleanup()
    }
  })

  it('writes a versioned snapshot atomically', async () => {
    const { dir, heartbeat, cleanup } = await withHeartbeat()
    try {
      heartbeat.markRound(true)
      await heartbeat.save()

      const raw = await readFile(Heartbeat.pathFor(dir), 'utf8')
      const parsed = JSON.parse(raw) as { version: number; pid: number }
      expect(parsed.version).toBe(1)
      expect(typeof parsed.pid).toBe('number')
      // No temp file left behind by the rename dance.
      await expect(readFile(`${Heartbeat.pathFor(dir)}.tmp`, 'utf8')).rejects.toThrow()
    } finally {
      await cleanup()
    }
  })

  it('does not write when nothing changed', async () => {
    const { dir, heartbeat, cleanup } = await withHeartbeat()
    try {
      await heartbeat.save()
      await expect(readFile(Heartbeat.pathFor(dir), 'utf8')).rejects.toThrow()

      heartbeat.markRound(true)
      await heartbeat.save()
      expect(JSON.parse(await readFile(Heartbeat.pathFor(dir), 'utf8'))).toMatchObject({ version: 1 })
    } finally {
      await cleanup()
    }
  })

  it('reads an absent or corrupt file as undefined', async () => {
    const { dir, cleanup } = await withHeartbeat()
    try {
      expect(await Heartbeat.read(dir)).toBeUndefined()

      await mkdir(join(dir, 'state'), { recursive: true })
      await writeFile(Heartbeat.pathFor(dir), 'not json', 'utf8')
      expect(await Heartbeat.read(dir)).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})
