# Changelog

## 2.10.0 — 2026-11-10

- **外部斜杠命令也镜像进时间线**：DSH 桌面版（或其他客户端）里执行 `/compact`、`/goal` 时，Paseo 以前完全看不到。现在 `command/run` → 一条「用户命令」，`command/done` → 一条命令回执，并顺带刷新上下文占用。Paseo 自己发起的命令会先暂停镜像，避免同一条命令出现两次。
- `sessionInfo` 拆出两条路径：需要 `running`（判断外部回合）时只查一次 `session/list`；其余场合走单会话 `session/projections`。上下文刷新仍是单会话取值。
- Tests: 63 tests / 10 files.

## 2.9.2 — 2026-11-10

- **兜底识别文本形式的斜杠命令**：实测 Paseo 0.15.3 的 bridge 不会把 `/compact` 转成 `command` 输入，仍按普通文本走 `session.prompt`（这正是"在 Paseo 里输入 /compact 不生效"的原因）。provider 现在按 DSH `commands/list` 的目录识别：命中就走 `commands/execute`，不在目录里的 `/xxx`（如 `/usr/bin/env`）仍按文本发。
- 命令执行器抽成 `runCommand`，两条入口（command 输入 / 文本兜底）共用同一套回执、notice 与 usage 刷新。
- Tests: 62 tests / 10 files.

## 2.9.1 — 2026-11-10

**上下文面板不再"迟钝 / 偶尔不动"**：

- 占用改走单会话 `session/projections`（`{request:{sessionId}}`），不再为了一个数字去 `session/list` 拉全部会话。
- 刷新时机补齐：回合开始立刻一次；回合中每 3 秒（值变化才发）；收工（含 abort / 异常路径）强制一次；命令执行后一次（`/compact` 之后占用会立刻掉下来）。
- `compaction/start`、`compaction/end` 不再算"未知事件"；压缩开始/结束给可见 notice，结束时强制刷新占用。
- 外部回合（DSH 桌面版发起）结束时也刷新占用 —— 以前只有 Paseo 自己发消息才会更新面板。
- Tests: 61 tests / 10 files.

## 2.9.0 — 2026-11-10

**斜杠命令接通了**（`/compact` 之前只会被当成普通文本发给模型，看起来"没生效"）：

- 新增 capability `prompt.command`；打开会话时从 DSH `commands/list` 广播命令目录（`session.commands`），带 `argumentHint`（如 `/goal` 的 `[<objective>|clear]`）。
- Paseo 发来的命令输入（`{type:'command', name, arguments}`）改走 DSH `commands/execute`（`{agentId, line, submittedAttachments}`），不再走 `session/prompt`。
- 命令回执（`result.text`）作为一条 `assistant_message` 进时间线；失败给 `dsh/command` + 可读 notice。
- 实测（DSH 0.2.1-rc.5）：`/goal`、`/compact`、`/plan` 都返回 `{kind:'success', text}`。
- Tests: 60 tests / 10 files.

## 2.8.3 — 2026-11-10

面向「别人装得上、装不上知道为什么」的一轮：

- **跨平台日志候选补齐**：除 Electron `app.getPath('logs')` 的三个平台路径外，补上 `userData/logs` 兜底（macOS `~/Library/Application Support/@deepseek-ai/dsh-desktop/logs/`、Windows `%APPDATA%`/`%LOCALAPPDATA%`、Linux `$XDG_CONFIG_HOME`），并同时尝试应用名 `DeepSeek Harness` / `deepseek-harness`。
- **发现失败不再静默**：读不到 launch token 时，插件日志打印尝试过的全部路径，直接告诉用户该把 `DSH_WEB_LOG` 指到哪。
- **降级指路**：`provider status` 的诊断文案明确「本插件需要桌面版在运行；只有 CLI 的用户应改用 CLI/ACP 的 provider」，并对 token 过期给出「重启桌面版后 reload 插件」的可操作提示。
- **README**：新增兼容矩阵（macOS 已验证 / Linux·Windows 路径已覆盖未真机验证）、「这个插件不适合你，如果…」一节、架构图 `docs/arch.svg`。
- Tests: 59 tests / 10 files.

