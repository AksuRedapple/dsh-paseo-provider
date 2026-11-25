#!/usr/bin/env bash
# WS provider 契约测试（sessions / replay / unsupported），mock DSH，不连真机。
set -euo pipefail
cd "$(dirname "$0")"
# --test-force-exit：这些用例会开长连接（mock DSH 的 mux / $events）。
# 用例本身跑完，但泄漏的 socket 会让 node --test 永不退出（Linux + Node 22 必现，本地看运气）。
# 该 flag 只在 runner 跑完后强制退进程，不掩盖失败（rc 仍按测试结果给）。
exec node --test --test-force-exit provider_contract.test.mjs
