import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/deliver/turn-tracker.js'

/**
 * Minimal event factory. The tracker only reads the fields the design names, so
 * building full session events here would hide which fields it actually depends on.
 */
function event(type: string, data: Record<string, unknown>) {
  return { type, data }
}

function assistantText(turn: number, step: number, text: string) {
  return event('assistant/message', {
    turn,
    step,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

describe('TurnTracker', () => {
  it('records the first user source of a turn', () => {
    const tracker = new TurnTracker()
    tracker.observe(
      's1',
      event('user/message', { turn: 1, source: { kind: 'weixin-link' }, content: [{ type: 'text', text: 'hi' }] }),
    )

    expect(tracker.take('s1', 1)?.firstUserSource).toBe('weixin-link')
  })

  it('keeps the FIRST user source when a turn has several user messages', () => {
    // Every turn carries injected context messages (runtime snapshot, skill
    // catalog, time context) *after* the real one. Taking the last would
    // classify every turn as "time-context" and deliver nothing.
    const tracker = new TurnTracker()
    tracker.observe('s1', event('user/message', { turn: 1, source: { kind: 'schedule' } }))
    tracker.observe('s1', event('user/message', { turn: 1, source: { kind: 'runtime-context' } }))
    tracker.observe('s1', event('user/message', { turn: 1, source: { kind: 'time-context' } }))

    expect(tracker.take('s1', 1)?.firstUserSource).toBe('schedule')
  })

  it('keeps the last assistant text across steps', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistantText(1, 1, 'first'))
    tracker.observe('s1', assistantText(1, 2, 'second'))

    expect(tracker.take('s1', 1)?.lastText).toBe('second')
  })

  it('joins multiple text blocks of one message', () => {
    const tracker = new TurnTracker()
    tracker.observe(
      's1',
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
      }),
    )

    expect(tracker.take('s1', 1)?.lastText).toBe('part one\npart two')
  })

  it('never includes reasoning blocks in the delivered text', () => {
    // Observed live: reasoning carried "User says 你好 via WeChat. Reply concisely
    // via weixin_push" — internal judgement that must never reach the owner.
    const tracker = new TurnTracker()
    tracker.observe(
      's1',
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'SECRET: the user is testing me' },
            { type: 'text', text: 'visible' },
          ],
        },
      }),
    )

    const text = tracker.take('s1', 1)?.lastText
    expect(text).toBe('visible')
    expect(text).not.toContain('SECRET')
  })

  it('flags a manual weixin_push call in the same turn', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('tool/call', { turn: 1, step: 1, name: 'weixin_push' }))

    expect(tracker.take('s1', 1)?.pushedManually).toBe(true)
  })

  it('ignores tool calls other than weixin_push', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('tool/call', { turn: 1, step: 1, name: 'read' }))

    expect(tracker.take('s1', 1)?.pushedManually).toBe(false)
  })

  it('records the turn end reason', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistantText(1, 1, 'x'))
    tracker.observe('s1', event('turn/end', { turn: 1, reason: { kind: 'aborted' } }))

    expect(tracker.take('s1', 1)?.reason).toBe('aborted')
  })

  it('isolates turns from each other', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistantText(1, 1, 'turn one'))
    tracker.observe('s1', assistantText(2, 1, 'turn two'))

    expect(tracker.take('s1', 1)?.lastText).toBe('turn one')
    expect(tracker.take('s1', 2)?.lastText).toBe('turn two')
  })

  it('isolates sessions from each other', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistantText(1, 1, 'session one'))
    tracker.observe('s2', assistantText(1, 1, 'session two'))

    expect(tracker.take('s1', 1)?.lastText).toBe('session one')
    expect(tracker.take('s2', 1)?.lastText).toBe('session two')
  })

  it('forgets a turn once taken, so a replay cannot deliver twice', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistantText(1, 1, 'once'))

    expect(tracker.take('s1', 1)?.lastText).toBe('once')
    expect(tracker.take('s1', 1)).toBeUndefined()
  })

  it('returns undefined for a turn it never saw', () => {
    expect(new TurnTracker().take('s1', 99)).toBeUndefined()
  })

  it('drops stale turns so a long-lived process does not grow without bound', () => {
    const tracker = new TurnTracker({ maxTurnsPerSession: 2, maxSessions: 2 })
    tracker.observe('s1', assistantText(1, 1, 'one'))
    tracker.observe('s1', assistantText(2, 1, 'two'))
    tracker.observe('s1', assistantText(3, 1, 'three'))

    // The oldest turn is evicted; the two most recent survive.
    expect(tracker.take('s1', 1)).toBeUndefined()
    expect(tracker.take('s1', 2)?.lastText).toBe('two')
    expect(tracker.take('s1', 3)?.lastText).toBe('three')
  })

  it('drops whole sessions when the session cap is exceeded', () => {
    const tracker = new TurnTracker({ maxTurnsPerSession: 4, maxSessions: 2 })
    tracker.observe('s1', assistantText(1, 1, 'one'))
    tracker.observe('s2', assistantText(1, 1, 'two'))
    tracker.observe('s3', assistantText(1, 1, 'three'))

    expect(tracker.take('s1', 1)).toBeUndefined()
    expect(tracker.take('s3', 1)?.lastText).toBe('three')
  })

  it('survives malformed events without throwing', () => {
    // These arrive from a global bus fed by other plugins; a throw here would
    // propagate into their event dispatch.
    const tracker = new TurnTracker()
    expect(() => {
      tracker.observe('s1', { type: 'assistant/message', data: {} })
      tracker.observe('s1', { type: 'assistant/message', data: { turn: 'x' } })
      tracker.observe('s1', { type: 'user/message', data: { turn: 1 } })
      tracker.observe('s1', { type: 'tool/call', data: { turn: 1 } })
      tracker.observe('s1', { type: 'turn/end', data: {} })
    }).not.toThrow()
  })

  it('treats a turn with no turn number as unseen', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }))

    expect(tracker.take('s1', 1)).toBeUndefined()
  })

  it('attributes an untagged user/message to the turn turn/start opened', () => {
    // Real transcripts: `user/message` carries only {content, source, role, id} —
    // no `turn`. Dropping it for that reason made every Weixin turn resolve as
    // `source-unknown` and be silently skipped, which is exactly how a working
    // reply became unreachable. The open turn is the only correct attribution.
    const tracker = new TurnTracker()
    tracker.observe('s1', event('turn/start', { turn: 7 }))
    tracker.observe('s1', event('user/message', { source: { kind: 'weixin-link' }, content: [] }))
    tracker.observe('s1', event('assistant/message', { turn: 7, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }))
    tracker.observe('s1', event('turn/end', { turn: 7, reason: { kind: 'completed' } }))

    expect(tracker.take('s1', 7)).toMatchObject({ firstUserSource: 'weixin-link', lastText: 'ok', reason: 'completed' })
  })

  it('keeps the first untagged source and ignores later injected context', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('turn/start', { turn: 3 }))
    tracker.observe('s1', event('user/message', { source: { kind: 'schedule' } }))
    tracker.observe('s1', event('user/message', { source: { kind: 'runtime-context' } }))
    tracker.observe('s1', event('user/message', { source: { kind: 'skill-catalog' } }))
    tracker.observe('s1', event('user/message', { source: { kind: 'time-context' } }))

    expect(tracker.take('s1', 3)?.firstUserSource).toBe('schedule')
  })

  it('does not attribute an untagged user/message when no turn is open', () => {
    // A message appended outside any turn (a seed, a replay) has no owner; guessing
    // would attach it to an unrelated turn and could deliver the wrong text.
    const tracker = new TurnTracker()
    tracker.observe('s1', event('user/message', { source: { kind: 'weixin-link' } }))
    tracker.observe('s1', event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }))

    expect(tracker.take('s1', 1)?.firstUserSource).toBeUndefined()
  })

  it('stops attributing to a turn once it has ended', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('turn/start', { turn: 1 }))
    tracker.observe('s1', event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    tracker.observe('s1', event('user/message', { source: { kind: 'weixin-link' } }))

    expect(tracker.take('s1', 1)?.firstUserSource).toBeUndefined()
  })

  it('attributes each turn independently across a session', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', event('turn/start', { turn: 1 }))
    tracker.observe('s1', event('user/message', { source: { kind: 'weixin-link' } }))
    tracker.observe('s1', event('turn/start', { turn: 2 }))
    tracker.observe('s1', event('user/message', { source: { kind: 'schedule' } }))

    expect(tracker.take('s1', 1)?.firstUserSource).toBe('weixin-link')
    expect(tracker.take('s1', 2)?.firstUserSource).toBe('schedule')
  })
})