## 2.8.2 — 2026-11-10

- 鉴权失效的错误提示不再写死某台机器的 launchd label（`release-check` 脱敏扫描拦下的真问题）：改成 `DSH_LAUNCHD_LABEL` 环境变量或 `<DSH 的 launchd label>` 占位。
- Tests: 58 tests / 10 files.

## 2.8.1 — 2026-11-10

真机事故（DSH 被 `open -a` 启动 → 不写新 token → 换不到 cookie → 全链路 401）暴露的两个「误导性日志」：

- **鉴权失效一句话说清**：端点来源是 `discovered-no-cookie` 时，`runTurn` 直接抛「DSH 鉴权失效…用 launchctl kickstart 重启 DSH，再 reload 插件」，不再表现为 15s 后的 `first snapshot timeout`。observer 遇到同一状态直接跳过，不再 401 空转重连。
- **抛错不再记成 completed**：`runTurn` 的异常路径以前把 `reason` 留在 `completed`（日志 `reason=completed lastSeq=-1`，看着像正常收工）；现在记 `reason=failed` 并带 `error="…"`。
- Tests: 58 tests / 10 files.

## 2.8.0 — 2026-11-10

同一轮复盘的后三件（1/2/3）：

- **镜像改「暂停」而不是「每轮重建」**：自有回合只在 observer 上 `setPaused(true)`，WS 连接保留、游标照常前进（恢复后不回放），回合结束再放开。以前每轮 `stopObserver → startObserver`，单会话 89 次启动，DSH 重启期尤其容易撞 `1006`。断言锁在 `provider_observer`：一起回合只允许新增 runTurn 那一条连接。
- **图片能力预检**：DSH 的 `modelCatalog` 没有能力位，改为从 `session/attachment-invalid` 反向学习（`provider::model` 集合）。学到的模型再收到图片时本地快速失败（`dsh/no-image-support`），DSH 拒绝时也把原始 JSON 换成可读错误（`dsh/attachment`）。
- **`selectModel` 失败不再整条失败**：常见于目录漂移（Paseo 列表里还有 DSH 已下架的 provider）。现在保留 DSH 当前模型、强制刷新目录、推一条带新模型列表的 `session.config`，UI 不再继续提供坏模型；`session.open` 路径同样清缓存重取。
- Tests: 57 tests / 10 files.

## 2.7.0 — 2026-11-10

线上日志复盘（11-07 ~ 11-09，108 次提问 / 7 次回合失败）后的一轮「可解释性 + 韧性」修复：

- **断线重连会重新解析端点**：DSH 桌面端重启会换 launch token（→ 新 `dsh-auth` cookie），端口也可能变。此前 `followSession` 重连只复用首连的 url/cookie，接不回去就把回合判死——真机 4 次回合失败都发生在 DSH 进程重启的同一秒（`websocket closed (1006)`）。现在新增 `FollowOptions.resolveEndpoint`，重连前重新 discovery；解析失败沿用旧端点继续退避重试。
- **回合失败不再静默**：`runTurn` 结束时输出结构化日志 `turn end reason=... interrupted=... reconnects=... durationMs=... lastSeq=...`；断线 60s 内收工会被标记为「DSH 重启打断」，向用户发一条 warning notice，`prompt_result` 的错误文案也会说明是连接中断。
- **`interrupt` 后立刻发消息不再误判 busy**：上一轮的 `abort → finally` 是异步的，直接判定 `session busy` 会把用户的正常操作打成失败（真机两次）。现在先等上一轮收尾（上限 3 秒）再判忙，仍有并发回合才回 `dsh/busy`。
- **结构化日志**：所有插件日志统一成 `[dsh] <event> key=value`（可 grep / awk），级别由 `DSH_LOG_LEVEL` 控制（`debug|info|warn|error`，默认 `info`）；`observer stop`、`turn end`、`request.completed <ms>` 等缺失的事件补齐。日志仍不打印 prompt 正文 / token / cookie。
- Tests: 54 tests / 10 files.

## 2.6.0 — 2026-11-04

