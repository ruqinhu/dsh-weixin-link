# @ruqinhu/dsh-weixin-link

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的微信 iLink 通道：发送、接收、可核对投递。

DSH 没有内置 IM 投递。本插件让 agent 能往微信推报告，也能接收消息。

## 决定一切的约束

iLink 每次发送都必须带 `context_token`，而**这个 token 只能从入站消息里拿到**，没有别的办法生成。

所以一个安静的夜晚意味着 07:00 早报发不出去，直到你主动发一条消息。插件不假装能绕过：这类消息会被暂存，等真实入站消息刷新 token 后立刻重放。**故意不做保底通道** —— 静默的保底会掩盖失败，而不是暴露失败。

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
| `dataDir` | `~/.dsh/weixin-link` | token、outbox、收据目录 |
| `poll` | `true` | 是否跑入站长轮询 |
| `pollTimeoutMs` | `40000` | 客户端预算，必须大于服务端 35 秒挂起 |
| `defaultUserId` | `""` | 收件人；空表示"最近一次入站发送者" |
| `echoOwnMessages` | `false` | 是否把 bot 自己的消息当作入站 |

## 投递策略

1. 先试一次。
2. 分类失败：
   - **token 失效** → 暂存，不重试（只有新的入站消息能救）
   - **被限流** → 退避 30/60/120 秒；仍然限流则**暂存**
   - **其他** → 立即重试一次，再失败就放弃
3. 每次尝试写一行 JSONL 收据。

限流退避耗尽后暂存不是随手加的：一条报告退避完被丢弃，和从未被调度过完全无法区分 —— 这正是曾经整份早报被吞掉的失败模式。

## 工具

| 工具 | 用途 |
| --- | --- |
| `weixin_push` | 发送文本；发不出去时自动暂存 |
| `weixin_status` | 登录态、token 年龄、最近投递、积压深度 |

## 收据

每次尝试一行，写在 `dataDir/receipts/YYYY-MM-DD.jsonl`，按操作者的 **+08:00 本地日**归档而非 UTC。这就是用来替代"grep agent 日志找 delivered"的。

## 入站投递

入站文本作为普通后续回合投给最近活跃的根 agent，来源标记为 `weixin-link`。若 profile 里没有 agent，token 缓存仍然会刷新 —— 那才是解锁投递的关键部分。

## 许可

MIT
