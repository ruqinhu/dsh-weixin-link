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
  /**
   * Session that inbound messages are delivered to.
   *
   * Empty means "route to whichever root agent is already live". That works until
   * the process restarts — after which no agent is resident and inbound text has
   * nowhere to go. Naming the session lets the plugin resume it on demand, which is
   * what keeps the conversation alive across restarts.
   */
  sessionId: string
  /**
   * How often the outbox is retried, independent of inbound traffic.
   *
   * A parked message is usually a transient rejection that clears by itself, so the
   * trigger is time, not a human. Five minutes is frequent enough that a brief 07:00
   * rejection still delivers while the report is useful, and rare enough to cost
   * nothing when the outbox is empty.
   */
  replayIntervalMs: number
  /**
   * Identical texts sent within this window are treated as already delivered.
   *
   * The two senders — automatic delivery and the outbox replayer — do not know
   * about each other, and a turn replayed across a reconnect can end twice. Zero
   * disables the guard.
   */
  dedupeWindowMs: number
  /**
   * Whether a deliverable turn that ended without completing gets a short notice.
   *
   * On by default: a crashed 07:00 report and a day with no schedule are otherwise
   * identical from the phone, and they call for entirely different responses.
   */
  notifyTurnFailures: boolean
  /**
   * Watchdog interval. `0` disables the in-process watchdog.
   *
   * The watchdog restarts the poll loop when no round has succeeded for three
   * client budgets — the failure mode where the process stays up and every later
   * report is delivered into a channel that stopped listening.
   */
  watchdogIntervalMs: number
  /** 是否对入站语音做本地转写（silk → wav → faster-whisper）。 */
  enableStt: boolean
  /**
   * 覆盖内置转写命令；`{file}` 会被替换成音频路径。
   *
   * 内置助手需要 python3 + faster_whisper + pilk；没有这些的机器可以把这里指向任何
   * 会打印转写文本的命令。
   */
  sttCommand: string
  /** 单条语音转写的超时。模型加载要几秒，给得比一次网络请求宽。 */
  sttTimeoutMs: number
  /** 本地转写的初始提示；留空则用模型默认（base 会输出繁体）。 */
  sttPrompt: string
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
  sessionId: Schema.string()
    .default('')
    .description(
      'Session inbound messages are routed to, resumed when cold. Empty means the first live root agent.',
    ),
  replayIntervalMs: Schema.number()
    .default(5 * 60_000)
    .description(
      'How often parked messages are retried. Runs on its own timer, never inside the poll loop: ' +
        'a rate-limit backoff takes minutes, and a channel that stops receiving for that long turns ' +
        'a delivery delay into a conversation delay.',
    ),
  dedupeWindowMs: Schema.number()
    .default(10 * 60_000)
    .description(
      'Identical texts sent within this window are treated as already delivered. Guards against ' +
        'automatic delivery and outbox replay sending the same report twice. Zero disables it.',
    ),
  notifyTurnFailures: Schema.boolean()
    .default(true)
    .description(
      'Send a short notice when a deliverable turn ends without completing. Without it a crashed ' +
        'scheduled task is indistinguishable from one that never ran.',
    ),
  watchdogIntervalMs: Schema.number()
    .default(60_000)
    .description(
      'How often to check that the poll loop is still making progress, and restart it when it is ' +
        'not. Zero disables the watchdog.',
    ),
  enableStt: Schema.boolean()
    .default(true)
    .description(
      'Transcribe inbound voice messages locally (silk → wav → faster-whisper) and hand the text ' +
        'to the agent. Off means the audio is still saved and the agent is told where it is.',
    ),
  sttCommand: Schema.string()
    .default('')
    .description(
      'Override the bundled transcription helper; `{file}` is replaced with the audio path. ' +
        'Empty uses the bundled python helper, which needs faster_whisper and pilk.',
    ),
  sttTimeoutMs: Schema.number()
    .default(90_000)
    .description('Give up on one transcription after this long; the message then carries the saved path.'),
  sttPrompt: Schema.string()
    .default('')
    .description(
      'Initial prompt for local transcription. The official adapter keeps the same knob ' +
        '(`stt.local.initial_prompt`); without it the base model answers Mandarin in Traditional characters.',
    ),
})