- Live read-only mirroring: after a session is opened, a persistent follow keeps streaming DSH native turns into the Paseo timeline. Turns started in DSH Desktop (or any other client) now appear in Paseo as they happen, with reasoning, assistant text, tool cards, usage, and turn start/end.
- If the session is opened while a turn is already running, that turn is announced as started and closed when DSH emits `turn/end`.
- The mirror yields to Paseo-initiated turns: it is stopped before `runTurn` and restarted afterwards, so the same events are never processed twice. Explicit steer keeps the mirror alive.
- The open-time "session is running" notice is now only emitted in `DSH_RUNNING_MODE=fail`; in steer mode the live turn itself is shown instead of a stale notice.
- Tests: 49 tests / 9 files.

## 2.5.2 — 2026-11-04

- Treat DSH goal phase `complete` as completed (previously only `completed` / `done`). A finished goal no longer shows as an in-progress task card at the bottom of a replayed timeline.
- Tests: 48 tests / 8 files.

## 2.5.1 — 2026-11-04

- Report `prompt_result(turn|steer)` as soon as DSH accepts the prompt, using a provider-generated turn id that every `session.turn` event reuses. Paseo aborts a run after 60 seconds if it never sees the start result, so any turn longer than a minute failed with `run did not start`.
- Stop overriding the turn-state defaults in `runTurn` (`120_000` / 5 ticks). Long goal turns now really use the 6-hour budget and the ~10-minute idle fallback.
- Tests: 48 tests / 8 files.

## 2.5.0 — 2026-11-04

- Goal cards are emitted once per open from session projections. Historical `goal/change` revisions no longer add duplicate task cards (Paseo appends a new todo card whenever its content differs; same-id merging only applies to text streams).
- Long DSH turns are no longer ended early: the idle fallback is skipped while a tool is pending, its threshold is ~10 minutes, and the turn budget is 6 hours. Fixes the Paseo timer freezing at the first long tool gap (a real goal turn ran 25m36s while Paseo recorded 19s).
- Snapshot truncation (`hasMore=true`) is logged instead of shown as a notice; the window is truncated on almost every open, so the notice was pure noise.
- Opening an existing session no longer writes Paseo's `config.model` / `thinkingOption` back to DSH. Imports used to clobber the session's model with the catalog default; explicit switches still go through `session.configure`, and new sessions still apply the open-time config.
- Tests: 46 tests / 8 files.

## 2.4.1 — 2026-11-03

- Refresh the goal/todos cards from projections on every prompt, so already-open sessions show the current goal without reopening.

## 2.4.0 — 2026-11-03

- Map DSH `goal/change` to a persistent task card and restore the current goal/todos from session projections when opening a session.
- `goal/change` is now a known timeline event instead of an unknown-event notice.
- 42 tests / 8 files.

## 2.3.0 — 2026-11-03

- Stream reasoning live: first reasoning delta is emitted immediately, then every ~40 characters, using a stable item id and cumulative text (Paseo derives the delta).
- Tool cards are emitted when the tool starts (`running`) and updated to `completed` with the result, instead of appearing only after completion.
- External steer uses a 30-minute budget (`DSH_STEER_BUDGET_MS`) and disables the idle fallback, so long DSH turns are not failed at 120s.
- 42 tests / 8 files.

## 2.2.0 — 2026-11-03

- Sync titles: open an existing session with its DSH title, and write the Paseo `title` back to DSH (`session/rename`) for new sessions.
- Search platform-specific DSH web log locations (macOS, Windows `%APPDATA%`, Linux `~/.config`), still overridable with `DSH_WEB_LOG`.
- Verified against Paseo 0.15.0 in an isolated daemon (plugin running, agent completed).
- 42 tests / 8 files.

## 2.1.0 — 2026-11-03

- Apply `config.model` / `config.thinkingOption` when opening a session, so `paseo agent run --model/--thinking` works for the `dsh` provider.
- Treat `session/end-seed` as a known ignored event; no more unknown-event notices for it.
- Redact `session.open` config/env from logs; prompt text/images already excluded.
- 40 tests / 8 files.

## 2.0.3 — 2026-11-03

