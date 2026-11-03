# DeepSeek Harness (desktop)

Paseo provider for DeepSeek Harness (DSH), a desktop agent harness. The plugin talks to the DSH desktop app that is already running on the same machine: it does not install a CLI, create a DSH profile, or change DSH configuration.

## How it works

DSH's desktop app exposes a local HTTP RPC endpoint and a WebSocket mux. The plugin reads the app's launch token from its local web log, exchanges it for an auth cookie on loopback, and connects to `127.0.0.1:8780`. It follows a DSH session with one persistent `session/follow` stream (snapshot, events and assistant stream chunks), converts DSH events into Paseo timeline items, and uses DSH's `turn/end` as the authoritative end of a turn.

## Setup

- Paseo 0.14 or newer.
- The DSH desktop app running on the same machine (verified with 0.2.1-rc.x on macOS).
- The plugin reads `~/Library/Logs/DeepSeek Harness/dsh-web.log` on macOS. Set `DSH_WEB_LOG` if the log is elsewhere, or `DSH_BASE` / `DSH_MUX` to skip discovery.
- DSH login is handled by DSH; the plugin does not store accounts or tokens.

## Capabilities

- List DSH sessions, open them with history replay, and create new sessions.
- Stream reasoning and assistant text, tool calls and results, todo lists, token usage and context-window occupancy, and turn state.
- Interrupt a running turn, close a session, and report whether a runtime can be stopped.
- Model catalog from DSH, including model and reasoning-effort selection for existing sessions.
- Image prompts and steering a running turn.
- Report snapshot truncation, reconnects and unknown events as visible notices.

## Data access

The plugin reads the local DSH web log to obtain a launch token, then exchanges the token for an auth cookie on `127.0.0.1` and uses that cookie for local HTTP and WebSocket requests. The cookie is kept in memory and is not logged or sent anywhere else. The plugin connects only to the local DSH endpoint; it sends prompts, images, model selections and cancellation requests to DSH. Prompts and tool results are stored and forwarded to model providers by DSH itself. The plugin adds no external services, telemetry, or analytics.

## Permissions

The plugin runs unsandboxed with the permissions of the user running the Paseo daemon, like other Paseo plugins. It does not add a tool-approval layer: DSH executes tools according to its own configuration preset. It does not modify files outside the DSH endpoints it calls.

## Limitations

- Requires the DSH desktop app to be running; there is no CLI or headless mode.
- Verified on macOS with DSH 0.2.1-rc.x and Paseo 0.14. Windows and Linux are untested and need `DSH_WEB_LOG` or `DSH_BASE`.
- DSH is a private protocol; unknown events are reported as notices, but a DSH release can still change behavior.
- Very long histories are truncated by DSH (reported as a notice; no pagination).
- Permission prompts, MCP servers, slash commands, session revert and archive are not supported.
- Prompting a DSH session that is already running in another client fails fast with a visible error instead of queueing.
