# DESIGN — DSH ↔ Paseo provider 传输与 turn 状态机

> 2.0.0 起只保留 WS 桌面通道；本文档的 ACP 章节保留为 v1.x 历史参考（见 tag v1.3.0）。
> 状态：2026-11-03 已实现（持久 follow + 共用状态机）；协议细节随实现更新
> 范围：WS（`dsh`）与 ACP（`dsh-acp`）两条通道共用的数据路径

## 1. 背景

DSH 暴露两套接口：

- HTTP RPC（`session/list`、`session/create`、`session/prompt`），响应是**无 `Content-Encoding` 头的 brotli**。
- WebSocket mux（`/api/remote.mux`），`session/follow` 会先回一份 `snapshot`，之后持续推增量帧。

早期实现把 mux 当「一次性快照」用：每次轮询新建连接、只认 `snapshot`、把其余帧丢弃。这有三个后果：

1. 每个活跃轮次每 1.2s 新建一条 WS，连接 churn 高；
2. `turn/end`、`assistant-stream` 等权威信号不可见，只能靠 idle 猜收工；
3. seq 重置、快照截断、未知事件全部静默。

本设计把 mux 还原成**持久流**，并把「一轮对话何时结束」抽成 WS/ACP 共用的状态机。

## 2. 协议事实（2026-11-03 实测）

`session/follow` 请求：

```json
{ "type": "open", "streamId": "...", "endpoint": "session/follow",
  "payload": { "args": { "request": {
    "address": { "kind": "session", "sessionId": "..." },
    "assistantStream": true,
    "maxMessages": 500,
    "turnWindow": { "minMessages": 50, "minTurns": 2 }
  } } } }
```

帧格式（`type:"item"`，`streamId` 与请求一致）：

| `value.type` | 形状 | 用途 |
|---|---|---|
| `snapshot` | `{ header, cursor, records, hasMore, projections, assistantStream }` | 初始水位 + 历史窗口 |
| `event` | `{ event: { type, seq, time, data } }` | 增量 DSH 事件 |
| `assistant-stream` | `{ frame: { type: start|chunk|end, attemptId, revision, ... } }` | token 级生成流 |

关键语义（实测）：

- `cursor` = 快照内最大 seq；短会话 `hasMore=false`，长会话（342 条记录）`hasMore=true`。
- `assistant-stream.start` 带 `turn/step` 与 `startedAfterSeq`；`end.outcome` 指明提交的事件类型与 seq。
- 增量 `event` 的 `seq` 单调递增；事件类型包括 `turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`、`agent/inbox/spliced`、`session/title*`、`request/*`、`job/*`。

## 3. 传输层：`followSession`

```
connect ──open──> snapshot(cursor, hasMore)
                      │
                      ├── records[seq > lastSeq] → event
                      └── 之后持续: event / assistant-stream
close/error ──backoff──> reconnect ──> snapshot(cursor)
```

### 3.1 不变式

1. **水位单调**：只向下游发 `seq > lastSeq` 的事件；重复帧计数不外发。
2. **重置可检测**：重连后的 `snapshot.cursor < lastSeq` 视为 seq 重置，发 `reset` 通知并**只把 cursor 作为新基线**（不回放历史，避免重复）。
3. **截断可见**：`snapshot.hasMore === true` 发一次 `truncated` 通知（每个快照一次）。
4. **未知不静默**：未知 `value.type` / `event.type` 计数并发 `unknown` 通知；已知但刻意忽略的类型走白名单。
5. **断线可恢复**：非主动关闭时按指数退避重连（250ms → 5s 上限）；主动 `close()` 不再重连。
6. **可测试**：`connect` 可注入，单测用假 socket 驱动，不连 DSH。

### 3.2 API

```ts
const follow = followSession(sessionId, { assistantStream: true });
await follow.ready;              // { cursor, hasMore }
for await (const msg of follow)  // snapshot | event | assistant | reset | truncated | unknown | error
follow.close();
```

一次性读取仍是 `fetchSessionRecords()`：内部复用 `followSession` 的首个 snapshot，超时返回 `[]`，保持「绝不抛」的旧契约。

## 4. Turn 状态机（WS/ACP 共用）

输入：`snapshot / event / assistantFrame / tick(now)`。
输出动作：`timeline`、`turn`、`notice`、`echo`、`done`。

```
        prompt sent
             │
      waitEcho(15s) ──超时──> running(from cursor)
             │ echo(user/message)
          running
       ┌─────┼───────────────┐
  turn/end  replyText+idle600(!busy)  deadline(6h)
       │         │                        │
    completed  completed                timeout
```

规则：

- **权威收工**：`turn/end` → `done(completed)`，原因取 `data.reason.kind`。
- **旧版兜底**：没有 `turn/end` 时，出现带正文的 `assistant/message` 且连续 600 个 tick（约 10 分钟）无新事件 → `done(completed)`；有未结算的工具时**不数空闲**（2026-11-04 真机：goal 轮次里的长工具让 5s 兜底误收工，Paseo 计时冻结在 19s）。
- **回复判定**：只有 `assistant/message` 里存在 `text` block 才算回复；tool-call 消息不算。
- **回声抑制**：`waitEcho` 阶段只寻找匹配本次 prompt 的 `user/message`，找到后返回其 seq；该事件不进入时间线。
- **超时**：总预算 6h（goal 轮次实测可跑 25 分钟）；echo 预算 15s。外部 steer 可用 `DSH_STEER_BUDGET_MS` 覆盖。
- **run 启动回执**：`session.prompt` 被 DSH 接受后立即发 `prompt_result(turn|steer)`；turnId 由 provider 生成并贯穿本轮所有 `session.turn` 事件。Paseo 的 bridge 若 60s 内看不到启动回执，会按 `run did not start` 中止（2026-11-04 真机：149s 的 goal 回合被 60s 中止）。
- **turn 事件**：`turn/start` → `session.turn(started)`；`turn/end` → `session.turn(completed|failed|canceled)`。

