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

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
export TUI_FRAME_DUMP=1
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; echo "--- status ---"; "$H" status; echo "--- pane ---"; "$H" capture "$S"; exit 1
fi
chk "ready" "$(f ready)" "true"
chkne "activeWorkspace" "$(f activeWorkspace)"
echo "  info: treeRows=$(f treeRows) focus=$(f focus) size=$(f width)x$(f height)"

# Height-robust content offset: the whole layout below the workspace tab strip shifts down by this
# many rows when the strip grows past 1 line (two-line workspace tabs -> offset 1). Every hardcoded
# content/tree/editor click y below is expressed as base+content_offset so the smoke passes at any
# strip height. Derived from the rendered frame, not a compiled-in constant.
content_offset="$("$H" content-offset "$S" 2>/dev/null)"; content_offset="${content_offset:-0}"
echo "  info: content_offset=$content_offset (workspace strip height - 1)"

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
const gutterNumber=(y)=>{const m=f.rows[y].text.slice(37,44).match(/\d+/);return m?Number(m[0]):null};
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

echo "== undo back to the saved content reads UNCHANGED (dirty clears — flag AND the rendered ● dot) =="
# The buffer is dirty from the X typed earlier. Undo every edit back to the on-disk content: dirty
# must CLEAR — a buffer undone all the way to its saved state is not modified (it used to stay dirty
# forever after the first edit). We assert BOTH the internal flag AND the RENDERED tab dot, because the
# user's symptom is the visible ● (the field could clear while the dot stays). FrameProbe remaps the ●
# glyph into its opaque plane, so we assert the dot CELL is non-space (dirty) vs a space (clean). The
# tab row shows " <name> " (leading space); the pane-border legend row shows "─<name>", so the
# leading-space search picks the tab, not the border.
dot_state() { BASE="$(basename "$(f activeBuffer)")" FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));const needle=" "+process.env.BASE+" ";
let out="notab";
for(const row of f.rows){const t=row.text||"";const i=t.indexOf(needle);if(i>=0){out=(t[i+needle.length]||" ")===" "?"clean":"dot";break;}}
process.stdout.write(out);'; }
chk "buffer dirty from the earlier edit (flag)" "$(f dirty)" "true"
chk "the tab shows the ● dirty dot while dirty" "$(dot_state)" "dot"
for _ in 1 2 3 4 5; do [ "$(f dirty)" = "false" ] && break; "$H" send "$S" C-z >/dev/null; sleep 0.25; "$H" settle "$S" >/dev/null 2>&1; done
chk "undo to the saved content cleared the flag" "$(f dirty)" "false"
chk "undo to the saved content cleared the RENDERED ● dot" "$(dot_state)" "clean"
"$H" send "$S" -l X >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1   # restore a dirty edit for the later close-tab step

echo "== mouse drag-select persists + Ctrl+C copies (human-QA regression) =="
# Drag along doc line 1 ("A tiny project..." — a CONTENT line; an empty line cannot hold a
# horizontal selection). Screen row = editor content top, shifted by the workspace-strip height.
# x is +4 for the far-left activity bar (Task 7) which shifts all editor content right by its 4 cols.
"$H" drag "$S" 44 $((3 + content_offset)) 54 $((3 + content_offset)) >/dev/null
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
"$H" click "$S" 44 $((6 + content_offset)) >/dev/null
"$H" settle "$S" >/dev/null 2>&1
mouse="$(f mouse)"
if [ -n "$mouse" ] && [ "$mouse" != "null" ]; then echo "  PASS  mouse click registered ($mouse)"; else echo "  FAIL  mouse click did not register"; fail=1; fi

echo "== h-scroll range: End reveals the long line's end (scrollbar geometry regression) =="
"$H" click "$S" 44 $((3 + content_offset)) >/dev/null   # editor line 0 (workspace strip + buffer tabs above); x+4 for the activity bar
tmux send-keys -t "$S" End; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
end_visible="$(FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
let ok=false;for(let y=0;y<f.height;y++) if(f.rows[y].text.includes("desync)")){ok=true;break}
console.log(ok?"OK":"CUT");
')"
if [ "$end_visible" = "OK" ]; then echo "  PASS  line end visible at max scrollLeft"; else echo "  FAIL  line end cut off at max scrollLeft"; fail=1; fi

