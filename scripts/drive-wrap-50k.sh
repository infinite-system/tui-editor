#!/usr/bin/env bash
# Drive-verify the cumulative wrap index on a REAL 50k-line file: word wrap ON must stay
# responsive and quiescent (the old code walked every line per RootView update through a
# thrashing 512-entry memo), an edit must resync only the delta (quiescence + cursor land
# promptly), and the wrapped extent must make the TRUE last line reachable (Ctrl+End).
# One-shot verification driver (not a gate smoke): the gate's wrap coverage lives in
# scripts/smoke-wrap.sh + behavioral-contracts.sh; this exercises the 50k scale specifically.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
S="wrap50k-$$"
fail=0
f() { "$H" field "$S" "$1"; }

WORKSPACE="$(mktemp -d /tmp/tui-wrap50k.XXXXXX)"
awk 'BEGIN{for(line = 1; line <= 50000; line++){printf "line %06d ", line; for(chunk = 0; chunk < 9; chunk++) printf "abcdefghij"; printf "\n"}}' \
  > "$WORKSPACE/big.txt"
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$WORKSPACE"' EXIT INT TERM

bun_pid_of_session() {
  local candidate
  candidate="$(tmux display-message -p -t "$1" '#{pane_pid}' 2>/dev/null)" || return 1
  for _ in 1 2 3 4; do
    [ -n "$candidate" ] || return 1
    [ "$(cat "/proc/$candidate/comm" 2>/dev/null)" = "bun" ] && { echo "$candidate"; return 0; }
    candidate="$(pgrep -P "$candidate" | head -1)"
  done
  return 1
}

echo "== launch on the 50k-line workspace, open big.txt =="
"$H" launch "$S" 120x40 bun run src/main.ts "$WORKSPACE" >/dev/null
"$H" ready "$S" 25 >/dev/null || { echo "  FAIL boot"; exit 1; }
"$H" send "$S" Enter >/dev/null; sleep 1.0; "$H" settle "$S" 15 >/dev/null 2>&1
buffer="$(f activeBuffer)"
case "$buffer" in */big.txt) echo "  PASS  opened big.txt";; *) echo "  FAIL  did not open big.txt ($buffer)"; exit 1;; esac
APP_PID="$(bun_pid_of_session "$S")"

echo "== word wrap ON at 50k lines: settles, and idle CPU stays ~0 (no per-frame document walk) =="
# Ensure the EDITOR owns focus (opening from the tree usually hands it over already — a blind
# Tab would toggle it right back out).
for _ in 1 2 3; do
  [ "$(f focus)" = "editor" ] && break
  "$H" send "$S" Tab >/dev/null; sleep 0.3
done
[ "$(f focus)" = "editor" ] || { echo "  FAIL  editor never took focus"; exit 1; }
"$H" send "$S" M-z >/dev/null; sleep 1.5
if "$H" settle "$S" 20 >/dev/null 2>&1; then echo "  PASS  wrap-on settled to quiescence"; else echo "  FAIL  never settled after wrap-on"; fail=1; fi
[ "$(f wordWrap)" = "true" ] && echo "  PASS  word wrap is on" || { echo "  FAIL  wordWrap not on"; fail=1; }
sleep 3   # let the ONE-TIME index build + its GC tail finish — the claim is about STEADY state
frame_before="$(f frame)"; ticks_before=$(awk '{print $14+$15}' "/proc/$APP_PID/stat"); sleep 5
frame_after="$(f frame)"; ticks_after=$(awk '{print $14+$15}' "/proc/$APP_PID/stat")
idle_cpu=$(awk -v t=$((ticks_after-ticks_before)) 'BEGIN{printf "%.2f", t*100/(5*100)}')
frame_delta=$((frame_after - frame_before))
if [ "$frame_delta" -eq 0 ] && awk -v c="$idle_cpu" 'BEGIN{exit !(c < 2.0)}'; then
  echo "  PASS  wrapped 50k-line steady state: frames +$frame_delta, CPU ${idle_cpu}% (extent is O(1), no per-frame walk)"
else
  echo "  FAIL  wrapped steady state not quiescent: frames +$frame_delta, CPU ${idle_cpu}%"; fail=1
fi

echo "== an edit resyncs the index as a DELTA: typing stays prompt and requiescess =="
edit_started_ms=$(date +%s%3N)
"$H" send "$S" -l "x" >/dev/null
edit_deadline=$((edit_started_ms + 3000)); edit_landed=0
while [ "$(date +%s%3N)" -lt "$edit_deadline" ]; do
  [ "$(f dirty)" = "true" ] && { edit_landed=1; break; }
  sleep 0.05
done
edit_ms=$(( $(date +%s%3N) - edit_started_ms ))
if [ "$edit_landed" = 1 ] && [ "$edit_ms" -lt 1500 ]; then
  echo "  PASS  edit landed in ${edit_ms}ms on the wrapped 50k file (delta resync, no full rewrap stall)"
else
  echo "  FAIL  edit slow or lost (landed=$edit_landed ${edit_ms}ms)"; fail=1
fi
"$H" settle "$S" 15 >/dev/null 2>&1

echo "== the wrapped extent reaches the TRUE last line (Ctrl+End) =="
"$H" send "$S" C-End >/dev/null; sleep 1.2; "$H" settle "$S" 15 >/dev/null 2>&1
cursor_line="$(f cursorLineIndex)"
# 50000 lines of content + the trailing-newline empty final line = document end is index 49999 or
# 50000 depending on the parse; either proves the wrapped extent reaches the TRUE end.
if [ "${cursor_line:-0}" -ge 49999 ] 2>/dev/null; then
  echo "  PASS  cursor reached the document end (line index $cursor_line — extent/locate agree)"
else
  echo "  FAIL  cursor at '$cursor_line', expected the document end"; fail=1
fi
if "$H" capture "$S" | grep -q "line 050000"; then
  echo "  PASS  the last line's content renders (window locate lands mid-document correctly)"
else
  echo "  FAIL  last line content not on screen"; fail=1
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
