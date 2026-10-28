# @ruqinhu/dsh-weixin-link

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的微信 iLink 通道：收发消息，并**自动投递**回合结果。

DSH 没有内置 IM 投递。本插件补上两件事：

1. agent 能往微信推报告（`weixin_push` 工具）
2. **一个回合结束后，正文自动发到微信** —— 不需要模型记得调工具

第二件是重点。见「为什么投递不由模型负责」。

## 决定一切的约束

iLink 每次发送都必须带 `context_token`，而**这个 token 只能从入站消息里拿到**，没有别的办法生成。

所以一个安静的夜晚意味着 07:00 早报发不出去，直到你主动发一条消息。插件不假装能绕过：这类消息会被暂存，等真实入站消息刷新 token 后立刻重放。**故意不做保底通道** —— 静默的保底会掩盖失败，而不是暴露失败。

## 为什么投递不由模型负责

早先的版本靠每个定时任务的 prompt 里写一句话：「完成后必须调用 `weixin_push`」。它失败得很安静：

- 模型把回复写进会话，回合正常 `completed`，用户什么也没收到。从模型的角度看，在会话里回答是正确行为 —— 它不知道这句话是要发到手机的。
- 换一种失败：模型先调 `weixin_push` 发正文，再在会话里补一句「已通过微信回复你了」。用户收到的第二句是元叙述，不是内容。
- 一旦任务失败，prompt 仍然说「必须发」，于是错误也被当成报告发出去。

根子上，投递是**传输层**的职责，不是模型的自律。

现在插件订阅 DSH 的全局 `session/event` 总线，在 `turn/end` 时取该回合最后一条 `assistant/message` 的正文自己发送。DSH 的 `dsh-schedule` 在投递消息后只等 `sessions.flush()`，它既不知道也不关心 agent 回了什么 —— 所以这件事必须由通道做。

### 哪些回合会被投递

按该回合第一条 `user/message` 的 `source.kind` 判定：

| `source.kind` | 来源 | 投递 |
| --- | --- | --- |
| `schedule` | 定时任务 | ✅ |
| `weixin-link` | 用户在微信发起 | ✅ |
| `user` | 用户在终端 / Web 输入 | ❌ 人就在键盘前，同一句话在屏幕上已经有了 |
| `runtime-context` / `skill-catalog` / `time-context` | 注入的上下文 | ❌ 不是对话 |
| `compact-checkpoint` / `provider` / `fallback` | 会话压缩、标题生成 | ❌ 内部维护，投了就是噪音 |

### 去重

一个回合只投递一次。若模型在该回合内自己调过 `weixin_push`，自动投递跳过这个回合 —— 否则同一条内容会收到两遍。

### 空回合

定时任务跑完但没输出时，发一条 `本次无产出（时间戳）`。静默会让「跑了但挂了」和「根本没跑」无法区分，而两者该做的处置完全不同。

prompt 可以显式放弃这次通知：**整个回合正文恰好只有 `[SILENT]`** 时跳过。只在正文整体等于它时才算，正文里提到这几个字不影响投递。

### 长度上限

单条消息硬上限 **2200 字符**。iLink 对超长内容的失败不是干净的拒绝 —— 发送可能返回 message id 却根本没送达。完整报告写进网页版，微信只发摘要，截断时会追一行说明并指向首行链接。

上限在代码里强制，不依赖模型遵守：投递已经不看模型了。

## 安装

```bash
dsh plugin add @ruqinhu/dsh-weixin-link
```

## 凭据

token 通过 DSH 凭据库读取（`ctx.credentials.resolve()`），**不直接读 `process.env`**。这是有意的：凭据库已经按 `$DSH_HOME/.credentials.yaml` → 继承环境变量 → 项目/用户 `.env` 分层解析，绕过去反而会遮蔽受管存储。

在 `tokenEnv`（默认 `WEIXIN_BOT_TOKEN`）指定的名字下配置凭据。

