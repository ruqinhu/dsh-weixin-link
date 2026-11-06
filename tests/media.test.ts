import { describe, expect, it } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  decodeMediaPayload,
  downloadMedia,
  identifyMedia,
  MAX_MEDIA_BYTES,
  payloadPrefix,
  MediaDecodeError,
  resolveMediaUrl,
} from '../src/ilink/media.js'
import { silkToWavArgs } from '../src/ilink/voice.js'

/** Smallest valid-looking headers; enough for signature detection. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)])
const SILK = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.alloc(32, 3)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 9)])
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(24, 5)])
const AMR = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(16, 2)])

/** Encrypt the way the protocol does: AES-CBC, IV = first 16 bytes of the key. */
function encrypt(payload: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, key.subarray(0, 16))
  return Buffer.concat([cipher.update(payload), cipher.final()])
}

const item = (aesKey?: string) => ({ media: aesKey === undefined ? undefined : { aes_key: aesKey } })

describe('identifyMedia', () => {
  it('recognises images, audio and documents by their magic bytes', () => {
    expect(identifyMedia(PNG)).toMatchObject({ kind: 'image', extension: 'png' })
    expect(identifyMedia(JPEG)).toMatchObject({ kind: 'image', extension: 'jpg' })
    expect(identifyMedia(SILK)).toMatchObject({ kind: 'audio', extension: 'silk' })
    expect(identifyMedia(AMR)).toMatchObject({ kind: 'audio', extension: 'amr' })
    expect(identifyMedia(PDF)).toMatchObject({ kind: 'document', extension: 'pdf' })
    expect(identifyMedia(ZIP)).toMatchObject({ kind: 'document', extension: 'zip' })
  })

  it('refuses to guess', () => {
    expect(identifyMedia(Buffer.from('plain text, not a file'))).toBeUndefined()
    expect(identifyMedia(Buffer.alloc(0))).toBeUndefined()
  })
})

