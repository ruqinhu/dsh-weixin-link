import { describe, expect, it } from 'vitest'
import {
  classifyIlinkError,
  isSendAccepted,
  IlinkError,
  readSendResponse,
} from '../src/ilink/errors.js'

describe('classifyIlinkError', () => {
  it('maps ret=0 to no error', () => {
    expect(classifyIlinkError(0, undefined)).toBeUndefined()
  })

  it('treats a bare invalid-token message as NEEDS_INBOUND', () => {
    // Without the context/token pairing rule this fell through to UNKNOWN, which
    // retries once and then drops the message.
    expect(classifyIlinkError(1003, 'invalid token')?.code).toBe('NEEDS_INBOUND')
  })

  it('prefers the non-retryable token verdict when a message mentions both', () => {
    // A stale token is not repairable by retrying, so it must win over rate
    // limiting — parking is safe, dropping is not.
    expect(classifyIlinkError(1003, 'invalid token, please retry later')?.code).toBe('NEEDS_INBOUND')
  })

  it('still classifies a plain rate-limit message as retryable', () => {
    expect(classifyIlinkError(429, 'rate limit on send')?.code).toBe('RATE_LIMITED')
  })

  it('maps an invalid context token to NEEDS_INBOUND', () => {
    const error = classifyIlinkError(1003, 'context token invalid')
    expect(error).toBeInstanceOf(IlinkError)
    expect(error?.code).toBe('NEEDS_INBOUND')
  })

  it('recognises an expired token', () => {
    expect(classifyIlinkError(1005, 'context_token expired')?.code).toBe('NEEDS_INBOUND')
  })

  it('maps rate limiting to RATE_LIMITED', () => {
    expect(classifyIlinkError(429, 'too many requests')?.code).toBe('RATE_LIMITED')
  })

  it('maps the observed cooldown wording to RATE_LIMITED', () => {
    expect(
      classifyIlinkError(-1, 'iLink sendmessage rate limited; cooldown active for 30.0s')?.code,
    ).toBe('RATE_LIMITED')
  })

  it('maps anything else to UNKNOWN', () => {
    expect(classifyIlinkError(500, 'boom')?.code).toBe('UNKNOWN')
  })

  it('synthesises a message when errmsg is absent', () => {
    expect(classifyIlinkError(500, undefined)?.message).toBe('iLink ret=500')
  })
})

describe('isSendAccepted', () => {
  it('accepts a real success response that carries no ret', () => {
    // Verbatim shape observed from the live iLink endpoint.
    expect(isSendAccepted({ message_id: 7520807369715385000 })).toBe(true)
  })

  it('rejects a response with no message_id', () => {
    expect(isSendAccepted({})).toBe(false)
  })

  it('rejects a zero or empty id', () => {
    expect(isSendAccepted({ message_id: 0 })).toBe(false)
    expect(isSendAccepted({ message_id: '' })).toBe(false)
    expect(isSendAccepted({ message_id: null })).toBe(false)
  })

  it('accepts a string id', () => {
    expect(isSendAccepted({ message_id: '7520807369715385000' })).toBe(true)
  })
})

describe('readSendResponse', () => {
  it('returns the msgid from a real success response', () => {
    const outcome = readSendResponse({ message_id: 7520807369715385000 })
    expect(outcome).toEqual({ msgid: '7520807369715385000' })
  })

  it('returns a classified error when ret is non-zero', () => {
    const outcome = readSendResponse({ ret: 1003, errmsg: 'context token invalid' })
    expect('error' in outcome && outcome.error.code).toBe('NEEDS_INBOUND')
  })

  it('returns an error rather than a false success when neither field is present', () => {
    const outcome = readSendResponse({})
    expect('error' in outcome).toBe(true)
  })
})
