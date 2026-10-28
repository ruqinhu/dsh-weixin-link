import { describe, expect, it, vi } from 'vitest'
import { IlinkError } from '../src/ilink/errors.js'
import { BACKOFF_MS, pushWithRetry } from '../src/delivery/push.js'

const base = { toUserId: 'u1', text: 'hi', contextToken: 'tok' }

function senderThatThrows(errors: Error[]) {
  let call = 0
  return vi.fn(async () => {
    const error = errors[call++]
    if (error) throw error
    return { msgid: `m${call}` }
  })
}

describe('pushWithRetry', () => {
  it('returns success on the first try', async () => {
    const send = senderThatThrows([])
    const outcome = await pushWithRetry(base, { send, sleep: async () => {} })

    expect(outcome.ok).toBe(true)
    expect(outcome.retries).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('parks a message that is still rate limited after the backoff ladder', async () => {
    // Guards the regression where exhausting the ladder returned shouldPark:false
    // and the message was silently dropped — the same class of failure that
    // swallowed the whole 2026-09-21 morning report.
    const rateLimited = () => new IlinkError('RATE_LIMITED', 429, 'rate limited')
    const send = senderThatThrows([
      rateLimited(),
      rateLimited(),
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ])
    const sleep = vi.fn(async () => {})

    const outcome = await pushWithRetry(base, { send, sleep })

    expect(outcome.ok).toBe(false)
    expect(outcome.errorCode).toBe('RATE_LIMITED')
    expect(outcome.shouldPark).toBe(true)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([...BACKOFF_MS])
    expect(send).toHaveBeenCalledTimes(BACKOFF_MS.length + 1)
  })

  it('succeeds if a rate-limited retry eventually works', async () => {
    const send = senderThatThrows([new IlinkError('RATE_LIMITED', 429, 'slow down')])
    const sleep = vi.fn(async () => {})

    const outcome = await pushWithRetry(base, { send, sleep })

    expect(outcome.ok).toBe(true)
    expect(outcome.retries).toBe(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('parks immediately without retrying when the context token is stale', async () => {
    const send = senderThatThrows([new IlinkError('NEEDS_INBOUND', 1003, 'context token invalid')])
    const sleep = vi.fn(async () => {})

    const outcome = await pushWithRetry(base, { send, sleep })

    expect(outcome.ok).toBe(false)
    expect(outcome.errorCode).toBe('NEEDS_INBOUND')
    expect(outcome.shouldPark).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries an unknown failure exactly once', async () => {
    const send = senderThatThrows([
      new IlinkError('UNKNOWN', 500, 'boom'),
      new IlinkError('UNKNOWN', 500, 'boom'),
    ])
    const sleep = vi.fn(async () => {})

    const outcome = await pushWithRetry(base, { send, sleep })

    expect(outcome.ok).toBe(false)
    expect(outcome.errorCode).toBe('UNKNOWN')
    expect(outcome.retries).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('parks an unknown failure instead of dropping it', async () => {
    // The regression this guards: `shouldPark:false` for every non-rate-limit
    // error meant an HTTP 5xx or a timeout at 07:00 discarded the morning report
    // with nothing on disk, nothing to replay, and no receipt an operator would
    // see — `status` only reports the last *successful* delivery.
    const send = senderThatThrows([
      new IlinkError('UNKNOWN', 500, 'bad gateway'),
      new IlinkError('UNKNOWN', 500, 'bad gateway'),
    ])

    const outcome = await pushWithRetry(base, { send, sleep: async () => {} })

    expect(outcome.ok).toBe(false)
    expect(outcome.shouldPark).toBe(true)
  })

  it('parks a timeout rather than treating it as unsendable', async () => {
    const send = senderThatThrows([new Error('timeout'), new Error('timeout')])

    const outcome = await pushWithRetry(base, { send, sleep: async () => {} })

    expect(outcome.errorCode).toBe('UNKNOWN')
    expect(outcome.shouldPark).toBe(true)
  })

  it('wraps a non-IlinkError as UNKNOWN and retries once', async () => {
    const send = senderThatThrows([new Error('network down'), new Error('network down')])
    const outcome = await pushWithRetry(base, { send, sleep: async () => {} })

    expect(outcome.errorCode).toBe('UNKNOWN')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('reports retries through onRetry for a rate limit', async () => {
    const send = senderThatThrows([new IlinkError('RATE_LIMITED', 429, 'slow')])
    const onRetry = vi.fn()

    await pushWithRetry(base, { send, sleep: async () => {}, onRetry })

    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 0, delayMs: BACKOFF_MS[0] }),
    )
  })
})