describe('decodeMediaPayload', () => {
  it('passes a clear-text file through, because a file need not be encrypted', () => {
    const decoded = decodeMediaPayload(PDF, item(), 'any')

    expect(decoded.kind).toBe('document')
    expect(decoded.extension).toBe('pdf')
    expect(decoded.bytes.equals(PDF)).toBe(true)
    expect(decoded.decrypted).toBe(false)
  })

  it('decrypts a voice payload and identifies it as audio', () => {
    const key = randomBytes(16)
    const decoded = decodeMediaPayload(encrypt(SILK, key), item(key.toString('base64')), 'any')

    expect(decoded.kind).toBe('audio')
    expect(decoded.extension).toBe('silk')
    expect(decoded.decrypted).toBe(true)
    expect(decoded.bytes.equals(SILK)).toBe(true)
  })

  it('decrypts with the scheme the official adapter uses (AES-128-ECB)', () => {
    const key = randomBytes(16)
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const payload = Buffer.concat([cipher.update(JPEG), cipher.final()])

    const decoded = decodeMediaPayload(payload, item(key.toString('base64')), 'any')

    expect(decoded.mode).toBe('ecb')
    expect(decoded.mime).toBe('image/jpeg')
    expect(decoded.bytes.equals(JPEG)).toBe(true)
  })

  it('accepts a key stored as base64 of 32 hex characters', () => {
    // The official `_parse_aes_key` decodes 32 bytes that spell hex into the 16-byte
    // key; treating those 32 bytes as an AES-256 key is the bug this pins down.
    const key = randomBytes(16)
    const asHexText = Buffer.from(key.toString('hex'), 'ascii').toString('base64')
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const payload = Buffer.concat([cipher.update(PNG), cipher.final()])

    const decoded = decodeMediaPayload(payload, item(asHexText), 'any')

    expect(decoded.mode).toBe('ecb')
    expect(decoded.mime).toBe('image/png')
  })

  it('keeps a cleanly decrypted container it cannot name, using the declared kind', () => {
    // 2026-11-06: a voice payload decrypted fine, but its opening bytes matched no
    // signature, so it was reported as a failure. The official adapter trusts the
    // declared kind instead of the magic bytes; refusing here loses real messages.
    const key = randomBytes(16)
    const unknown = randomBytes(64)
    const payload = encrypt(unknown, key)

    const decoded = decodeMediaPayload(payload, item(key.toString('base64')), 'any', {
      extension: 'silk',
      mime: 'audio/silk',
      kind: 'audio',
    })

    expect(decoded.decrypted).toBe(true)
    expect(decoded.extension).toBe('silk')
    expect(decoded.kind).toBe('audio')
    expect(decoded.bytes.equals(unknown)).toBe(true)
  })

  it('recognises SILK with the leading length byte real WeChat voice carries', () => {
    const wrapped = Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3'), Buffer.alloc(24, 1)])

    expect(identifyMedia(wrapped)).toMatchObject({ kind: 'audio', extension: 'silk' })
  })

  it('still demands an image signature when the caller expects one', () => {
    // A file saved as a JPEG that is not a JPEG is worse than a reported failure.
    expect(() => decodeMediaPayload(SILK, item(), 'image')).toThrow(/not an image/)
  })

  it('reports a wrong key instead of saving ciphertext', () => {
    const key = randomBytes(16)
    const wrong = randomBytes(16)

    expect(() => decodeMediaPayload(encrypt(SILK, key), item(wrong.toString('base64')), 'any')).toThrow(
      /did not decode/,
    )
  })

  it('keeps the raw bytes on a decode failure so the scheme can be learned once', async () => {
    const key = randomBytes(16)
    const wrong = randomBytes(16)
    const payload = encrypt(SILK, key)
    const fetchImpl = (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch

    try {
      await downloadMedia(
        { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/x', aes_key: wrong.toString('base64') } },
        { kind: 'any', fetchImpl },
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MediaDecodeError)
      const decodeError = error as MediaDecodeError
      expect(decodeError.payload.length).toBeGreaterThan(0)
      expect(payloadPrefix(decodeError.payload, 4)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})

describe('downloadMedia', () => {
  it('downloads, decodes and reports kind, extension and mode', async () => {
    const key = randomBytes(16)
    const payload = encrypt(SILK, key)
    const fetchImpl = (async () =>
      new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })) as unknown as typeof fetch

    const decoded = await downloadMedia(
      { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/v', encrypt_query_param: 'k=v', aes_key: key.toString('base64') } },
      { kind: 'any', fetchImpl },
    )

    expect(decoded.kind).toBe('audio')
    expect(decoded.extension).toBe('silk')
    expect(decoded.mode).toBe('cbc-iv-from-key')
  })

  it('reports an HTTP failure as a reason the caller can log', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch

    await expect(
      downloadMedia({ media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' } }, { kind: 'any', fetchImpl }),
    ).rejects.toThrow(/HTTP 403/)
  })

  it('refuses a payload that announces itself as too large', async () => {
    const fetchImpl = (async () =>
      new Response(Buffer.alloc(4), {
        status: 200,
        headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) },
      })) as unknown as typeof fetch

    await expect(
      downloadMedia({ media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/x' } }, { kind: 'any', fetchImpl }),
    ).rejects.toThrow(/too large/)
  })

  it('needs a URL at all', async () => {
    await expect(downloadMedia({}, { kind: 'any' })).rejects.toThrow(/neither encrypt_query_param nor full_url/)
  })
})

describe('resolveMediaUrl', () => {
  it('prefers the CDN base and the encrypted query parameter, as the official adapter does', () => {
    expect(
      resolveMediaUrl({ encryptQueryParam: 'abc=1/2', fullUrl: 'https://example.com/x' }),
    ).toBe('https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc%3D1%2F2')
  })

  it('falls back to full_url only for a WeChat CDN host', () => {
    expect(resolveMediaUrl({ fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/x' })).toBe(
      'https://novac2c.cdn.weixin.qq.com/c2c/x',
    )
    // A media URL arrives inside a message; fetching it unchecked is an SSRF primitive.
    expect(() => resolveMediaUrl({ fullUrl: 'https://evil.example/x' })).toThrow(/not a WeChat CDN host/)
    expect(() => resolveMediaUrl({ fullUrl: 'file:///etc/passwd' })).toThrow(/disallowed scheme/)
  })
})


describe('voice helpers', () => {
  it('builds the silk→wav step with the sample rate Hermes settled on', () => {
    expect(silkToWavArgs('/a.silk', '/a.wav')).toEqual({ silk: '/a.silk', wav: '/a.wav', rate: 24_000 })
  })
})
