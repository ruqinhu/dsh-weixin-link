import { describe, expect, it } from 'vitest'
import { isDeliverable, undeliverableReason, type ChannelHealth } from '../src/health.js'

const healthy: ChannelHealth = {
  hasCredential: true,
  contextToken: 'ctx-token',
  stuck: 0,
}

describe('channel health', () => {
  it('is deliverable with a credential, a context token, and a clear outbox', () => {
    expect(isDeliverable(healthy)).toBe(true)
    expect(undeliverableReason(healthy)).toBeUndefined()
  })

  it('is NOT deliverable with a credential but no context token', () => {
    // This is the case that used to report `loggedIn: true` while every send was
    // rejected: the bot token was present, so status called the channel healthy
    // even though no message could reach the owner.
    const health = { ...healthy, contextToken: undefined }
    expect(isDeliverable(health)).toBe(false)
    expect(undeliverableReason(health)).toContain('must message the bot')
  })

  it('is NOT deliverable without a bot token', () => {
    const health = { ...healthy, hasCredential: false }
    expect(isDeliverable(health)).toBe(false)
    expect(undeliverableReason(health)).toContain('no bot token')
  })

  it('is NOT deliverable while messages are stuck in the outbox', () => {
    const health = { ...healthy, stuck: 2 }
    expect(isDeliverable(health)).toBe(false)
    expect(undeliverableReason(health)).toContain('2 message(s) stuck')
  })

  it('reports the missing credential before the missing token', () => {
    const health = { hasCredential: false, contextToken: undefined, stuck: 3 }
    expect(undeliverableReason(health)).toBe('no bot token configured')
  })
})
