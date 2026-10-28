import { describe, expect, it } from 'vitest'
import { classifyIlinkError } from '../src/ilink/errors.js'

describe('iLink error classification', () => {
  it('treats ret=-2 "prepare failed" as needing an inbound message', () => {
    // The protocol defines ret=-2 as a parameter error, and this errmsg as "the
    // peer's iLink session is not ready" — no inbound message yet, or the context
    // token is gone. The message contains neither "token" nor "expired", so
    // keyword matching alone classified it UNKNOWN and the outbox retried
    // something that cannot succeed until the owner writes to the bot.
    const error = classifyIlinkError(-2, 'prepare failed')
    expect(error?.code).toBe('NEEDS_INBOUND')
  })

  it('treats ret=-2 "unknown error" as an expired session', () => {
    expect(classifyIlinkError(-2, 'unknown error')?.code).toBe('NEEDS_INBOUND')
  })

  it('keeps a genuine rate limit distinguishable from the session case', () => {
    // ret=-13 is the documented rate-limit code; ret=-2 with a rate-limit message
    // is also a real limit. Both must stay retryable rather than being mistaken
    // for the deterministic session failure.
    expect(classifyIlinkError(-2, 'rate limit exceeded')?.code).toBe('RATE_LIMITED')
  })

  it('does not invent an error for a successful response', () => {
    expect(classifyIlinkError(0)).toBeUndefined()
  })

  it('still recognises an explicitly expired context token', () => {
    expect(classifyIlinkError(-14, 'context token expired')?.code).toBe('NEEDS_INBOUND')
  })
})
