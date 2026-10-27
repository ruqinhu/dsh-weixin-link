export interface IlinkClientOptions {
  baseUrl: string
  token: string
  /** Default per-request budget. Long-poll callers pass their own. */
  timeoutMs?: number
}

export interface PostOptions {
  /** Override the client's default budget for this one call. */
  timeoutMs?: number
}

export class IlinkTimeoutError extends Error {
  constructor(ms: number) {
    super(`iLink request timeout after ${ms}ms`)
    this.name = 'IlinkTimeoutError'
  }
}

export class IlinkHttpError extends Error {
  constructor(
    readonly status: number,
    endpoint: string,
  ) {
    super(`iLink HTTP ${status} for ${endpoint}`)
    this.name = 'IlinkHttpError'
  }
}

/**
 * `X-WECHAT-UIN` is a per-request anti-replay header: base64 of a random uint32
 * rendered as a decimal string. Regenerating it on every call is mandatory —
 * reusing one makes the server treat the request as a replay.
 */
export function makeUin(random: () => number = Math.random): string {
  const value = Math.floor(random() * 0x1_0000_0000) >>> 0
  return Buffer.from(String(value), 'utf8').toString('base64')
}

export class IlinkClient {
  private readonly baseUrl: string

  constructor(private readonly opts: IlinkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
  }

  async post<T>(endpoint: string, body: unknown, options: PostOptions = {}): Promise<T> {
    const budget = options.timeoutMs ?? this.opts.timeoutMs ?? 30_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)

    try {
      const response = await fetch(`${this.baseUrl}/ilink/bot/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AuthorizationType: 'ilink_bot_token',
          Authorization: `Bearer ${this.opts.token}`,
          'X-WECHAT-UIN': makeUin(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new IlinkHttpError(response.status, endpoint)
      return (await response.json()) as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new IlinkTimeoutError(budget)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
