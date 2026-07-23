#!/usr/bin/env bash
# Audio-narration smoke (the third projection). Two layers, mirroring smoke-agent.sh / smoke-terminal.sh:
#   A) deterministic NarrationProjection unit tests via `bun test` (scripted transcript -> exact spoken
#      lines through a MockTtsBackend — milestone filter, off-by-default, ordering, barge-in).
#   B) real drives under tmux with INVAR_AGENT_BACKEND=echo (hermetic agent) + INVAR_TTS_BACKEND=mock
#      (silent — NO audio in CI). Two launches prove the applied effect of the agentAudioNarration toggle:
#        OFF (default): drive an agent turn, assert NOTHING is spoken.
#        ON  (seeded):  drive an agent turn, assert the completed turn IS spoken (the assistant text),
#                       then a keystroke BARGES IN (stop issued).
# Usage: scripts/smoke-audio-narration.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
SETTINGS_HOME="$(mktemp -d /tmp/tui-narr-home.XXXXXX)"   # isolated HOME so the seeded config is never the real one
SET="$SETTINGS_HOME/.config/invar/settings.json"
mkdir -p "$SETTINGS_HOME/.config/invar"
SESSIONS=""
fail=0
f()   { "$H" field "$1" "$2"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
gt()  { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }

# Write one boolean into the seeded settings.json (the app reads it at boot).
setb() {
  "$BUN" -e '
    const fs = require("fs");
    const path = process.argv[1];
    const settings = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : {};
    settings[process.argv[2]] = process.argv[3] === "true";
    fs.writeFileSync(path, JSON.stringify(settings, null, 2));
  ' "$SET" "$1" "$2"
}

# Ctrl+Shift+A (97 = 'a') — the panel.toggleAgent chord (from smoke-agent.sh).
toggle_agent() { tmux send-keys -t "$1" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$1" >/dev/null 2>&1; }
# Drive one agent turn: type a prompt into the composer, submit; the echo backend replies + ends the turn.
drive_turn() {
  local S="$1" prompt="$2"
  "$H" send "$S" -l "$prompt" >/dev/null
  sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
  "$H" send "$S" Enter >/dev/null
  sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
}

trap 'for s in $SESSIONS; do "$H" kill "$s" >/dev/null 2>&1; done; rm -rf "$SETTINGS_HOME"' EXIT INT TERM

echo "== A) deterministic NarrationProjection unit tests (MockTtsBackend — no audio) =="
if "$BUN" test src/modules/narration/ >/tmp/narr-unit-$$.log 2>&1; then
  echo "  PASS  narration unit tests (milestone filter, off-by-default, ordering, barge-in, mid-session enable)"
else
  echo "  FAIL  narration unit tests"; tail -25 /tmp/narr-unit-$$.log; fail=1
fi
rm -f /tmp/narr-unit-$$.log

echo "== B1) narration OFF (default): a completed agent turn speaks NOTHING =="
S="narr-off-$$"; SESSIONS="$SESSIONS $S"
setb agentAudioNarration false
"$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" INVAR_AGENT_BACKEND=echo INVAR_TTS_BACKEND=mock bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
chk "narration disabled at boot" "$(f "$S" narrationEnabled)" "false"
toggle_agent "$S"
chk "agent pane open" "$(f "$S" panelActiveContent)" "agent"
drive_turn "$S" "hello narration"
if "$H" capture "$S" | grep -qF "You said"; then echo "  PASS  the agent turn completed (reply rendered)"; else echo "  FAIL  agent turn did not complete"; "$H" capture "$S" | tail -12; fail=1; fi
chk "OFF: nothing spoken" "$(f "$S" narrationSpokenCount)" "0"
chk "OFF: last spoken empty" "$(f "$S" narrationLastSpoken)" ""

echo "== B2) narration ON (seeded): the completed turn IS spoken; a keystroke barges in =="
S="narr-on-$$"; SESSIONS="$SESSIONS $S"
setb agentAudioNarration true
"$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" INVAR_AGENT_BACKEND=echo INVAR_TTS_BACKEND=mock bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
chk "narration enabled at boot (setting applied)" "$(f "$S" narrationEnabled)" "true"
toggle_agent "$S"
chk "agent pane open" "$(f "$S" panelActiveContent)" "agent"
drive_turn "$S" "speak this reply"
gt "ON: a completed turn was spoken" "$(f "$S" narrationSpokenCount)" "0"
# The spoken text is the assistant transcript text (pure projection): the echo reply begins 'You said'.
last="$(f "$S" narrationLastSpoken)"
case "$last" in
  *"You said"*) echo "  PASS  spoken text is the assistant turn text ('${last:0:32}...')";;
  *) echo "  FAIL  spoken text not the assistant reply (got '${last:0:48}')"; fail=1;;
esac

echo "== barge-in: typing does NOT stop narration; Escape does (intentional interruptibility) =="
barge_before="$(f "$S" narrationBargeInCount)"
"$H" send "$S" -l "x" >/dev/null   # ordinary typing must NOT barge in — listen while you work
sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
barge_typed="$(f "$S" narrationBargeInCount)"
if [ "$barge_typed" = "$barge_before" ]; then echo "  PASS  typing did NOT barge in ($barge_typed)"; else echo "  FAIL  typing barged in ($barge_before -> $barge_typed)"; fail=1; fi
"$H" send "$S" Escape >/dev/null   # Escape is the EXPLICIT stop
sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
barge_after="$(f "$S" narrationBargeInCount)"
gt "Escape barged in on narration" "$barge_after" "$barge_typed"

echo "== idle quiescence with narration ON + agent open (demand-driven; frame delta <= 1) =="
"$H" settle "$S" >/dev/null 2>&1
idle_start="$(f "$S" frame)"; sleep 4; idle_end="$(f "$S" frame)"
idle_delta=$(( idle_end - idle_start ))
if [ "$idle_delta" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s (frame $idle_start -> $idle_end)"; else
  echo "  FAIL  idle loop ticking with narration on: +$idle_delta over 4s"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
