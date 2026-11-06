import { createDecipheriv } from 'node:crypto'

/**
 * Media payload as iLink delivers it.
 *
 * The shape was captured from real messages on 2026-11-06, not guessed: the bytes sit
 * behind `media.full_url` + `media.encrypt_query_param`, encrypted with a key carried
 * twice (`media.aes_key` and a sibling `aeskey`). Images, files and voice all appear
 * to share this envelope, which is why one downloader serves all three.
 */
export interface MediaPayload {
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

/** Kept as an alias: the first payload modelled was an image. */
export type ImageItem = MediaPayload

export type MediaKind = 'image' | 'audio' | 'document'

export interface MediaSignature {
  kind: MediaKind
  mime: string
  extension: string
}

export interface DecodedMedia {
  bytes: Buffer
  kind: MediaKind
  mime: string
  extension: string
  /** True when the payload had to be decrypted before it could be identified. */
  decrypted: boolean
  /**
   * Which scheme produced the bytes, or `plain` when no decryption was needed.
   *
   * Recorded because the wire shape does not say: on 2026-11-06 three deployments
   * guessed one scheme and silently produced nothing. The winning name in the log is
   * what turns the next surprise from a guessing game into a read.
   */
  mode: string
}

/** Default download budget. A chat attachment is small; a stall means something is wrong. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 20_000

/** Refuse absurd payloads rather than filling the disk on a malformed message. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

interface Signature extends MediaSignature {
  matches: (bytes: Buffer) => boolean
}

const SIGNATURES: readonly Signature[] = [
  { kind: 'image', mime: 'image/jpeg', extension: 'jpg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    kind: 'image',
    mime: 'image/png',
    extension: 'png',
    matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { kind: 'image', mime: 'image/gif', extension: 'gif', matches: (b) => b.length > 6 && b.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null },
  {
    kind: 'image',
    mime: 'image/webp',
    extension: 'webp',
    matches: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { kind: 'image', mime: 'image/bmp', extension: 'bmp', matches: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  // Voice: WeChat sends SILK; other deployments may send AMR, WAV, MP3, OGG or M4A.
  { kind: 'audio', mime: 'audio/silk', extension: 'silk', matches: (b) => b.length > 9 && b.subarray(0, 9).toString('ascii') === '#!SILK_V3' },
  { kind: 'audio', mime: 'audio/amr', extension: 'amr', matches: (b) => b.length > 5 && b.subarray(0, 5).toString('ascii') === '#!AMR' },
  {
    kind: 'audio',
    mime: 'audio/wav',
    extension: 'wav',
    matches: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE',
  },
  {
    kind: 'audio',
    mime: 'audio/mpeg',
    extension: 'mp3',
    matches: (b) =>
      b.length > 3 &&
      (b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0)),
  },
  { kind: 'audio', mime: 'audio/ogg', extension: 'ogg', matches: (b) => b.length > 4 && b.subarray(0, 4).toString('ascii') === 'OggS' },
  { kind: 'audio', mime: 'audio/mp4', extension: 'm4a', matches: (b) => b.length > 12 && b.subarray(4, 8).toString('ascii') === 'ftyp' },
  // Documents: PDF, and the ZIP container that DOCX/XLSX/PPTX share.
  { kind: 'document', mime: 'application/pdf', extension: 'pdf', matches: (b) => b.length > 5 && b.subarray(0, 5).toString('ascii') === '%PDF-' },
  { kind: 'document', mime: 'application/zip', extension: 'zip', matches: (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
]

/** Identify a payload by its magic bytes, or `undefined` when nothing matches. */
export function identifyMedia(bytes: Buffer): MediaSignature | undefined {
  for (const signature of SIGNATURES) {
    if (!signature.matches(bytes)) continue
    return { kind: signature.kind, mime: signature.mime, extension: signature.extension }
  }
  return undefined
}

/** Image-only alias kept for the call sites that predate files and voice. */
export const identifyImage = identifyMedia

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
 * A payload that arrived intact but did not decode.
 *
 * Carries the raw bytes so the caller can keep them for diagnosis: "did not decode"
 * without the bytes is a dead end, and adding another round trip through the owner's
 * phone to find out what the bytes look like is a worse trade than one 0600 file that
 * gets deleted after the scheme is understood.
 */
export class ImageDecodeError extends Error {
  constructor(
    message: string,
    readonly payload: Buffer,
    readonly contentType: string | undefined,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ImageDecodeError'
  }
}

/** First bytes of a failed payload, as hex, for the log. */
export function payloadPrefix(payload: Buffer, length = 16): string {
  return payload.subarray(0, length).toString('hex')
}

function aesCbc(payload: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv)
  return Buffer.concat([decipher.update(payload), decipher.final()])
}

interface DecryptionMode {
  name: string
  decrypt: (payload: Buffer, key: Buffer) => Buffer
}

