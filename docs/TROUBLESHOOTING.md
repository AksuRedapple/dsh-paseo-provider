# TROUBLESHOOTING

## 1. `paseo provider ls` 显示 `dsh` unavailable

`status()` 会对 DSH 做真实探活。先看插件日志里的端点来源：

```bash
paseo plugin logs dsh-provider | grep "endpoint"
# [dsh] endpoint discovered http://127.0.0.1:8780   ← 日志 token 换 cookie 成功
# [dsh] endpoint legacy-fallback http://127.0.0.1:8781
```

- 没有 `endpoint discovered`：确认 DSH 桌面版在运行，且 `~/Library/Logs/DeepSeek Harness/dsh-web.log` 有 `dsh web: http://...?token=...`；必要时设 `DSH_WEB_LOG`。
- `legacy-fallback` 且 8781 不通：DSH 后端没起，或本机没有自建代理；官方通道可设 `DSH_BASE`/`DSH_MUX` 兜底。
- `authentication failed`：token 已过期（DSH 重启过），reload 插件会重新读取日志并换 cookie。
- 200 / 连接正常：重新 `paseo plugin reload dsh-provider`，再看日志。

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

## 4. DSH 桌面版启动崩溃（上游问题）

如果 `~/bin/dsh-start.sh` 后 8780 仍不监听，且 crash log 出现：

```
inspector: source state exceeds the source-frame byte limit
```

这是 `dsh-experimental-inspector` 的问题（实测 0.2.1-rc.5 桌面；app 内 runtime 是 rc.5，profile 内 `plugin-market` 仍是 rc.3）。处理方式：

- 回退桌面版到与 runtime 匹配的版本，或升级 runtime/等待上游修复；
- 本机实测 workaround（2026-11-03）：备份 `~/.dsh/profiles/desktop/package.json`，从 `dsh.profile.bundles` 移除 `@deepseek-ai/dsh-experimental-inspector-profile`，再跑 `~/bin/dsh-start.sh`；8780 恢复、inspector 不再崩溃；
- 用户态 runtime 缓存 `~/.dsh/dsh-runtimes/dsh-primary-runtime` 已从 app 内 rc.5 同步（备份 `*.rc3.bak-20261103-131632`）；profile 里 rc.3 的插件包仍需用 pnpm 升级或移除；
- 回滚 rc.3 的实测结论：官方 rc.3 包签名有效，但在 macOS 27.2 上进程停于 dyld（无 host、无 8780），回滚不可行；保留 rc.5 + 移除 inspector；
- 锁定更新（无 sudo）：把 `~/Library/Caches/@deepseek-aidsh-desktop-updater` 与 `com.deepseek.dsh.ShipIt` 设为只读，并禁用 pending；app bundle 受 macOS App Management 保护，用户级 `chflags/chmod` 会被拒；需要硬锁时用 `sudo chflags uchg "/Applications/DeepSeek Harness.app"`（或 hosts 阻断下载域）；
- 不要通过改 provider 绕过：DSH 后端没起时 provider 只能报 unavailable。

## 5. 收集证据

```bash
paseo plugin logs dsh-provider
tail -100 ~/.paseo/daemon.log
```

提 issue 时请附：`node -v`、Paseo 版本、DSH 版本、插件日志中 `endpoint ...` / `Plugin ready` / `stream ended` 行。
