import { describe, expect, it, vi } from 'vitest'
import { registerTools } from '../src/tools.js'
import type { StatusReport } from '../src/tools.js'

interface Registered {
  name: string
  output?: { schema: unknown }
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

function harness(deps: Parameters<typeof registerTools>[1]) {
  const registered: Registered[] = []
  const ctx = {
    tools: {
      register: (tool: Registered) => {
        registered.push(tool)
      },
    },
  } as never
  registerTools(ctx, deps)
  const byName = (name: string): Registered => {
    const found = registered.find((t) => t.name === name)
    if (found === undefined) throw new Error(`tool ${name} not registered`)
    return found
  }
  return { byName }
}

const noopDeps = {
  push: vi.fn(async () => ({ ok: true, retries: 0, shouldPark: false })),
  park: vi.fn(async () => ({ id: 'parked-1' })),
  resolveContextToken: () => 'ctx',
  defaultUserId: () => 'owner',
}

describe('weixin_status output', () => {
  it('omits absent optional fields instead of returning undefined', async () => {
    // The harness validates tool output as lossless JSON. `{accountId: undefined}`
    // serialises to `{}`, so the declared schema stops matching the returned value
    // and the entire tool call fails — which is the state at boot, before the
    // channel has handled its first message.
    const report: StatusReport = {
      loggedIn: true,
      accountId: undefined,
      contextTokenAgeHours: undefined,
      lastDelivery: undefined,
      outboxCount: 0,
      pendingMessages: 0,
    }
    const { byName } = harness({ ...noopDeps, status: async () => report })

    const value = (await byName('weixin_status').execute({})) as Record<string, unknown>

    expect(value).toEqual({ loggedIn: true, outboxCount: 0, pendingMessages: 0 })
    // The specific regression: the keys must be absent, not present-and-undefined.
    expect(Object.keys(value)).not.toContain('accountId')
    expect(Object.keys(value)).not.toContain('contextTokenAgeHours')
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('keeps the fields that are present', async () => {
    const report: StatusReport = {
      loggedIn: true,
      accountId: 'acct@im.bot',
      contextTokenAgeHours: 2.5,
      lastDelivery: { id: 'msg-1', ts: '2026-10-27T01:00:00.000Z' },
      outboxCount: 3,
      pendingMessages: 1,
    }
    const { byName } = harness({ ...noopDeps, status: async () => report })

    const value = await byName('weixin_status').execute({})

    expect(value).toEqual(report)
  })
})

describe('weixin_push output', () => {
  it('omits undefined msgid and errorCode', async () => {
    const deps = {
      ...noopDeps,
      push: vi.fn(async () => ({ ok: false, retries: 0, shouldPark: true })),
      status: async () => ({ loggedIn: true, outboxCount: 0, pendingMessages: 0 }),
    }
    const { byName } = harness(deps)

    const value = (await byName('weixin_push').execute({ text: 'hi' })) as Record<string, unknown>

    expect(Object.keys(value)).not.toContain('msgid')
    expect(Object.keys(value)).not.toContain('errorCode')
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('passes through msgid and errorCode when present', async () => {
    const deps = {
      ...noopDeps,
      push: vi.fn(async () => ({
        ok: true,
        msgid: 'msg-9',
        errorCode: 'RATE_LIMITED',
        retries: 2,
        shouldPark: false,
      })),
      status: async () => ({ loggedIn: true, outboxCount: 0, pendingMessages: 0 }),
    }
    const { byName } = harness(deps)

    const value = await byName('weixin_push').execute({ text: 'hi' })

    expect(value).toEqual({
      ok: true,
      msgid: 'msg-9',
      errorCode: 'RATE_LIMITED',
      retries: 2,
      parked: false,
    })
  })

  it('reports NEEDS_INBOUND without a recipient', async () => {
    const deps = {
      ...noopDeps,
      defaultUserId: () => undefined,
      status: async () => ({ loggedIn: true, outboxCount: 0, pendingMessages: 0 }),
    }
    const { byName } = harness(deps)

    const value = (await byName('weixin_push').execute({ text: 'hi' })) as Record<string, unknown>

    expect(value.ok).toBe(false)
    expect(value.errorCode).toBe('NEEDS_INBOUND')
    expect(value.parked).toBe(false)
  })

  it('actually parks when no context token is cached', async () => {
    // The regression this guards: the branch returned `parked: true` without
    // writing anything to the outbox, so the agent believed the report was
    // queued for replay while it had been discarded — the silent-loss shape of
    // the 2026-09 incident. `parked: true` must mean a file exists.
    const park = vi.fn(async () => ({ id: 'parked-1' }))
    const push = vi.fn(async () => ({ ok: true, retries: 0, shouldPark: false }))
    const deps = {
      ...noopDeps,
      push,
      park,
      resolveContextToken: () => undefined,
      status: async () => ({ loggedIn: true, outboxCount: 0, pendingMessages: 0 }),
    }
    const { byName } = harness(deps)

    const value = (await byName('weixin_push').execute({ text: 'morning brief' })) as Record<string, unknown>

    expect(value.ok).toBe(false)
    expect(value.parked).toBe(true)
    expect(value.errorCode).toBe('NEEDS_INBOUND')
    expect(park).toHaveBeenCalledTimes(1)
    expect(park).toHaveBeenCalledWith({
      toUserId: 'owner',
      text: 'morning brief',
      reason: 'NEEDS_INBOUND',
    })
    // A parked message must not also be handed to the send path: no token means
    // sendText would throw and the entry would be written twice.
    expect(push).not.toHaveBeenCalled()
  })
})
