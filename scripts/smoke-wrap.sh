#!/usr/bin/env bash
# Word-wrap MODE smoke: boot the real TUI under tmux on a long-line fixture, toggle wrap via the
# PALETTE and Alt+Z, and assert both modes. State from status-<session>.json; visual rows +
# gutters from FrameProbe; the caret from tmux's OWN cursor position (the authoritative channel).
# Wrap-OFF stays covered by scripts/smoke-editor.sh (this script asserts the round-trip back).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="wrap-$$"
BUN="$HOME/.bun/bin/bun"
FIX="$(mktemp -d /tmp/tui-wrap-fixture.XXXXXX)"
FRAME="$ROOT/artifacts/frame-$S.json"
STATUSF="$ROOT/artifacts/status-$S.json"
fail=0
f()    { "$H" field "$S" "$1"; }
chk()  { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
status_field() { STATUS_FILE="$STATUSF" FIELD="$1" "$BUN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.STATUS_FILE)).cursor[process.env.FIELD])'; }
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$FIX"' EXIT

# Fixture: a ~476-column wrappable sentence line, a short line, an unbroken 200-char run.
"$BUN" -e '
const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey yankee zulu";
const longLine = `${words} ${words} ${words}`;
// Trailing filler makes the document OVERFLOW the viewport (even wrapped) so vertical scroll has
// somewhere to go — the "H-wheel routes to vertical" assertion needs a scrollable document.
const filler = Array.from({length: 60}, (_, i) => `filler body line ${String(i).padStart(3, "0")}`);
require("fs").writeFileSync(process.argv[1] + "/long.txt", [longLine, "short tail line", "q".repeat(200), "final line", ...filler].join("\n") + "\n");
' "$FIX"

echo "== launch on the long-line fixture =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot ready"; else echo "  FAIL  boot"; "$H" capture "$S"; exit 1; fi

echo "== open long.txt + focus editor =="
"$H" send "$S" Enter >/dev/null
sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
chk "buffer open" "$(basename "$(f activeBuffer)")" "long.txt"
"$H" send "$S" Right >/dev/null
chk "editor focused" "$(f focus)" "editor"
chk "wordWrap default OFF" "$(f wordWrap)" "false"

echo "== baseline (wrap OFF): consecutive gutters 1,2 (one line == one row) =="
"$H" settle "$S" >/dev/null 2>&1
baseline="$(FRAME_FILE="$FRAME" "$BUN" -e '
const frame=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
const gutterNumber=(y)=>{const m=frame.rows[y].text.slice(33,40).match(/\d+/);return m?Number(m[0]):null};
// FIND the first gutter row (content starts below the tab bar + pane border — do not hardcode the
// row, so the check survives chrome-layout shifts) then assert the next line is consecutive.
let base=-1;for(let y=0;y<frame.height;y++){if(gutterNumber(y)===1){base=y;break}}
console.log(base>=0&&gutterNumber(base+1)===2?"OK":`WRONG base=${base} g=${base<0?null:gutterNumber(base)} gNext=${base<0?null:gutterNumber(base+1)}`);
')"
chk "wrap-off gutter" "$baseline" "OK"

echo "== toggle wrap ON via the PALETTE (F1) =="
"$H" send "$S" F1 >/dev/null   # F1 = command palette (Ctrl+P is now go-to-file)
"$H" send "$S" -l wrap >/dev/null
sleep 0.3
"$H" send "$S" Enter >/dev/null
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
chk "wordWrap ON" "$(f wordWrap)" "true"
chk "scrollLeft forced 0" "$(f editorScrollLeft)" "0"

echo "== wrap ON: long line occupies MULTIPLE rows; gutter number only on the FIRST =="
wrap_gutter="$(FRAME_FILE="$FRAME" "$BUN" -e '
const frame=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
const gutterNumber=(y)=>{const m=frame.rows[y].text.slice(33,40).match(/\d+/);return m?Number(m[0]):null};
const codeBody=(y)=>frame.rows[y].text.slice(40).trim();
// Find the first line (gutter 1) wherever the chrome places it, then the gutter-2 line below it;
// the rows between must be wrap CONTINUATIONS (no gutter number, non-empty body).
let base=-1;for(let y=0;y<frame.height;y++){if(gutterNumber(y)===1){base=y;break}}
let row2=-1;for(let y=base+1;y<frame.height;y++){if(gutterNumber(y)===2){row2=y;break}}
const continuationRows=row2-base-1; let continuationOk=base>=0&&continuationRows>0;
for(let y=base+1;y<row2;y++){ if(gutterNumber(y)!==null||codeBody(y).length===0) continuationOk=false; }
console.log(base>=0&&row2>base+1&&continuationOk?`OK rows=${1+continuationRows}`:`WRONG base=${base} row2=${row2} contOk=${continuationOk}`);
')"
case "$wrap_gutter" in OK*) echo "  PASS  wrapped rows + blank continuation gutters ($wrap_gutter)";; *) echo "  FAIL  $wrap_gutter"; fail=1;; esac

