#!/usr/bin/env bash
# Live regression: the file tree scrolls as one uniform surface via an INDEPENDENT window offset, and
# clicking a visible row NEVER moves the scroll position (the user-QA "click jumps to top" bug).
# Drives real SGR wheel + click sequences and asserts the tree scrollTop from status.json.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="tree-scroll-$$"
BUN="$HOME/.bun/bin/bun"
fail=0
f() { "$H" field "$S" "$1"; }

WORKSPACE="$(mktemp -d /tmp/tui-tree-scroll.XXXXXX)"
for fileNumber in $(seq -w 1 60); do printf 'x\n' > "$WORKSPACE/file-$fileNumber.txt"; done
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$WORKSPACE"' EXIT

echo "== launch + boot (60-file workspace so the tree overflows) =="
"$H" launch "$S" 120x40 bun run src/main.ts "$WORKSPACE" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot"; else echo "  FAIL  boot"; exit 1; fi
echo "  info: rows=$(f treeRows) scrollTop=$(f treeScrollTop)"

echo "== wheel scrolls the WINDOW, not the selection (no swim) =="
for _ in 1 2 3 4 5 6 7 8; do tmux send-keys -t "$S" -l "$(printf '\033[<65;10;10M')"; sleep 0.1; done
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
scrolled="$(f treeScrollTop)"; selected_after_scroll="$(f treeSelected)"
if [ "${scrolled:-0}" -gt 0 ] 2>/dev/null; then echo "  PASS  wheel scrolled the window (scrollTop=$scrolled)"; else echo "  FAIL  wheel did not scroll the window (scrollTop=$scrolled)"; fail=1; fi
if [ "$selected_after_scroll" = "0" ]; then echo "  PASS  wheel left the selection put (selected=0)"; else echo "  FAIL  wheel moved the selection (selected=$selected_after_scroll)"; fail=1; fi

echo "== clicking a visible lower row does NOT move the scroll (no jump-to-top) =="
tmux send-keys -t "$S" -l "$(printf '\033[<0;10;20M')"; sleep 0.05
tmux send-keys -t "$S" -l "$(printf '\033[<0;10;20m')"; sleep 0.3
"$H" settle "$S" >/dev/null 2>&1
after_click="$(f treeScrollTop)"; opened="$(f activeBuffer)"
if [ "$after_click" = "$scrolled" ]; then echo "  PASS  scroll stayed put on click ($scrolled)"; else echo "  FAIL  click jumped the scroll ($scrolled -> $after_click)"; fail=1; fi
if [ -n "$opened" ] && [ "$opened" != "null" ]; then echo "  PASS  click opened the clicked row ($(basename "$opened"))"; else echo "  FAIL  click opened nothing"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
