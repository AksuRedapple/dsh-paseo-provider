# RELEASING — 发布清单

> 目标：把本仓作为普通工程仓库发布，不带本机台账与面试材料。
> 发布前必须得到仓库名与可见性确认；push 是最后一步。

## 1. 发布前检查

- [ ] `./tools/release-check.sh`（测试 + pack 清单 + 禁入文件 + 脱敏扫描）
- [ ] `./check.sh` 通过（tests + typecheck）
- [ ] 干净目录 `npm ci && ./check.sh` 通过
- [ ] Node 22 / 24 至少各跑一次测试
- [ ] `npm pack --dry-run` 文件清单符合预期（README / LICENSE / CHANGELOG / server / docs / acp-server / icon / check.sh）
- [ ] `grep -rn "wuyangbo\\|100\\.77\\.\\|/Users/"`（排除 `forge/`、`STATUS.md`、`JOURNAL.md`）无命中
- [ ] README「已知限制」与代码一致（unsupported 项明确）

## 2. 本地建仓

```bash
cd ~/qoder_place/dsh-provider
git init
git add .
git status          # 确认没有 forge/ STATUS.md JOURNAL.md node_modules *.bak-*
git commit -m "feat: DSH desktop provider for Paseo with persistent WS streaming"
```

`.gitignore` 已排除：`node_modules/`、`*.bak-*`、`.test-last.json`、`.DS_Store`、`forge/`、`STATUS.md`、`JOURNAL.md`。

## 3. 发布到 GitHub

先确认：**仓库名、可见性（public/private）、目标账号**。本机 `gh` 当前 active 可能是 `ouya15`，发布到 aksu 账号前先切换：

```bash
gh auth status
gh auth switch --user AksuRedapple    # 以确认到的账号名为准
```

确认后一键发布（会建仓、push main 和 v1.0.0 tag）：

```bash
tools/publish.sh AksuRedapple <repo-name> public   # 或 private
```

或手动：

```bash
gh repo create AksuRedapple/<repo-name> --public --source . --remote origin --push
git push origin v1.0.0
```

## 4. 发布后

- [ ] GitHub Actions（Node 22/24）绿灯
- [ ] 仓库首页 README 渲染正常；docs 链接可点
- [ ] 无 secret / 本机路径 / 内网信息
- [ ] 如需打 tag：`git tag v1.0.0 && git push origin v1.0.0`

## 5. 不进公开仓的内容

- `forge/`（课堂交接）、`STATUS.md`（踩坑原始记录）、`JOURNAL.md`（内部台账）
- 面试证据卡 / BPE / gauntlet 卡（只在 `4-面试/`）
- 本机运行日志、agent id、会话 id、私网地址
