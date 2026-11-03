#!/usr/bin/env bash
# WS provider 契约测试（sessions / replay / unsupported），mock DSH，不连真机。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_contract.test.mjs
