#!/usr/bin/env bash
# DSH 端点/鉴权自动发现：日志解析、cookie 交换、cookie 鉴权 mock 端到端。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test dsh_endpoint.test.mjs
