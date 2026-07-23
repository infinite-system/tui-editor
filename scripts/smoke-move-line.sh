#!/usr/bin/env bash
# Move-line / duplicate-line smoke (pure editor model op). Two layers:
#   A) deterministic unit tests via `bun test` (doc mutations + cursor + one-step undo).
#   B) real drive under tmux: open a .ts fixture, run the commands through the COMMAND PALETTE (robust —
#      avoids modifier-arrow encoding), and assert via the probe that the document reordered, the cursor
#      followed, and one undo restored. (The Alt+Shift+↑/↓ + Ctrl+Shift+D chords route to the same
#      handlers; the palette drive exercises the model op end to end.)
# Usage: scripts/smoke-move-line.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
FIX="$(mktemp -d /tmp/tui-moveline.XXXXXX)"
S="moveline-$$"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
type_str() { local i; for ((i=0;i<${#1};i++)); do "$H" send "$S" "${1:$i:1}" >/dev/null; sleep 0.03; done; }
# Run a palette command by title: F1 opens the palette, type the title, Enter runs the top match.
run_command() { "$H" send "$S" F1 >/dev/null; sleep 0.3; tmux send-keys -t "$S" -l "$1"; sleep 0.3; "$H" send "$S" Enter >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }

# git-init'd fixture so quick-open (enumerates via `git ls-files --others`) lists the file. No trailing
# newline, so the document is exactly 3 lines (a trailing \n would add an empty 4th line to editorLines).
printf 'one\ntwo\nthree' > "$FIX/sample.ts"
( cd "$FIX" && git init -q )

trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$FIX"' EXIT INT TERM

echo "== A) deterministic unit tests (doc mutation + cursor + one-step undo) =="
if "$BUN" test src/modules/editor/__tests__/moveLine.test.ts >/tmp/moveline-unit-$$.log 2>&1; then
  echo "  PASS  move-line unit tests (move up/down, edge no-op, duplicate, cursor follows, undo reverts in one step)"
else
  echo "  FAIL  move-line unit tests"; tail -25 /tmp/moveline-unit-$$.log; fail=1
fi
rm -f /tmp/moveline-unit-$$.log

echo "== B) launch + open the fixture =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
"$H" send "$S" C-p >/dev/null; sleep 1.0; "$H" settle "$S" >/dev/null 2>&1
type_str "sample"
"$H" send "$S" Enter >/dev/null; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
# Quick-open leaves focus on the file tree; Tab moves it to the editor so the C-z undo chord (context
# 'editor') resolves. The palette commands run regardless of focus, but raw chords need editor focus.
"$H" send "$S" Tab >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
chk "editor focused" "$(f focus)" "editor"
chk "opened the fixture at line order one,two,three" "$(f editorLines)" "one,two,three"
chk "cursor starts on line 0" "$(f cursorLineIndex)" "0"

echo "== Move Line Down: line 0 swaps below and the cursor follows =="
run_command "Move Line Down"
chk "lines reordered (two,one,three)" "$(f editorLines)" "two,one,three"
chk "cursor followed the moved line to index 1" "$(f cursorLineIndex)" "1"

echo "== one undo restores the move entirely =="
"$H" send "$S" C-z >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "lines restored (one,two,three)" "$(f editorLines)" "one,two,three"
chk "cursor restored to line 0" "$(f cursorLineIndex)" "0"

echo "== Move Line Up at the top edge is a no-op =="
run_command "Move Line Up"
chk "top-edge move-up left the order unchanged" "$(f editorLines)" "one,two,three"
chk "cursor unchanged at line 0" "$(f cursorLineIndex)" "0"

echo "== Duplicate Line: a copy is inserted below and the cursor lands on it =="
run_command "Duplicate Line"
chk "line 0 duplicated (one,one,two,three)" "$(f editorLines)" "one,one,two,three"
chk "cursor on the copy (line 1)" "$(f cursorLineIndex)" "1"
"$H" send "$S" C-z >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "one undo removes the duplicate" "$(f editorLines)" "one,two,three"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
