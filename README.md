# @ruqinhu/dsh-weixin-link

English | [中文](README.zh-CN.md)

The Weixin (iLink) channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
receives messages, and delivers turn results **without the model having to remember
to send them**.

DSH has no built-in IM delivery. This plugin adds two things — a `weixin_push` tool,
and automatic delivery of a finished turn — and the second one is the design. The
rest of this document is why delivery cannot be left to the model, what the channel
refuses to do, and how the receiving path survives a send that is stuck.

## 1. The constraint that decides everything

Every iLink send must carry a `context_token`, and **a token can only come from an
inbound message**. There is no way to mint one.

So a quiet night means the 07:00 report cannot be sent until the owner speaks. The
plugin does not pretend otherwise: such messages are parked and replayed as soon as
a real inbound message refreshes the token. There is deliberately **no fallback
channel** — a silent fallback hides the failure instead of exposing it.

That single constraint explains the parking queue, the replay rules, and why a stale
token is a first-class state rather than an error to retry.

## 2. Delivery is a transport concern, not model discipline

The first version of this channel put a sentence in every task prompt: "you must
call `weixin_push` when done". It failed quietly, in three different ways:

- The model wrote the report into the session, the turn ended `completed`, and the
  owner received nothing — from the model's point of view, answering in-session was
  the correct behaviour. It did not know the sentence was meant for a phone.
- The model called `weixin_push` with the body, then added "已经通过微信回复你了" in
  the session. The owner's second notification was meta-commentary, not content.
- When the task failed, the prompt still said "you must send", so the error was
  delivered as if it were the report.

Root cause: delivery is the transport's job. The plugin now subscribes to DSH's
global `session/event` bus and, on `turn/end`, takes the last `assistant/message` of
that turn and sends it itself. `dsh-schedule` only awaits `sessions.flush()` after
queueing a message; it neither knows nor cares what the agent answered — so the
channel has to do this.

## 3. Which turns are delivered

Keyed on the `source.kind` of the turn's first `user/message`:

| `source.kind` | Origin | Delivered |
| --- | --- | --- |
| `schedule` | cron task | ✅ |
| `weixin-link` | owner messaged from Weixin | ✅ |
| `user` | typed in terminal / web UI | ❌ the answer is already on screen |
| `runtime-context` / `skill-catalog` / `time-context` | injected context | ❌ not speech |
| `compact-checkpoint` / `provider` / `fallback` | compaction, session-title generation | ❌ internal maintenance; sending it is noise |

One delivery per turn. If the model called `weixin_push` itself during that turn,
auto-delivery stands down — otherwise the owner gets the same content twice.

The hard cap is **2,200 characters** per message, enforced in code. iLink's failure
for over-long payloads is not a clean rejection: a send can return a message id and
still never arrive. Full reports go to the HTML page; the message carries the
summary and, when cut, a line saying so plus the link on the first line. The cap is
enforced rather than trusted to the model because delivery no longer consults the
model at all.

## 4. Silence is a failure mode, so it is bounded on both sides

A scheduled task that finishes with no output sends `本次无产出（timestamp）`.
Silence would make "ran and failed" indistinguishable from "never ran", and those
two need different responses.

A prompt can opt out of that notification: when the **entire turn text is exactly
`[SILENT]`**, delivery is skipped. Only whole-text equality counts; mentioning the
marker inside a real report does not suppress it.

A deliverable turn that ends **without** `completed` — errored, aborted, canceled —
sends `⚠️ 回合未完成（reason，timestamp）：本次没有可投递的内容。` instead of its
partial text. The fragment must not go out: it is part of an answer, not an answer.
But dropping the turn entirely, which is what this plugin first did, made a crashed
07:00 report indistinguishable from a day with no schedule.

At most one such notice is sent per session per hour. A task failing in a retry loop
would otherwise page the owner on every attempt, and the owner's response to that is
to mute the channel — which also mutes the reports that work. A turn that already
pushed something itself is exempt; it has already said what it had to say.

## 5. The second filter level: the same text does not go out twice

Automatic delivery and the outbox replayer are independent senders that never talk
to each other. A report that a retry delivered can be replayed minutes later, and a
turn replayed across a reconnect can end twice.

So identical text sent within ten minutes counts as already delivered. Ten minutes
is longer than any retry path here and shorter than the gap between two runs of the
same task. Successful sends are recorded in one place — the send path itself — so
the window covers every sender, and the replayer checks it before sending.

Deliberately not an LLM judgement. A per-message model call to decide "is this worth
interrupting the owner" costs a round trip on every delivery and introduces a new
way to be silently wrong: a classifier that says "don't send" is indistinguishable
from a crash, which is the failure this plugin exists to prevent.

## 6. Receiving is not blocked by sending

