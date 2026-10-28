# @ruqinhu/dsh-weixin-link

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

## Tools

| Tool | Purpose |
| --- | --- |
| `weixin_push` | Send text on demand; parks automatically when it cannot deliver |
| `weixin_status` | Login state, token age, last delivery, outbox depth |

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
send session=... turn=12 len=63
ok   session=... turn=12 msgid=7521135910923441000
skip session=... turn=13 reason=source-not-deliverable
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

MIT
