# @ruqinhu/dsh-weixin-link

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的微信 iLink 通道：
收消息，并且不依赖模型记得就把回合结果投递出去。

## 1. 约束

| 约束 | 后果 |
| --- | --- |
| 每次发送都必须带 `context_token` | token 只能来自入站消息 |
| token 无法生成 | 安静的夜晚意味着 07:00 早报被暂存，直到 owner 开口 |
| 保底通道会掩盖失败 | 不做保底；暂存的文本只重放，不改道 |
| 超长载荷可能返回 message id 却没送达 | 2,200 字符上限在代码里强制，不依赖模型遵守 |

## 2. 哪些回合会被投递

| `source.kind` | 来源 | 投递 |
| --- | --- | --- |
| `schedule` | 定时任务 | ✅ |
| `weixin-link` | 用户在微信发起 | ✅ |
| `user` | 终端 / Web 输入 | ❌ 屏幕上已经有了 |
| `runtime-context` / `skill-catalog` / `time-context` | 注入的上下文 | ❌ 不是对话 |
| `compact-checkpoint` / `provider` / `fallback` | 压缩、标题生成 | ❌ 内部噪音 |

只认**第一条** user 消息：每个回合后面都跟着注入的上下文，取最后一条会把所有回合判成上下文，
结果一条都不投。

## 3. 机制

| 问题 | 决定 | 否决的替代 | 代价 |
| --- | --- | --- | --- |
| 谁来投递 | 通道订阅 `session/event`，在 `turn/end` 自己发 | 让模型「必须调用 weixin_push」：它会在会话里回答而不投递、发元叙述、把错误当报告发 | 模型无法决定沉默，除非 `[SILENT]` |
| 重复发送 | 十分钟内同文本算已投递；已手动 `weixin_push` 则自动投递让位 | LLM 判定「值不值得打扰」：每条多一次往返，且「别发」与崩溃无法区分 | 窗口之外的重复仍会发 |
| 空回合 | 发 `本次无产出（时间戳）` | 静默：「跑了但挂了」和「根本没跑」无法区分 | 有时是一句废话 |
| 失败回合 | `⚠️ 回合未完成（原因，时间戳）：本次没有可投递的内容。`，每会话每小时最多一条 | 发半截正文：碎片读起来像答案；静默：崩掉的早报像没排任务 | 每小时下限存在内存，重启会多一条 |
| 图片 | 从 CDN 下载 → AES-CBC 解密 → 存进 `inbox/`，消息里给出文件路径供 `read_image` 读取 | 静默丢弃：2026-11-04 用户发了两次图片，agent 和日志都没看见，最后说「不改了就这样吧」 | 每张图一次下载（在后台任务里），解密失败降级成占位文本 |
| 其他媒体 | 折成一条模型能处理的占位文本（`（收到 1 个文件…）`），并把线上字段骨架追加进 `inbound-media.log` | 假装读过语音或文件：模型会对着没人读过的内容作答 | 内容仍未读取 —— 占位文本如实说明 |
| 收发解耦 | 重放独立定时器 + 单飞；bootstrap 不 await | 在轮询里 await 重放：退避 30/60/120 秒意味着 3.5 分钟收不到消息 | 重放串行，慢发送拖住后面的条目 |
| 存活判定 | 每轮写 `state/heartbeat.json`；每 60 秒判读；连续 3 个预算（≥90 秒）**没有尝试**则重启 | 按「上次成功」判：每轮都失败的循环会被每 tick 重启，掐掉正在进行的重试 | 分不清「挂死」和「被暂停」 |
| 重放删除 | 只有可证明永久失败才删 | 按「既非 NEEDS_INBOUND 也非 RATE_LIMITED」删：`ret:-2 prepare failed` 是暂时性错误，这条规则吃掉过一条 12:40 午报 | 队列里会留可能永远发不出去的条目 |
| 合并消息 | 不做 | 把几乎同时结束的回合合并：推迟价值衰减的报告、让长度上限更难处理、重放更难 | 偶尔连收几条独立消息 |

## 4. 失败处理

| 类别 | 动作 | 为什么不换一种 |
| --- | --- | --- |
| token 失效 | 暂存，不重试 | 只有新的入站消息能生成 token |
| 被限流 | 退避 30/60/120 秒，之后暂存 | 退避完就丢，看起来和「从未被调度」一样 |
| 其他 | 立即重试一次，再失败就放弃 | 更多重试会把抖动变成队列停摆 |
| 完全没有 token（自动投递） | 丢弃，不暂存 | 重放一周前的报告比丢掉更糟 |
| 重放条目失败 | 保留，绝不二次暂存 | 同一段文本两个文件 = 恢复后每条都发 |

## 5. 实测

| 项 | 结果 |
| --- | --- |
| 单测 | 248 个、21 个文件；`tsc --noEmit` 干净 |
| 投递往返 | 入站 10:00:04 → 回合 10:00:24 完成 → 同一秒 `ok msgid=7523202391886746000` |
| Watchdog | 心跳逐轮前进，连续运行 14 小时 `restarts: 0` |
| 收据 | 每次尝试一行 JSONL，按操作者本地日归档 |

