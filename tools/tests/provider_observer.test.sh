#!/usr/bin/env bash
# 只读实时镜像（observer）端到端 mock，不连真实 DSH。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test provider_observer.test.mjs
