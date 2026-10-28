import { describe, expect, it } from 'vitest'
import { isPermanentlyUnsendable } from '../src/delivery/retryable.js'

describe('outbox replay retention', () => {
  it('keeps a message whose send failed with UNKNOWN', () => {
    // The regression this guards: `ret:-2 prepare failed` is classified UNKNOWN
    // and is transient, but the replay used to delete anything that was not
    // NEEDS_INBOUND or RATE_LIMITED. A live noon report disappeared that way.
    expect(isPermanentlyUnsendable('UNKNOWN')).toBe(false)
  })

  it('keeps a message that is waiting for an inbound token', () => {
    expect(isPermanentlyUnsendable('NEEDS_INBOUND')).toBe(false)
  })

  it('keeps a message that was rate limited', () => {
    expect(isPermanentlyUnsendable('RATE_LIMITED')).toBe(false)
  })

  it('keeps a message when no code was reported', () => {
    expect(isPermanentlyUnsendable(undefined)).toBe(false)
  })

  it('keeps a message whose code this version does not recognise', () => {
    // A new code is far more likely to be another transient failure than proof
    // that the message can never be delivered.
    const unknownFutureCode = 'SOMETHING_NEW' as never
    expect(isPermanentlyUnsendable(unknownFutureCode)).toBe(false)
  })
})
