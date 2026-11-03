#!/usr/bin/env bash
# WS provider 基础能力：图片 prompt、steer、todo 时间线（mock DSH）。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_capabilities.test.mjs
