import { describe, expect, it } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  buildMediaUrl,
  decodeImagePayload,
  downloadImage,
  identifyImage,
  MAX_IMAGE_BYTES,
} from '../src/ilink/media.js'

/** Smallest valid-looking PNG header; enough for signature detection. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
])

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)])

/** Encrypt the way the protocol does: AES-CBC, IV = first 16 bytes of the key. */
function encrypt(payload: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, key.subarray(0, 16))
  return Buffer.concat([cipher.update(payload), cipher.final()])
}

function item(extra: Record<string, unknown> = {}) {
  return {
    aeskey: undefined as string | undefined,
    media: undefined as { full_url?: string; aes_key?: string; encrypt_query_param?: string } | undefined,
    ...extra,
  }
}

describe('identifyImage', () => {
  it('recognises the formats iLink delivers', () => {
    expect(identifyImage(PNG)?.extension).toBe('png')
    expect(identifyImage(JPEG)?.extension).toBe('jpg')
  })

  it('rejects anything else', () => {
    expect(identifyImage(Buffer.from('not an image'))).toBeUndefined()
    expect(identifyImage(Buffer.alloc(0))).toBeUndefined()
  })
})

describe('buildMediaUrl', () => {
  it('appends the encrypted query parameter with the right separator', () => {
    expect(buildMediaUrl('https://cdn/x', 'a=1')).toBe('https://cdn/x?a=1')
    expect(buildMediaUrl('https://cdn/x?z=0', 'a=1')).toBe('https://cdn/x?z=0&a=1')
    expect(buildMediaUrl('https://cdn/x', '?a=1')).toBe('https://cdn/x?a=1')
    expect(buildMediaUrl('https://cdn/x', '')).toBe('https://cdn/x')
  })
})

describe('decodeImagePayload', () => {
  it('passes a clear-text image straight through', () => {
    const decoded = decodeImagePayload(PNG, item())

    expect(decoded.mime).toBe('image/png')
    expect(decoded.decrypted).toBe(false)
    expect(decoded.mode).toBe('plain')
    expect(decoded.bytes.equals(PNG)).toBe(true)
  })

  it('decrypts with the base64 key carried beside the URL', () => {
    const key = randomBytes(16)
    const payload = encrypt(JPEG, key)

    const decoded = decodeImagePayload(payload, item({ media: { aes_key: key.toString('base64') } }))

    expect(decoded.decrypted).toBe(true)
    expect(decoded.mime).toBe('image/jpeg')
    // The winning scheme is recorded because the wire shape does not say which one it
    // is; three deploys guessed and produced nothing before this was logged.
    expect(decoded.mode).toBe('cbc-iv-from-key')
    expect(decoded.bytes.equals(JPEG)).toBe(true)
  })

  it('falls back to the duplicated aeskey field', () => {
    // The captured message carries the key twice; either may be the populated one.
    const key = randomBytes(32)
    const decoded = decodeImagePayload(encrypt(PNG, key), item({ aeskey: key.toString('base64') }))

    expect(decoded.mime).toBe('image/png')
    expect(decoded.decrypted).toBe(true)
  })

  it('accepts a hex-encoded key', () => {
    const key = randomBytes(16)
    const decoded = decodeImagePayload(encrypt(JPEG, key), item({ aeskey: key.toString('hex') }))

    expect(decoded.mime).toBe('image/jpeg')
  })

  it('refuses an encrypted payload with no key instead of writing garbage', () => {
    expect(() => decodeImagePayload(Buffer.from('ciphertext'), item())).toThrow(/no usable aes key/)
  })

  it('reports a wrong key rather than pretending to decode', () => {
    const key = randomBytes(16)
    const wrong = randomBytes(16)
    const payload = encrypt(JPEG, key)

    expect(() => decodeImagePayload(payload, item({ media: { aes_key: wrong.toString('base64') } }))).toThrow(
      /did not decode/,
    )
  })
})

describe('downloadImage', () => {
  it('fetches, decodes and reports the extension', async () => {
    const key = randomBytes(16)
    const payload = encrypt(PNG, key)
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
    }) as unknown as typeof fetch

    const decoded = await downloadImage(
      item({
        media: { full_url: 'https://cdn/img', encrypt_query_param: 'k=v', aes_key: key.toString('base64') },
      }),
      { fetchImpl },
    )

    expect(calls).toEqual(['https://cdn/img?k=v'])
    expect(decoded.extension).toBe('png')
  })

  it('reports an HTTP failure as a reason the caller can log', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch

    await expect(downloadImage(item({ media: { full_url: 'https://cdn/x' } }), { fetchImpl })).rejects.toThrow(
      /HTTP 403/,
    )
  })

  it('refuses a payload that announces itself as too large', async () => {
    const fetchImpl = (async () =>
      new Response(Buffer.alloc(4), {
        status: 200,
        headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) },
      })) as unknown as typeof fetch

    await expect(downloadImage(item({ media: { full_url: 'https://cdn/x' } }), { fetchImpl })).rejects.toThrow(
      /too large/,
    )
  })

  it('needs a URL at all', async () => {
    await expect(downloadImage(item())).rejects.toThrow(/no full_url/)
  })
})
