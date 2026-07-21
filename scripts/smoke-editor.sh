#!/usr/bin/env bash
# End-to-end editor smoke: boot the real TUI under tmux, drive it, assert STATE from
# artifacts/status.json (via tui-harness.sh). Exercises the reactive frame effect, tree nav,
# file open, editing, the palette, and clean quit. Usage: scripts/smoke-editor.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-$$"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
FRAME="$ROOT/artifacts/frame-$S.json"
STATUSF="$ROOT/artifacts/status-$S.json"
fail=0
f()    { "$H" field "$S" "$1"; }
chk()  { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
chkne(){ if [ -n "$2" ] && [ "$2" != "null" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: '$2'"; fail=1; fi; }
gt()   { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT

echo "== launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
export TUI_FRAME_DUMP=1
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

"$H" settle "$S" >/dev/null 2>&1
echo "== caret cell == typed glyph cell (human-QA regression: was one row high) =="
if [ "${TUI_FRAME_DUMP:-}" = "1" ]; then
  caret_check="$(FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
let qx=-1,qy=-1;
for(let y=0;y<f.height && qx<0;y++){let cell=0;for(const ch of f.rows[y].text){if(ch==="X"){qx=cell;qy=y;break}cell++;}}
const [cx,cy]=process.argv[1].split(",").map(Number);
console.log(qx>=0 && cx===qx+1 && cy===qy ? "OK" : `WRONG glyph=(${qx},${qy}) caret=(${cx},${cy})`);
' "$(tmux display-message -p -t "$S" '#{cursor_x},#{cursor_y}')")"
  if [ "$caret_check" = "OK" ]; then echo "  PASS  caret immediately after typed glyph, same row"; else echo "  FAIL  caret misplaced: $caret_check"; fail=1; fi
else
  echo "  SKIP  (run with TUI_FRAME_DUMP=1 for the caret-cell check)"
fi

echo "== no soft-wrap: long line 1 stays one row; gutter 2 on the next row (human-QA regression) =="
wrap_check="$(FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
let qy=-1;
for(let y=0;y<f.height && qy<0;y++){for(const ch of f.rows[y].text){if(ch==="X"){qy=y;break}}}
if(qy<0){console.log("WRONG no typed glyph found");process.exit(0)}
// Consecutive rows must carry CONSECUTIVE gutter numbers (one file line == one visual row). A
// wrap tail leaves a blank gutter on the next row and shifts every number after it.
const gutterNumber=(y)=>{const m=f.rows[y].text.slice(33,40).match(/\d+/);return m?Number(m[0]):null};
const here=gutterNumber(qy), below=gutterNumber(qy+1);
console.log(here!==null && below===here+1 ? "OK" : `WRONG here=${here} below=${below}`);
')"
if [ "$wrap_check" = "OK" ]; then echo "  PASS  one file line == one visual row (gutter aligned)"; else echo "  FAIL  wrap/gutter desync: $wrap_check"; fail=1; fi

echo "== selection (Shift+Right selects; Escape clears) =="
"$H" send "$S" S-Right >/dev/null
chk "hasSelection after Shift+Right" "$(f hasSelection)" "true"
chkne "selection range published" "$(f selection)"
"$H" send "$S" Escape >/dev/null
chk "selection cleared after Escape" "$(f hasSelection)" "false"

echo "== mouse drag-select persists + Ctrl+C copies (human-QA regression) =="
# Drag along row y=2 (doc line 1, "A tiny project..." — a CONTENT line; an empty line cannot hold
# a horizontal selection).
"$H" drag "$S" 40 2 50 2 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "drag created a selection" "$(f hasSelection)" "true"
sleep 0.8
"$H" settle "$S" >/dev/null 2>&1
chk "selection persists across frames" "$(f hasSelection)" "true"
"$H" send "$S" C-c >/dev/null
sleep 0.4
copied="$(f lastCopyChars)"
if [ -n "$copied" ] && [ "$copied" != "null" ] && [ "$copied" -gt 0 ] 2>/dev/null; then echo "  PASS  Ctrl+C copied $copied chars"; else echo "  FAIL  Ctrl+C copied nothing (lastCopyChars=$copied)"; fail=1; fi
"$H" send "$S" Escape >/dev/null

echo "== mouse input path (real SGR click arrives) =="
"$H" click "$S" 40 5 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
mouse="$(f mouse)"
if [ -n "$mouse" ] && [ "$mouse" != "null" ]; then echo "  PASS  mouse click registered ($mouse)"; else echo "  FAIL  mouse click did not register"; fail=1; fi

echo "== h-scroll range: End reveals the long line's end (scrollbar geometry regression) =="
"$H" click "$S" 40 1 >/dev/null   # put the cursor ON the long line (row y=1 = doc line 0)
tmux send-keys -t "$S" End; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
end_visible="$(FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
let ok=false;for(let y=0;y<f.height;y++) if(f.rows[y].text.includes("desync)")){ok=true;break}
console.log(ok?"OK":"CUT");
')"
if [ "$end_visible" = "OK" ]; then echo "  PASS  line end visible at max scrollLeft"; else echo "  FAIL  line end cut off at max scrollLeft"; fail=1; fi
tmux send-keys -t "$S" Home; sleep 0.3

echo "== drag-edge auto-scroll: hold at right edge scrolls + extends selection =="
tmux send-keys -t "$S" -l "$(printf '\033[<0;50;2M')"; sleep 0.1     # press on line 0 (long line)
tmux send-keys -t "$S" -l "$(printf '\033[<32;118;2M')"; sleep 0.1   # drag to right edge, HOLD
sleep 0.9; "$H" settle "$S" >/dev/null 2>&1
edge_scroll="$(f editorScrollLeft)"
tmux send-keys -t "$S" -l "$(printf '\033[<0;118;2m')"; sleep 0.3    # release
if [ -n "$edge_scroll" ] && [ "$edge_scroll" -gt 5 ] 2>/dev/null; then echo "  PASS  edge hold auto-scrolled (scrollLeft=$edge_scroll)"; else echo "  FAIL  no edge auto-scroll (scrollLeft=$edge_scroll)"; fail=1; fi
"$H" send "$S" Escape >/dev/null
tmux send-keys -t "$S" Home; sleep 0.2   # reset horizontal scroll for later checks

echo "== tree click: select, click-again activates; click-to-focus (human-QA regression) =="
"$H" send "$S" Escape >/dev/null   # ensure editor focus first (escape w/o selection -> files)... then re-focus editor by clicking
"$H" click "$S" 5 1 >/dev/null     # click tree row 0 -> select + focus files
chk "tree click focuses files" "$(f focus)" "files"
chk "tree click selected row 0" "$(f treeSelected)" "0"
"$H" click "$S" 60 5 >/dev/null    # click editor pane -> focus editor
chk "editor click focuses editor" "$(f focus)" "editor"

echo "== single-dispatch: a tree click opens WITHOUT moving the editor cursor =="
"$H" click "$S" 60 6 >/dev/null   # place the cursor somewhere via an editor click
"$H" settle "$S" >/dev/null 2>&1
"$H" click "$S" 5 2 >/dev/null    # click a tree FILE row (data.json)
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
opened_buffer="$(f activeBuffer)"
cursor_line="$(STATUS_FILE="$STATUSF" "$BUN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.STATUS_FILE)).cursor?.line ?? -1)')"
case "$opened_buffer" in *greeter.ts) buffer_ok=1;; *) buffer_ok=0;; esac  # y=2 = greeter.ts (src expanded by the earlier click test)
if [ "$buffer_ok" = 1 ] && [ "$cursor_line" = "0" ]; then echo "  PASS  tree click opened a file, cursor stayed at line 0 (no double-dispatch)"; else echo "  FAIL  double-dispatch? buffer=$opened_buffer cursorLine=$cursor_line"; fail=1; fi

