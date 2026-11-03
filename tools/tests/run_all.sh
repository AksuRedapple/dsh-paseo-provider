#!/usr/bin/env bash
# 共享测试 runner：给任意目录跑它的测试，统一判定与留痕。
#
# 为什么要有它：本机各项目的测试一直是「每个 test 单独跑」，所以新项目里没人跑、
# 也跑不出一个统一结论；换会话就忘。统一入口 = 可以写进入口脚本、写进全局规矩。
#
# 用法：
#   run_all.sh <dir> [--fast] [--quiet]
# 发现规则（按顺序）：
#   *.test.sh / *_test.sh / *selftest.sh   → bash 执行
#   test_*.py                              → python3 执行
#   退出码 0 视为 PASS；非 0 视为 FAIL（会打印尾部输出）
# 留痕：<dir>/.test-last.json  {ts, total, pass, fail, fast, results[]}
# 退出码：0 全过；1 有失败；2 没找到测试（也算失败——空测试等于没测试）
set -uo pipefail
DIR="${1:?用法: run_all.sh <dir> [--fast]}"; shift || true
FAST=0; QUIET=0
for a in "$@"; do
  case "$a" in --fast) FAST=1;; --quiet) QUIET=1;; esac
done
[ -d "$DIR" ] || { echo "目录不存在: $DIR"; exit 1; }
DIR="$(cd "$DIR" && pwd)"

# macOS 自带 bash 3.2 没有 mapfile —— 用临时文件列表，保证 while 在**当前 shell** 里跑（计数器才留得住）
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
{ find "$DIR" -maxdepth 1 -type f \( -name '*.test.sh' -o -name '*_test.sh' -o -name '*selftest.sh' \) ;
  find "$DIR" -maxdepth 1 -type f -name 'test_*.py' ; } 2>/dev/null | sort > "$LIST"
TOTAL=$(wc -l < "$LIST" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  echo "  ✗ $DIR 里没有测试（空测试 = 没测试）"
  exit 2
fi

pass=0; fail=0; results=()
export ZB_RUNALL_ACTIVE=1      # 防止测试内部再次调用 run_all 造成递归
echo "▸ $(basename "$DIR") 共 $TOTAL 个测试$([ "$FAST" = 1 ] && echo '（fast）')"
while IFS= read -r t; do
  [ -n "$t" ] || continue
  base="$(basename "$t")"
  # 慢测标记：文件名含 .slow. 时，fast 模式跳过
  if [ "$FAST" = 1 ] && [[ "$base" == *".slow."* ]]; then
    results+=("{\"name\":\"$base\",\"status\":\"skip\"}"); continue
  fi
  case "$t" in
    *.py) out=$(cd "$DIR" && timeout 300 python3 "$t" 2>&1); rc=$? ;;
    *)    out=$(cd "$DIR" && timeout 300 bash "$t" 2>&1); rc=$? ;;
  esac
  if [ "$rc" -eq 0 ]; then
    pass=$((pass+1)); results+=("{\"name\":\"$base\",\"status\":\"pass\"}")
    [ "$QUIET" = 1 ] || echo "  ✓ $base"
  else
    fail=$((fail+1)); results+=("{\"name\":\"$base\",\"status\":\"fail\",\"rc\":$rc}")
    echo "  ✗ $base (rc=$rc)"
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
  fi
done < "$LIST"

python3 - "$DIR" "$pass" "$fail" "$FAST" "${results[@]}" <<'PY'
import json, sys, datetime
d, p, f, fast, *res = sys.argv[1:]
items = []
for r in res:
    try: items.append(json.loads(r))
    except Exception: pass
rec = {"ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
       "total": len(items), "pass": int(p), "fail": int(f), "fast": fast == "1",
       "results": items}
open(f"{d}/.test-last.json", "w", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False, indent=1))
PY

echo "▸ 结果: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
