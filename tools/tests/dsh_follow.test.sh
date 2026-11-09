#!/usr/bin/env bash
# 断线重连的端点重解析（2026-11-10）。纯本地 mock，不连真 DSH。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test dsh_follow.test.mjs
