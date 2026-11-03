# VERIFICATION — 验证记录

> 日期：2026-11-03 ｜ 环境：macOS (Apple Silicon) · Node 26 · Paseo 0.14 · 本地 DSH
> 兼容性：Node 22.23.4 / 24.22.1 / 26.12.1 均实跑通过（34 条测试；22/24 用干净目录 `npm ci` 后运行）。
> 所有数字来自实际运行，不是估算。个人信息已脱敏。

## 1. 单测

```bash
./check.sh
# ▸ tests 共 11 个测试（fast）
# ▸ 结果: pass=11 fail=0
# node --test: 36 / pass 36 / fail 0
# 干净目录 npm ci → check.sh 通过（Node 26 / Node 24）；Node 22.23.4 直跑通过
```

| 用例 | 锁定内容 |
|---|---|
| invariant-1/2/3 | baseline 不重放、回声抑制、assistant 先于 prompt_result |
| guard-1 | 漏传 `startSeq` 必须抛错 |
| turn-1 | tool-call 的 assistant 不触发早收工 |
| limit-1 | 标题补全并发 ≤ 4（注入值） |
| echo-1 | `waitForUserEcho` 超时退回最大 seq |
| error-1 | 错误消息可读 |
| follow-1 | snapshot 基线 + 增量事件去重 |
| follow-2 | 重连快照 cursor 变小 → reset，不回放历史 |
| state-1 | echo 抑制、tool-call 不算回复、turn/end 收工 |
| state-2 | 截断/重置 notice |
| state-3 | 注入上下文 user/message 不进入时间线，真实用户消息进入 |
| run-1 | 持久流 + 状态机 + 未完成工具结算 |
| run-2 | abort 取消运行中的轮次并关闭 follow |
| run-3 | 工具 60s 超时结算为 failed |
| run-4 | reasoning/text 预览发出，最终 assistant/message 同 step 去重 |
| run-5 | usage chunk → session.usage（input/cached/output） |
| client-1..3 | 非 JSON 上游错误可读、探活 5xx/200 |
| acp-1..5 | user/assistant/tool_call/tool_call_update 映射与 prompt 文本拼接 |
| acp-mock | mock DSH（HTTP+WS）跑完整 prompt：文本只出现一次、tool_call/tool_call_update 生命周期 |
| provider-mock | mock DSH 跑完整 WS provider：tool_call、文本去重、usage、session.turn completed |
| provider-lifecycle | can_stop_runtime → interrupt 取消；session.close 取消并 closed |
| provider-contract | sessions 标题补全、history replay、`session.configure` 返回 config 快照、unsupported 输入显式失败 |
| acp-load | session/load 回放 user/assistant，响应在 updates 之后，并带 configOptions |
| provider-models | 目录按 provider 分组、`session.open` 同步当前模型、`session.configure` → `selectModel`、旧模型 id 保留并提示 |
| usage 映射 | 真机 camelCase（inputTokens/cacheReadTokens/outputTokens）与旧版 snake_case 都能映射 |
| acp-config | `configOptions`（model / thought_level）、`set_config_option` 生效、`usage_update`（used=8 / size=1e6） |
| provider-capabilities | 图片 prompt → DSH `mediaType`；todo/write → `todo` 项；steer 插话回与当前轮一致的 `turnId` |
| acp-mock（增补） | 图片 prompt 透传、`todo/write` → `plan`、`promptCapabilities.image=true` |

## 2. 真机（Paseo → dsh provider）

| 场景 | 证据 |
|---|---|
| 单轮工具调用 | prompt → `sleep 5` → 回复 `STREAM-9090`，当轮出现 |
| 慢工具 | `sleep 8` → 回复 `DONE-8888`；`stream ended seq=27 replyText=true turnEnd=true` |
| 双会话并发 | 两个会话分别只出现 `CHARLIE-1111` / `DELTA-2222`（各 3 次：提示、命令、回复），无串扰 |
| 上一轮不补显 | 第二轮只出现新回复，没有重复上一轮 |
| 用户回声 | 时间线中用户消息各只出现 1 次 |
| 上下文过滤 | 真实会话中 `ssot-context` / `system-reminder` 出现次数 = 0（过滤前会冒出 5 条伪用户消息） |
| 流式预览 | reasoning-delta 实时出现；正文单块落定；最终 assistant/message 被去重（实测最终文本只出现 1 次） |
| interrupt | provider 连接直接发 `session.interrupt` → `prompt_result(failed, turn canceled)` + `request.completed` |
| can_stop / close | `can_stop_runtime=true`；`session.close` → `session.closed`，运行中的轮次被取消 |
| 未实现输入 | 返回 `request.failed` + `dsh/unsupported`，不再静默 `request.completed` |
| **最终 v1.0 回归** | `FINAL-OK`、`SLOW-FINAL`（sleep 8）、`ALPHA-FINAL`/`BRAVO-FINAL` 并发零串扰、interrupt → `turn canceled` |
| **最终 ACP 回归** | `ACP-TOOL` 实时 tool_call/tool_call_update、cancel `cancelled`、Paseo `--provider dsh-acp` 回复 `ACP-FINAL` |

