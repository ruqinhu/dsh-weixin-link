import { createDecipheriv } from 'node:crypto'

/**
 * An inbound image as iLink delivers it.
 *
 * The shape was captured from a real message on 2026-11-06, not guessed: the bytes
 * live behind `media.full_url` + `media.encrypt_query_param`, and they are encrypted
 * with a key carried twice (`media.aes_key` and `image_item.aeskey`). Guessing this
 * shape would have produced another silent failure.
 */
export interface ImageItem {
  /** Base64 AES key, duplicated from `media.aes_key` on the messages seen so far. */
  aeskey?: string
  media?: {
    full_url?: string
    aes_key?: string
    encrypt_query_param?: string
  }
  mid_size?: number
  thumb_size?: number
  thumb_width?: number
  thumb_height?: number
  hd_size?: number
}

export interface DecodedImage {
  bytes: Buffer
  mime: string
  extension: string
  /** True when the payload had to be decrypted before it looked like an image. */
  decrypted: boolean
}

/** Default download budget. A chat image is small; a stall means something is wrong. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 20_000

/** Refuse absurd payloads rather than filling the disk on a malformed message. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface Signature {
  mime: string
  extension: string
  matches: (bytes: Buffer) => boolean
}

const SIGNATURES: readonly Signature[] = [
  { mime: 'image/jpeg', extension: 'jpg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', extension: 'png', matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/gif', extension: 'gif', matches: (b) => b.length > 6 && b.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null },
  { mime: 'image/webp', extension: 'webp', matches: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/bmp', extension: 'bmp', matches: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
]

/** Identify an image by its magic bytes, or `undefined` when it is not one. */
export function identifyImage(bytes: Buffer): Signature | undefined {
  return SIGNATURES.find((signature) => signature.matches(bytes))
}

/**
 * Join the CDN URL with its encrypted query parameter.
 *
 * The parameter arrives without a leading `?` on the messages observed, but the
 * separators differ between deployments, so every shape is handled rather than
 * assuming one and producing a 404 that looks like a decryption failure.
 */
export function buildMediaUrl(fullUrl: string, queryParam?: string): string {
  if (queryParam === undefined || queryParam === '') return fullUrl
  if (queryParam.startsWith('?')) return `${fullUrl}${queryParam}`
  const separator = fullUrl.includes('?') ? '&' : '?'
  return `${fullUrl}${separator}${queryParam}`
}

/** Every key encoding the protocol might use, most likely first. */
function keyCandidates(aesKeyB64: string | undefined, aesKeyAlt: string | undefined): Buffer[] {
  const out: Buffer[] = []
  const seen = new Set<string>()
  for (const raw of [aesKeyB64, aesKeyAlt]) {
    if (raw === undefined || raw === '') continue
    const value = raw.trim()
    const push = (buffer: Buffer) => {
      const key = buffer.toString('hex')
      if ((buffer.length === 16 || buffer.length === 24 || buffer.length === 32) && !seen.has(key)) {
        seen.add(key)
        out.push(buffer)
      }
    }
    // Base64 (standard and URL-safe) first: that is what the captured message carries.
    push(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
    if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) push(Buffer.from(value, 'hex'))
  }
  return out
}

/**
 * Decrypt one AES-CBC payload.
 *
 * WeChat-family CDNs derive the IV from the key itself (first 16 bytes), which is
 * why no IV field exists in the wire shape. Padding failures surface as a thrown
 * error and are treated as "wrong key", not as a fatal condition.
 */
function aesCbcDecrypt(payload: Buffer, key: Buffer): Buffer {
  const iv = key.subarray(0, 16)
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv)
  return Buffer.concat([decipher.update(payload), decipher.final()])
}

/**
 * Turn downloaded bytes into a usable image.
 *
 * Two cases exist in the wild and both are handled by evidence rather than by a
 * flag: some deployments serve the image in the clear, others encrypt it. The
 * signature check runs *after* decryption too, so a wrong key is reported as a
 * wrong key instead of being written to disk as a corrupt JPEG.
 */
export function decodeImagePayload(payload: Buffer, item: ImageItem): DecodedImage {
  const plain = identifyImage(payload)
  if (plain !== undefined) {
    return { bytes: payload, mime: plain.mime, extension: plain.extension, decrypted: false }
  }

  const keys = keyCandidates(item.media?.aes_key, item.aeskey)
  if (keys.length === 0) {
    throw new Error('image payload is encrypted but carries no usable aes key')
  }

  for (const key of keys) {
    try {
      const decrypted = aesCbcDecrypt(payload, key)
      const signature = identifyImage(decrypted)
      if (signature !== undefined) {
        return {
          bytes: decrypted,
          mime: signature.mime,
          extension: signature.extension,
          decrypted: true,
        }
      }
    } catch {
      // Padding failure: try the next key encoding.
    }
  }
  throw new Error('image payload did not decode with any key encoding')
}

export interface DownloadOptions {
  timeoutMs?: number
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch and decode one inbound image.
 *
 * Everything that can go wrong here is reported as a thrown error with a short
 * reason, because the caller's contract is "attach the image or say why not" — never
 * "drop the message".
 */
export async function downloadImage(
  item: ImageItem,
  options: DownloadOptions = {},
): Promise<DecodedImage> {
  const fullUrl = item.media?.full_url
  if (fullUrl === undefined || fullUrl === '') throw new Error('image item has no full_url')

  const url = buildMediaUrl(fullUrl, item.media?.encrypt_query_param)
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`)

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${declared} bytes`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('image download returned no bytes')
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.length} bytes`)

  return decodeImagePayload(bytes, item)
}
