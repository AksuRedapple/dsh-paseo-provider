# DeepSeek Harness (WS + ACP)

Paseo providers for DeepSeek Harness (DSH), a desktop agent harness. The plugin adds two providers: a WebSocket provider backed by DSH's session stream, and an ACP provider for clients that prefer the Agent Client Protocol.

The plugin works with the stock DSH desktop app. It does not install a DSH profile plugin, does not edit anything under `~/.dsh`, and needs only a Paseo plugin reload; the other approach to this integration adds a bridge inside DSH and requires a daemon restart.

## How it works

DSH runs locally and exposes an HTTP RPC endpoint plus a WebSocket mux at `/api/remote.mux`. The plugin follows a DSH session with one persistent `session/follow` stream (snapshot, events and assistant stream chunks), converts DSH events into Paseo timeline items, and uses `turn/end` as the authoritative end of a turn. The ACP provider is a small stdio adapter (`acp-server.mjs`) over the same DSH endpoints, so both providers share one turn state machine and one set of failure semantics.

## Setup

- Paseo 0.14 or newer.
- DSH desktop 0.2.1-rc.x running on the same machine, reachable at `127.0.0.1:8781` (the plugin reads `DSH_BASE` and `DSH_MUX` if a different local endpoint is used).
- DSH login is handled by DSH itself; the plugin does not store or request accounts or tokens.
- The ACP provider starts `acp-server.mjs` with the Node.js runtime of the Paseo daemon.

## Capabilities

- List DSH sessions, open them with history replay, and create new sessions.
- Stream reasoning and assistant text, tool calls and results, todo lists, usage, and turn state.
- Interrupt a running turn, close a session, and report whether a runtime can be stopped.
- Model catalog from DSH, including model and reasoning-effort selection for existing sessions.
- Image prompts and steering a running turn.
- ACP: streaming output, tool calls, model selection through session config options, context usage updates, plans, and session history replay.

## Data access

The plugin connects only to the local DSH endpoint (`127.0.0.1:8781` by default). It reads DSH session data and sends prompts, images, model selections and cancellation requests to DSH. Prompts and tool results are processed and stored by DSH, and are forwarded by DSH to the model providers configured inside DSH; the plugin adds no external services, telemetry, or analytics. No credentials are read beyond the optional local endpoint environment variables.

## Permissions

The plugin runs unsandboxed with the permissions of the user running the Paseo daemon, like other Paseo plugins. It does not add a tool-approval layer: DSH executes tools according to its own configuration preset. The plugin does not modify files outside the DSH endpoints it calls.

## Limitations

- DSH snapshot windows are fixed by DSH; very long histories may be truncated (the plugin reports truncation instead of paginating).
- Permission prompts, slash commands, session revert and archive are not supported because DSH exposes no corresponding endpoints or runs without per-tool approval.
- MCP servers configured in Paseo are not forwarded into DSH; the agent only sees DSH's own tools.
- Verified on macOS with DSH 0.2.1-rc.x and Paseo 0.14; other platforms are untested.
- DSH is a private protocol. Unknown events and fields are reported as notices rather than guessed, but a DSH release can still change behavior.
