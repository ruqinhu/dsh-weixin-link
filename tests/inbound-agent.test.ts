import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveInboundAgent } from '../src/bridge/session.js'

/** A stand-in for the parts of `Agent` that resolution touches. */
function fakeAgent(id: string): Agent {
  return { id, followup: () => {} } as unknown as Agent
}

interface Harness {
  resolveAgent?: (id: string) => Promise<unknown>
  roots?: () => Agent[]
}

/** Adapt the flat harness to the shape `resolveInboundAgent` expects. */
function contextOf(harness: Harness): Parameters<typeof resolveInboundAgent>[0] {
  return {
    sessionController:
      harness.resolveAgent === undefined ? undefined : { resolveAgent: harness.resolveAgent },
    agents: harness.roots === undefined ? undefined : { roots: harness.roots },
  }
}

describe('resolveInboundAgent', () => {
  it('resumes the configured session even when no agent is live', async () => {
    // The bug this covers: after a restart the registry is empty, so a
    // registry-only lookup drops every inbound message. A configured session
    // must be resumed through sessionController instead.
    const resumed = fakeAgent('resumed')
    const calls: string[] = []
    const context = contextOf({
      resolveAgent: async (id) => {
        calls.push(id)
        return resumed
      },
      roots: () => [],
    })

    const agent = await resolveInboundAgent(context, 'session-abc')

    expect(agent).toBe(resumed)
    expect(calls).toEqual(['session-abc'])
  })

  it('unwraps the { agent } shape that a cold resume returns', async () => {
    // The real `resolveAgent` returns `Agent` when the session is already live but
    // `{ agent }` when it had to resume — and after a restart every call takes the
    // resume path. Treating only the bare shape as success made the fix look
    // deployed while it still dropped every message.
    const resumed = fakeAgent('resumed')
    const context = contextOf({
      resolveAgent: async () => ({ agent: resumed }),
      roots: () => [],
    })

    expect(await resolveInboundAgent(context, 'session-abc')).toBe(resumed)
  })

  it('does not mistake an { error } result for a wrapped agent', async () => {
    const live = fakeAgent('live')
    const context = contextOf({
      resolveAgent: async () => ({ error: new Error('not found'), agent: undefined }),
      roots: () => [live],
    })

    expect(await resolveInboundAgent(context, 'session-abc')).toBe(live)
  })

  it('does not consult the registry when the session resolves', async () => {
    const resumed = fakeAgent('resumed')
    let rootsCalled = false
    const context = contextOf({
      resolveAgent: async () => resumed,
      roots: () => {
        rootsCalled = true
        return [fakeAgent('stale')]
      },
    })

    await resolveInboundAgent(context, 'session-abc')

    expect(rootsCalled).toBe(false)
  })

  it('falls back to a live root agent when no session is configured', async () => {
    const live = fakeAgent('live')
    let resolveCalled = false
    const context = contextOf({
      resolveAgent: async () => {
        resolveCalled = true
        return live
      },
      roots: () => [live],
    })

    expect(await resolveInboundAgent(context, '')).toBe(live)
    expect(resolveCalled).toBe(false)
  })

  it('falls back to a live root agent when the session cannot be resumed', async () => {
    const live = fakeAgent('live')
    const context = contextOf({
      resolveAgent: async () => ({ error: new Error('gone') }),
      roots: () => [live],
    })

    expect(await resolveInboundAgent(context, 'session-abc')).toBe(live)
  })

  it('falls back when resolveAgent throws rather than rejecting the batch', async () => {
    const live = fakeAgent('live')
    const context = contextOf({
      resolveAgent: async () => {
        throw new Error('storage exploded')
      },
      roots: () => [live],
    })

    await expect(resolveInboundAgent(context, 'session-abc')).resolves.toBe(live)
  })

  it('returns undefined when nothing can be resolved', async () => {
    expect(await resolveInboundAgent(contextOf({}), 'session-abc')).toBeUndefined()
    expect(await resolveInboundAgent(contextOf({ roots: () => [] }), 'session-abc')).toBeUndefined()
  })

  it('treats a whitespace-only session id as unconfigured', async () => {
    const live = fakeAgent('live')
    let resolveCalled = false
    const context = contextOf({
      resolveAgent: async () => {
        resolveCalled = true
        return live
      },
      roots: () => [live],
    })

    expect(await resolveInboundAgent(context, '   ')).toBe(live)
    expect(resolveCalled).toBe(false)
  })
})
