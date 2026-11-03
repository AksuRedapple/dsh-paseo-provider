# TROUBLESHOOTING

## 1. `paseo provider ls` 显示 `dsh` unavailable

`status()` 会对 DSH 做真实探活。看到 unavailable 时：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8781/
```

- 502 / 连接失败：DSH 后端没起。先确认 `127.0.0.1:8780` 在监听，再按你的 DSH 安装方式启动。
- 200：重新 `paseo plugin reload dsh-provider`，再看 `paseo plugin logs dsh-provider`。

## 2. 插件加载失败 / 改动不生效

```bash
paseo plugin reload dsh-provider
paseo plugin ls | grep dsh-provider
```

- 不要 `paseo daemon restart`（会断用户会话）；热载用 `plugin reload`。
- `daemon reload` 只重读 `config.json`，不重载插件代码。
- reload 前已建立的会话不会自动换新代码；验证请新开会话。

## 3. 回复「慢一拍」/ 工具后丢最终答案

已在 1.0 修复，但如果仍复现：

1. 确认插件真的 reload 了（`paseo plugin logs` 应看到 `Plugin ready` 和 `connect called`）；
2. 新开会话复测（旧连接不会热更新）；
3. 查日志里的 `stream ended ... replyText= turnEnd=`：正常应为 `turnEnd=true`。

## 4. ACP provider 显示 error

`runAcpProvider` 的 status 探针会调用 `session/new`，后者需要 DSH 在线。先修好第 1 条，再看：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | node acp-server.mjs
```

应返回 `agentCapabilities.loadSession: true`。

## 5. DSH 桌面版启动崩溃（上游问题）

如果 `~/bin/dsh-start.sh` 后 8780 仍不监听，且 crash log 出现：

```
inspector: source state exceeds the source-frame byte limit
```

这是 `dsh-experimental-inspector` 的问题（实测 0.2.1-rc.5 桌面 + rc.3 runtime 组合）。处理方式：

- 回退桌面版到与 runtime 匹配的版本，或升级 runtime/等待上游修复；
- 本机实测 workaround（2026-11-03）：备份 `~/.dsh/profiles/desktop/package.json`，从 `dsh.profile.bundles` 移除 `@deepseek-ai/dsh-experimental-inspector-profile`，再跑 `~/bin/dsh-start.sh`；8780 恢复、inspector 不再崩溃；
- 不要通过改 provider 绕过：DSH 后端没起时 provider 只能报 unavailable。

## 6. 收集证据

```bash
paseo plugin logs dsh-provider
tail -100 ~/.paseo/daemon.log
cat /tmp/dsh-acp.log            # ACP 子进程日志（存在时）
```

提 issue 时请附：`node -v`、Paseo 版本、DSH 版本、`curl 8781` 状态码、插件日志中 `Plugin ready` / `stream ended` 行。
