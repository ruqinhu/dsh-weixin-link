# @ruqinhu/dsh-weixin-link

Weixin (WeChat) iLink channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
send, receive, and verify delivery.

DSH has no built-in IM delivery. This plugin gives an agent a Weixin channel it
can push reports to and receive messages from.

## The constraint that shapes everything

iLink requires a `context_token` on every send, and **that token can only be
obtained from an inbound message**. There is no way to mint one.

So a quiet night means the 07:00 report cannot be delivered until the owner sends
something. Rather than pretend otherwise, the plugin parks such messages and
replays them the moment a real inbound message refreshes the token. No fallback
channel, by design — a silent fallback hides the failure instead of surfacing it.

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
| `dataDir` | `~/.dsh/weixin-link` | Tokens, outbox, receipts |
| `poll` | `true` | Run the inbound long-poll loop |
| `pollTimeoutMs` | `40000` | Client budget; must exceed the server's 35 s hold |
| `defaultUserId` | `""` | Recipient; empty means "most recent inbound sender" |
| `echoOwnMessages` | `false` | Surface the bot's own messages as inbound |

## Delivery policy

1. Try once.
2. Classify the failure:
   - **stale token** → park, do not retry (only a new inbound message helps)
   - **rate limited** → back off 30 s, 60 s, 120 s; if still limited, **park**
   - **anything else** → one immediate retry, then give up
3. Write one JSONL receipt per attempt.

Parking on exhausted rate limiting is not incidental. A report that exhausts the
backoff ladder and is then dropped looks identical to one that was never
scheduled — the failure mode that once swallowed a whole morning report.

## Tools

| Tool | Purpose |
| --- | --- |
| `weixin_push` | Send text; parks automatically when it cannot deliver |
| `weixin_status` | Login state, token age, last delivery, outbox depth |

## Receipts

One JSON line per attempt under `dataDir/receipts/YYYY-MM-DD.jsonl`, keyed by the
operator's +08:00 day rather than UTC. This replaces grepping an agent log for
"delivered".

## Inbound delivery

Inbound text is delivered to the most recently active root agent as an ordinary
follow-up turn, tagged with source `weixin-link`. Without an agent in the profile
the token cache is still refreshed — which is the part that unblocks delivery.

## License

MIT
