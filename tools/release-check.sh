#!/usr/bin/env bash
# 发布门禁：测试 + typecheck + pack 清单 + 禁入文件 + 脱敏扫描。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ check.sh"
./check.sh

echo "▸ npm pack 清单"
PACK=$(npm pack --dry-run 2>&1)
echo "$PACK" | grep -q "README.md" || { echo "missing README.md"; exit 1; }
echo "$PACK" | grep -q "LICENSE" || { echo "missing LICENSE"; exit 1; }
echo "$PACK" | grep -q "CHANGELOG.md" || { echo "missing CHANGELOG.md"; exit 1; }
echo "$PACK" | grep -q "server/dsh-follow.mjs" || { echo "missing dsh-follow.mjs"; exit 1; }
echo "$PACK" | grep -q "server/acp-map.mjs" || { echo "missing acp-map.mjs"; exit 1; }
echo "$PACK" | grep -q "docs/DESIGN.md" || { echo "missing DESIGN.md"; exit 1; }
echo "$PACK" | grep -q "docs/VERIFICATION.md" || { echo "missing VERIFICATION.md"; exit 1; }
echo "$PACK" | grep -q "docs/TROUBLESHOOTING.md" || { echo "missing TROUBLESHOOTING.md"; exit 1; }

echo "▸ 禁入公开仓的文件"
for bad in "forge/" "STATUS.md" "JOURNAL.md" "BPE" "node_modules"; do
  if echo "$PACK" | grep -q "$bad"; then
    echo "forbidden in pack: $bad"; exit 1
  fi
done

echo "▸ 脱敏扫描"
if grep -rn "wuyangbo\|100\.77\.\|/Users/" \
  --include="*.ts" --include="*.mjs" --include="*.json" --include="*.md" --include="*.yml" . 2>/dev/null \
  | grep -v node_modules | grep -v "^./forge/" | grep -v "^./STATUS.md" | grep -v "^./JOURNAL.md" \
  | grep -v "^./docs/RELEASING.md" \
  | head -1 | grep -q .; then
  echo "sensitive path/host found"; exit 1
fi

echo "▸ release-check OK"