echo "== rightward drag-select INCLUDES the char under the release cell (last-char off-by-one) =="
# The user's repro: "horizontal scrollbar + drag-select to the right end drops the last letter." The
# defect is a half-open range that ends BEFORE the grapheme under the release cell — independent of
# scroll position (it lives in the shared drag behavior). We drive it deterministically at Home:
# "Fixture" (7 chars) sits in the plain-ASCII head of the long line, so screen col == grapheme col and
# NO reveal-scroll drifts the cells mid-drag. Dragging 'F'..'e' must copy all 7 — before the fix the
# range stopped at 'r' (6). (At the scrolled right edge the same fix applies; a real user tracks the
# last char visually, where the smoke's precomputed cell drifts with the boundary reveal-scroll.)
tmux send-keys -t "$S" Home; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
read -r fx_row fx_col <<<"$(FRAME_FILE="$FRAME" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
for(let y=0;y<f.height;y++){const i=f.rows[y].text.indexOf("Fixture");if(i>=0){console.log(y+" "+i);break}}
')"
if [ -n "${fx_col:-}" ]; then
  fx_end=$((fx_col + 6))   # "Fixture" spans 7 cells; final 'e' is at offset 6
  scroll_present="$(f editorHorizontalScrollbar 2>/dev/null || echo unknown)"
  "$H" drag "$S" "$fx_col" "$fx_row" "$fx_end" "$fx_row" >/dev/null
  "$H" settle "$S" >/dev/null 2>&1
  "$H" send "$S" C-c >/dev/null; sleep 0.4
  fx_copied="$(f lastCopyChars)"
  if [ "${fx_copied:-0}" = "7" ]; then echo "  PASS  rightward drag copied all 7 chars incl. the final 'e' (lastCopyChars=7)";
  else echo "  FAIL  rightward drag dropped the last char (lastCopyChars=$fx_copied, want 7)"; fail=1; fi
  "$H" send "$S" Escape >/dev/null
else
  echo "  FAIL  could not locate 'Fixture' at the line head"; fail=1
fi
tmux send-keys -t "$S" Home; sleep 0.3

echo "== horizontal wheel ROUTING test (Option+wheel SGR 75/74) =="
# ROUTING test only: injecting into tmux bypasses the terminal, so this proves the app ROUTES the
# codes, NOT that a given modifier is delivered. Real-terminal delivery is terminal-dependent and was
# confirmed OUT-OF-BAND: the user's `cat -v` capture showed Option+wheel arriving as 74/75 (shift 68/69
# is swallowed by xterm-family terminals; native tilt 66/67 is terminal-dependent). Acceptance = 74/75.
"$H" settle "$S" >/dev/null 2>&1
h_wheel_before="$(f editorScrollLeft)"
wheel_sgr_row=$((3 + content_offset))   # over editor content; shifts with the workspace-strip height
for _ in 1 2 3 4 5 6; do tmux send-keys -t "$S" -l "$(printf '\033[<75;44;%dM' "$wheel_sgr_row")"; sleep 0.12; done  # Option+wheel-right (x+4: activity bar)
sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
h_wheel_after="$(f editorScrollLeft)"
if [ "${h_wheel_after:-0}" -gt "${h_wheel_before:-0}" ] 2>/dev/null; then echo "  PASS  Option+wheel routes to horizontal ($h_wheel_before->$h_wheel_after)"; else echo "  FAIL  Option+wheel did not route horizontal ($h_wheel_before->$h_wheel_after)"; fail=1; fi
for _ in 1 2 3 4 5 6 7 8; do tmux send-keys -t "$S" -l "$(printf '\033[<74;44;%dM' "$wheel_sgr_row")"; sleep 0.1; done  # Option+wheel-left reverses (x+4: activity bar)
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
tmux send-keys -t "$S" Home; sleep 0.3

echo "== drag-edge auto-scroll: hold at right edge scrolls + extends selection =="
edge_sgr_row=$((4 + content_offset))   # SGR is 1-based; editor line 0 = screen y=(3+content_offset)
tmux send-keys -t "$S" -l "$(printf '\033[<0;54;%dM' "$edge_sgr_row")"; sleep 0.1     # press on editor line 0 (x+4: activity bar)
tmux send-keys -t "$S" -l "$(printf '\033[<32;118;%dM' "$edge_sgr_row")"; sleep 0.1   # drag to right edge, HOLD
sleep 0.9; "$H" settle "$S" >/dev/null 2>&1
edge_scroll="$(f editorScrollLeft)"
tmux send-keys -t "$S" -l "$(printf '\033[<0;118;%dm' "$edge_sgr_row")"; sleep 0.3    # release
if [ -n "$edge_scroll" ] && [ "$edge_scroll" -gt 5 ] 2>/dev/null; then echo "  PASS  edge hold auto-scrolled (scrollLeft=$edge_scroll)"; else echo "  FAIL  no edge auto-scroll (scrollLeft=$edge_scroll)"; fail=1; fi
"$H" send "$S" Escape >/dev/null
tmux send-keys -t "$S" Home; sleep 0.2   # reset horizontal scroll for later checks

