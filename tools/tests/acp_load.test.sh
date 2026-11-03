#!/usr/bin/env bash
# ACP session/load 回放测试，mock DSH，不连真机。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test acp_load.test.mjs