- Stop emitting the snapshot-truncation notice on every turn. The notice is only shown when opening or replaying history.

## 2.0.2 — 2026-11-03

- Prompting a DSH session that is already running elsewhere now steers into the current turn by default. Set `DSH_RUNNING_MODE=fail` to reject with `dsh/busy` instead.
- Debug logs no longer include prompt text or images; the overview documents endpoint overrides and the logging boundary.
- 38 tests / 8 files.

## 2.0.1 — 2026-11-03

- Prompting a DSH session that is already running in the desktop app (or another client) now fails fast with `dsh/busy` instead of queueing until Paseo's 60s start timeout.
- `session.open` emits a warning notice for sessions that are currently running.
- Test added; 37 tests / 8 files.

## 2.0.0 — 2026-11-03

WS-only release.

- Removed the ACP providers, `acp-server.mjs`, the ACP mapping tests and the `@getpaseo/plugin` runtime dependency. The plugin now only registers `dsh` (desktop WS mux).
- The ACP variant remains available at tag `v1.3.0` and branch `acp-legacy`.
- Listing name is now `DeepSeek Harness (desktop)`; the artifact has one runtime dependency (`ws`).

## 1.3.0 — 2026-11-03

WS daily-use polish.

- `session.usage` now includes `contextWindowUsedTokens` / `contextWindowMaxTokens` from DSH `projections.contextPressure` (emitted on open and after each turn).
- History replay reports snapshot truncation (`hasMore=true`) instead of silently showing a partial timeline.
- Fix a plugin-load failure introduced in 1.2.0: Paseo's loader does not always provide `import.meta.url`, so `ws` is now loaded with a dynamic import when a cookie is present.
- Tests: replay/tool/todo regression, 401 cookie rotation recovery, context usage; 47 tests total.

## 1.2.0 — 2026-11-03

WS endpoint discovery; no local proxy required.

- New `server/dsh-endpoint.mjs`: read the DSH web log, exchange the launch token for the `dsh-auth-*` cookie, and connect to `127.0.0.1:8780`. Falls back to the old `8781` endpoint only when no log/token exists.
- HTTP and WebSocket requests carry the cookie; `ws` is now a runtime dependency.
- 401/403 clears the endpoint cache and retries once, so a DSH restart is picked up automatically.
- Env overrides: `DSH_WEB_LOG`, `DSH_COOKIE`, plus the existing `DSH_BASE`/`DSH_MUX`.
- Tests: log parsing, cookie exchange, cache invalidation, and a cookie-authenticated mock DSH end-to-end.

## 1.1.0 — 2026-11-03

Official ACP channel, opt-in.

- Add `server/dsh-cli.mjs`: discover the `dsh` CLI via `DSH_CLI`, the CLI bundled with the DSH desktop app, then `PATH`.
- Add `dsh-acp-official` (`DSH_ACP_MODE=official|both`): launches the official `dsh --profile acp` server, gaining permission prompts, HTTP MCP servers and session list/resume. Uses a 120s startup timeout and `workspaceOnlyCatalog` because the official profile lists models at startup (30–90s cold start in testing).
- Keep the existing adapter as the default `dsh-acp`: instant startup, plans/todos/images/`session/load`.
- New env vars: `DSH_ACP_MODE`, `DSH_CLI`, `DSH_ACP_PROFILE`, `DSH_ACP_STARTUP_MS`.
- Tests: CLI discovery unit tests.

## 1.0.3 — 2026-11-03

Real-task dogfooding fixes.

- ACP tool cards now send `rawInput` (command / file path / edit strings) and `rawOutput`, so Paseo no longer renders bare tool names.
- Document that Paseo MCP servers are not forwarded into DSH.

## 1.0.2 — 2026-11-03

Registry listing name and positioning.

- Manifest name: `DeepSeek Harness (WS + ACP)` so the listing is distinguishable from the existing native-provider plugin.
- Manifest description and overview state the boundary: stock DSH desktop app, no DSH profile changes, Paseo plugin reload only.

## 1.0.1 — 2026-11-03

Plugin registry packaging.

