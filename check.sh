#!/usr/bin/env bash
# dsh-provider 统一入口：先测试闸，再类型检查。
set -euo pipefail
cd "$(dirname "$0")"

"$PWD/tools/tests/run_all.sh" "$PWD/tools/tests" --fast --quiet || exit 1
npm run typecheck --silent
