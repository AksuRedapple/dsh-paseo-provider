#!/usr/bin/env bash
# 包一层 node --test，让共享 runner（run_all.sh）能发现并判定。
# 不连 DSH、不连网络、不启 paseo。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test acp_map.test.mjs
