# DeepSeek Harness (desktop)

Paseo provider for DeepSeek Harness (DSH), a desktop agent harness. The plugin talks to the DSH desktop app that is already running on the same machine: it does not install a CLI, create a DSH profile, or change DSH configuration.

## How it works

DSH's desktop app exposes a local HTTP RPC endpoint and a WebSocket mux. The plugin reads the app's launch token from its local web log, exchanges it for an auth cookie on loopback, and connects to `127.0.0.1:8780`. It follows a DSH session with one persistent `session/follow` stream (snapshot, events and assistant stream chunks), converts DSH events into Paseo timeline items, and uses DSH's `turn/end` as the authoritative end of a turn.

## Setup

- Paseo 0.14 or newer (verified with 0.14 and 0.15).
- The DSH desktop app running on the same machine (verified with 0.2.1-rc.x on macOS).
- The plugin discovers the desktop app's launch token from its log. It looks in the platform log locations first — macOS `~/Library/Logs/DeepSeek Harness/` (and the lowercase `deepseek-harness` variant, plus `~/Library/Application Support/@deepseek-ai/dsh-desktop/logs/`), Linux `$XDG_CONFIG_HOME/<app>/logs/` and `~/.local/share/<app>/logs/`, Windows `%APPDATA%` and `%LOCALAPPDATA%` `<app>\logs` — and also tries the Electron `userData/logs` layout on all three platforms.
- Override with `DSH_WEB_LOG=/path/to/dsh-web.log` if the file lives elsewhere; set `DSH_BASE` / `DSH_MUX` to skip discovery entirely. When discovery fails the plugin log lists every path it tried.
- DSH login is handled by DSH; the plugin does not store accounts or tokens.

## Capabilities

- List DSH sessions, open them with history replay, and create new sessions.
- Sync titles: use the DSH title when opening, and write the Paseo title back to DSH for new sessions.
- Stream reasoning and assistant text, tool calls and results, todo lists, token usage and context-window occupancy (refreshed during the turn, after compaction, and on turn end), and turn state.
- Slash commands: the DSH command catalog is advertised to Paseo and `/compact`, `/goal`, `/plan`, `/permission`, `/export`, `/feedback` run through DSH's own `commands/execute` instead of being sent to the model as text. Commands executed in the desktop app are mirrored into the Paseo timeline.
- Interrupt a running turn, close a session, and report whether a runtime can be stopped.
- Model catalog from DSH, including model and reasoning-effort selection for existing sessions.
- Image prompts and steering a running turn.
- Show the DSH goal as a persistent task card (Paseo has no dedicated goal item) and restore goals/todos from projections when opening a session.
- Report snapshot truncation, reconnects and unknown events as visible notices.

## Data access

The plugin reads the local DSH web log to obtain a launch token, then exchanges the token for an auth cookie on `127.0.0.1` and uses that cookie for local HTTP and WebSocket requests. The cookie is kept in memory and is not logged or sent anywhere else. The plugin connects only to the local DSH endpoint; it sends prompts, images, model selections and cancellation requests to DSH. Prompts and tool results are stored and forwarded to model providers by DSH itself. The plugin adds no external services, telemetry, or analytics. Plugin logs contain session ids and event types; prompt text and images are not logged. When `DSH_BASE` or `DSH_MUX` is set, prompts and images are sent to those configured endpoints instead of local discovery.

## Permissions

The plugin runs unsandboxed with the permissions of the user running the Paseo daemon, like other Paseo plugins. It does not add a tool-approval layer: DSH executes tools according to its own configuration preset. It does not modify files outside the DSH endpoints it calls.

## Limitations

- Requires the DSH desktop app to be running; there is no CLI or headless mode.
- Verified on macOS with DSH 0.2.1-rc.x and Paseo 0.14/0.15. The Windows/Linux log candidates are covered by unit tests but have not been run on real hardware; `DSH_WEB_LOG` (or `DSH_BASE`/`DSH_MUX`) overrides discovery on any platform.
- DSH is a private protocol; unknown events are reported as notices, but a DSH release can still change behavior.
- Very long histories are truncated by DSH (reported as a notice; no pagination).
- Permission prompts, MCP servers, session revert and archive are not supported (DSH exposes no endpoints for them; its presets execute tools automatically).
- Prompting a DSH session that is already running in another client steers into the current turn by default; set `DSH_RUNNING_MODE=fail` to reject with a visible busy error instead.
- Title changes made by DSH after a turn are not pushed live (the Paseo provider contract has no title update event); reopening uses the DSH title.
- Goals are rendered as a task card because the Paseo timeline has no dedicated goal item.
