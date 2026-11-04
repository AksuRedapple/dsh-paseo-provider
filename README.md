# DSH provider for Paseo

把 DeepSeek Harness（DSH）**桌面版**接进 Paseo：一个原生 provider，直接消费 DSH 的 `session/follow` 持久流。
不装 DSH CLI、不改 DSH profile、不需要重启 Paseo daemon。

## 特性

- **持久流而不是轮询**：一次 `session/follow` 连接消费 `snapshot → event → assistant-stream`，断线指数退避重连。
- **收工有权威信号**：以 DSH 的 `turn/end` 结束一轮，`idle` 仅作旧版兜底。
- **端点/鉴权自动发现**：从 DSH 的 `dsh-web.log` 读取 launch token，本机换取 `dsh-auth` cookie，连 `127.0.0.1:8780`；不再依赖自建代理。
- **生命周期完整**：`session.interrupt`（DSH `session/cancel`）、`session.close`、`session.can_stop_runtime`；取消后正确收轮。
- **模型选择是实时的**：从 `session/modelCatalog` 拉模型目录（provider 分组 + reasoning efforts）；切换模型/思考档位真正写回 DSH。
- **外部回合实时镜像**：会话打开后持续跟随 DSH mux；DSH 桌面版/其他客户端发起的回合会实时出现在 Paseo 时间线（只读）。Paseo 自己发消息时镜像自动让位，steer 时保持跟随。
- **桌面版原生交互**：图片 prompt（DSH `mediaType`）、运行中 steer 插话（`mode:'steer'`）、`todo/write` → 时间线任务列表。
- **实时过程**：thinking（reasoning-delta）边到边发；工具调用一开始就显示 running，结果回来再更新为 completed。
- **Goal 可见**：DSH 的 `goal/change` 映射为时间线里的任务卡（Paseo 没有独立 goal 卡片，用 todo 项承载）；打开会话时从 projections 恢复当前 goal 和 todos。
- **上下文与失败可见**：usage 带 token 与上下文窗口占用；seq 重置、快照截断、未知事件、重连缺口都有 notice，不静默。
- **历史导入/回放**：列出 DSH 会话、打开并重建时间线；`hasMore` 截断会明确提示。
- **标题同步**：打开已有会话时使用 DSH 标题；新会话把 Paseo 的 `title` 回写到 DSH（`session/rename`）。

## 要求

- Node.js ≥ 22
- **DSH 桌面版正在运行**（macOS 已验证；其他平台需设置 `DSH_WEB_LOG` 或 `DSH_BASE`/`DSH_MUX`）
- Paseo daemon ≥ 0.14（已在 0.14 / 0.15 实测）

插件不安装 DSH、不修改 DSH profile；它只读取本机 DSH web 日志里的 launch token 并在 loopback 换取 cookie。

## 快速开始

```bash
npm install
./check.sh                 # 测试 + typecheck

paseo plugin install "$PWD"
paseo plugin ls            # 应看到 dsh-provider running
paseo provider ls          # 应看到 dsh available
```

> 改完代码必须 `paseo plugin reload dsh-provider`。不要 `restart`，会断开用户在线会话。

## Provider 契约覆盖（`dsh`）

| 输入 / 事件 | 状态 |
|---|---|
| catalog（动态模型目录）/ sessions / session.open / session.prompt | ✅ |
| session.interrupt / session.close / session.can_stop_runtime | ✅ |
| session.configure（模型 + reasoning effort）→ `session.config` | ✅ |
| prompt.image（图片）/ prompt.steer（运行中插话） | ✅ |
| todo/write → `todo` 时间线项 | ✅ |
| session.usage（tokens + 上下文窗口占用） | ✅ |
| session.permission | ⚠️ 接收但忽略（DSH preset 自动执行） |
| prompt.command（斜杠命令） | ❌ DSH 没有命令注册 RPC |
| session.revert / archive / unarchive | ❌ 显式 `request.failed(dsh/unsupported)` |

## 架构

