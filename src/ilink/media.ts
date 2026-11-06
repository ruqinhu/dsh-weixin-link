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
  /** Original name, carried by `file_item`; the official adapter derives the MIME from it. */
  file_name?: string
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
  {
    kind: 'audio',
    mime: 'audio/silk',
    extension: 'silk',
    // pilk and the official decoder accept a leading 0x02 length byte before the magic,
    // which is what real WeChat voice carries.
    matches: (b) =>
      b.length > 9 &&
      (b.subarray(0, 9).toString('ascii') === '#!SILK_V3' || b.subarray(1, 10).toString('ascii') === '#!SILK_V3'),
  },
  {
    kind: 'audio',
    mime: 'audio/amr',
    extension: 'amr',
    matches: (b) => b.length > 5 && (b.subarray(0, 5).toString('ascii') === '#!AMR' || b.subarray(1, 6).toString('ascii') === '#!AMR'),
  },
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

/** Official iLink CDN base (`gateway/platforms/weixin.py: WEIXIN_CDN_BASE_URL`). */
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/**
 * Hosts the official adapter accepts for a `full_url` fetch.
 *
 * Copied from `_WEIXIN_CDN_ALLOWLIST`: a media URL arrives inside a message, so
 * fetching it unchecked is an SSRF primitive. The CDN-base path is preferred and needs
 * no allowlist because the host is ours; this covers the fallback only.
 */
const CDN_ALLOWLIST: ReadonlySet<string> = new Set([
  'novac2c.cdn.weixin.qq.com',
  'ilinkai.weixin.qq.com',
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'res.wx.qq.com',
  'mmbiz.qpic.cn',
  'mmbiz.qlogo.cn',
])

/**
 * Resolve the download URL the way the official adapter does.
 *
 * `encrypt_query_param` wins when present: the official client turns it into
 * `<cdn-base>/download?encrypted_query_param=…` and only falls back to `full_url` when
 * there is no parameter. Treating `full_url` as the primary source and appending the
 * parameter happened to return the same bytes here, but it depends on how a particular
 * deployment populates the field.
 */
