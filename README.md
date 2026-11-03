# DSH → Paseo provider

> Status: v1.0.0（2026-11-03）

把 **DeepSeek Harness（DSH）** 的会话接进 Paseo：在 Paseo 里列会话、发消息、看流式时间线、导入历史。

提供两条通道：

| Provider | 传输 | 特点 |
|---|---|---|
| `dsh` | DSH 私有 WebSocket mux（`/api/remote.mux`） | 全量历史、工具调用结构化、持久流 |
| `dsh-acp` | ACP（stdio JSON-RPC） | 标准协议、换 harness 兼容性好 |

> 这是对 DSH 私有协议的工程化适配，不是 DSH 官方项目。协议细节来自实测，见 `docs/DESIGN.md`。

## 特性

- **持久流而不是轮询**：一次 `session/follow` 连接消费 `snapshot → event → assistant-stream`，断线指数退避重连。
- **一轮对话的收工是状态机**：以 DSH 的 `turn/end` 为权威信号，`idle` 仅作旧版兜底；WS 与 ACP 共用同一套逻辑。
- **生命周期完整**：`session.interrupt`（映射 DSH `session/cancel`）、`session.close`、`session.can_stop_runtime`；取消后正确收轮。
- **思考实时可见**：`assistant-stream` 的 `reasoning-delta` 实时刷成 reasoning 项；正文在 block-end 落定，最终 `assistant/message` 去重，不会重复或插入换行。
- **上下文不污染时间线**：DSH 注入的 system-reminder / ssot-context / 时间戳等 user/message 按 `source.kind` 过滤。
- **失败面显式化**：seq 重置、快照截断、未知事件、工具无结果、连接中断都会变成可见的 notice/日志。
- **测试**：18 条 provider + 3 条 client + 5 条 ACP 契约 + 5 条端到端/契约 mock，见 `docs/VERIFICATION.md`。

## Provider 契约覆盖

### `dsh`（WS）

| 输入 / 事件 | 状态 |
|---|---|
| catalog / sessions / session.open / session.prompt | ✅ |
| session.interrupt / session.close / session.can_stop_runtime | ✅ |
| session.permission | ⚠️ 接收但忽略（DSH preset 自动执行） |
| session.configure / revert / archive / unarchive | ❌ 显式 `request.failed(dsh/unsupported)` |
| timeline.item / session.turn / session.notice / prompt_result / session.usage | ✅ |
| session.config / commands / permission | ❌ 未发 |

### `dsh-acp`

| 方法 / 更新 | 状态 |
|---|---|
| initialize / session/new / session/prompt / session/load / session/cancel / session/close | ✅ |
| 实时 reasoning / text / tool_call / tool_call_update | ✅ |
| `loadSession` 能力声明 | ✅ |
| permission / mode / model 切换 | ❌ 未做 |

## 架构

```
Paseo daemon
   │  provider events (timeline.item / session.turn / notice / prompt_result)
   ▼
dsh-provider  ┌───────────────┐      ┌──────────────────────────┐
(index.server)│ provider.ts   │─────▶│ dsh-ws.ts (followSession)│──▶ DSH mux
              │ runTurn()     │      │ snapshot/event/assistant │
              │ turn-state.mjs│◀─────│ reconnect / reset detect │
              └───────┬───────┘      └──────────────────────────┘
                      │
              ┌───────▼───────┐      HTTP RPC (brotli)
              │ dsh-client.ts │─────▶ session/list · create · prompt
              └───────────────┘

dsh-acp  acp-server.mjs ── stdio ACP ── Paseo
              └── 复用 dsh-client + turn-state.mjs
```

## DSH 协议速记（实测）

- **HTTP RPC**：`POST /api/<method>`，请求信封 `payload.args._request`（`session/list`）或 `payload.args.request`（`session/create`、`session/prompt`）。
- **brotli 无头**：响应是 brotli 压缩，但**不带 `Content-Encoding`**，必须无条件尝试解压。
- **mux 帧**：`{"type":"item","streamId","value":{"type":"snapshot"|"event"|"assistant-stream"}}`。
- **snapshot**：`cursor` 是最大 seq，`hasMore` 表示历史窗口被截断（实测 342 条记录时 `hasMore=true`）。
- **assistant-stream**：`start → chunk(block-start/…/block-end) → end`，`end.outcome` 指向提交的 `assistant/message` seq。

## 快速开始

要求：Node.js ≥ 22、本机可访问 DSH（默认 `127.0.0.1:8781`）、Paseo daemon ≥ 0.14。

```bash
npm install
./check.sh                 # 先跑测试闸，再 typecheck

# 把本目录注册为 Paseo 插件（具体命令以你的 Paseo 版本为准）
paseo plugin install "$PWD"
paseo plugin ls            # 应看到 dsh-provider running
paseo provider ls          # 应看到 dsh / dsh-acp available
```

> 改完代码必须 `paseo plugin reload dsh-provider`。不要 `restart`，会断开用户在线会话。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BASE` | `http://127.0.0.1:8781` | HTTP RPC 地址 |
| `DSH_MUX` | `ws://127.0.0.1:8781/api/remote.mux` | mux 地址 |
| `DSH_DEFAULT_CWD` | `$HOME` | 新建会话的默认 cwd |
| `DSH_TITLE_CONCURRENCY` | `8` | 列表补标题的并发上限 |
| `DSH_ACP_REPLAY_CHUNK` | `50` | ACP `session/load` 每批通知数 |

## 测试

```bash
./check.sh          # tests + typecheck
node --test tools/tests/provider_stream.test.mjs
```

覆盖：baseline 不重放、回声抑制、`turn/end` 收工、tool-call 不误判为回复、seq 重置、快照截断、未知事件、断线重连、标题并发上限、echo 超时兜底、ACP 缓冲分段。

## 已知限制

- DSH 是私有协议，版本变化可能破坏解析；未知事件会告警而不是猜测。
- 故障排查见 `docs/TROUBLESHOOTING.md`（DSH 502、插件热载、ACP、桌面版启动崩溃）。
- Paseo 契约没有 token delta 事件；`assistant-stream` 用于 reasoning 预览与状态判定，正文不逐字渲染。
- 快照窗口由 DSH 服务端控制（实测 `maxMessages=2000` 仍只返回 342 条、`hasMore=true`）；超长历史会截断（有 notice，不会自动分页）。
- `session.configure` / `session.revert` / `session.archive` / `session.unarchive` 未实现，会显式返回 `request.failed(dsh/unsupported)`。
- ACP 已支持持久流、实时 reasoning/text 与 tool_call/tool_call_update；权限、模式/模型切换未做。
- `session/load` 与 WS 历史一样受快照窗口限制。
- seq 重置有检测与恢复策略，但尚无真实故障样本验证。
- 真机验证仅在 macOS + Node 26 完成；CI 矩阵为 Node 22/24。

## License

MIT（见 `LICENSE`）。
