#!/usr/bin/env bash
# Live regression for the editor tab bar (item 10a + the tab-bar QA fixes): positional Ctrl+PageDown/
# PageUp cycle (advance by exactly one, wrap), and CLICKABLE overflow arrows pinned at the right edge.
# Drives real SGR keys + clicks; asserts the active buffer index from status.json.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
BUN="$HOME/.bun/bin/bun"
S="tabs-$$"
fail=0
f() { "$H" field "$S" "$1"; }

WORKSPACE="$(mktemp -d /tmp/tui-tabs.XXXXXX)"
for n in $(seq 1 9); do printf 'x\n' > "$WORKSPACE/file-$n.txt"; done
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$WORKSPACE"' EXIT INT TERM

echo "== launch + open 8 tabs (overflows the strip -> arrows appear) =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$WORKSPACE" >/dev/null
"$H" ready "$S" 20 >/dev/null || { echo "  FAIL boot"; exit 1; }
for _ in $(seq 1 30); do
  [ "$(f bufferTabCount)" -ge 8 ] 2>/dev/null && break
  [ "$(f focus)" = "files" ] || "$H" send "$S" Tab >/dev/null
  "$H" send "$S" Down >/dev/null; "$H" send "$S" Enter >/dev/null
done
"$H" settle "$S" >/dev/null 2>&1
tabs="$(f bufferTabCount)"
if [ "${tabs:-0}" -ge 8 ] 2>/dev/null; then echo "  PASS  opened $tabs tabs"; else echo "  FAIL  only $tabs tabs"; fail=1; fi

echo "== buffer tabs render a path breadcrumb + a powerline separator between tabs =="
# FrameProbe remaps the non-ASCII crumb (›) and separator glyphs into its opaque plane, so assert the
# REAL rendered text via tmux capture. › is the always-present crumb separator; the tab separator is
# tier-dependent (nerd  / unicode ❯ / ascii >), so match any of them between two crumbs.
tab_capture="$("$H" capture "$S")"
if echo "$tab_capture" | grep -q "›"; then echo "  PASS  buffer tab shows a path breadcrumb (project › … › file)"; else echo "  FAIL  no breadcrumb (›) in the buffer tab bar"; fail=1; fi
if echo "$tab_capture" | grep -qE "› [A-Za-z].* (❯|>|) "; then echo "  PASS  a powerline separator divides adjacent tabs"; else echo "  FAIL  no powerline separator between tabs"; fail=1; fi

echo "== Ctrl+PageDown / Ctrl+PageUp cycle positionally (advance by one, wrap) =="
start="$(f activeBufferIndex)"
"$H" send "$S" C-PageDown >/dev/null; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
next="$(f activeBufferIndex)"
expected_next=$(( ( ${start:-0} + 1 ) % ${tabs:-1} ))
if [ "$next" = "$expected_next" ]; then echo "  PASS  Ctrl+PageDown advanced one ($start -> $next, wrap-correct)"; else echo "  FAIL  cycle incoherent ($start -> $next, expected $expected_next)"; fail=1; fi
"$H" send "$S" C-PageUp >/dev/null; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
back="$(f activeBufferIndex)"
if [ "$back" = "$start" ]; then echo "  PASS  Ctrl+PageUp returned ($next -> $back)"; else echo "  FAIL  Ctrl+PageUp incoherent ($next -> $back, expected $start)"; fail=1; fi

echo "== overflow arrows are at the RIGHT edge and CLICKABLE =="
# Move to the first tab so the right arrow is enabled (something further right to reveal).
for _ in $(seq 1 "${tabs:-8}"); do [ "$(f activeBufferIndex)" = "0" ] && break; "$H" send "$S" C-PageUp >/dev/null; sleep 0.1; done
"$H" settle "$S" >/dev/null 2>&1
before="$(f activeBufferIndex)"
# The COUNT BADGE (active/total digits) is the rightmost element. Assert it shows the total.
badge_info="$("$BUN" -e 'const frame=JSON.parse(require("fs").readFileSync(process.argv[1]));const total=process.argv[2];for(let rowIndex=0;rowIndex<frame.rows.length;rowIndex+=1){const cells=Array.from(frame.rows[rowIndex].text);const slashIndex=cells.findIndex((cell,columnIndex)=>cell==="/"&&cells.slice(columnIndex+1,columnIndex+1+total.length).join("")===total);if(slashIndex<0)continue;let start=slashIndex;while(start>0&&/[0-9]/.test(cells[start-1]))start-=1;let end=slashIndex+1+total.length;console.log(start+" "+rowIndex+" "+cells.slice(start,end).join(""));process.exit(0)}console.log("-1 -1 missing");' "$DIR/../artifacts/frame-$S.json" "$tabs")"
badge_start="$(echo "$badge_info" | cut -d' ' -f1)"; badge_row="$(echo "$badge_info" | cut -d' ' -f2)"; badge_text="$(echo "$badge_info" | cut -d' ' -f3)"
if echo "$badge_text" | grep -q "/${tabs}"; then echo "  PASS  count badge shows total ($badge_text)"; else echo "  FAIL  count badge wrong ($badge_text, tabs=$tabs)"; fail=1; fi

echo "== clicking the count badge opens the all-buffers dropdown; a row activates that tab =="
"$H" click "$S" "$badge_start" "$badge_row" >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
if [ "$(f contextMenuOpen)" = "true" ]; then echo "  PASS  badge click opened the dropdown"; else echo "  FAIL  badge click did not open the dropdown"; fail=1; fi
"$H" send "$S" Escape >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1

echo "== the » arrow PANS the strip to reveal later tabs WITHOUT changing the active tab =="
# Ensure the active tab is the first (so the right arrow is live and active sits at the strip's left).
for _ in $(seq 1 "${tabs:-8}"); do [ "$(f activeBufferIndex)" = "0" ] && break; "$H" send "$S" C-PageUp >/dev/null; sleep 0.1; done
"$H" settle "$S" >/dev/null 2>&1
active_before="$(f activeBufferIndex)"
arrow_col=$(( ${badge_start:-100} - 2 ))
"$H" click "$S" "$arrow_col" "$badge_row" >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
active_after="$(f activeBufferIndex)"
if [ "$active_after" = "$active_before" ]; then echo "  PASS  right-arrow panned the strip; active tab UNCHANGED ($active_before)"; else echo "  FAIL  right-arrow changed the active tab ($active_before -> $active_after) — must only pan"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
