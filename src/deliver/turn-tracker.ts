/**
 * Accumulates one turn's delivery-relevant facts from the session event stream.
 *
 * The event bus carries every session's events, so this class is the only place
 * that knows how a turn is shaped: which message opened it, what the model said
 * last, and whether it already pushed something itself. It performs no IO and
 * makes no decisions — `policy.ts` decides, this observes.
 */

/**
 * The subset of a session event this tracker reads.
 *
 * Declared structurally rather than imported from the host so a DSH upgrade that
 * adds event fields cannot break compilation here; the fields used are the ones
 * observed in a real transcript.
 */
export interface SessionEventLike {
  type: string
  data?: unknown
}

export interface TurnSummary {
  /** `source.kind` of the turn's first `user/message`, absent when there was none. */
  firstUserSource: string | undefined
  /** Last assistant text of the turn, joined across text blocks. Never reasoning. */
  lastText: string
  /** True when the agent called `weixin_push` itself during this turn. */
  pushedManually: boolean
  /** `reason.kind` from `turn/end`, or undefined while the turn is still open. */
  reason: string | undefined
}

export interface TurnTrackerOptions {
  /** Cap on remembered turns per session; oldest are evicted first. */
  maxTurnsPerSession?: number
  /** Cap on remembered sessions; the least recently observed is evicted. */
  maxSessions?: number
}

interface TurnState {
  summary: TurnSummary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Extract a turn number, or undefined when the event carries none.
 *
 * Most events put it in `data.turn`, but `user/message` does not: a real transcript
 * carries only `{content, source, role, id}`. Those messages are attributed through
 * the currently open turn instead — see {@link TurnTracker.observe}.
 */
function turnOf(data: Record<string, unknown>): number | undefined {
  const turn = data.turn
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : undefined
}

function sourceKindOf(data: Record<string, unknown>): string | undefined {
  const source = data.source
  if (!isRecord(source)) return undefined
  return typeof source.kind === 'string' ? source.kind : undefined
}

/**
 * Concatenate the visible text blocks of one assistant message.
 *
 * Only `type: 'text'` blocks are included. Reasoning blocks carry the model's
 * internal narration — a real transcript contained "User says 你好 via WeChat.
 * Reply concisely via weixin_push" — and must never be sent to the owner.
 */
function textOfAssistantMessage(data: Record<string, unknown>): string {
  const message = data.message
  if (!isRecord(message)) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') continue
    parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export class TurnTracker {
  private readonly maxTurnsPerSession: number
  private readonly maxSessions: number
  /** Insertion order doubles as recency: Map iteration is oldest-first. */
  private readonly sessions = new Map<string, Map<number, TurnState>>()
  /** The turn each session currently has open, set by `turn/start` and cleared by `turn/end`. */
  private readonly openTurn = new Map<string, number>()

  constructor(options: TurnTrackerOptions = {}) {
    this.maxTurnsPerSession = options.maxTurnsPerSession ?? 32
    this.maxSessions = options.maxSessions ?? 64
  }

  observe(sessionId: string, event: SessionEventLike): void {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (!isRecord(event) || typeof event.type !== 'string') return
    if (!isRecord(event.data)) return

    // `turn/start` opens a turn and `turn/end` closes it. Recorded before the switch
    // so an untagged `user/message` in the same batch is attributed correctly.
    const tagged = turnOf(event.data)
    if (event.type === 'turn/start' && tagged !== undefined) this.openTurn.set(sessionId, tagged)

    // `user/message` is the one event that never carries a turn number. Everything
    // else must, and is dropped when it does not: guessing would attach a message to
    // an unrelated turn.
    const turn = event.type === 'user/message' ? (tagged ?? this.openTurn.get(sessionId)) : tagged
    if (turn === undefined) return

    // `turn/end` must not create state. If it did, a turn this process never watched
    // open would look identical to a tracked turn that is merely missing its opening
    // message, and the two need different handling: the former is unanswerable, the
    // latter is a policy skip.
    if (event.type === 'turn/end') {
      this.closeTurn(sessionId, turn, event.data)
      return
    }

    const state = this.stateFor(sessionId, turn)

    switch (event.type) {
      case 'user/message': {
        // Only the first user message names the turn's origin: every turn is
        // followed by injected context (runtime snapshot, skill catalog, time
        // context), so taking the last would classify every turn as context and
        // deliver nothing.
        if (state.summary.firstUserSource === undefined) {
          state.summary.firstUserSource = sourceKindOf(event.data)
        }
        break
      }
      case 'assistant/message': {
        const text = textOfAssistantMessage(event.data)
        // An empty message (tool-call only step) must not erase earlier text.
        if (text !== '') state.summary.lastText = text
        break
      }
      case 'tool/call': {
        if (event.data.name === 'weixin_push') state.summary.pushedManually = true
        break
      }
      default:
        break
    }
  }

  /**
   * Record a turn's terminal reason without creating state for an untracked turn.
   *
   * Closing is deliberately separate from `stateFor`: a `turn/end` for a turn this
   * process never saw open must leave the tracker empty so the caller can tell
   * "unanswerable, do nothing" apart from "tracked but skipped by policy".
   */
  private closeTurn(sessionId: string, turn: number, data: Record<string, unknown>): void {
    const turns = this.sessions.get(sessionId)
    const state = turns?.get(turn)
    if (state !== undefined) {
      const reason = data.reason
      state.summary.reason = isRecord(reason) && typeof reason.kind === 'string' ? reason.kind : undefined
    }
    if (this.openTurn.get(sessionId) === turn) this.openTurn.delete(sessionId)
  }

  /**
   * Read and forget a turn.
   *
   * Taking removes the entry: a replayed `session/event` (the bus can re-deliver on
   * reconnect) must not produce a second message, and the only reliable way to
   * guarantee that is to make the second read find nothing.
   */
  take(sessionId: string, turn: number): TurnSummary | undefined {
    const turns = this.sessions.get(sessionId)
    if (turns === undefined) return undefined
    const state = turns.get(turn)
    if (state === undefined) return undefined
    turns.delete(turn)
    if (turns.size === 0) this.sessions.delete(sessionId)
    return state.summary
  }

  private stateFor(sessionId: string, turn: number): TurnState {
    let turns = this.sessions.get(sessionId)
    if (turns === undefined) {
      turns = new Map()
      this.sessions.set(sessionId, turns)
      this.evictSessions()
    }
    let state = turns.get(turn)
    if (state === undefined) {
      state = { summary: { firstUserSource: undefined, lastText: '', pushedManually: false, reason: undefined } }
      turns.set(turn, state)
      this.evictTurns(turns)
    }
    return state
  }

  /**
   * Bound per-session growth.
   *
   * A turn that never ends (the process was killed mid-turn) would otherwise be
   * retained forever; over weeks of a long-lived `dsh web` that is a slow leak.
   * Evicting the oldest is safe because a turn this old can no longer be delivered.
   */
  private evictTurns(turns: Map<number, TurnState>): void {
    while (turns.size > this.maxTurnsPerSession) {
      const oldest = turns.keys().next()
      if (oldest.done === true) return
      turns.delete(oldest.value)
    }
  }

  /** Bound total sessions, evicting the one observed least recently. */
  private evictSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) return
      this.sessions.delete(oldest.value)
      this.openTurn.delete(oldest.value)
    }
  }
}
