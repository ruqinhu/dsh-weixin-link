# @ruqinhu/dsh-weixin-link

English | [中文](README.zh-CN.md)

The Weixin (iLink) channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
receives messages, and delivers turn results without the model having to remember to
send them.

## 1. The constraint

| Constraint | Consequence |
| --- | --- |
| Every send must carry a `context_token` | a token can only come from an inbound message |
| No token can be minted | a quiet night parks the 07:00 report until the owner speaks |
| A fallback channel would hide failure | no fallback; parked text is replayed, never rerouted |
| Over-long payloads can return a message id and still not arrive | the 2,200-char cap is enforced in code, not trusted to the model |

## 2. Which turns are delivered

| `source.kind` | Origin | Delivered |
| --- | --- | --- |
| `schedule` | cron task | ✅ |
| `weixin-link` | owner messaged from Weixin | ✅ |
| `user` | typed in terminal / web UI | ❌ answer already on screen |
| `runtime-context` / `skill-catalog` / `time-context` | injected context | ❌ not speech |
| `compact-checkpoint` / `provider` / `fallback` | compaction, title generation | ❌ internal noise |

Only the **first** user message names the origin: every turn is followed by injected
context, so the last one would classify every turn as context and deliver nothing.

## 3. Mechanisms

| Problem | Decision | Rejected alternative | Cost paid |
| --- | --- | --- | --- |
| Who delivers | the channel subscribes to `session/event` and sends on `turn/end` | telling the model "you must call `weixin_push`" — it answered in-session and delivered nothing, pushed meta-commentary, and shipped errors as reports | the model cannot choose silence, except via `[SILENT]` |
| Duplicate sends | identical text within 10 min counts as delivered; a manual `weixin_push` stands auto-delivery down | an LLM "is this worth it" gate: a round trip per message, and a silent "don't send" is indistinguishable from a crash | duplicates outside the window still go out |
| Empty turns | `本次无产出（timestamp）` | silence: "ran and failed" looks like "never ran" | one message that may say nothing |
| Failed turns | `⚠️ 回合未完成（reason，timestamp）：本次没有可投递的内容。`, at most one per session per hour | sending the partial text: a fragment reads like an answer; skipping: a crashed 07:00 report looks like a day with no schedule | the hourly floor is in memory, so a restart can add one |
| Images | downloaded from the CDN, AES-CBC decrypted, saved to `inbox/`, and the message names the files for `read_image` | dropping them silently: on 2026-11-04 an image was sent twice and neither the agent nor the log saw anything, so the owner gave up ("不改了就这样吧") | one download per image inside a background task, and a decrypt failure degrades to the placeholder |
| Other media | folded into a placeholder the agent can act on (`（收到 1 个文件…）`), with the wire field skeleton appended to `inbound-media.log` | pretending to have read a voice note or a file: the model would answer about content nobody read | content still unread — the placeholder says so |
| Receive vs send | replay on its own timer + single-flight; bootstrap does not await it | awaiting replay inside the poll loop: a 30/60/120 s backoff means 3.5 minutes deaf | replay is serial — one slow send delays the rest |
| Liveness | rewrite `state/heartbeat.json` every round; judge every 60 s; restart when no round has been **attempted** for 3 budgets (≥ 90 s) | judging by last success: a loop failing every round gets restarted every tick, aborting the retry in flight | cannot tell "hung" from "paused" |
| Replay deletion | delete only on a provably permanent failure | deleting on "anything not NEEDS_INBOUND/RATE_LIMITED": `ret:-2 prepare failed` is transient, and that rule ate a 12:40 report | queue keeps entries that may never send |
| Batching turns | not done | coalescing near-simultaneous turns: delays a decaying report, complicates the cap, harder to replay | occasional burst of separate messages |

## 4. Failure handling

| Class | Action | Why not the alternative |
| --- | --- | --- |
| stale token | park, do not retry | only a new inbound can mint a token |
| rate limited | back off 30/60/120 s, then park | dropping after the ladder looks like "never scheduled" |
| other | one immediate retry, then give up | more retries turn a blip into a queue stall |
| no `context_token` at all (auto-delivery) | drop, do not park | replaying a week-old report is worse than dropping it |
| replayed entry fails | keep it, never re-park | a second file for the same text means every copy is sent |

## 5. Measured

| Item | Result |
| --- | --- |
| Unit tests | 248 across 21 files; `tsc --noEmit` clean |
| Delivery round trip | inbound 10:00:04 → turn completed 10:00:24 → `ok msgid=7523202391886746000` in the same second |
| Watchdog | heartbeat advances every round, `restarts: 0` across a 14-hour run |
| Receipts | one JSONL line per attempt, keyed by the operator's local day |

