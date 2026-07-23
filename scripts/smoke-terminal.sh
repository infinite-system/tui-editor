#!/usr/bin/env bash
# Integrated-terminal smoke (tier S). Two layers:
#   A) deterministic MockBackend + emulator + PanelHost assertions via `bun test` (no shell — scripted
#      ANSI in, asserted cells out, incl. a color + cursor case) so the gate is not shell-flaky.
#   B) ONE real OpenPtyBackend liveness drive under tmux: toggle the terminal, type `echo hello`, assert
#      it renders in the panel cells; confirm the shell sees a tty; drive a SPLIT resize and assert the
#      shell reflows (`stty size` reflects the new rows×cols); confirm Ctrl+Q still quits from the terminal.
# Usage: scripts/smoke-terminal.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-term-$$"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()    { "$H" field "$S" "$1"; }
chk()  { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
gt()   { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== A) deterministic MockBackend + PanelHost (no shell) =="
if "$BUN" test src/modules/terminal/ src/modules/ui/PanelHost.test.ts >/tmp/term-unit-$$.log 2>&1; then
  echo "  PASS  terminal-core + panel unit tests (scripted ANSI -> cells, color, cursor, switching)"
else
  echo "  FAIL  terminal-core/panel unit tests"; tail -20 /tmp/term-unit-$$.log; fail=1
fi
rm -f /tmp/term-unit-$$.log

echo "== B) launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1
fi
chk "terminal hidden at boot" "$(f terminalVisible)" "false"

echo "== toggle the terminal panel (F8 = deliverable alias for Ctrl+backtick) =="
"$H" send "$S" F8 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "terminalVisible after toggle" "$(f terminalVisible)" "true"
chk "terminalFocused after toggle" "$(f terminalFocused)" "true"
chk "active panel content is the terminal" "$(f panelActiveContent)" "terminal"
cols0="$(f terminalColumns)"; rows0="$(f terminalRows)"
gt "terminal has real columns" "$cols0" "0"
gt "terminal has real rows" "$rows0" "0"
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1   # let the shell print its first prompt

echo "== the shell sees a tty + stty size matches the converged pane geometry =="
"$H" send "$S" -l "stty size" >/dev/null
"$H" send "$S" Enter >/dev/null
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
# The panel body is inside a bordered box, so the stty line can sit flush against the border
# ("│10 118"); a box-drawing char is a non-digit, so bound on non-digits, not spaces.
if "$H" capture "$S" | grep -qE "(^|[^0-9])${rows0} ${cols0}([^0-9]|\$)"; then
  echo "  PASS  stty size == ${rows0} ${cols0} (child tty reflects the laid-out pane)"
else
  echo "  FAIL  stty size did not match ${rows0} ${cols0}"; "$H" capture "$S" | grep -E '[0-9]+ [0-9]+' | tail -3; fail=1
fi
"$H" send "$S" -l "tty" >/dev/null; "$H" send "$S" Enter >/dev/null; sleep 0.4
if "$H" capture "$S" | grep -qE '/dev/pts/|/dev/tty'; then echo "  PASS  child reports a real tty (/dev/pts)"; else echo "  FAIL  no tty reported"; fail=1; fi

echo "== drive typing: echo hello renders in the panel cells (round-trip) =="
"$H" send "$S" -l "echo hello" >/dev/null
"$H" send "$S" Enter >/dev/null
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
if "$H" capture "$S" | awk '{gsub(/^[ \t│|╎]+|[ \t│|╎]+$/,"")} $0=="hello"{found=1} END{exit found?0:1}'; then
  echo "  PASS  'hello' output line rendered in the terminal pane"
else
  echo "  FAIL  'hello' output not found in pane"; "$H" capture "$S" | tail -12; fail=1
fi

echo "== drive a SPLIT resize (drag the panel divider up) -> shell reflows =="
# The panel sits at the bottom: [ ...main... | divider(1 row) | panelBox(termRows+2) | statusBar(1) ].
# So the divider's 0-based screen row = height - 1(status) - (termRows+2) - 1(divider) = height-termRows-4.
# Drag it UP 6 rows to GROW the panel; the frame loop reconverges cols/rows and the ioctl reflows the child.
height="$(f height)"
divider_y=$(( height - rows0 - 4 ))
target_y=$(( divider_y - 6 ))
"$H" drag "$S" 20 "$divider_y" 20 "$target_y" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
rows1="$(f terminalRows)"
gt "split drag grew terminal rows" "$rows1" "$rows0"
cols1="$(f terminalColumns)"
"$H" send "$S" -l "stty size" >/dev/null
"$H" send "$S" Enter >/dev/null
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
if "$H" capture "$S" | grep -qE "(^|[^0-9])${rows1} ${cols1}([^0-9]|\$)"; then
  echo "  PASS  shell reflowed after split resize (stty size == ${rows1} ${cols1})"
else
  echo "  FAIL  shell did not reflow to ${rows1} ${cols1}"; "$H" capture "$S" | grep -E '[0-9]+ [0-9]+' | tail -3; fail=1
fi

echo "== status-bar minute-clock renders HH:MM (bottom-right) =="
if "$H" capture "$S" | tail -1 | grep -qE '[0-2][0-9]:[0-5][0-9]'; then
  echo "  PASS  clock shows HH:MM in the status bar ($("$H" capture "$S" | tail -1 | grep -oE '[0-2][0-9]:[0-5][0-9]' | head -1))"
else
  echo "  FAIL  no HH:MM clock in the status bar"; "$H" capture "$S" | tail -1; fail=1
fi

echo "== idle quiescence with the terminal open (demand-driven; frame delta <= 1: minute-clock only) =="
# The only legitimate periodic wake at rest is the status-bar minute-clock (once/min). A 4s window
# sees 0 frames between ticks, at most 1 at a minute boundary; a busy loop would be ~120 (30fps×4s).
"$H" settle "$S" >/dev/null 2>&1
idle_start="$(f frame)"; sleep 4; idle_end="$(f frame)"
idle_delta=$(( idle_end - idle_start ))
if [ "$idle_delta" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s with terminal open (frame $idle_start -> $idle_end; clock tick at most)"; else
  echo "  FAIL  idle loop ticking with terminal open: +$idle_delta over 4s"; fail=1; fi

echo "== Ctrl+Q quits from the focused terminal (reserved global escape hatch) =="
chk "terminal still focused before quit" "$(f terminalFocused)" "true"
"$H" send "$S" C-q >/dev/null
sleep 0.5
if "$H" capture "$S" 2>/dev/null | grep -q "Files"; then
  echo "  FAIL  UI still rendered after Ctrl+Q from terminal"; fail=1
else
  echo "  PASS  Ctrl+Q from the focused terminal quit the app"
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
