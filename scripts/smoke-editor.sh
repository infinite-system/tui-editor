#!/usr/bin/env bash
# End-to-end editor smoke: boot the real TUI under tmux, drive it, assert STATE from
# artifacts/status.json (via tui-harness.sh). Exercises the reactive frame effect, tree nav,
# file open, editing, the palette, and clean quit. Usage: scripts/smoke-editor.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-$$"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()    { "$H" field "$1"; }
chk()  { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
chkne(){ if [ -n "$2" ] && [ "$2" != "null" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: '$2'"; fail=1; fi; }
gt()   { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT

echo "== launch + boot =="
"$H" launch "$S" 120x40 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; echo "--- status ---"; "$H" status; echo "--- pane ---"; "$H" capture "$S"; exit 1
fi
chk "ready" "$(f ready)" "true"
chkne "activeWorkspace" "$(f activeWorkspace)"
echo "  info: treeRows=$(f treeRows) focus=$(f focus) size=$(f width)x$(f height)"

echo "== navigate file tree =="
"$H" send "$S" Down >/dev/null
"$H" send "$S" Down >/dev/null
echo "  info: treeSelected=$(f treeSelected)"

echo "== open a file (walk the tree, Enter to open/expand) =="
for _ in 1 2 3 4 5 6 7 8; do
  b="$(f activeBuffer)"; [ -n "$b" ] && [ "$b" != "null" ] && break
  "$H" send "$S" Enter >/dev/null
  "$H" send "$S" Down >/dev/null
done
chkne "activeBuffer" "$(f activeBuffer)"

echo "== focus editor + type (reactive frame + editing + coordinate model) =="
"$H" send "$S" Right >/dev/null
rev0="$(f bufferRevision)"
"$H" send "$S" -l X >/dev/null
rev1="$(f bufferRevision)"
gt "typing bumped bufferRevision" "$rev1" "$rev0"
echo "  info: dirty=$(f dirty) cursor=$(f cursor)"

echo "== selection (Shift+Right selects; Escape clears) =="
"$H" send "$S" S-Right >/dev/null
chk "hasSelection after Shift+Right" "$(f hasSelection)" "true"
chkne "selection range published" "$(f selection)"
"$H" send "$S" Escape >/dev/null
chk "selection cleared after Escape" "$(f hasSelection)" "false"

echo "== mouse input path (real SGR click arrives) =="
"$H" click "$S" 40 5 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
mouse="$(f mouse)"
if [ -n "$mouse" ] && [ "$mouse" != "null" ]; then echo "  PASS  mouse click registered ($mouse)"; else echo "  FAIL  mouse click did not register"; fail=1; fi

echo "== command palette (Ctrl+P) =="
"$H" send "$S" C-p >/dev/null
chk "palette overlay" "$(f overlay)" "palette"
echo "  info: paletteMatches=$(f paletteMatches)"
"$H" send "$S" Escape >/dev/null
chk "palette closed" "$(f overlay)" "null"

echo "== quit (Ctrl+Q) + terminal restore =="
"$H" send "$S" C-q >/dev/null
if "$H" capture "$S" 2>/dev/null | grep -q "Command Palette"; then
  echo "  FAIL  UI still rendered after quit"; fail=1
else
  echo "  PASS  quit (editor UI gone from pane)"
fi

echo "== visual (final pane tail) =="
"$H" capture "$S" 2>/dev/null | tail -4
echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