export function resolveMediaUrl(params: {
  cdnBaseUrl?: string
  encryptQueryParam?: string
  fullUrl?: string
}): string {
  const base = (params.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL).replace(/\/+$/, '')
  if (params.encryptQueryParam !== undefined && params.encryptQueryParam !== '') {
    return `${base}/download?encrypted_query_param=${encodeURIComponent(params.encryptQueryParam)}`
  }
  const fullUrl = params.fullUrl
  if (fullUrl === undefined || fullUrl === '') {
    throw new Error('media item has neither encrypt_query_param nor full_url')
  }
  let parsed: URL
  try {
    parsed = new URL(fullUrl)
  } catch {
    throw new Error(`unparseable media URL: ${fullUrl.slice(0, 80)}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`media URL has disallowed scheme ${parsed.protocol}`)
  }
  if (!CDN_ALLOWLIST.has(parsed.hostname)) {
    throw new Error(`media URL host ${parsed.hostname} is not a WeChat CDN host`)
  }
  return fullUrl
}

/**
 * Join the CDN URL with its encrypted query parameter.
 *
 * Kept for the plain join it describes; the download path uses {@link resolveMediaUrl},
 * which is what the official adapter does.
 */
export function buildMediaUrl(fullUrl: string, queryParam?: string): string {
  if (queryParam === undefined || queryParam === '') return fullUrl
  if (queryParam.startsWith('?')) return `${fullUrl}${queryParam}`
  const separator = fullUrl.includes('?') ? '&' : '?'
  return `${fullUrl}${separator}${queryParam}`
}

/**
 * Key candidates, mirroring the official `_parse_aes_key`.
 *
 * Three encodings exist and the official code distinguishes them by decoded length: a
 * 16-byte base64 decode is the key itself; a 32-byte decode that is ASCII hex is a key
 * stored hex-encoded; and `image_item.aeskey` carries the key as a *raw hex string*
 * beside the media block. Treating that 32-byte hex-as-text case as an AES-256 key is
 * the mistake this comment exists to prevent.
 */
function keyCandidates(aesKeyB64: string | undefined, rawAeskeyHex: string | undefined): Buffer[] {
  const out: Buffer[] = []
  const push = (key: Buffer | undefined): void => {
    if (key === undefined || key.length === 0) return
    if (!out.some((existing) => existing.equals(key))) out.push(key)
  }
  const hex = (value: string): Buffer | undefined =>
    /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0 ? Buffer.from(value, 'hex') : undefined

  // The raw hex form the image envelope carries beside `media`.
  if (rawAeskeyHex !== undefined && rawAeskeyHex.trim() !== '') push(hex(rawAeskeyHex.trim()))

  if (aesKeyB64 !== undefined && aesKeyB64.trim() !== '') {
    const value = aesKeyB64.trim()
    push(hex(value))
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (decoded.length === 16) push(decoded)
    else if (decoded.length === 32) push(hex(decoded.toString('ascii')) ?? decoded)
  }
  return out.filter((key) => key.length === 16 || key.length === 24 || key.length === 32)
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
 * ECB is first because that is what the official adapter uses
 * (`_aes128_ecb_decrypt` in `gateway/platforms/weixin.py`) and what the first real
 * payload decoded with. The CBC variants stay as a fallback for deployments that
 * encrypt differently — guessing a single scheme is how a future channel silently
 * breaks.
 */
const DECRYPTION_MODES: readonly DecryptionMode[] = [
  {
    name: 'ecb',
    decrypt: (p, k) => {
      const decipher = createDecipheriv(`aes-${k.length * 8}-ecb`, k, null)
      return Buffer.concat([decipher.update(p), decipher.final()])
    },
  },
  { name: 'cbc-iv-from-key', decrypt: (p, k) => aesCbc(p, k, k.subarray(0, 16)) },
  { name: 'cbc-zero-iv', decrypt: (p, k) => aesCbc(p, k, Buffer.alloc(16)) },
  {
    name: 'cbc-iv-prepended',
    decrypt: (p, k) => {
      if (p.length <= 32) throw new Error('payload too short for a prepended IV')
      return aesCbc(p.subarray(16), k, p.subarray(0, 16))
    },
  },
]

/**
 * What the message itself says the payload is.
 *
 * The official adapter caches by declared kind (`.silk` for voice, the `file_name`
 * extension for a document) and never gates on magic bytes. That matters: a voice
 * payload that decrypted correctly was still rejected here on 2026-11-06 because the
 * opening bytes matched no signature — a successful decrypt reported as a failure.
 */
export interface DecodeHint {
  extension: string
  mime: string
  kind?: MediaKind
}

/**
 * Turn downloaded bytes into a usable attachment.
 *
 * Two expectations exist. `image` demands an image signature — a file saved as a JPEG
 * that is not a JPEG is worse than a reported failure. `any` accepts the first
 * decryption that succeeds, falling back to the caller's declared kind, which is what
 * the official adapter does and the only way a voice note survives an unrecognised
 * container.
 */
export function decodeMediaPayload(
  payload: Buffer,
  item: MediaPayload,
  expect: 'image' | 'any',
  hint?: DecodeHint,
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
        kind: hint?.kind ?? 'document',
        mime: hint?.mime ?? 'application/octet-stream',
        extension: hint?.extension ?? 'bin',
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
      if (signature !== undefined) {
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
      // A clean decryption of a container we cannot name. Trust the declared kind, as
      // the official adapter does; refusing here is how a real voice note gets lost.
      if (expect === 'any') {
        return {
          bytes: decrypted,
          kind: hint?.kind ?? 'document',
          mime: hint?.mime ?? 'application/octet-stream',
          extension: hint?.extension ?? 'bin',
          decrypted: true,
          mode: attempt.name,
        }
      }
    }
  }
  throw new Error('media payload did not decode with any key encoding')
}

export interface DownloadOptions {
  /** What the caller can use: `image` for a picture, `any` for files, voice and video. */
  kind?: 'image' | 'any'
  /** Declared kind of the payload, used when decryption succeeds without a signature. */
  hint?: DecodeHint
  /** Overrides the official CDN base; the encrypted query parameter is appended to it. */
  cdnBaseUrl?: string
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
  const url = resolveMediaUrl({
    ...(options.cdnBaseUrl === undefined ? {} : { cdnBaseUrl: options.cdnBaseUrl }),
    ...(item.media?.encrypt_query_param === undefined
      ? {}
      : { encryptQueryParam: item.media.encrypt_query_param }),
    ...(item.media?.full_url === undefined ? {} : { fullUrl: item.media.full_url }),
  })
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
    return decodeMediaPayload(bytes, item, options.kind ?? 'any', options.hint)
  } catch (error) {
    throw new ImageDecodeError((error as Error).message, bytes, contentType, response.status)
  }
}

/** Image-only wrapper, kept so the image call sites read as they did. */
export function downloadImage(item: MediaPayload, options: Omit<DownloadOptions, 'kind'> = {}): Promise<DecodedMedia> {
  return downloadMedia(item, { ...options, kind: 'image' })
}