echo "== command palette (Ctrl+P) =="
"$H" send "$S" C-p >/dev/null
chk "palette overlay" "$(f overlay)" "palette"
echo "  info: paletteMatches=$(f paletteMatches)"
"$H" send "$S" Escape >/dev/null
chk "palette closed" "$(f overlay)" "null"

echo "== idle quiescence: rendering is demand-driven; the loop STOPS at rest (frame delta == 0) =="
# Authoritative signal is the FRAME COUNTER, not CPU (empty frames are cheap, so a CPU check passes
# even while the loop ticks — the false-green that a pre-fix build shipped). After a settle, the
# status frame counter must not advance at all over a fully-untouched window.
"$H" send "$S" Escape >/dev/null   # clear any lingering overlay/selection -> true rest
"$H" settle "$S" >/dev/null 2>&1
sleep 1
idle_frame_start="$(f frame)"
sleep 5   # 5s FULLY untouched — no input, no harness sends
idle_frame_end="$(f frame)"
idle_frame_delta=$(( idle_frame_end - idle_frame_start ))
if [ "$idle_frame_delta" -eq 0 ]; then
  echo "  PASS  idle frame delta == 0 over 5s untouched (frame stayed $idle_frame_start)"
else
  echo "  FAIL  idle loop still ticking: frame $idle_frame_start -> $idle_frame_end (+$idle_frame_delta over 5s, ~$((idle_frame_delta / 5))fps) — rendering is NOT demand-driven"
  fail=1
fi

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
