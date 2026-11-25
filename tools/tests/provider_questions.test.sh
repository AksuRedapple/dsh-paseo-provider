#!/usr/bin/env bash
# 提问卡端到端：$events 认领 → Paseo session.permission → 回包 $events/result。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_questions.test.mjs
