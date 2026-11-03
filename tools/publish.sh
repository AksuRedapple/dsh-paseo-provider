#!/usr/bin/env bash
# 发布到 GitHub：tools/publish.sh <owner> <repo> <public|private>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <owner> <repo> <public|private>" >&2
  exit 1
fi
OWNER="$1"; REPO="$2"; VIS="$3"
case "$VIS" in public|private) ;; *) echo "visibility must be public or private" >&2; exit 1;; esac

cd "$(dirname "$0")/.."

git rev-parse --verify v1.0.0 >/dev/null 2>&1 || { echo "tag v1.0.0 missing" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree dirty; commit first" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated" >&2; exit 1; }

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "repo $OWNER/$REPO already exists" >&2
  exit 1
fi

gh repo create "$OWNER/$REPO" "--$VIS" --source . --remote origin --push \
  --description "Paseo provider for the DeepSeek Harness desktop app: persistent WS mux streaming"
git push origin v1.0.0
gh repo view "$OWNER/$REPO" --json url,visibility
