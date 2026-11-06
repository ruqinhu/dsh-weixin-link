import { describe, expect, it } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  buildMediaUrl,
  decodeMediaPayload,
  downloadMedia,
  identifyMedia,
  MAX_MEDIA_BYTES,
  payloadPrefix,
  ImageDecodeError,
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
        { media: { full_url: 'https://cdn/x', aes_key: wrong.toString('base64') } },
        { kind: 'any', fetchImpl },
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ImageDecodeError)
      const decodeError = error as ImageDecodeError
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
      { media: { full_url: 'https://cdn/v', encrypt_query_param: 'k=v', aes_key: key.toString('base64') } },
      { kind: 'any', fetchImpl },
    )

    expect(decoded.kind).toBe('audio')
    expect(decoded.extension).toBe('silk')
    expect(decoded.mode).toBe('cbc-iv-from-key')
  })

  it('reports an HTTP failure as a reason the caller can log', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch

    await expect(
      downloadMedia({ media: { full_url: 'https://cdn/x' } }, { kind: 'any', fetchImpl }),
    ).rejects.toThrow(/HTTP 403/)
  })

  it('refuses a payload that announces itself as too large', async () => {
    const fetchImpl = (async () =>
      new Response(Buffer.alloc(4), {
        status: 200,
        headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) },
      })) as unknown as typeof fetch

    await expect(
      downloadMedia({ media: { full_url: 'https://cdn/x' } }, { kind: 'any', fetchImpl }),
    ).rejects.toThrow(/too large/)
  })

  it('needs a URL at all', async () => {
    await expect(downloadMedia({}, { kind: 'any' })).rejects.toThrow(/no full_url/)
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

describe('voice helpers', () => {
  it('builds the silk→wav step with the sample rate Hermes settled on', () => {
    expect(silkToWavArgs('/a.silk', '/a.wav')).toEqual({ silk: '/a.silk', wav: '/a.wav', rate: 24_000 })
  })
})
