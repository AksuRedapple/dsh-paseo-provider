#!/usr/bin/env bash
# 包一层 node --test，让共享 runner（run_all.sh）能发现并判定。
# 不连 DSH、不连网络、不启 paseo。
set -euo pipefail
cd "$(dirname "$0")"
# --test-force-exit：这些用例会开长连接（mock DSH 的 mux / $events）。
# 用例本身跑完，但泄漏的 socket 会让 node --test 永不退出（Linux + Node 22 必现，本地看运气）。
# 该 flag 只在 runner 跑完后强制退进程，不掩盖失败（rc 仍按测试结果给）。
exec node --test --test-force-exit provider_stream.test.mjs
