#!/usr/bin/env bash
# Bracketed-paste smoke (tier S). A clipboard paste or a dictation tool (Hex: Ctrl+Alt push-to-talk)
# injects bulk text framed as \e[200~…\e[201~. OpenTUI parses that framing into ONE `paste` event and
# emits NO keypresses for it — so before this fix the burst vanished (nothing listened to the paste
# channel). This drives a REAL bracketed paste into each focused target and asserts the text lands:
#   1) editor — single-line paste inserts at the caret (bufferRevision bumps, text renders)
#   2) editor — MULTI-LINE paste splits into lines (insertMultiline path)
#   3) terminal — paste is written to the child PTY (echoes at the shell prompt)
#   4) agent — paste inserts into the composer
# The routing mirrors keyTick: focused panel pane → PTY / composer, else the editor.
# invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-paste-$$"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
gt()  { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -16; fail=1; fi; }
toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
export TUI_FRAME_DUMP=1
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" status; "$H" capture "$S"; exit 1
fi
chk "ready" "$(f ready)" "true"

echo "== open a file + focus the editor =="
for _ in 1 2 3 4 5 6 7 8; do
  b="$(f activeBuffer)"; [ -n "$b" ] && [ "$b" != "null" ] && break
  "$H" send "$S" Enter >/dev/null
  "$H" send "$S" Down >/dev/null
done
b="$(f activeBuffer)"
if [ -z "$b" ] || [ "$b" = "null" ]; then echo "  FAIL  no buffer opened"; exit 1; fi
echo "  info: activeBuffer=$b"
"$H" send "$S" Right >/dev/null   # move focus tree -> editor

echo "== 1) EDITOR single-line paste inserts at the caret =="
rev0="$(f bufferRevision)"
"$H" paste "$S" "PASTEUNIQUEXYZ" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
rev1="$(f bufferRevision)"
gt "paste bumped bufferRevision" "$rev1" "$rev0"
chk "paste dirtied the document" "$(f dirty)" "true"
has "pasted text renders in the editor" "PASTEUNIQUEXYZ"

echo "== 2) EDITOR multi-line paste splits into lines (insertMultiline) =="
rev2="$(f bufferRevision)"
"$H" paste "$S" "$(printf 'ALPHALINE\nBRAVOLINE\nCHARLIELINE')" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
gt "multi-line paste bumped bufferRevision" "$(f bufferRevision)" "$rev2"
has "first pasted line renders" "ALPHALINE"
has "last pasted line renders (newline created a new line)" "CHARLIELINE"

echo "== 3) TERMINAL paste is written to the child PTY (F8 opens the panel) =="
"$H" send "$S" F8 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "terminal focused after F8" "$(f terminalFocused)" "true"
chk "active pane is the terminal" "$(f panelActiveContent)" "terminal"
"$H" paste "$S" "PASTEDINTERMINAL" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
has "paste reached the shell (echoed at the prompt)" "PASTEDINTERMINAL"
"$H" send "$S" F8 >/dev/null   # close the panel
"$H" settle "$S" >/dev/null 2>&1

echo "== 4) AGENT paste inserts into the composer (Ctrl+Shift+A opens the pane) =="
toggle_agent
chk "active pane is the agent" "$(f panelActiveContent)" "agent"
"$H" paste "$S" "PASTEDINAGENT" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
has "paste renders in the agent composer" "PASTEDINAGENT"
toggle_agent   # close the agent pane; focus returns to the editor

echo "== 5) paste SURVIVES a tab defocus->refocus (recovery re-enters bracketed paste) =="
# The regression this gates: mode ownership was split — boot enabled DECSET 2004 inline, but the
# focus-in recovery reasserted only OpenTUI's modes, so a VS Code tab round-trip silently killed
# paste/dictation until restart. Recovery now re-enters the app-owned bundle; the raw pty stream
# must show a FRESH 2004h after focus-in, and a real paste must still land.
RAWLOG="/tmp/paste-raw-$$.log"
tmux pipe-pane -t "$S" "cat >> $RAWLOG"
"$H" focus "$S" out >/dev/null
"$H" focus "$S" in >/dev/null
sleep 0.5
"$H" settle "$S" >/dev/null 2>&1
if grep -aq $'\x1b\[?2004h' "$RAWLOG"; then
  echo "  PASS  recovery re-emitted bracketed-paste enable (2004h) after focus-in"
else
  echo "  FAIL  no 2004h in the raw stream after the focus round-trip"; fail=1
fi
rev3="$(f bufferRevision)"
"$H" paste "$S" "PASTEAFTERREFOCUS" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
gt "paste after refocus bumped bufferRevision" "$(f bufferRevision)" "$rev3"
has "paste after the focus round-trip renders in the editor" "PASTEAFTERREFOCUS"
tmux pipe-pane -t "$S"   # detach the pipe
rm -f "$RAWLOG"

echo
if [ "$fail" = 0 ]; then echo "PASTE SMOKE: ALL-PASS"; else echo "PASTE SMOKE: FAIL"; fi
exit "$fail"