- Add `description` and a declared `build` step (`npm ci --omit=dev --ignore-scripts`) to `paseo-plugin.json`; Git installs now install the runtime dependency (`@getpaseo/plugin`) from the committed lockfile.
- Replace the listing text with an English `OVERVIEW.md` covering purpose, setup, capabilities, data access, permissions and limitations.

## 1.0.0 — 2026-11-03

首个开源版本。

### 传输与生命周期

- **持久 follow 传输**（`server/dsh-follow.mjs`）：一次 `session/follow` 消费 `snapshot → event → assistant-stream`；断线指数退避；seq 去重；cursor 重置检测；快照截断与重连缺口提示；未知帧不静默。
- **共享 turn 状态机**（`server/turn-state.mjs`）：WS 与 ACP 共用；echo 抑制、tool-call 不算回复、`turn/end` 权威收工、idle 兜底、120s 预算。
- **WS provider**：prompt 后台化；`session.interrupt`（DSH `session/cancel`）、`session.close`、`session.can_stop_runtime`；未实现输入显式 `request.failed`；工具 60s 超时结算；`session.turn` / `session.notice`。
- **ACP provider**：持久流、实时 `agent_thought_chunk` / `agent_message_chunk`、`tool_call` / `tool_call_update`；`loadSession` 声明；`session/load` 分段 + stdout 背压。

### 模型与用量

- **WS 模型目录动态化**：`catalog` 调用 DSH `session/modelCatalog`，按 provider 分组输出（id 编码为 `provider::model`），每个模型带 reasoning efforts 与默认档位。
- **WS 模型切换**：`session.configure` → DSH `session/selectModel`（模型 + reasoning effort）；打开会话时从 `session/list` 的 `projections.modelSelection` 同步当前模型并推送 `session.config`。
- **ACP 模型选择**：`session/new` / `session/load` 返回 `configOptions`（`category=model` 与 `category=thought_level`），实现 `session/set_config_option`，并兼容旧版 `session/set_model`。
- **usage**：WS 把 usage chunk 映射为 `session.usage`（同时认真机 camelCase 与旧版 snake_case）；ACP 发 `usage_update`（`used = inputTokens + cacheReadTokens`，`size` 取自 `projections.contextPressure.contextWindow`）。

### 基础交互

- **图片 prompt**（WS + ACP）：Paseo `mimeType` → DSH `mediaType`；ACP 声明 `promptCapabilities.image`。
- **运行中 steer**（WS）：`delivery:'steer'` → DSH `mode:'steer'`，回与当前轮一致的 `turnId`。
- **任务列表**：DSH `todo/write` → Paseo `todo` 时间线项（WS）与 ACP `plan`。
- **流式预览**：reasoning 实时；正文 block-end 落定；最终 `assistant/message` 同 step 去重。
- **上下文过滤**：DSH 注入的 system-reminder / 记忆 / 时间戳不进入时间线。
- **错误可读化**：DSH 非 JSON 响应（如上游 502）返回可读错误，不再抛 `SyntaxError`。

### 工程

- **测试**：36 条测试 / 11 个测试文件（传输、状态机、契约、模型、ACP、mock 端到端）；`./check.sh`（测试 + typecheck）；`tools/release-check.sh`（pack 清单、禁入文件、脱敏扫描）；GitHub Actions（Node 22/24）。
- **文档**：README、DESIGN、VERIFICATION、TROUBLESHOOTING、RELEASING、LICENSE。

### 已知限制

- DSH 快照窗口固定（实测 `maxMessages=2000` 仍 342 条封顶），超长历史截断。
- Paseo 契约无 token delta；正文不逐字渲染。
- `session.revert` / `archive` / `unarchive` 未实现（DSH 无对应端点，显式 `request.failed`）；`prompt.command`（DSH 没有命令注册 RPC）与 permission 桥接未做（DSH preset 自动执行）。
- 真机验证仅 macOS + Node 26；Node 22/24 由干净目录与 CI 覆盖；并发只测 2 会话。
- DSH 是私有协议，升级 rc 可能改变字段；未知事件会告警而不是猜测。

## 0.x

内部迭代版本（未发布）。
