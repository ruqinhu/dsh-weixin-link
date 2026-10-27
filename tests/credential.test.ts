import { describe, expect, it, vi } from 'vitest'
import { resolveCredential } from '../src/store/credential.js'

function ctxWith(resolve: (ref: string) => Promise<{ value: string; source: string } | undefined>) {
  return { credentials: { resolve } } as never
}

const options = {
  tokenEnv: 'WEIXIN_BOT_TOKEN',
  accountIdEnv: 'WEIXIN_BOT_ACCOUNT_ID',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

describe('resolveCredential', () => {
  it('returns the token and account when both resolve', async () => {
    const ctx = ctxWith(async (ref) =>
      ref === 'WEIXIN_BOT_TOKEN'
        ? { value: 'tok', source: 'env' }
        : { value: 'acct', source: 'env' },
    )

    await expect(resolveCredential(ctx, options)).resolves.toEqual({
      token: 'tok',
      accountId: 'acct',
      baseUrl: options.baseUrl,
    })
  })

  it('returns undefined instead of throwing when the token is missing', async () => {
    // A missing channel credential is a configuration state. Throwing here aborts
    // the whole profile load, so one unconfigured optional channel would make the
    // agent, scheduler, and UI unavailable too.
    const ctx = ctxWith(async () => undefined)
    await expect(resolveCredential(ctx, options)).resolves.toBeUndefined()
  })

  it('returns undefined when the token resolves to an empty string', async () => {
    const ctx = ctxWith(async () => ({ value: '', source: 'env' }))
    await expect(resolveCredential(ctx, options)).resolves.toBeUndefined()
  })

  it('returns undefined when the account id is missing', async () => {
    const ctx = ctxWith(async (ref) =>
      ref === 'WEIXIN_BOT_TOKEN' ? { value: 'tok', source: 'env' } : undefined,
    )
    await expect(resolveCredential(ctx, options)).resolves.toBeUndefined()
  })

  it('returns undefined when no credential service is mounted', async () => {
    await expect(resolveCredential({} as never, options)).resolves.toBeUndefined()
  })

  it('queries the credential store rather than process.env', async () => {
    const resolve = vi.fn(async () => ({ value: 'tok', source: 'managed' }))
    vi.stubEnv('WEIXIN_BOT_TOKEN', 'from-env')
    try {
      const result = await resolveCredential(ctxWith(resolve), options)
      expect(result?.token).toBe('tok')
      expect(resolve).toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
