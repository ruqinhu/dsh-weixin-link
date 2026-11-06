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
      rawText: 'hello',
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

  it('turns a media-only message into a placeholder instead of dropping it', () => {
    // 2026-11-04: the owner sent an image twice and the bot never saw anything —
    // no inbound, no token refresh, no log line. Silence is the failure; a
    // placeholder that says what arrived and what the channel cannot read is the
    // minimum honest behaviour until images are implemented.
    const inbound = toInboundText(message({ item_list: [{ type: 2, image_item: { url: 'x' } }] }), {
      echoOwnMessages: false,
    })

    expect(inbound?.text).toContain('图片')
    expect(inbound?.text).toContain('未读取')
    expect(inbound?.media).toMatchObject([{ type: 2, keys: ['image_item'] }])
  })

  it('records the nested field skeleton without any value', () => {
    // The first capture only logged the item's top-level keys, which yielded the name
    // `image_item` and nothing inside it — no way to build a downloader from that.
    const inbound = toInboundText(
      message({
        item_list: [
          {
            type: 2,
            image_item: { url: 'https://secret/cdn', aes_key: 'k3y', size: { w: 10, h: 20 } },
          },
        ],
      }),
      { echoOwnMessages: false },
    )

    const shape = JSON.stringify(inbound?.media?.[0]?.shape)
    expect(shape).toContain('image_item')
    expect(shape).toContain('aes_key')
    expect(shape).toContain('size')
    expect(shape).not.toContain('secret')
    expect(shape).not.toContain('k3y')
  })

  it('routes item types the way the official adapter numbers them', () => {
    // Official: ITEM_TEXT, ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO = 1,2,3,4,5.
    // Guessing the other order is how a voice note gets treated as a document.
    const voice = toInboundText(message({ item_list: [{ type: 3, voice_item: { media: { full_url: 'u' } } }] }), {
      echoOwnMessages: false,
    })
    const file = toInboundText(message({ item_list: [{ type: 4, file_item: { media: { full_url: 'u' } } }] }), {
      echoOwnMessages: false,
    })

    expect(voice?.voices).toHaveLength(1)
    expect(voice?.files).toBeUndefined()
    expect(file?.files).toHaveLength(1)
    expect(file?.voices).toBeUndefined()
  })

  it('mentions media that arrived beside text without replacing the text', () => {
    const inbound = toInboundText(
      message({
        item_list: [
          { type: 1, text_item: { text: '看看这张图' } },
          { type: 2, image_item: { url: 'x' } },
        ],
      }),
      { echoOwnMessages: false },
    )

    expect(inbound?.text.startsWith('看看这张图')).toBe(true)
    expect(inbound?.text).toContain('图片')
  })

  it('counts several media items without leaking their contents', () => {
    const inbound = toInboundText(
      message({
        item_list: [
          { type: 2, image_item: { url: 'https://secret/cdn?key=1' } },
          { type: 2, image_item: { url: 'https://secret/cdn?key=2' } },
          { type: 4, file_item: { url: 'https://secret/f' } },
        ],
      }),
      { echoOwnMessages: false },
    )

    expect(inbound?.text).toContain('2 张图片')
    expect(inbound?.text).toContain('1 个文件')
    expect(inbound?.text).not.toContain('secret')
    expect(inbound?.media?.map((item) => item.keys)).toEqual([
      ['image_item'],
      ['image_item'],
      ['file_item'],
    ])
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
      message({ from_user_id: 'b', item_list: [{ type: 2, image_item: { url: 'x' } }] }),
      message({ from_user_id: 'c', item_list: [{ type: 1, text_item: { text: '3' } }] }),
    ]

    // The image is kept as a placeholder: it is the owner speaking, even though
    // this channel cannot read what is inside.
    expect(collectInbound(batch, { echoOwnMessages: false }).map((c) => c.userId)).toEqual([
      'a',
      'b',
      'c',
    ])
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