```
Paseo daemon
   │  provider events (timeline.item / session.turn / notice / prompt_result / usage)
   ▼
dsh-provider  ┌───────────────┐      ┌──────────────────────────┐
(index.server)│ provider.ts   │─────▶│ dsh-follow.mjs           │──▶ DSH mux (8780)
              │ runTurn()     │      │ snapshot/event/assistant │
              │ turn-state.mjs│◀─────│ reconnect / reset detect │
              └───────┬───────┘      └──────────────────────────┘
                      │
              ┌───────▼───────┐      HTTP RPC (brotli, cookie)
              │ dsh-client.ts │─────▶ session/list · create · prompt · modelCatalog
              └───────────────┘
                      ▲
              ┌───────┴────────┐
              │ dsh-endpoint   │  dsh-web.log token → dsh-auth cookie → 127.0.0.1:8780
              └────────────────┘
```

## DSH 协议速记（实测）

- **HTTP RPC**：`POST /api/<method>`，请求信封 `payload.args._request`（`session/list`）、`payload.args.request`（`session/create`、`session/prompt`、`session/selectModel`）或**裸参数**（`session/modelCatalog`）。
- **模型与上下文**：`session/modelCatalog` 返回按 provider 分组的模型与 reasoning efforts；`session/selectModel` 接受 `{sessionId, provider, model, reasoningEffort?}`；当前模型读 `projections.values.modelSelection`，上下文窗口读 `projections.values.contextPressure.contextWindow`。
- **brotli 无头**：响应是 brotli 压缩，但**不带 `Content-Encoding`**，必须无条件尝试解压。
- **mux 帧**：`{"type":"item","streamId","value":{"type":"snapshot"|"event"|"assistant-stream"}}`。
- **snapshot**：`cursor` 是最大 seq，`hasMore` 表示历史窗口被截断。
- **assistant-stream**：`start → chunk(block-start/…/block-end) → end`，`end.outcome` 指向提交的 `assistant/message` seq。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_WEB_LOG` | 平台日志路径 | DSH web 日志（token 来源）；macOS 默认 `~/Library/Logs/DeepSeek Harness/dsh-web.log` |
| `DSH_BASE` / `DSH_MUX` | 自动发现 | 显式覆盖端点（设置后不再读日志） |
| `DSH_COOKIE` | 自动交换 | 显式 `dsh-auth-*` cookie；跳过 token 交换 |
| `DSH_DEFAULT_CWD` | `$HOME` | 新建会话的默认 cwd |
| `DSH_TITLE_CONCURRENCY` | `8` | 列表补标题的并发上限 |
| `DSH_RUNNING_MODE` | `steer` | 目标会话正在运行时的行为：`steer`（插入当前轮次）｜`fail`（返回 `dsh/busy`） |

## 测试

```bash
./check.sh          # tests + typecheck
node --test tools/tests/provider_stream.test.mjs
```

覆盖：baseline 不重放、回声抑制、`turn/end` 收工、tool-call 不误判为回复、seq 重置、快照截断、未知事件、断线重连、标题并发上限、echo 超时兜底、端点发现与 cookie 轮换、回放/工具/任务列表。

## 已知限制

- **必须有 DSH 桌面版在运行**；无头/CLI 用户请使用官方 ACP 方案（本仓库 v1.3.0 及以前提供过 ACP 适配器）。
- 真机只在 macOS + Node 26 验证；Windows/Linux 需要显式 `DSH_WEB_LOG` 或 `DSH_BASE`。
- DSH 是私有协议；rc 升级可能改变日志/字段，未知事件会告警而不是猜测。
- 快照窗口由 DSH 控制，超长历史会截断（只记日志，不弹 notice，不分页）。
- 权限审批、MCP、斜杠命令、revert/archive 未做（DSH desktop preset 自动执行 / 无对应端点）。
- 目标 DSH 会话正在运行（桌面版/其他客户端）时，默认把消息 **steer 插入当前轮次**；外部轮次可能很长，steer 的预算是 6 小时（`DSH_STEER_BUDGET_MS`），且不会用 idle 兜底提前收工。设置 `DSH_RUNNING_MODE=fail` 可改为快速失败（`dsh/busy`）。
- goal 轮次可以跑几十分钟；普通轮次的总预算为 6 小时，idle 兜底只在没有挂起工具时生效（防止长工具被误判为本轮结束）。
- DSH 自动改标题（`session/title` 事件）不会实时同步到 Paseo（Paseo 契约没有标题更新事件）；重新打开时以 DSH 标题为准。

## License

MIT（见 `LICENSE`）。