**5.1 An outage, as the trace recorded it.** Quota exhaustion (`429 AccountQuotaExceeded`),
two consecutive builds on the same channel:

| Time (UTC) | Build | Behaviour |
| --- | --- | --- |
| 10:40:29 | old | `skip … turn=304 reason=not-completed` |
| 10:42:31 | old | `skip … turn=305 reason=not-completed` |
| 10:44:34 | old | `skip … turn=306 reason=not-completed` |
| 10:46:33 | new | `send … turn=307 kind=failure len=44` → `ok msgid=7522972414050248000` |
| 10:46+ | new | further notices held back: `skip … reason=failure-notice-rate-limited` |

Four minutes of silence became one line on the phone saying the run did not finish.

## 6. Open questions

| Question | Current state |
| --- | --- |
| Token refresh | cannot be done by the plugin; ~12 h without an inbound message parks sends |
| Recipients | one poll loop, one recipient; multi-account needs a routing layer |
| Replay concurrency | serial; per-entry locking would be needed |
| Failure-notice floor | in memory; persisting costs a write per failure |
| Media / rich cards | none — text is the only payload whose failure is observable here |
| Watchdog false positives | a debugger pause or long GC looks like a stall; restart is harmless but recorded |
| Outbox validation | none at write time; bad entries are skipped on read and logged |

## 7. Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.2.1-rc.5` (peer dependencies pinned) |
| Runtime | Node 22+, no native modules |
| Required services | `tools`, `credentials`, `sessionController`; `agents` optional |
| Payload | text only, ≤ 2,200 chars |

## 8. Install, credentials, configuration

```bash
dsh plugin add @ruqinhu/dsh-weixin-link
```

The token is read through the DSH credential store (`ctx.credentials.resolve()`), not
`process.env`: the store already layers `$DSH_HOME/.credentials.yaml` → environment →
project/user `.env`, and reading the environment directly would shadow it.

| Key | Default | Meaning |
| --- | --- | --- |
| `tokenEnv` | `WEIXIN_BOT_TOKEN` | credential name for the bot token |
| `accountIdEnv` | `WEIXIN_BOT_ACCOUNT_ID` | credential name for the account id |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink endpoint |
| `dataDir` | `~/.dsh/weixin-link` | tokens, outbox, receipts, trace |
| `poll` | `true` | run the inbound long-poll loop |
| `pollTimeoutMs` | `40000` | client budget; must exceed the server's 35 s hold |
| `defaultUserId` | `""` | recipient; empty = most recent inbound sender |
| `echoOwnMessages` | `false` | surface the bot's own messages as inbound |
| `sessionId` | `""` | session inbound is routed to, resumed when cold |
| `replayIntervalMs` | `300000` | outbox retry interval, own timer |
| `dedupeWindowMs` | `600000` | identical texts inside this window count as delivered |
| `notifyTurnFailures` | `true` | announce a turn that ended without completing |
| `watchdogIntervalMs` | `60000` | liveness check interval; `0` disables |

## 9. Tools and files

| Tool | Purpose |
| --- | --- |
| `weixin_push` | send now; parks automatically when it cannot deliver |
| `weixin_status` | login state, token age, last delivery, outbox depth, poll liveness |

| File | Content |
| --- | --- |
| `receipts/YYYY-MM-DD.jsonl` | one line per send attempt, keyed by the +08:00 day |
| `delivery-trace.log` | one line per turn decision, **including skips and why** |
| `outbox/` | parked messages awaiting a token |
| `state/heartbeat.json` | last attempt/success, failures, inbound count, restarts |
| `inbound-media.log` | one line per inbound non-text message: item types, field **names**/skeleton, and the image save outcome (no URLs, keys or bytes) |
| `inbox/` | images downloaded from inbound messages, named `<messageId>-<n>.<ext>`, mode 0600 |

```
send session=... turn=12 kind=turn len=63
ok   session=... turn=12 msgid=7521135910923441000
skip session=... turn=13 reason=source-not-deliverable
skip session=... turn=14 reason=duplicate
watchdog-restart reason=stalled lagMs=142000 failures=0
```

## 10. Inbound routing

| Situation | Behaviour |
| --- | --- |
| session configured, cold start | resume via `sessionController.resolveAgent()` (bare `Agent`, `{ agent }`, or `{ error }` — all three handled) |
| no session configured | route to the first live root agent |
| no agent at all | token cache still refreshed; that is what unblocks delivery |

`sessionController` must be in `static inject`: cordis **throws** on an undeclared
service rather than returning `undefined`, and a `try/catch` turns that into
"messages arrive but nothing ever answers".

## License

[MIT](LICENSE)