The outbox retry used to run inside the poll loop, awaited. A rate-limit backoff
runs 30 → 60 → 120 seconds, so one parked message meant the channel received
nothing for up to three and a half minutes — a send delay turned into a conversation
delay.

Replay now runs on its own timer (`replayIntervalMs`, five minutes by default) with
a single-flight guard, and the loop that receives only ever enqueues. The same rule
applies at boot: a fresh process starts the poll loop first and replays parked
messages in the background, rather than staying deaf until the backoff ladder
finishes.

## 7. Watchdog: the failure the loop cannot report on itself

The poll loop is a `while (true)` around a network call, and every failure it knows
about is caught and retried. The failure it cannot handle is the one it never sees:
a round that hangs forever inside the transport, or a promise that never settles. In
both, the process stays up, the log says nothing, and every later report goes into a
channel that stopped listening.

`state/heartbeat.json` is rewritten on every round: last attempt, last success,
consecutive failures, inbound count, restart count. Every 60 seconds the plugin
judges that file, and **restarts the loop in place** when no round has been attempted
for three client budgets (two minutes at the default 40 s timeout, floored at 90 s).

The signal is *silence*, not failure: a round that fails still proves the loop is
turning, and restarting a loop that is already backing off would abort the retry in
flight, and the next tick would abort the next one. A loop that keeps failing is
left alone — restarting it would not bring the network back.

The heartbeat is a file rather than a log line so an operator, or an external cron
watching a different process, can answer "is it alive" without grepping.
`weixin_status` reports it as `lastPollAgeMs`, `pollRestarts`, and
`consecutivePollFailures`.

## 8. Send policy and replay

Auto-delivery and `weixin_push` share one send path:

1. Try once.
2. Classify the failure:
   - **stale token** → park, do not retry (only a new inbound message helps)
   - **rate limited** → back off 30 s, 60 s, 120 s; if still limited, **park**
   - **anything else** → one immediate retry, then give up
3. Write one JSONL receipt per attempt.

Parking on exhausted rate limiting is not incidental. A report that exhausts the
backoff ladder and is then dropped looks identical to one that was never scheduled —
the failure mode that once swallowed a whole morning report.

The one exception: auto-delivery that finds **no `context_token` at all** (no
inbound message ever received) does not park. Replaying a week-old report is worse
than dropping it.

Replay has one rule, and it too was paid for: **an entry is deleted only when the
failure is provably permanent.** Everything else is kept. An earlier implementation
treated "neither `NEEDS_INBOUND` nor `RATE_LIMITED`" as permanent, but the failure
that actually happens here is `ret:-2 prepare failed`, classified `UNKNOWN` — which
is transient. A 12:40 noon report was deleted by that rule: the receipt said
`ok:false` and the outbox was already empty.

A replayed entry is never re-parked on failure; it is already in the outbox, and a
second file for the same text means every copy is sent once the token recovers.

## 9. What we measured

- **Unit tests**: 248 across 21 files — the decision matrix, the turn tracker, the
  outbox rules, the dedupe window, the heartbeat and the watchdog each have their
  own tests; `tsc --noEmit` is clean.
- **Failure notices in production**: the trace shows the switch — three consecutive
  `skip … reason=not-completed` while a quota outage lasted, then
  `send … kind=failure len=44` followed by `ok … msgid=7522972414050248000`.
- **Delivery round trip**: an inbound message at 10:00:04 refreshed the token, the
  turn completed at 10:00:24, and the reply was delivered in the same second
  (`ok msgid=7523202391886746000`).
- **Watchdog**: heartbeat advances every round, `restarts: 0` after a full day, and
  a stopped loop is restarted by the same tick that would otherwise have stayed
  silent.

## 10. Open questions

- **A token cannot be refreshed by the plugin.** If the owner does not message the
  bot for roughly twelve hours, sends fail with `ret:-2 prepare failed` and park
  until they do. This is a property of iLink, not of the plugin.
- **One poll loop, one recipient.** Multi-account or multi-recipient delivery would
  need a routing layer this plugin does not have.
- **Replay is serial.** One slow send delays the entries behind it; a concurrent
  replay would need per-entry locking to stay safe.
- **The hourly failure-notice floor lives in memory**, so a restart can add one
  notice. Persisting it costs a file write per failure to suppress one message.
- **No media, no rich cards.** Text only, because the 2,200-character cap and the
  silent-drop failure mode make text the only payload whose failure is observable.

## Install

```bash
dsh plugin add @ruqinhu/dsh-weixin-link
```

## Credentials

The token is read through the DSH credential store — via `ctx.credentials.resolve()`
— not from `process.env` directly. That is deliberate: the store already layers
`$DSH_HOME/.credentials.yaml`, inherited environment, and project/user `.env` files.
Reading the environment directly would shadow the managed store.

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
