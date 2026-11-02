import { describe, expect, it } from 'vitest'
import { DeliveryDedupe } from '../src/delivery/dedupe.js'

const MINUTE = 60_000

describe('DeliveryDedupe', () => {
  it('treats a repeat inside the window as already delivered', () => {
    const dedupe = new DeliveryDedupe({ windowMs: 10 * MINUTE })
    dedupe.record('report', 1_000)

    expect(dedupe.isDuplicate('report', 2_000)).toBe(true)
  })

  it('forgets a text once the window has passed', () => {
    // A report that is genuinely run again later must still arrive; a dedupe that
    // never forgets would silently eat it.
    const dedupe = new DeliveryDedupe({ windowMs: 10 * MINUTE })
    dedupe.record('report', 1_000)

    expect(dedupe.isDuplicate('report', 1_000 + 10 * MINUTE + 1)).toBe(false)
  })

  it('ignores surrounding whitespace', () => {
    // The same text read back from an outbox file carries different trailing
    // whitespace than the turn that parked it.
    const dedupe = new DeliveryDedupe()
    dedupe.record('report\n', 1_000)

    expect(dedupe.isDuplicate('  report  ', 2_000)).toBe(true)
  })

  it('does not confuse different texts', () => {
    const dedupe = new DeliveryDedupe()
    dedupe.record('report a', 1_000)

    expect(dedupe.isDuplicate('report b', 2_000)).toBe(false)
  })

  it('records nothing for empty text', () => {
    // An empty send is a bug elsewhere; remembering it would suppress the next real
    // empty notice.
    const dedupe = new DeliveryDedupe()
    dedupe.record('   ', 1_000)

    expect(dedupe.isDuplicate('', 2_000)).toBe(false)
  })

  it('bounds how many texts it remembers', () => {
    const dedupe = new DeliveryDedupe({ maxEntries: 2 })
    for (let i = 0; i < 5; i++) dedupe.record(`report ${i}`, 1_000 + i)

    // The oldest went first; the most recent two survive.
    expect(dedupe.isDuplicate('report 0', 2_000)).toBe(false)
    expect(dedupe.isDuplicate('report 4', 2_000)).toBe(true)
  })

  it('is safe to call with no configuration', () => {
    const dedupe = new DeliveryDedupe()
    expect(dedupe.window).toBeGreaterThan(0)
    expect(dedupe.isDuplicate('never sent')).toBe(false)
  })
})
