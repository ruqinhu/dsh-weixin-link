import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export interface ResolvedCredential {
  token: string
  accountId: string
  baseUrl: string
}

export interface CredentialOptions {
  tokenEnv: string
  accountIdEnv: string
  baseUrl: string
}

/**
 * Resolve the bot token through the harness credential seam.
 *
 * `ctx.credentials.resolve(ref)` already layers the managed
 * `$DSH_HOME/.credentials.yaml` over inherited environment and `.env` fallbacks,
 * so this function must NOT re-implement that order — reading `process.env`
 * here would silently shadow the managed store.
 *
 * Returns `undefined` rather than throwing when the token is absent. A missing
 * channel credential is a *configuration state*, not a harness failure: throwing
 * here aborts the whole profile load, so one unconfigured optional channel would
 * make every other plugin — the agent, the scheduler, the UI — unavailable. The
 * caller logs the reason and keeps the plugin registered but idle.
 *
 * `credentialRef()` brands and validates the name, so a typo in configuration
 * still fails loudly instead of silently resolving to nothing.
 */
export async function resolveCredential(
  ctx: Context,
  options: CredentialOptions,
): Promise<ResolvedCredential | undefined> {
  const credentials = ctx.credentials
  if (credentials === undefined) return undefined

  const tokenRef = credentialRef(options.tokenEnv)
  const accountRef = credentialRef(options.accountIdEnv)

  const token = await credentials.resolve(tokenRef)
  const accountId = await credentials.resolve(accountRef)

  if (token === undefined || token.value === '') return undefined
  if (accountId === undefined || accountId.value === '') return undefined

  return { token: token.value, accountId: accountId.value, baseUrl: options.baseUrl }
}
