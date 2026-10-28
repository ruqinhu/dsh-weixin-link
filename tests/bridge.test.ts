import { describe, expect, it, vi } from 'vitest'
import {
  collectInbound,
  deliverToAgent,
  toInboundText,
  toUserMessage,
  WEIXIN_SOURCE,
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
    expect(built.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(typeof built.id).toBe('string')
    expect(Object.isFrozen(built)).toBe(true)
  })

  it('carries the owner text verbatim, with no reply instruction', () => {
    // Delivery moved to the plugin (it observes turn/end and sends the agent's last
    // text). A prepended instruction would make the model call weixin_push too, so
    // the owner would get the answer twice — or, worse, only the meta line
    // "已通过微信回复你了" instead of the content.
    const built = toUserMessage({ userId: 'u1', text: '你好', contextToken: 'tok' })

    const text = (built.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('你好')
    expect(text).not.toContain('weixin_push')
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
    expect(sent.content[0]?.text).toBe('hi')
  })
})
