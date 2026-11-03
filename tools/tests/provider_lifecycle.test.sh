#!/usr/bin/env bash
# WS provider 生命周期端到端 mock（interrupt/close/can_stop），不连真实 DSH。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_lifecycle.test.mjs
