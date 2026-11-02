import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MIN_STALL_MS,
  assessPollHealth,
  stallThresholdMs,
  Watchdog,
} from '../src/watchdog/watchdog.js'

const TIMEOUT = 40_000
const thresholds = { pollTimeoutMs: TIMEOUT }

describe('stallThresholdMs', () => {
  it('is three round budgets for the shipped timeout', () => {
    expect(stallThresholdMs(thresholds)).toBe(120_000)
  })

  it('never goes below the floor', () => {
    // Without the floor, a tiny configured budget plus one dropped round would
    // restart the loop every few seconds, turning a blip into a churn.
    expect(stallThresholdMs({ pollTimeoutMs: 1_000 })).toBe(DEFAULT_MIN_STALL_MS)
  })
})

describe('assessPollHealth', () => {
  const startedAt = 1_000_000

  it('is healthy while rounds keep succeeding', () => {
    const verdict = assessPollHealth(
      { now: startedAt + 60_000, startedAt, lastOkAt: startedAt + 30_000, consecutiveFailures: 0 },
      thresholds,
    )

    expect(verdict).toMatchObject({ action: 'healthy' })
  })

  it('is healthy while rounds keep failing but the loop still runs', () => {
    // Failures are not the trigger: a failing loop still backs off and retries, and
    // restarting it would not make the network come back.
    const verdict = assessPollHealth(
      { now: startedAt + 20_000, startedAt, lastOkAt: startedAt + 10_000, consecutiveFailures: 5 },
      thresholds,
    )

    expect(verdict).toMatchObject({ action: 'healthy' })
  })

  it('restarts after three missed rounds', () => {
    const verdict = assessPollHealth(
      { now: startedAt + 121_000, startedAt, lastOkAt: startedAt, consecutiveFailures: 0 },
      thresholds,
    )

    expect(verdict).toMatchObject({ action: 'restart', reason: 'stalled' })
  })

  it('names a loop that never succeeded as never-polled', () => {
    // The two cases lead to different investigations: a loop that never started
    // usually means configuration or credentials, a stalled one means transport.
    const verdict = assessPollHealth(
      { now: startedAt + 300_000, startedAt, lastOkAt: undefined, consecutiveFailures: 0 },
      thresholds,
    )

    expect(verdict).toMatchObject({ action: 'restart', reason: 'never-polled' })
  })

  it('does not restart a fresh process', () => {
    expect(
      assessPollHealth({ now: startedAt + 10_000, startedAt, lastOkAt: undefined, consecutiveFailures: 0 }, thresholds),
    ).toMatchObject({ action: 'healthy' })
  })
})

describe('Watchdog', () => {
  function harness(options: { lagMs?: number } = {}) {
    const restart = vi.fn()
    const persist = vi.fn(async () => undefined)
    // The clock is fixed and the staleness is expressed in the reference points, so
    // a tick is decided without waiting for wall time.
    const lagMs = options.lagMs ?? 0
    const watchdog = new Watchdog({
      thresholds,
      read: () => ({ now: lagMs + 1, startedAt: -1, lastOkAt: 0, consecutiveFailures: 0 }),
      restart,
      persist,
      log: { warn: vi.fn() },
    })
    return { watchdog, restart, persist }
  }

  it('restarts a stalled loop and reports it', () => {
    const { watchdog, restart } = harness({ lagMs: 500_000 })

    const verdict = watchdog.tick()

    expect(verdict).toMatchObject({ action: 'restart' })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart.mock.calls[0]?.[0]).toMatchObject({ reason: 'stalled' })
  })

  it('leaves a healthy loop alone', () => {
    const { watchdog, restart } = harness({ lagMs: 1_000 })

    const verdict = watchdog.tick()

    expect(verdict).toMatchObject({ action: 'healthy' })
    expect(restart).not.toHaveBeenCalled()
  })

  it('survives a restart that throws, so the next tick can retry', () => {
    const restart = vi.fn(() => {
      throw new Error('boom')
    })
    const watchdog = new Watchdog({
      thresholds,
      read: () => ({ now: 500_000, startedAt: -1, lastOkAt: 0, consecutiveFailures: 0 }),
      restart,
      persist: async () => undefined,
      log: { warn: vi.fn() },
    })

    expect(() => watchdog.tick()).not.toThrow()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('persists the heartbeat on every tick', () => {
    const { watchdog, persist } = harness({ lagMs: 1_000 })

    watchdog.tick()

    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly', () => {
    const { watchdog } = harness()
    const stop = watchdog.start(1_000)
    expect(() => stop()).not.toThrow()
    expect(() => stop()).not.toThrow()
  })
})
