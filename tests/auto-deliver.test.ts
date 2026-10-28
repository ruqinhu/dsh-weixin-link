import { describe, expect, it, vi } from 'vitest'
import { AutoDeliver } from '../src/deliver/auto-deliver.js'
import type { PushTarget } from '../src/delivery/push.js'

interface Harness {
  deliver: AutoDeliver
  push: ReturnType<typeof vi.fn>
  emit: (sessionId: string, event: unknown) => void
  /** Let queued microtasks run. */
  settle: () => Promise<void>
}

function harness(
  options: {
    tokenUserId?: string
    token?: string
    pushResult?: { ok: boolean }
    /** Simulate "no inbound message ever arrived", which means no context_token. */
    noTarget?: boolean
    timeZoneOffset?: number
  } = {},
): Harness {
  const push = vi.fn(async (_target: PushTarget) => options.pushResult ?? { ok: true, msgid: 'm1', retries: 0 })
  const deliver = new AutoDeliver({
    resolveTarget: () =>
      options.noTarget === true
        ? undefined
        : { toUserId: options.tokenUserId ?? 'u1', contextToken: options.token ?? 'tok' },
    push: push as never,
    log: { warn: vi.fn(), info: vi.fn() },
    timeZoneOffset: options.timeZoneOffset,
  })

  let handler: ((sessionId: string, event: unknown) => void) | undefined
  const seen: { sessionId: string; event: unknown }[] = []
  handler = (sessionId, event) => {
    seen.push({ sessionId, event })
    deliver.observe(sessionId, event as never)
  }

  const emit = (sessionId: string, event: unknown) => handler?.(sessionId, event)
  const settle = async () => {
    // Two awaits: one for the queueMicrotask, one for the async push.
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { deliver, push, emit, settle }
}

function textMessage(turn: number, text: string) {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

function userMessage(turn: number, kind: string) {
  return { type: 'user/message', data: { turn, source: { kind }, content: [{ type: 'text', text: 'x' }] } }
}

function turnEnd(turn: number, kind = 'completed') {
  return { type: 'turn/end', data: { turn, reason: { kind } } }
}

describe('AutoDeliver', () => {
  it('sends a completed scheduled turn exactly once', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'morning report'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.push.mock.calls[0]?.[0]).toMatchObject({ text: 'morning report', toUserId: 'u1', contextToken: 'tok' })
  })

  it('sends a Weixin conversation turn', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'weixin-link'))
    h.emit('s1', textMessage(1, 'reply'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(1)
  })

  it('stays silent for a terminal turn', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'user'))
    h.emit('s1', textMessage(1, 'visible in the UI already'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).not.toHaveBeenCalled()
  })

  it('stays silent for internal maintenance turns', async () => {
    const h = harness()
    for (const kind of ['provider', 'compact-checkpoint', 'runtime-context']) {
      h.emit('s1', userMessage(1, kind))
      h.emit('s1', textMessage(1, 'internal'))
      h.emit('s1', turnEnd(1))
    }
    await h.settle()

    expect(h.push).not.toHaveBeenCalled()
  })

  it('does not send twice when the agent pushed by itself', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'weixin-link'))
    h.emit('s1', { type: 'tool/call', data: { turn: 1, step: 1, name: 'weixin_push' } })
    h.emit('s1', textMessage(1, '已通过微信回复你了'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).not.toHaveBeenCalled()
  })

  it('does not send a turn that was aborted', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'partial'))
    h.emit('s1', turnEnd(1, 'aborted'))
    await h.settle()

    expect(h.push).not.toHaveBeenCalled()
  })

  it('sends the empty notice when a scheduled turn produced no text', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(1)
    expect(String(h.push.mock.calls[0]?.[0]?.text)).toContain('本次无产出')
  })

  it('does nothing when there is no cached context token', async () => {
    // Without an inbound message there is no token, so a send cannot succeed. It
    // must not be attempted, and it must not be parked either: the report would be
    // replayed days later, long after it was useful.
    const h = harness({ noTarget: true })
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'report'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).not.toHaveBeenCalled()
  })

  it('delivers a single turn only once even if turn/end arrives twice', async () => {
    // The bus can re-deliver events; `take()` removes the summary so the second
    // read finds nothing.
    const h = harness()
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'report'))
    h.emit('s1', turnEnd(1))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(1)
  })

  it('keeps delivering later turns of the same session', async () => {
    const h = harness()
    for (const turn of [1, 2, 3]) {
      h.emit('s1', userMessage(turn, 'schedule'))
      h.emit('s1', textMessage(turn, `report ${turn}`))
      h.emit('s1', turnEnd(turn))
    }
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(3)
    expect(h.push.mock.calls.map((c) => c[0]?.text)).toEqual(['report 1', 'report 2', 'report 3'])
  })

  it('delivers turns of different sessions independently', async () => {
    const h = harness()
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'one'))
    h.emit('s1', turnEnd(1))
    h.emit('s2', userMessage(1, 'weixin-link'))
    h.emit('s2', textMessage(1, 'two'))
    h.emit('s2', turnEnd(1))
    await h.settle()

    expect(h.push).toHaveBeenCalledTimes(2)
  })

  it('does not throw when the push fails', async () => {
    const h = harness({ pushResult: { ok: false } })
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', textMessage(1, 'report'))
    h.emit('s1', turnEnd(1))

    await expect(h.settle()).resolves.toBeUndefined()
  })

  it('does not let a throwing push break the event bus', async () => {
    // The handler runs inside another plugin's dispatch; a rejection escaping here
    // would surface as an unhandled rejection in their turn loop.
    const push = vi.fn(async () => {
      throw new Error('network down')
    })
    const deliver = new AutoDeliver({
      resolveTarget: () => ({ toUserId: 'u1', contextToken: 'tok' }),
      push: push as never,
      log: { warn: vi.fn(), info: vi.fn() },
    })
    deliver.observe('s1', userMessage(1, 'schedule') as never)
    deliver.observe('s1', textMessage(1, 'report') as never)
    expect(() => deliver.observe('s1', turnEnd(1) as never)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('records the configured time zone offset in the empty notice', async () => {
    const h = harness({ timeZoneOffset: 8 })
    h.emit('s1', userMessage(1, 'schedule'))
    h.emit('s1', turnEnd(1))
    await h.settle()

    expect(String(h.push.mock.calls[0]?.[0]?.text)).toMatch(/本次无产出（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/)
  })
})

describe('delivery trace', () => {
  /**
   * The trace exists because cordis' logger only buffers in memory: without a file,
   * "was delivery considered at 07:00?" is unanswerable after the fact, and a
   * skipped turn leaves no receipt to inspect.
   */
  function traced(options: { noTarget?: boolean } = {}) {
    const noTarget = options.noTarget === true
    const lines: string[] = []
    const push = vi.fn(async () => ({ ok: true, msgid: 'm1', retries: 0 }))
    const deliver = new AutoDeliver({
      resolveTarget: () => (noTarget ? undefined : { toUserId: 'u1', contextToken: 'tok' }),
      push: push as never,
      log: { warn: vi.fn(), info: vi.fn() },
      trace: (line) => lines.push(line),
    })
    return { lines, deliver }
  }

  it('records a send', async () => {
    const { lines, deliver } = traced()
    deliver.observe('s1', userMessage(1, 'schedule') as never)
    deliver.observe('s1', textMessage(1, 'body') as never)
    deliver.observe('s1', turnEnd(1) as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(lines.some((l) => l.startsWith('send session=s1 turn=1'))).toBe(true)
    expect(lines.some((l) => l.startsWith('ok session=s1 turn=1'))).toBe(true)
  })

  it('records why a turn was skipped', async () => {
    const { lines, deliver } = traced()
    deliver.observe('s1', userMessage(1, 'user') as never)
    deliver.observe('s1', textMessage(1, 'x') as never)
    deliver.observe('s1', turnEnd(1) as never)

    expect(lines).toContain('skip session=s1 turn=1 reason=source-not-deliverable')
  })

  it('delivers a Weixin turn whose user/message carries no turn number', async () => {
    // This is the exact shape emitted by the harness, and the reason a real reply was
    // silently dropped in production: `user/message` has {content, source, role, id}
    // and no `turn`, so keying on data.turn made every Weixin turn resolve as
    // source-unknown.
    const lines: string[] = []
    const push = vi.fn(async () => ({ ok: true, msgid: 'm1', retries: 0 }))
    const deliver = new AutoDeliver({
      resolveTarget: () => ({ toUserId: 'u1', contextToken: 'tok' }),
      push: push as never,
      log: { warn: vi.fn(), info: vi.fn() },
      trace: (line) => lines.push(line),
    })

    deliver.observe('s1', { type: 'turn/start', data: { turn: 11 } } as never)
    deliver.observe('s1', { type: 'user/message', data: { source: { kind: 'weixin-link' }, content: [{ type: 'text', text: '测试' }] } } as never)
    deliver.observe('s1', {
      type: 'assistant/message',
      data: { turn: 11, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '测试收到 ✅' }] } },
    } as never)
    deliver.observe('s1', { type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } } as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0]?.[0]).toMatchObject({ text: '测试收到 ✅' })
    expect(lines.some((l) => l.startsWith('ok session=s1 turn=11'))).toBe(true)
  })

  it('records a dropped send when no token exists', async () => {
    const { lines, deliver } = traced({ noTarget: true })
    deliver.observe('s1', userMessage(1, 'schedule') as never)
    deliver.observe('s1', textMessage(1, 'body') as never)
    deliver.observe('s1', turnEnd(1) as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(lines.some((l) => l.includes('reason=no-context-token'))).toBe(true)
  })

  it('does not deliver a turn the tracker has no state for', async () => {
    // Happens when the process booted mid-turn: `turn/start` and the opening message
    // were never observed. Sending would be a guess, and guessing wrong either spams
    // the owner with session-title generation or drops a real report.
    const { lines, deliver } = traced()
    deliver.observe('s1', turnEnd(1) as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(lines).toContain('skip session=s1 turn=1 reason=untracked-turn')
  })

  it('does not deliver an orphan turn that carries text but no opening message', async () => {
    // `assistant/message` creates tracker state, but without a `user/message` the
    // source is unknown — and policy skips unknown sources rather than assuming.
    const { lines, deliver } = traced()
    deliver.observe('s1', textMessage(1, 'orphan text') as never)
    deliver.observe('s1', turnEnd(1) as never)
    await new Promise((r) => setTimeout(r, 0))

    expect(lines).toContain('skip session=s1 turn=1 reason=source-unknown')
  })

  it('does not let a throwing trace sink break delivery', async () => {
    const push = vi.fn(async () => ({ ok: true, msgid: 'm1', retries: 0 }))
    const deliver = new AutoDeliver({
      resolveTarget: () => ({ toUserId: 'u1', contextToken: 'tok' }),
      push: push as never,
      log: { warn: vi.fn(), info: vi.fn() },
      trace: () => {
        throw new Error('disk full')
      },
    })
    deliver.observe('s1', userMessage(1, 'schedule') as never)
    deliver.observe('s1', textMessage(1, 'body') as never)
    expect(() => deliver.observe('s1', turnEnd(1) as never)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))

    expect(push).toHaveBeenCalledTimes(1)
  })
})
