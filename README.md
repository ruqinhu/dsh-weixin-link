# @ruqinhu/dsh-weixin-link

English | [中文](README.zh-CN.md)

Weixin (WeChat) iLink channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
send, receive, and **deliver turn results automatically**.

DSH has no built-in IM delivery. This plugin adds two things:

1. an agent can push a report to Weixin (`weixin_push` tool)
2. **when a turn ends, its text is sent to Weixin by the plugin** — the model does not
   have to remember to call a tool

The second one is the point. See "Why delivery is not the model's job".

## The constraint that shapes everything

iLink requires a `context_token` on every send, and **that token can only be
obtained from an inbound message**. There is no way to mint one.

So a quiet night means the 07:00 report cannot be delivered until the owner sends
something. Rather than pretend otherwise, the plugin parks such messages and
replays them the moment a real inbound message refreshes the token. No fallback
channel, by design — a silent fallback hides the failure instead of surfacing it.

## Why delivery is not the model's job

An earlier version relied on a sentence in every scheduled prompt: "when done you
must call `weixin_push`". It failed quietly:

- The model wrote its answer into the session, the turn ended `completed`, and the
  owner received nothing. From the model's point of view, answering in-session was
  the correct thing to do — it had no way to know the turn was addressed to a phone.
- A different failure: the model called `weixin_push` with the body, then added
  "已通过微信回复你了" in the session. The owner got the meta line, not the content.
- With the task failing, the prompt still said "you must send", so the error was
  delivered as if it were the report.

Delivery is a transport concern, not a matter of model discipline.

The plugin now subscribes to DSH's global `session/event` bus and, on `turn/end`,
takes the last `assistant/message` text of that turn and sends it itself. DSH's
`dsh-schedule` only awaits `sessions.flush()` after queueing a message; it neither
knows nor cares what the agent answered — so the channel has to do this.

### Which turns are delivered

Keyed on the `source.kind` of the turn's first `user/message`:

| `source.kind` | Origin | Delivered |
| --- | --- | --- |
| `schedule` | cron task | ✅ |
| `weixin-link` | owner messaged from Weixin | ✅ |
| `user` | typed in terminal / web UI | ❌ the answer is already on screen |
| `runtime-context` / `skill-catalog` / `time-context` | injected context | ❌ not speech |
| `compact-checkpoint` / `provider` / `fallback` | compaction, session-title generation | ❌ internal maintenance; sending it is noise |

### Exactly once

One delivery per turn. If the model called `weixin_push` itself during that turn,
auto-delivery stands down for that turn — otherwise the owner gets the same content
twice.

### Empty turns

A scheduled task that finishes without output sends `本次无产出（timestamp）`.
Silence would make "ran and failed" indistinguishable from "never ran", and those
two need different responses.

A prompt can opt out of that notification: when the **entire turn text is exactly
`[SILENT]`**, delivery is skipped. Only whole-text equality counts; mentioning the
marker inside a real report does not suppress it.

### Failed turns

A deliverable turn that ends **without** `completed` — errored, aborted, canceled —
sends `⚠️ 回合未完成（reason，timestamp）` instead of its partial text.

The partial text must not go out: it is a fragment of an answer, not an answer.
But dropping the turn entirely, which is what this plugin used to do, made a crashed
07:00 report indistinguishable from a day with no schedule. The notice names the
terminal reason and carries no model output, so it cannot be mistaken for a report.
At most one is sent per session per hour: a task failing in a retry loop would
otherwise page the owner on every attempt, and the owner's response to that is to
mute the channel — which also mutes the reports that work.

A turn that already pushed something itself is exempt; it has already said what it
had to say.

The hourly floor is per session and held in memory, so a restart can add one more
notice — bounded in practice by systemd's start limit, and the alternative (a
persisted counter) costs a file write per failure to suppress one message.

### The second filter level

Above the source check there is a delivery gate: **identical text sent within ten
minutes is considered already delivered**. Automatic delivery and the outbox
replayer are independent senders that never talk to each other, and a turn replayed
across a reconnect can end twice. Ten minutes is longer than any retry path here
and shorter than the gap between two runs of the same task.

Deliberately not an LLM judgement. A per-message model call to decide "is this worth
interrupting the owner" costs a round trip on every delivery and introduces a new
way to be silently wrong: a classifier that says "don't send" is indistinguishable
from a crash, which is the failure this plugin exists to prevent.

### Length cap

**2200 characters** per message, enforced. iLink's failure for over-long payloads is
not a clean rejection — a send can return a message id and still never arrive. Full
reports go to the HTML page; the message carries the summary and, when truncated, a
line saying so plus the link on the first line.

Enforced in code rather than left to the model, because delivery no longer consults
the model at all.

## Install

```bash
dsh plugin add @ruqinhu/dsh-weixin-link
```

## Credentials

The token is read through the DSH credential store — via
`ctx.credentials.resolve()` — not from `process.env` directly. That is deliberate:
the store already layers `$DSH_HOME/.credentials.yaml`, inherited environment,
and project/user `.env` files. Reading the environment directly would shadow the
managed store.

