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
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$WORKSPACE"' EXIT

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
# Rightmost non-space glyph on the tab-bar row is the '›' arrow.
arrow_col="$("$BUN" -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));const cells=[...f.rows[0].text];let ns=[];for(let x=0;x<cells.length;x++)if(cells[x]!==" "&&cells[x]!=="│")ns.push(x);console.log(ns[ns.length-1]??-1);' "$DIR/../artifacts/frame-$S.json")"
if [ "${arrow_col:-100}" -gt 80 ] 2>/dev/null; then echo "  PASS  right arrow at the right edge (col $arrow_col)"; else echo "  FAIL  right arrow not at the right edge (col $arrow_col)"; fail=1; fi
"$H" click "$S" "$arrow_col" 0 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
after="$(f activeBufferIndex)"
if [ "${after:-0}" -gt "${before:-0}" ] 2>/dev/null; then echo "  PASS  right-arrow click scrolled the strip forward ($before -> $after)"; else echo "  FAIL  right-arrow click did nothing ($before -> $after)"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
