import Schema from '@deepseek-ai/schemastery'

export interface Config {
  tokenEnv: string
  accountIdEnv: string
  baseUrl: string
  dataDir: string
  poll: boolean
  pollTimeoutMs: number
  /** Optional explicit recipient. Falls back to the most recent inbound sender. */
  defaultUserId: string
  /** Inbound bot messages are ignored so the bot never answers itself. */
  echoOwnMessages: boolean
}

export const Config: Schema<Config> = Schema.object({
  tokenEnv: Schema.string()
    .default('WEIXIN_ILINK_TOKEN')
    .description('Credential reference holding the iLink bot token.'),
  accountIdEnv: Schema.string()
    .default('WEIXIN_ACCOUNT_ID')
    .description('Credential reference holding the bot account id.'),
  baseUrl: Schema.string()
    .default('https://ilinkai.weixin.qq.com')
    .description('iLink business API base URL.'),
  dataDir: Schema.string()
    .default('~/.dsh/weixin-link')
    .description('Where context tokens, outbox, and receipts live.'),
  poll: Schema.boolean().default(true).description('Run the getupdates long-poll loop.'),
  pollTimeoutMs: Schema.number()
    .default(40_000)
    .description('Client budget for one long-poll round; keep above the 35s server hold.'),
  defaultUserId: Schema.string()
    .default('')
    .description('Fixed recipient. Empty means use the most recent inbound sender.'),
  echoOwnMessages: Schema.boolean()
    .default(false)
    .description('Whether inbound messages sent by the bot itself should be surfaced.'),
})