Configure the credential under the name in `tokenEnv` (default `WEIXIN_BOT_TOKEN`).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `tokenEnv` | `WEIXIN_BOT_TOKEN` | Credential name holding the bot token |
| `accountIdEnv` | `WEIXIN_BOT_ACCOUNT_ID` | Credential name for the account/bot id |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink endpoint |
| `dataDir` | `~/.dsh/weixin-link` | Tokens, outbox, receipts, delivery trace |
| `poll` | `true` | Run the inbound long-poll loop |
| `pollTimeoutMs` | `40000` | Client budget; must exceed the server's 35 s hold |
| `defaultUserId` | `""` | Recipient; empty means "most recent inbound sender" |
| `echoOwnMessages` | `false` | Surface the bot's own messages as inbound |
| `sessionId` | `""` | Session inbound messages are routed to, resumed when cold |
| `replayIntervalMs` | `300000` | How often the outbox is retried, on its own timer |
| `dedupeWindowMs` | `600000` | Identical texts inside this window count as delivered |
| `notifyTurnFailures` | `true` | Announce a deliverable turn that ended without completing |
| `watchdogIntervalMs` | `60000` | Liveness check interval; `0` disables the watchdog |

## Send policy

Auto-delivery and `weixin_push` share one send path:

1. Try once.
2. Classify the failure:
   - **stale token** → park, do not retry (only a new inbound message helps)
   - **rate limited** → back off 30 s, 60 s, 120 s; if still limited, **park**
   - **anything else** → one immediate retry, then give up
3. Write one JSONL receipt per attempt.

Parking on exhausted rate limiting is not incidental. A report that exhausts the
backoff ladder and is then dropped looks identical to one that was never
scheduled — the failure mode that once swallowed a whole morning report.

The one exception: auto-delivery that finds **no `context_token` at all** (no inbound
message ever received) does not park. Replaying a week-old report is worse than
dropping it.

## Receiving is not blocked by sending

The outbox retry used to run inside the poll loop, awaited. A rate-limit backoff
runs 30 → 60 → 120 seconds, so one parked message meant the channel received
nothing for up to three and a half minutes — a send delay turned into a conversation
delay. Replay now runs on its own timer with a single-flight guard, and the loop
that receives only ever enqueues.

The same rule applies at boot: a fresh process starts the poll loop first and
replays parked messages in the background, rather than staying deaf until the
backoff ladder finishes.

## Watchdog

`state/heartbeat.json` is rewritten on every poll round: last attempt, last success,
consecutive failures, inbound count, restart count.

Every 60 seconds the plugin judges that file. No successful round for three client
budgets (two minutes at the default 40 s timeout, floored at 90 s) means the loop has
stopped moving, and it is **restarted in place**. The failure this covers is the one
the loop cannot report on itself: a round that hangs forever inside the transport,
or a promise that never settles. The process stays up, the log says nothing, and
every later report goes into a channel that stopped listening.

A loop that keeps *failing* is not restarted — it is still running, it already backs
off and retries, and restarting it would not bring the network back. Only silence
counts.

The heartbeat is a file rather than a log line so an operator, or an external cron
watching a different process, can answer "is it alive" without grepping. It is also
what `weixin_status` reports as `lastPollAgeMs`, `pollRestarts`, and
`consecutivePollFailures`.

## Tools

| Tool | Purpose |
| --- | --- |
| `weixin_push` | Send text on demand; parks automatically when it cannot deliver |
| `weixin_status` | Login state, token age, last delivery, outbox depth, poll liveness |

`weixin_push` remains for "send this now". Routine delivery does not need it — the
plugin does it, and calling the tool stands auto-delivery down for that turn to avoid
a duplicate.

## Receipts and trace

**Receipts** `dataDir/receipts/YYYY-MM-DD.jsonl`: one line per send attempt, keyed by
the operator's +08:00 day rather than UTC.

**Delivery trace** `dataDir/delivery-trace.log`: one line per turn decision, including
**skipped** turns and why.

Keeping them apart matters: a receipt only exists for a send that was attempted, and a
turn skipped by policy leaves no receipt at all. When a report does not arrive, the
first question is whether delivery was considered — only the trace answers that.

```
send session=... turn=12 kind=turn len=63
ok   session=... turn=12 msgid=7521135910923441000
skip session=... turn=13 reason=source-not-deliverable
skip session=... turn=14 reason=duplicate
watchdog-restart reason=stalled lagMs=142000 failures=0
```

## Inbound delivery

Inbound text is delivered to the most recently active root agent as an ordinary
follow-up turn, tagged with source `weixin-link`. Without an agent in the profile
the token cache is still refreshed — which is the part that unblocks delivery.

On a cold start the session is resumed through `sessionController.resolveAgent()`,
which returns one of three shapes — a bare `Agent`, `{ agent }`, or `{ error }` — and
all three must be handled.

> `sessionController` must be listed in `static inject`. cordis **throws** on an
> undeclared service rather than returning `undefined`; swallowed by a `try/catch`,
> that presents as "messages arrive but nothing ever answers".

## License

[MIT](LICENSE)
