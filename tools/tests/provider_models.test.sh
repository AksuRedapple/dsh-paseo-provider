#!/usr/bin/env bash
# WS provider 模型目录/切换 + usage 映射（mock DSH，不连真机）。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_models.test.mjs