echo "== tree click: select, click-again activates; click-to-focus (human-QA regression) =="
"$H" send "$S" Escape >/dev/null   # ensure editor focus first (escape w/o selection -> files)... then re-focus editor by clicking
"$H" click "$S" 5 $((2 + content_offset)) >/dev/null     # tree row 0 -> select + focus files
chk "tree click focuses files" "$(f focus)" "files"
chk "tree click selected row 0" "$(f treeSelected)" "0"
"$H" click "$S" 60 $((6 + content_offset)) >/dev/null    # click editor pane -> focus editor
chk "editor click focuses editor" "$(f focus)" "editor"

echo "== single-dispatch: a tree click opens WITHOUT moving the editor cursor =="
"$H" click "$S" 60 $((7 + content_offset)) >/dev/null   # place the cursor somewhere via an editor click
"$H" settle "$S" >/dev/null 2>&1
"$H" click "$S" 5 $((3 + content_offset)) >/dev/null    # click a tree FILE row (greeter.ts)
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
opened_buffer="$(f activeBuffer)"
cursor_line="$(STATUS_FILE="$STATUSF" "$BUN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.STATUS_FILE)).cursor?.line ?? -1)')"
case "$opened_buffer" in *greeter.ts) buffer_ok=1;; *) buffer_ok=0;; esac  # y=3 = greeter.ts (src expanded by the earlier click test)
if [ "$buffer_ok" = 1 ] && [ "$cursor_line" = "0" ]; then echo "  PASS  tree click opened a file, cursor stayed at line 0 (no double-dispatch)"; else echo "  FAIL  double-dispatch? buffer=$opened_buffer cursorLine=$cursor_line"; fail=1; fi

echo "== command palette (F1) =="
# F1 opens the palette (Ctrl+P is now go-to-file; Ctrl+Shift+P is unencodable on this legacy pty and
# intercepted by VS Code's terminal). F1 is the always-deliverable palette key.
"$H" send "$S" F1 >/dev/null
chk "palette overlay" "$(f overlay)" "palette"
echo "  info: paletteMatches=$(f paletteMatches)"
"$H" send "$S" Escape >/dev/null
chk "palette closed" "$(f overlay)" "null"

echo "== editor buffer tabs (item 10a): open ADDS tabs; flyweight keeps live docs < tab count =="
# Files are already open from earlier sections; open more clean tabs to exercise dehydration.
tabs_before="$(f bufferTabCount)"
target=$(( ${tabs_before:-1} + 2 ))
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(f bufferTabCount)" -ge "$target" ] 2>/dev/null && break
  [ "$(f focus)" = "files" ] || "$H" send "$S" Tab >/dev/null
  "$H" send "$S" Down >/dev/null
  "$H" send "$S" Enter >/dev/null
  "$H" settle "$S" >/dev/null 2>&1
done
tabs_after_open="$(f bufferTabCount)"
live_after_open="$(f bufferLiveCount)"
if [ "${tabs_after_open:-0}" -gt "${tabs_before:-0}" ] 2>/dev/null; then echo "  PASS  opening files ADDS tabs ($tabs_before->$tabs_after_open)"; else echo "  FAIL  opening files did not add tabs ($tabs_before->$tabs_after_open)"; fail=1; fi
# FLYWEIGHT: with clean background tabs open, fewer documents are LIVE than there are tabs (only the
# active + any dirty background buffer stays hydrated; clean background tabs dehydrate).
if [ "${live_after_open:-99}" -lt "${tabs_after_open:-0}" ] 2>/dev/null; then echo "  PASS  flyweight: liveDocs($live_after_open) < tabs($tabs_after_open)"; else echo "  FAIL  flyweight broke: liveDocs($live_after_open) not < tabs($tabs_after_open)"; fail=1; fi
# Ctrl+W closes the active tab; if the active tab is dirty it opens a close-confirm — answer y.
"$H" send "$S" C-w >/dev/null
"$H" settle "$S" >/dev/null 2>&1
if [ "$(f pendingCloseTab)" -ge 0 ] 2>/dev/null; then
  echo "  info: active tab was dirty -> close confirmation shown; answering y"
  "$H" send "$S" y >/dev/null
  "$H" settle "$S" >/dev/null 2>&1
fi
tabs_after_close="$(f bufferTabCount)"
if [ "${tabs_after_close:-9}" -lt "${tabs_after_open:-0}" ] 2>/dev/null; then echo "  PASS  Ctrl+W closed a tab ($tabs_after_open->$tabs_after_close)"; else echo "  FAIL  Ctrl+W did not close a tab ($tabs_after_open->$tabs_after_close)"; fail=1; fi

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