## 配置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `tokenEnv` | `WEIXIN_BOT_TOKEN` | bot token 的凭据名 |
| `accountIdEnv` | `WEIXIN_BOT_ACCOUNT_ID` | 账号/bot id 的凭据名 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 端点 |
| `dataDir` | `~/.dsh/weixin-link` | token、outbox、收据、投递追踪目录 |
| `poll` | `true` | 是否跑入站长轮询 |
| `pollTimeoutMs` | `40000` | 客户端预算，必须大于服务端 35 秒挂起 |
| `defaultUserId` | `""` | 收件人；空表示"最近一次入站发送者" |
| `echoOwnMessages` | `false` | 是否把 bot 自己的消息当作入站 |

## 发送策略

自动投递和 `weixin_push` 走同一条发送路径：

1. 先试一次。
2. 分类失败：
   - **token 失效** → 暂存，不重试（只有新的入站消息能救）
   - **被限流** → 退避 30/60/120 秒；仍然限流则**暂存**
   - **其他** → 立即重试一次，再失败就放弃
3. 每次尝试写一行 JSONL 收据。

限流退避耗尽后暂存不是随手加的：一条报告退避完被丢弃，和从未被调度过完全无法区分 —— 这正是曾经整份早报被吞掉的失败模式。

唯一的例外是自动投递发现**根本没有 `context_token`**（还没收到过任何入站消息）。这种情况不暂存：把几天前的报告重放到今天比丢掉更糟。

### 重放规则

暂存的消息在下次有 token 时重放。判定逻辑在 `delivery/outbox-replayer.ts`，独立于插件类 —— 因为它正是丢掉过报告的那段。

规则只有一条：**只有能证明永久失败的条目才删除**。其余全部保留。

这条规则是被事故逼出来的。早先的实现把「既不是 `NEEDS_INBOUND` 也不是 `RATE_LIMITED`」都当成永久失败删除，而当时真实发生的失败是 `ret:-2 prepare failed`，归类为 `UNKNOWN`，那是**暂时性**的。于是重放删掉了它本来要救的消息：一条 12:40 午报就这样没了，收据写着 `ok:false`，而 outbox 已经空了。

重放还有一个容易写错的地方：**失败时不重新暂存**。被重放的条目本来就在 outbox 里，再暂存一次会为同一段文本写出第二个文件，等 token 恢复后每一份都会被发出去。

## 工具

| 工具 | 用途 |
| --- | --- |
| `weixin_push` | 主动发送文本；发不出去时自动暂存 |
| `weixin_status` | 登录态、token 年龄、最近投递、积压深度 |

`weixin_push` 保留给「让 agent 现在主动发一条」的场景。日常投递不需要它 —— 插件会自己做，而调它会让该回合的自动投递让位，避免重复。

## 收据与追踪

**收据** `dataDir/receipts/YYYY-MM-DD.jsonl`：每次发送尝试一行，按操作者的 **+08:00 本地日**归档而非 UTC。替代"grep agent 日志找 delivered"。

**投递追踪** `dataDir/delivery-trace.log`：每个回合的判定结果一行，包括**跳过**的回合和原因。

两份分开是必要的：收据只记录尝试过的发送，一个被策略跳过的回合不会留下收据。当报告没到时，第一个问题是"到底有没有考虑过投递"，这个问题只有追踪文件能回答。

```
send session=... turn=12 len=63
ok   session=... turn=12 msgid=7521135910923441000
skip session=... turn=13 reason=source-not-deliverable
```

## 入站投递

入站文本作为普通后续回合投给最近活跃的根 agent，来源标记为 `weixin-link`。若 profile 里没有 agent，token 缓存仍然会刷新 —— 那才是解锁投递的关键部分。

冷启动时用 `sessionController.resolveAgent()` 恢复会话，它返回裸 `Agent`、`{ agent }` 或 `{ error }` 三种形态，都要认。

> 注意：`sessionController` 必须写进 `static inject`。cordis 对未声明的服务**抛异常**而不是返回 `undefined`，被 `try/catch` 吞掉后会表现为"消息收到了但没人回"。

## 许可

[MIT](LICENSE)
