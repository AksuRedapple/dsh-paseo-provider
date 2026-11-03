#!/usr/bin/env bash
# ACP configOptions（模型/思考档位）+ usage_update（mock DSH，不连真机）。
set -euo pipefail
cd "$(dirname "$0")"
exec node --test acp_config.test.mjs
