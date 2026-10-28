import { describe, expect, it, vi } from 'vitest'
import {
  collectInbound,
  deliverToAgent,
  toInboundText,
  toUserMessage,
  WEIXIN_SOURCE,
  REPLY_DIRECTIVE,
} from '../src/bridge/session.js'
import type { WeixinMessage } from '../src/ilink/types.js'

function message(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    from_user_id: 'u1',
    to_user_id: 'bot',
    message_type: 1,
    message_state: 2,
    context_token: 'tok',
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
    ...overrides,
  }
}

describe('toInboundText', () => {
  it('extracts text, sender and token', () => {
    expect(toInboundText(message(), { echoOwnMessages: false })).toEqual({
      userId: 'u1',
      text: 'hello',
      contextToken: 'tok',
      messageId: undefined,
    })
  })

  it('carries the server message id when present', () => {
    expect(toInboundText(message({ message_id: 'm9' }), { echoOwnMessages: false })?.messageId).toBe('m9')
  })

  it('ignores the bot s own echo by default', () => {
    expect(toInboundText(message({ message_type: 2 }), { echoOwnMessages: false })).toBeUndefined()
  })

  it('surfaces the echo when explicitly enabled', () => {
    expect(toInboundText(message({ message_type: 2 }), { echoOwnMessages: true })?.text).toBe('hello')
  })

  it('drops a message with no text item', () => {
    expect(toInboundText(message({ item_list: [{ type: 2 }] }), { echoOwnMessages: false })).toBeUndefined()
  })

  it('drops whitespace-only text', () => {
    const blank = message({ item_list: [{ type: 1, text_item: { text: '   ' } }] })
    expect(toInboundText(blank, { echoOwnMessages: false })).toBeUndefined()
  })

  it('drops a message without a context token', () => {
    expect(toInboundText(message({ context_token: undefined }), { echoOwnMessages: false })).toBeUndefined()
  })
})

describe('collectInbound', () => {
  it('keeps order and filters unusable messages', () => {
    const batch = [
      message({ from_user_id: 'a', item_list: [{ type: 1, text_item: { text: '1' } }] }),
      message({ message_type: 2 }),
      message({ from_user_id: 'b', item_list: [{ type: 2 }] }),
      message({ from_user_id: 'c', item_list: [{ type: 1, text_item: { text: '3' } }] }),
    ]

    expect(collectInbound(batch, { echoOwnMessages: false }).map((c) => c.userId)).toEqual(['a', 'c'])
  })

  it('returns an empty array for an empty batch', () => {
    expect(collectInbound([], { echoOwnMessages: false })).toEqual([])
  })
})

describe('toUserMessage', () => {
  it('builds a frozen user message tagged with the plugin source', () => {
    const built = toUserMessage({ userId: 'u1', text: 'hello', contextToken: 'tok' })

    expect(built.role).toBe('user')
    expect(built.source).toEqual(WEIXIN_SOURCE)
    expect(typeof built.id).toBe('string')
    expect(Object.isFrozen(built)).toBe(true)
  })

  it('tells the agent its reply must go out over weixin_push', () => {
    // Observed turn: the agent produced a correct reply and ended `completed`
    // without ever calling `weixin_push`, so the owner received nothing. The
    // directive is the only signal that this turn arrived over Weixin.
    const built = toUserMessage({ userId: 'u1', text: '你好', contextToken: 'tok' })

    const text = (built.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(REPLY_DIRECTIVE)
    expect(text).toContain('weixin_push')
    expect(text).toContain('你好')
    // The owner's words must survive intact and after the directive.
    expect(text.endsWith('你好')).toBe(true)
  })

  it('does not lose the message when the text is only whitespace-trimmed content', () => {
    const built = toUserMessage({ userId: 'u1', text: '  多行\n内容  ', contextToken: 'tok' })

    const text = (built.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('多行')
    expect(text).toContain('内容')
  })

  it('mints a distinct id per message', () => {
    const first = toUserMessage({ userId: 'u1', text: 'a', contextToken: 't' })
    const second = toUserMessage({ userId: 'u1', text: 'a', contextToken: 't' })
    expect(first.id).not.toBe(second.id)
  })
})

describe('deliverToAgent', () => {
  it('queues the message as a follow-up turn', () => {
    const followup = vi.fn()
    deliverToAgent({ followup } as never, { userId: 'u1', text: 'hi', contextToken: 't' })

    expect(followup).toHaveBeenCalledTimes(1)
    const sent = followup.mock.calls[0]?.[0] as { role: string; source: unknown; content: { text: string }[] }
    expect(sent.role).toBe('user')
    expect(sent.source).toEqual(WEIXIN_SOURCE)
    // The directive is prepended, so assert on the payload rather than exact text.
    expect(sent.content[0]?.text).toContain(REPLY_DIRECTIVE)
    expect(sent.content[0]?.text).toContain('hi')
  })
})