/**
 * The schemes worth trying, most likely first.
 *
 * WeCom-family CDNs document AES-CBC with the IV taken from the key, but the payload
 * that failed on 2026-11-06 decoded with none of the obvious variants — so the
 * remaining plausible shapes (zero IV, ECB, an IV prepended to the ciphertext) are
 * tried too, and the winning one is reported. Guessing a single scheme is how a future
 * deployment silently breaks.
 */
const DECRYPTION_MODES: readonly DecryptionMode[] = [
  { name: 'cbc-iv-from-key', decrypt: (p, k) => aesCbc(p, k, k.subarray(0, 16)) },
  { name: 'cbc-zero-iv', decrypt: (p, k) => aesCbc(p, k, Buffer.alloc(16)) },
  {
    name: 'cbc-iv-prepended',
    decrypt: (p, k) => {
      if (p.length <= 32) throw new Error('payload too short for a prepended IV')
      return aesCbc(p.subarray(16), k, p.subarray(0, 16))
    },
  },
  {
    name: 'ecb',
    decrypt: (p, k) => {
      const decipher = createDecipheriv(`aes-${k.length * 8}-ecb`, k, null)
      return Buffer.concat([decipher.update(p), decipher.final()])
    },
  },
]

/**
 * Turn downloaded bytes into a usable attachment.
 *
 * Two expectations exist. `image` demands an image signature — a file saved as a JPEG
 * that is not a JPEG is worse than a reported failure. `any` accepts a file or an
 * audio container too, and treats unidentified clear bytes as an opaque document,
 * because a log file or a DOCX without its zip header is still a file the owner meant
 * to send.
 */
export function decodeMediaPayload(
  payload: Buffer,
  item: MediaPayload,
  expect: 'image' | 'any',
): DecodedMedia {
  const plain = identifyMedia(payload)
  if (plain !== undefined && (expect === 'any' || plain.kind === 'image')) {
    return { bytes: payload, kind: plain.kind, mime: plain.mime, extension: plain.extension, decrypted: false, mode: 'plain' }
  }
  if (plain !== undefined) {
    // The bytes are readable but are not the kind the caller needs: an audio file
    // delivered where an image belongs. Naming that is more useful than "no key".
    throw new Error(`media payload is not an image (identified as ${plain.kind}/${plain.extension})`)
  }

  const keys = keyCandidates(item.media?.aes_key, item.aeskey)
  if (keys.length === 0) {
    if (expect === 'any') {
      // Unencrypted bytes of a type we cannot name: keep them rather than lose the file.
      return {
        bytes: payload,
        kind: 'document',
        mime: 'application/octet-stream',
        extension: 'bin',
        decrypted: false,
        mode: 'plain',
      }
    }
    throw new Error('media payload is encrypted but carries no usable aes key')
  }

  for (const key of keys) {
    for (const attempt of DECRYPTION_MODES) {
      let decrypted: Buffer
      try {
        decrypted = attempt.decrypt(payload, key)
      } catch {
        // Padding failure or bad block length: try the next scheme.
        continue
      }
      const signature = identifyMedia(decrypted)
      if (signature === undefined) continue
      if (expect === 'image' && signature.kind !== 'image') continue
      return {
        bytes: decrypted,
        kind: signature.kind,
        mime: signature.mime,
        extension: signature.extension,
        decrypted: true,
        mode: attempt.name,
      }
    }
  }
  throw new Error('media payload did not decode with any key encoding')
}

export interface DownloadOptions {
  /** What the caller can use: `image` for a picture, `any` for files and voice. */
  kind?: 'image' | 'any'
  timeoutMs?: number
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch and decode one inbound attachment.
 *
 * Everything that can go wrong here is reported as a thrown error with a short reason,
 * because the caller's contract is "attach the media or say why not" — never "drop the
 * message".
 */
export async function downloadMedia(item: MediaPayload, options: DownloadOptions = {}): Promise<DecodedMedia> {
  const fullUrl = item.media?.full_url
  if (fullUrl === undefined || fullUrl === '') throw new Error('media item has no full_url')

  const url = buildMediaUrl(fullUrl, item.media?.encrypt_query_param)
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`)

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
    throw new Error(`media too large: ${declared} bytes`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('media download returned no bytes')
  if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`media too large: ${bytes.length} bytes`)

  const contentType = response.headers.get('content-type') ?? undefined
  try {
    return decodeMediaPayload(bytes, item, options.kind ?? 'any')
  } catch (error) {
    throw new ImageDecodeError((error as Error).message, bytes, contentType, response.status)
  }
}

/** Image-only wrapper, kept so the image call sites read as they did. */
export function downloadImage(item: MediaPayload, options: Omit<DownloadOptions, 'kind'> = {}): Promise<DecodedMedia> {
  return downloadMedia(item, { ...options, kind: 'image' })
}
