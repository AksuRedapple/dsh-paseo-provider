# Changelog

## 1.0.0 — 2026-11-03

首个可开源版本。

### 新增

- **持久 follow 传输**（`server/dsh-follow.mjs`）：一次 `session/follow` 消费 `snapshot → event → assistant-stream`；断线指数退避；seq 去重；cursor 重置检测；快照截断与重连缺口提示；未知帧不静默。
- **共享 turn 状态机**（`server/turn-state.mjs`）：WS 与 ACP 共用；echo 抑制、tool-call 不算回复、`turn/end` 权威收工、idle 兜底、120s 预算。
- **WS provider**：prompt 后台化；`session.interrupt`（DSH `session/cancel`）、`session.close`、`session.can_stop_runtime`；未实现输入显式 `request.failed`；工具 60s 超时结算；`session.turn` / `session.notice`。
- **ACP provider**：持久流、实时 `agent_thought_chunk` / `agent_message_chunk`、`tool_call` / `tool_call_update`；`loadSession` 声明；`session/load` 分段 + stdout 背压。
- **流式预览**：reasoning 实时；正文 block-end 落定；最终 `assistant/message` 同 step 去重。
- **usage 与可用性**：`assistant-stream` 的 usage chunk 映射为 `session.usage`；`status()` 对 DSH 做真实探活（5s 缓存），上游 502 时显示 unavailable 与诊断。
- **上下文过滤**：DSH 注入的 system-reminder / 记忆 / 时间戳不进入时间线。
- **错误可读化**：DSH 非 JSON 响应（如上游 502）返回可读错误，不再抛 `SyntaxError`。
- **测试**：18 条 provider + 3 条 client + 5 条 ACP 契约 + 5 条端到端/契约 mock；`./check.sh`（测试 + typecheck）；GitHub Actions（Node 22/24）。
- **文档**：README、DESIGN、VERIFICATION、LICENSE、CI。

### 已知限制

- DSH 快照窗口固定（实测 `maxMessages=2000` 仍 342 条封顶），超长历史截断。
- Paseo 契约无 token delta；正文不逐字渲染。
- `session.configure` / `revert` / `archive` / `unarchive` 未实现（显式 unsupported）。
- ACP 权限 / 模式 / 模型切换未做。
- 真机验证仅 macOS + Node 26；并发只测 2 会话。

## 0.x

内部迭代版本（未发布）。