`assistant-stream` 映射（2026-11-03 实测）：

- `start` 帧带 `turn/step`；后续 `chunk` 帧**不带**，必须沿用 start 的 key（否则去重失败，真机曾出现全文重复）。
- `reasoning-delta` → 立即累积，每约 80 字发一条 `reasoning` 时间线项（daemon 会合并连续项）。
- `text-delta` → 缓冲到 `block-end`/`finish` 一次发 `assistant_message`（分块发会在块边界插入换行，破坏排版）。
- 最终 `assistant/message` 若与预览同 `turn:step`，跳过其正文/推理，避免重复。

### 4.1 ACP 实时映射

`acp-server.mjs` 的 `streamTurn` 复用同一个 `followSession`（不再是快照轮询）：

| DSH | ACP `session/update` |
|---|---|
| `assistant-stream` reasoning-delta | `agent_thought_chunk` |
| `assistant-stream` text-delta | `agent_message_chunk` |
| `tool/call` | `tool_call`（pending） |
| `tool/result` | `tool_call_update`（completed + 文本输出） |
| 最终 `assistant/message` | 同 step 已预览则跳过 |

`initialize` 声明 `loadSession: true`；`session/load` 仍按 50 条一批发送并等 stdout drain。

## 5. 事件分类

| 类别 | 事件 | 处理 |
|---|---|---|
| 时间线 | `user/message`（仅 `source.kind=user/agent`）`assistant/message` `tool/call` `tool/result` | `toTimeline` |
| 轮次 | `turn/start` `turn/end` `step/start` `step/end` | `session.turn` 状态机 |
| 有意忽略 | `request/header` `request/context` `session/title` `session/title-llm-request` `agent/inbox/spliced` `job/registered` `job/settled` `assistant/attempt` `system/message` `developer/message` `workspace/changes` `permission/preset` `sandbox/mode` `approval/policy` | 计数，不 emit |
| 未知 | 其余 | `session.notice(warning)` 每类型每会话一次 + 日志 |

DSH 会把 system-reminder、记忆注入、时间戳等以 `user/message` 形式塞进事件流；它们没有 `source.kind=user/agent`，因此**不得进入时间线**（2026-11-03 真机发现：不过滤会一次冒出 5 条伪用户消息）。

## 5.0 只读实时镜像（observer）

`session.open` 之后启动一个持久 `followSession`，把外部回合写进 Paseo：

- 每条 event → `toTimeline`（reasoning/assistant 走同一个 preview streamer；`user/message` 只保留 `source.kind=user/agent`）。
- `turn/start` → `session.turn(started)`，turnId 固定为 `dsh-ext-<turn>`；`turn/end` → 对应的 completed/canceled/failed，并结算未返回的工具卡。
- 打开时若回合仍在进行：replay 里记住未闭合的 turn，在 `session.ready` 后补发 started，观察者负责关掉。
- `session.prompt`（自有回合）前停掉观察者，回合结束后恢复；显式 steer 不打断观察者。
- observer 按 provider 连接隔离；`session.close` 时停止。

## 5.1 生命周期

| 输入 | 行为 |
|---|---|
| `session.interrupt` | `AbortController.abort()` + DSH `session/cancel`；本轮以 `prompt_result(failed, turn canceled)` 收尾 |
| `session.close` | abort 当前轮、清映射、发 `session.closed` |
| `session.can_stop_runtime` | 返回当前会话是否有活动轮次 |
| 未实现的输入（configure/revert/archive 等） | `request.failed` + `dsh/unsupported`，不静默吞掉 |

工具挂起超过 `toolPendingTimeoutMs`（默认 60s）或 turn 结束时仍无 result → 结算为 `failed`，error 写明原因，避免「永远 running」。

## 6. 失败模式与保证

| 场景 | 行为 |
|---|---|
| WS 断开 | 退避重连；snapshot 去重；重连期间事件可能缺失 → `notice` |
| seq 重置（DSH 重启） | `reset` 通知，cursor 重建基线，不回放 |
| 快照截断 | 只在日志记录（DSH 快照窗口几乎总是 hasMore；不弹 notice），实时流仍从 cursor 继续 |
| 未知事件 | 首次警告 + 计数，不中断 |
| turn 无结束信号 | 无挂起工具且静默 10 分钟 → 兜底 completed；否则 6h 超时 `prompt_result(failed)` |
| 工具无结果 | 60s 或 turn 结束时结算为 failed |

## 7. 测试策略

- 纯状态机：假事件数组 + 可推进的 `now`，覆盖 echo 超时、turn-end、idle 兜底、seq 重置、截断、未知事件。
- 传输层：注入假 socket，覆盖 snapshot→event→assistant-stream、断线重连、重复帧、主动关闭。
- 真机：单轮、慢工具（sleep 8）、双会话并发；对比重构前后 DSH 连接数与 CPU。
- 基线：网页版 DSH 使用不受影响（只减少额外连接，不修改 DSH 服务）。

## 8. 非目标

- 不改 DSH 服务端，也不改网页版前端。
- 不追求 Paseo 契约之外的 token 级 UI（契约没有 delta 事件）。
- 不在本阶段发布到 GitHub；发布前单独确认。