**5.1 一次故障，trace 是这么记的。** 配额耗尽（`429 AccountQuotaExceeded`），同一通道的两个版本：

| 时间（UTC） | 版本 | 行为 |
| --- | --- | --- |
| 10:40:29 | 旧 | `skip … turn=304 reason=not-completed` |
| 10:42:31 | 旧 | `skip … turn=305 reason=not-completed` |
| 10:44:34 | 旧 | `skip … turn=306 reason=not-completed` |
| 10:46:33 | 新 | `send … turn=307 kind=failure len=44` → `ok msgid=7522972414050248000` |
| 10:46 之后 | 新 | 后续通知被限流：`skip … reason=failure-notice-rate-limited` |

四分钟的沉默，变成手机上的一行字：这一轮没跑完。

## 6. 开放问题

| 问题 | 现状 |
| --- | --- |
| token 刷新 | 插件做不到；约 12 小时没有入站消息，发送就会被暂存 |
| 收件人 | 单轮询、单收件人；多账号需要一层路由 |
| 重放并发 | 串行；并发需要按条目的锁 |
| 失败通知下限 | 存在内存；持久化要为每次失败写一次文件 |
| 图片 / 富卡片 | 无 —— 只有文本的失败在这里是可观测的 |
| Watchdog 误判 | 调试器停顿或长 GC 看起来像停摆；重启无害但会被记录 |
| outbox 校验 | 写入时无校验；坏条目读取时跳过并记日志 |

## 7. 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `0.2.1-rc.5`（peer 依赖按此钉住） |
| 运行时 | Node 22+，无原生模块 |
| 必需服务 | `tools`、`credentials`、`sessionController`；`agents` 可选 |
| 载荷 | 纯文本，≤ 2,200 字符 |

## 8. 安装、凭据、配置

```bash
dsh plugin add @ruqinhu/dsh-weixin-link
```

token 通过 DSH 凭据库读取（`ctx.credentials.resolve()`），不读 `process.env`：凭据库已按
`$DSH_HOME/.credentials.yaml` → 环境变量 → 项目/用户 `.env` 分层解析，直读环境变量会遮蔽它。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `tokenEnv` | `WEIXIN_BOT_TOKEN` | bot token 的凭据名 |
| `accountIdEnv` | `WEIXIN_BOT_ACCOUNT_ID` | 账号 id 的凭据名 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 端点 |
| `dataDir` | `~/.dsh/weixin-link` | token、outbox、收据、trace |
| `poll` | `true` | 是否跑入站长轮询 |
| `pollTimeoutMs` | `40000` | 客户端预算，必须大于服务端 35 秒挂起 |
| `defaultUserId` | `""` | 收件人；空 = 最近一次入站发送者 |
| `echoOwnMessages` | `false` | 是否把 bot 自己的消息当作入站 |
| `sessionId` | `""` | 入站投递到的会话，冷启动时恢复 |
| `replayIntervalMs` | `300000` | outbox 重试间隔，独立定时器 |
| `dedupeWindowMs` | `600000` | 窗口内相同文本算已投递 |
| `notifyTurnFailures` | `true` | 是否通报未正常结束的回合 |
| `watchdogIntervalMs` | `60000` | 存活检查间隔；`0` 关闭 |

## 9. 工具与文件

| 工具 | 用途 |
| --- | --- |
| `weixin_push` | 立即发送；发不出去时自动暂存 |
| `weixin_status` | 登录态、token 年龄、最近投递、积压深度、轮询存活 |

| 文件 | 内容 |
| --- | --- |
| `receipts/YYYY-MM-DD.jsonl` | 每次发送尝试一行，按 +08:00 本地日归档 |
| `delivery-trace.log` | 每个回合的判定一行，**含跳过与原因** |
| `outbox/` | 等 token 的暂存消息 |
| `state/heartbeat.json` | 上次尝试/成功、失败数、入站数、重启数 |
| `inbound-media.log` | 每条非文本入站一行：item 类型、字段名与骨架、图片保存结果（不含 URL、密钥或字节） |
| `inbox/` | 从入站消息下载的图片，命名 `<messageId>-<n>.<ext>`，权限 0600 |

```
send session=... turn=12 kind=turn len=63
ok   session=... turn=12 msgid=7521135910923441000
skip session=... turn=13 reason=source-not-deliverable
skip session=... turn=14 reason=duplicate
watchdog-restart reason=stalled lagMs=142000 failures=0
```

## 10. 入站路由

| 情形 | 行为 |
| --- | --- |
| 配了 session、冷启动 | 用 `sessionController.resolveAgent()` 恢复（裸 `Agent`、`{ agent }`、`{ error }` 三种都要认） |
| 没配 session | 投给第一个活的根 agent |
| 完全没有 agent | token 缓存照常刷新 —— 那才是解锁投递的关键 |

`sessionController` 必须写进 `static inject`：cordis 对未声明的服务**抛异常**而不是返回
`undefined`，被 `try/catch` 吞掉就表现为「消息收到了但没人回」。

## 许可

[MIT](LICENSE)
