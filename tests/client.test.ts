import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  IlinkClient,
  IlinkHttpError,
  IlinkTimeoutError,
  makeUin,
} from '../src/ilink/client.js'
import { sendText } from '../src/ilink/send.js'
import { IlinkError } from '../src/ilink/errors.js'
import { DEFAULT_POLL_TIMEOUT_MS, SERVER_HOLD_MS, pollUpdates } from '../src/ilink/updates.js'

const BASE = 'https://ilinkai.weixin.qq.com'

describe('long-poll budget', () => {
  it('lets the client outwait the server hold, or every quiet poll aborts', () => {
    expect(SERVER_HOLD_MS).toBe(35_000)
    expect(DEFAULT_POLL_TIMEOUT_MS).toBeGreaterThan(SERVER_HOLD_MS)
  })
})


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('makeUin', () => {
  it('returns base64 of a decimal uint32', () => {
    const encoded = makeUin(() => 0.5)
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toMatch(/^\d+$/)
  })

  it('stays within uint32 for the top of the range', () => {
    const encoded = makeUin(() => 0.9999999)
    const value = Number(Buffer.from(encoded, 'base64').toString('utf8'))
    expect(value).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('IlinkClient', () => {
  it('sends the required iLink headers', async () => {
    let seen: Headers | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers)
      return jsonResponse({ ret: 0 })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 'ilinkbot_test' })
    await client.post('sendmessage', { msg: {} })

    expect(seen?.get('authorization')).toBe('Bearer ilinkbot_test')
    expect(seen?.get('authorizationtype')).toBe('ilink_bot_token')
    expect(seen?.get('content-type')).toBe('application/json')
    expect(seen?.get('x-wechat-uin')).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('identifies as the iLink bot app, or the server accepts without delivering', async () => {
    // Observed live: without these two headers the server answers
    // {"message_id": …} — a success — and the message never reaches the owner.
    // Same body, same token; only the headers differed.
    let seen: Headers | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen = new Headers(init.headers)
      return jsonResponse({ ret: 0 })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 't' })
    await client.post('sendmessage', { msg: {} })

    expect(seen?.get('ilink-app-id')).toBe(ILINK_APP_ID)
    expect(seen?.get('ilink-app-clientversion')).toBe(String(ILINK_APP_CLIENT_VERSION))
    // 2.2.0 encoded as major<<16 | minor<<8 | patch
    expect(ILINK_APP_CLIENT_VERSION).toBe((2 << 16) | (2 << 8))
  })

  it('generates a different X-WECHAT-UIN per request', async () => {
    const uins: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      uins.push(new Headers(init.headers).get('x-wechat-uin') ?? '')
      return jsonResponse({ ret: 0 })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 't' })
    await client.post('sendmessage', { msg: {} })
    await client.post('sendmessage', { msg: {} })

    expect(uins[0]).not.toBe(uins[1])
  })

  it('strips trailing slashes from the base url', async () => {
    let url = ''
    vi.stubGlobal('fetch', async (target: string) => {
      url = target
      return jsonResponse({ ret: 0 })
    })

    const client = new IlinkClient({ baseUrl: `${BASE}///`, token: 't' })
    await client.post('getupdates', {})

    expect(url).toBe(`${BASE}/ilink/bot/getupdates`)
  })

  it('throws a timeout error when the request exceeds the budget', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 't', timeoutMs: 30 })
    await expect(client.post('sendmessage', { msg: {} })).rejects.toBeInstanceOf(IlinkTimeoutError)
  })

  it('surfaces a non-2xx status as IlinkHttpError', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({}, 502))
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })
    await expect(client.post('sendmessage', {})).rejects.toBeInstanceOf(IlinkHttpError)
  })
})

describe('sendText', () => {
  it('builds a bot text message with the required shape', async () => {
    let body: any
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      // A real accepted send: no `ret`, just `message_id`.
      return jsonResponse({ message_id: 7520807369715385000 })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 't' })
    const result = await sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'hello' })

    expect(result.msgid).toBe('7520807369715385000')
    expect(body.msg.to_user_id).toBe('u1')
    expect(body.msg.message_type).toBe(2)
    expect(body.msg.message_state).toBe(2)
    expect(body.msg.context_token).toBe('tok')
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hello' } }])
  })

  it('carries from_user_id and a fresh client_id, like the reference client', async () => {
    // Live comparison against the reference implementation: the body that reached
    // the phone included `from_user_id: ""` and a unique `client_id`; the body
    // without them was accepted and never delivered.
    const seen: any[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)))
      return jsonResponse({ message_id: 1 })
    })

    const client = new IlinkClient({ baseUrl: BASE, token: 't' })
    await sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'a' })
    await sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'b' })

    expect(seen[0].msg.from_user_id).toBe('')
    expect(typeof seen[0].msg.client_id).toBe('string')
    expect(seen[0].msg.client_id.length).toBeGreaterThan(0)
    // Must differ per message: a reused id can be suppressed as a duplicate.
    expect(seen[0].msg.client_id).not.toBe(seen[1].msg.client_id)
  })

  it('accepts a send whose response omits ret entirely', async () => {
    // The regression this guards: success responses carry no `ret` field, so any
    // check of the form `ret === 0` silently reclassifies every delivered message
    // as a failure and retries it.
    vi.stubGlobal('fetch', async () => jsonResponse({ message_id: 42 }))
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    const result = await sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'hi' })

    expect(result.msgid).toBe('42')
  })

  it('rejects a response with neither message_id nor ret', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({}))
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    await expect(
      sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'hi' }),
    ).rejects.toBeInstanceOf(IlinkError)
  })

  it('throws a classified error on a non-zero ret', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ ret: 1003, errmsg: 'context token invalid' }),
    )
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    await expect(
      sendText(client, { toUserId: 'u1', contextToken: 'tok', text: 'hi' }),
    ).rejects.toMatchObject({ code: 'NEEDS_INBOUND' })
  })
})

describe('pollUpdates', () => {
  it('treats an idle answer with no ret as success and advances the cursor', async () => {
    // Verbatim idle shape from the live endpoint: `{"msgs":[],"sync_buf":"..."}`
    // with no `ret`. Any `ret === 0` check turned this into a permanent failure,
    // and reading the wrong cursor key meant the poll never advanced — so the
    // same inbound message would be replayed forever.
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ msgs: [], sync_buf: 'cursor-2', longpolling_timeout_ms: 35000 }),
    )
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    const result = await pollUpdates(client, { getUpdatesBuf: 'cursor-1' })

    expect(result.messages).toEqual([])
    expect(result.idle).toBe(true)
    expect(result.nextBuf).toBe('cursor-2')
  })

  it('returns inbound messages and the new cursor', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({
        msgs: [{ message_id: 'm1', from_user_name: 'u1', context_token: 'ctx', item_list: [] }],
        sync_buf: 'cursor-3',
      }),
    )
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    const result = await pollUpdates(client, { getUpdatesBuf: 'cursor-2' })

    expect(result.messages).toHaveLength(1)
    expect(result.idle).toBe(false)
    expect(result.nextBuf).toBe('cursor-3')
  })

  it('throws on a real getupdates failure', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse({ ret: 1003, errmsg: 'invalid token' }))
    const client = new IlinkClient({ baseUrl: BASE, token: 't' })

    await expect(pollUpdates(client, { getUpdatesBuf: '' })).rejects.toMatchObject({
      code: 'NEEDS_INBOUND',
    })
  })
})
