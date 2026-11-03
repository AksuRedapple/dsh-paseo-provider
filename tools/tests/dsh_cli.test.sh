#!/usr/bin/env bash
# dsh CLI 发现逻辑（桌面版内置 → PATH，纯函数测试）。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test dsh_cli.test.mjs
