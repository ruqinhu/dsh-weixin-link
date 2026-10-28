/**
 * What "healthy" means for this channel.
 *
 * `loggedIn` originally meant "a bot token is configured". That reported `true`
 * while every send was failing: on 2026-10-28 the cached context token was 12
 * hours old and `sendmessage` kept answering `ret:-2 prepare failed`, yet status
 * showed `loggedIn: true`, an empty outbox, and no error — a health field that
 * cannot go false, which is worse than having no field at all.
 *
 * A send needs two things: a bot token, and a context token obtained from an
 * inbound message. Missing either means nothing can be delivered, so health must
 * report both. Stuck outbox entries count too: a full outbox means earlier
 * messages were parked, so even a successful new send does not mean the channel
 * is caught up.
 */
export interface ChannelHealth {
  /** Whether a bot token is configured. Necessary, not sufficient. */
  hasCredential: boolean
  /** Context token for the recipient, if one was ever received. */
  contextToken?: string
  /** Outbox entries that could not be replayed. */
  stuck: number
}

export function isDeliverable(health: ChannelHealth): boolean {
  return health.hasCredential && health.contextToken !== undefined && health.stuck === 0
}

/**
 * Why the channel is not deliverable, for logs and status output. Returns
 * `undefined` when it is.
 */
export function undeliverableReason(health: ChannelHealth): string | undefined {
  if (!health.hasCredential) return 'no bot token configured'
  if (health.contextToken === undefined) {
    return 'no context token cached — the owner must message the bot once'
  }
  if (health.stuck > 0) {
    return `${health.stuck} message(s) stuck in the outbox`
  }
  return undefined
}
