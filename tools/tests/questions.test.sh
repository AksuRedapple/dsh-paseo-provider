#!/usr/bin/env bash
# 提问卡纯映射：DSH questions ↔ Paseo question card（无 I/O）。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test questions.test.mjs
