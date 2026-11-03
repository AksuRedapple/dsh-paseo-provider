#!/usr/bin/env bash
# ACP 端到端 mock（HTTP + WS），不连真实 DSH。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test acp_mock.test.mjs