echo "== caret vs tmux cursor MID-WRAPPED-LINE (click a continuation row, type X) =="
"$H" click "$S" 60 3 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
"$H" send "$S" -l X >/dev/null
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
caret_check="$(FRAME_FILE="$FRAME" "$BUN" -e '
const frame=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
let glyphX=-1,glyphY=-1;
for(let y=0;y<frame.height && glyphX<0;y++){let cell=0;for(const ch of frame.rows[y].text){if(ch==="X"){glyphX=cell;glyphY=y;break}cell++;}}
const [cursorX,cursorY]=process.argv[1].split(",").map(Number);
console.log(glyphX>=0 && cursorX===glyphX+1 && cursorY===glyphY ? "OK" : `WRONG glyph=(${glyphX},${glyphY}) caret=(${cursorX},${cursorY})`);
' "$(tmux display-message -p -t "$S" '#{cursor_x},#{cursor_y}')")"
chk "caret == tmux cursor on a wrapped row" "$caret_check" "OK"

echo "== vertical movement steps VISUAL rows (Down stays on the wrapped line) =="
line_before="$(status_field line)"
"$H" send "$S" Down >/dev/null
"$H" settle "$S" >/dev/null 2>&1
line_after="$(status_field line)"
column_after="$(status_field col)"
if [ "$line_after" = "$line_before" ] && [ "$column_after" -gt 60 ] 2>/dev/null; then
  echo "  PASS  Down moved within the wrapped line (line=$line_after col=$column_after)"
else
  echo "  FAIL  Down: line $line_before->$line_after col=$column_after"; fail=1
fi

"$H" send "$S" C-z >/dev/null   # undo the typed X
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1

echo "== horizontal wheel routes to VERTICAL; scrollLeft stays inert =="
top_before="$(f editorScrollTop)"
"$H" scroll "$S" 60 5 right 3 >/dev/null
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
top_after="$(f editorScrollTop)"
left_after="$(f editorScrollLeft)"
if [ "$left_after" = "0" ] && [ "$top_after" -gt "$top_before" ] 2>/dev/null; then
  echo "  PASS  H wheel routed to vertical (scrollTop $top_before->$top_after, scrollLeft=0)"
else
  echo "  FAIL  H wheel: scrollTop $top_before->$top_after scrollLeft=$left_after"; fail=1
fi
"$H" scroll "$S" 60 5 up 5 >/dev/null
sleep 0.3

echo "== toggle wrap OFF via Alt+Z: today's behavior restored =="
"$H" send "$S" M-z >/dev/null
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
chk "wordWrap OFF" "$(f wordWrap)" "false"
off_gutter="$(FRAME_FILE="$FRAME" "$BUN" -e '
const frame=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
const gutterNumber=(y)=>{const m=frame.rows[y].text.slice(33,40).match(/\d+/);return m?Number(m[0]):null};
// FIND the first gutter row (content starts below the tab bar + pane border — do not hardcode the
// row, so the check survives chrome-layout shifts) then assert the next line is consecutive.
let base=-1;for(let y=0;y<frame.height;y++){if(gutterNumber(y)===1){base=y;break}}
console.log(base>=0&&gutterNumber(base+1)===2?"OK":`WRONG base=${base} g=${base<0?null:gutterNumber(base)} gNext=${base<0?null:gutterNumber(base+1)}`);
')"
chk "wrap-off gutter restored (one line == one row)" "$off_gutter" "OK"

echo "== quit =="
"$H" send "$S" C-q >/dev/null
echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
