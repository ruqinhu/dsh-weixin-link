import { describe, expect, it } from 'vitest'
import {
  DELIVERABLE_SOURCES,
  EMPTY_TURN_NOTICE,
  MAX_DELIVERY_CHARS,
  SILENT_MARKER,
  TRUNCATION_SUFFIX,
  decide,
  formatEmptyNotice,
  isDeliverableSource,
  truncateForDelivery,
} from '../src/deliver/policy.js'
import type { TurnSummary } from '../src/deliver/turn-tracker.js'

function summary(over: Partial<TurnSummary> = {}): TurnSummary {
  return {
    firstUserSource: 'schedule',
    lastText: 'report body',
    pushedManually: false,
    reason: 'completed',
    ...over,
  }
}

describe('deliverable sources', () => {
  it('delivers a scheduled task', () => {
    expect(decide(summary({ firstUserSource: 'schedule' }))).toEqual({ action: 'send', text: 'report body' })
  })

  it('delivers a conversation that started in Weixin', () => {
    expect(decide(summary({ firstUserSource: 'weixin-link' }))).toEqual({ action: 'send', text: 'report body' })
  })

  it('does not deliver a turn typed in the terminal or web UI', () => {
    // The owner is at the keyboard; pushing to the phone would be noise, and the
    // same answer is already on screen.
    expect(decide(summary({ firstUserSource: 'user' }))).toEqual({ action: 'skip', reason: 'source-not-deliverable' })
  })

  it.each(['runtime-context', 'skill-catalog', 'time-context', 'compact-checkpoint', 'provider', 'fallback'])(
    'does not deliver internal turn source %s',
    (kind) => {
      expect(decide(summary({ firstUserSource: kind }))).toEqual({ action: 'skip', reason: 'source-not-deliverable' })
    },
  )

  it('exposes exactly the two deliverable kinds', () => {
    expect([...DELIVERABLE_SOURCES].sort()).toEqual(['schedule', 'weixin-link'])
  })

  it('isDeliverableSource agrees with the set', () => {
    for (const kind of DELIVERABLE_SOURCES) expect(isDeliverableSource(kind)).toBe(true)
    for (const kind of ['user', 'provider', 'fallback', 'nonsense']) expect(isDeliverableSource(kind)).toBe(false)
  })

  it('skips a turn with no identifiable source', () => {
    expect(decide(summary({ firstUserSource: undefined }))).toEqual({ action: 'skip', reason: 'source-unknown' })
  })
})

describe('turn completion', () => {
  it.each(['aborted', 'errored', 'canceled', 'failed'])('does not deliver a turn that ended %s', (reason) => {
    expect(decide(summary({ reason }))).toEqual({ action: 'skip', reason: 'not-completed' })
  })

  it('does not deliver a turn that never ended', () => {
    expect(decide(summary({ reason: undefined }))).toEqual({ action: 'skip', reason: 'not-completed' })
  })

  it('delivers when the turn completed', () => {
    expect(decide(summary({ reason: 'completed' })).action).toBe('send')
  })
})

describe('manual push', () => {
  it('does not deliver again when the agent already called weixin_push', () => {
    // Double delivery is the failure mode this guards: the owner would receive the
    // report twice, once from the tool and once from the auto-deliver path.
    expect(decide(summary({ pushedManually: true }))).toEqual({ action: 'skip', reason: 'already-pushed' })
  })

  it('still checks the source before the manual-push rule', () => {
    // A terminal turn that happened to push must skip for the source reason; the
    // ordering matters only for the reported reason, but pinning it keeps the
    // decision explainable from logs.
    expect(decide(summary({ pushedManually: true, firstUserSource: 'user' }))).toEqual({
      action: 'skip',
      reason: 'source-not-deliverable',
    })
  })
})