> 最终回归（2026-11-03 12:31）：DSH 桌面 0.2.1-rc.5 启动崩溃（inspector），改用 `dsh-desktop-host` 子进程直接拉起 8780（临时绕过，不改 DSH 配置）；provider 侧完成上述真机回归。

## 3. 负载测量（重构后）

采样：每 1s 统计 `lsof -iTCP:8781` 已建立连接数与 DSH 进程 CPU；一轮 `sleep 12` 的真实对话。

| 阶段 | 连接数 | DSH CPU |
|---|---|---|
| 基线（无本轮） | 8 | 0.0% |
| 轮内 | 10–12（稳定，无轮询抖动） | 0–2.5%，多数采样 0.0–0.4% |
| 轮后 | 10 | 0.0% |

结论：持久 follow 每轮只增加约 2 条稳定连接；没有旧实现「每 1.2s 新建一条 WS」的 churn。网页版 DSH 与插件共用同一服务，但插件负载在本次采样中可忽略。

## 4. ACP

| 场景 | 结果 |
|---|---|
| `session/load` 长会话 | 354 events → 113 updates，`session/update` 全部发完后才回响应 |
| 两轮 prompt | turn1 `["收到"]`、turn2 `["好的"]`；第二轮没有重放第一轮 |
| 实时工具 | `tool_call` pending → `tool_call_update` completed（同一 toolCallId），文本随后到达 |
| cancel | 运行 `sleep 60` 时发 `session/cancel` → `stopReason: "cancelled"` |
| 分段参数 | 每 50 条 `session/update` 等 stdout drain 并让出事件循环 |

## 5. 模型目录 / 切换 / usage（2026-11-03 增补，真机）

WS 路径（`server/provider.ts` 直连本机 DSH）：

| 场景 | 结果 |
|---|---|
| `catalog` | 7 个模型 / 3 个 provider 分组；默认 `deepseek-official::deepseek-v4-pro`；efforts = off/low/high/max |
| `session.open`（新会话） | `session.config` → `model=deepseek-official::deepseek-v4-pro`，`thinkingOption=high` |
| `session.configure` | `{model: deepseek-official::deepseek-v4-pro, thinkingOption: low}` → DSH `session/selectModel` 成功，`session.config` 回显 `low` |
| prompt | `只回复 USAGE-OK` → `completed`，正文 `USAGE-OK`，usage `{inputTokens:26592, cachedInputTokens:0, outputTokens:5}`（camelCase 已映射） |
| interrupt | 长文 prompt 运行中中止 → `turn canceled` |

ACP 路径（`acp-server.mjs` + stdio JSON-RPC）：

| 场景 | 结果 |
|---|---|
| `session/new` | `configOptions`：model（7 项，current `deepseek-official::deepseek-v4-pro`）+ reasoning_effort（current `high`） |
| `set_config_option(model)` | 切到 `deepseek-official::deepseek-flash`；DSH 侧真写回 |
| `set_config_option(reasoning_effort)` | 切到 `max`；响应 `configOptions.currentValue = max` |
| prompt | `只回复 ACP-OK` → `end_turn`，正文 `ACP-OK`，`usage_update {used:26607, size:1048576}` |
| `session/load` | 返回 `configOptions`：model=`deepseek-flash`、effort=`max`（`modelSelection` 带回了 effort） |

基础能力（真机）：

| 场景 | 结果 |
|---|---|
| 图片 prompt | 1×1 PNG + 文本 → `completed`，正文 `CAPS-OK`（DSH `mediaType` 校验通过） |
| todo | 同一轮 `todo/write` 3 次 → 时间线 `todo` 项 3 次更新，最终两项均 `completed` |
| steer | 长任务运行中发 `delivery:'steer'` → `{type:'steer', turnId:'dsh-turn-4'}`，与 `session.turn started` 一致；随后 interrupt → `turn canceled` |
| 协议探测 | `session/projections` / `session/rename` / `session/fork` 存在；`archive/delete/compact/commands` 返回 404（DSH 无对应能力） |

## 6. 未覆盖 / 局限

- seq 重置只有单测与恢复策略，没有真实 DSH 重启样本。
- 快照窗口固定（实测 `maxMessages` 调到 2000 仍是 342 条、`hasMore=true`）；超长历史会截断（有 notice）。
- `session.revert` / `archive` / `unarchive` 未实现（DSH 无对应端点，显式 `request.failed`）；`prompt.command`（DSH 没有命令注册 RPC）与 permission 桥接未做。
- 仅 2 个并发会话做过真机；更高并发未压测。
- 只在 macOS + Node 26 验证；CI 矩阵为 Node 22/24（尚未在 GitHub 实跑）。
- 最终真机回归已完成（见 §2），但 DSH 桌面 0.2.1-rc.5 仍会在启动时 inspector 崩溃；本次通过直接拉起 desktop-host 子进程完成验证，桌面壳需等上游修复或回退 rc.3。

## 7. 复现

```bash
npm install
./check.sh

# 真机（需本机 DSH + Paseo）
paseo plugin reload dsh-provider
paseo agent run "用 bash 运行 sleep 5，然后只回复 STREAM-9090" \
  --provider dsh --cwd "$HOME" --title "verify"
```
