import { describe, expect, it } from 'vitest'
import { OutboxReplayer, type ReplayTarget } from '../src/delivery/outbox-replayer.js'
import type { PushOutcome } from '../src/delivery/push.js'

/**
 * These tests pin the rule that once lost a noon report: a replayed entry is
 * removed only when the failure is *proven* permanent. Everything else keeps the
 * entry, because retrying costs a little traffic and deleting costs the report.
 */

function ready(id: string, text = 'report'): ReplayTarget {
  return { id, target: { toUserId: 'u1', contextToken: 't', text } }
}

function outcome(partial: Partial<PushOutcome>): PushOutcome {
  return { ok: false, retries: 0, shouldPark: false, ...partial }
}

const noop = () => {}

interface Harness {
  replayer: OutboxReplayer
  marked: string[]
  pushed: string[]
  pushesWithParking: boolean[]
  get prunes(): number
}

function harness(
  entries: ReplayTarget[],
  respond: (text: string) => Promise<PushOutcome>,
  options: { isPermanent?: (code: string | undefined) => boolean } = {},
): Harness {
  const marked: string[] = []
  const pushed: string[] = []
  const pushesWithParking: boolean[] = []
  let prunes = 0
  const replayer = new OutboxReplayer({
    list: async () => entries,
    push: async ({ text }, opts) => {
      pushed.push(text)
      pushesWithParking.push(opts.parkOnFailure)
      return respond(text)
    },
    markSent: async (id) => {
      marked.push(id)
    },
    pruneSent: async () => {
      prunes += 1
      return 0
    },
    isPermanentlyUnsendable: options.isPermanent ?? (() => false),
    log: { warn: noop, debug: noop },
  })
  return {
    replayer,
    marked,
    pushed,
    pushesWithParking,
    get prunes() {
      return prunes
    },
  }
}

describe('OutboxReplayer', () => {
  it('sends each parked entry and retires the ones that succeed', async () => {
    const h = harness([ready('a', 'A'), ready('b', 'B')], async () => outcome({ ok: true, msgid: 'm1' }))

    await h.replayer.replay()

    expect(h.pushed).toEqual(['A', 'B'])
    expect(h.marked).toEqual(['a', 'b'])
  })

  it('keeps an entry whose failure is not provably permanent', async () => {
    // The regression: `ret:-2 prepare failed` classifies as UNKNOWN, is transient,
    // and used to be treated as permanent — deleting the messages replay exists to
    // rescue. A 12:40 noon report was lost exactly this way.
    const h = harness([ready('a')], async () => outcome({ errorCode: 'UNKNOWN' }))

    await h.replayer.replay()

    expect(h.marked).toEqual([])
  })

  it('drops an entry only when the classifier says the failure is permanent', async () => {
    const h = harness([ready('a')], async () => outcome({ errorCode: 'NEEDS_INBOUND' }), {
      isPermanent: (code) => code === 'NEEDS_INBOUND',
    })

    await h.replayer.replay()

    expect(h.marked).toEqual(['a'])
  })

  it('never lets a replayed entry be parked again', async () => {
    // A replayed message is already in the outbox. Parking on failure would write a
    // second file for the same text, so one failed replay doubles the outbox and
    // every copy is sent once the token works.
    const h = harness([ready('a')], async () => outcome({ errorCode: 'RATE_LIMITED' }))

    await h.replayer.replay()

    expect(h.pushesWithParking).toEqual([false])
  })

  it('keeps going after one entry throws', async () => {
    // A single bad entry must not abort the batch: the rest of the parked reports
    // still have a chance to go out.
    let calls = 0
    const h = harness([ready('a', 'first'), ready('b', 'second')], async (text) => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return outcome({ ok: true, msgid: 'm2' })
    })

    await h.replayer.replay()

    expect(h.pushed).toEqual(['first', 'second'])
    expect(h.marked).toEqual(['b'])
  })

  it('prunes delivered records on every replay', async () => {
    const h = harness([], async () => outcome({ ok: true }))

    await h.replayer.replay()

    expect(h.prunes).toBe(1)
  })

  it('survives a prune failure without touching delivery', async () => {
    // Housekeeping runs after the sends; a broken `sent/` directory must not make
    // replay look failed.
    const marked: string[] = []
    const replayer = new OutboxReplayer({
      list: async () => [ready('a')],
      push: async () => outcome({ ok: true, msgid: 'm' }),
      markSent: async (id) => {
        marked.push(id)
      },
      pruneSent: async () => {
        throw new Error('EACCES')
      },
      isPermanentlyUnsendable: () => false,
      log: { warn: noop, debug: noop },
    })

    await expect(replayer.replay()).resolves.toBeUndefined()
    expect(marked).toEqual(['a'])
  })
})