describe('empty turns', () => {
  it('notifies instead of staying silent when a scheduled task produced nothing', () => {
    // Silence would make "ran and failed" indistinguishable from "never ran", and
    // those two need different responses.
    const decision = decide(summary({ lastText: '' }))
    expect(decision.action).toBe('send')
    expect(decision.action === 'send' && decision.text).toContain(EMPTY_TURN_NOTICE)
  })

  it('does not notify for an empty terminal turn', () => {
    expect(decide(summary({ lastText: '', firstUserSource: 'user' })).action).toBe('skip')
  })

  it('formats the notice with the turn time, in local time', () => {
    // 2026-10-28T16:30:00Z is 2026-10-29 00:30 in Asia/Shanghai; the notice is read
    // on a phone, so it must be local rather than UTC.
    const notice = formatEmptyNotice(new Date('2026-10-28T16:30:00Z'), 8)
    expect(notice).toContain('2026-10-29 00:30')
  })

  it('treats whitespace-only text as empty', () => {
    expect(decide(summary({ lastText: '   \n  ' })).action === 'send').toBe(true)
    const decision = decide(summary({ lastText: '  ' }))
    expect(decision.action === 'send' && decision.text).toContain(EMPTY_TURN_NOTICE)
  })

  it('passes text through unchanged when present', () => {
    expect(decide(summary({ lastText: '  padded  ' }))).toEqual({ action: 'send', text: '  padded  ' })
  })

  it('honours an explicit opt-out marker instead of notifying', () => {
    // 每周持久记忆压缩 runs at 01:30 Saturday and its prompt says "output nothing,
    // do not notify" when there is nothing to compact. Turning that into a
    // "本次无产出" push would wake the owner for a non-event.
    expect(decide(summary({ lastText: SILENT_MARKER }))).toEqual({
      action: 'skip',
      reason: 'deliberately-silent',
    })
  })

  it('tolerates surrounding whitespace on the opt-out marker', () => {
    expect(decide(summary({ lastText: `  ${SILENT_MARKER}\n` })).action).toBe('skip')
  })

  it.each([
    ['backticks', `\`${SILENT_MARKER}\``],
    ['code fence', `\`\`\`\n${SILENT_MARKER}\n\`\`\``],
    ['trailing full stop', `${SILENT_MARKER}。`],
    ['quotes', `「${SILENT_MARKER}」`],
    ['exclamation', `${SILENT_MARKER}!`],
    ['all of it', `\`\`\`\n「${SILENT_MARKER}」。\n\`\`\``],
  ])('recognises the opt-out marker wrapped in %s', (_label, text) => {
    // A model told to output exactly [SILENT] wraps it in backticks or adds punctuation
    // often enough that strict equality would turn intentional silence into a 01:30
    // "本次无产出" push — the very outcome the marker exists to prevent.
    expect(decide(summary({ lastText: text }))).toEqual({ action: 'skip', reason: 'deliberately-silent' })
  })

  it('still delivers real text that merely mentions the marker', () => {
    // Only a turn whose entire text is the marker opts out; a report explaining that
    // something was skipped must not be swallowed.
    const text = `今日休市 ${SILENT_MARKER} 但已归档`
    expect(decide(summary({ lastText: text }))).toEqual({ action: 'send', text })
  })
})

describe('length cap', () => {
  /**
   * iLink rate-limits or drops payloads beyond ~2200 characters, and the failure is not
   * a clean rejection — a send can return a message id and still never arrive. The
   * prompts promise "Weixin payload ≤2200 characters" while the full report goes to the
   * HTML file, so the cap is enforced here rather than trusted to the model.
   */
  it('leaves a message under the cap untouched', () => {
    expect(truncateForDelivery('short')).toBe('short')
  })

  it('leaves a message exactly at the cap untouched', () => {
    const text = 'x'.repeat(MAX_DELIVERY_CHARS)
    expect(truncateForDelivery(text)).toBe(text)
  })

  it('cuts a message over the cap and says so', () => {
    const text = 'x'.repeat(MAX_DELIVERY_CHARS + 500)
    const out = truncateForDelivery(text)
    expect(out.length).toBeLessThan(text.length)
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true)
  })

  it('prefers a line boundary so no line is cut in half', () => {
    // Many short lines: the cut should land on a newline, keeping every retained line.
    const lines = Array.from({ length: 400 }, (_, i) => `第${i}行内容`)
    const text = lines.join('\n')
    const out = truncateForDelivery(text)
    const body = out.slice(0, out.length - TRUNCATION_SUFFIX.length)
    expect(body.length).toBeLessThanOrEqual(MAX_DELIVERY_CHARS)
    // No partial last line: every retained line parses as a whole entry.
    expect(body.split('\n').every((l) => /^第\d+行内容$/.test(l))).toBe(true)
  })

  it('falls back to an exact cut when there is no usable line break', () => {
    const text = 'x'.repeat(MAX_DELIVERY_CHARS * 2)
    const out = truncateForDelivery(text)
    expect(out.slice(0, -TRUNCATION_SUFFIX.length).length).toBe(MAX_DELIVERY_CHARS)
  })

  it('applies the cap through the decision, not only the helper', () => {
    const text = 'y'.repeat(MAX_DELIVERY_CHARS + 100)
    const decision = decide(summary({ lastText: text }))
    expect(decision.action).toBe('send')
    expect(decision.action === 'send' && decision.text.length).toBeLessThan(text.length)
  })

  it('does not truncate the empty-turn notice', () => {
    const decision = decide(summary({ lastText: '' }))
    expect(decision.action === 'send' && decision.text).not.toContain(TRUNCATION_SUFFIX)
  })
})
