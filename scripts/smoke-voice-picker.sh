#!/usr/bin/env bash
# Voice-picker + mouse-editable settings smoke. NO real audio (INVAR_TTS_BACKEND=mock). Two layers:
#   A) deterministic unit tests (voice discovery dir+library, resolvePiperModel selected-over-first, the
#      dynamic-enum cycle) via `bun test`.
#   B) real drive under tmux against a SEEDED fake voices dir (XDG_DATA_HOME): assert the Test-Voice
#      command is registered; open settings; navigate to the Narration-voice row and confirm it's a
#      dynamic-enum listing the discovered voices; cycle it by KEYBOARD; then edit by MOUSE — click the
#      voice '>' arrow (enum), the rate '[+]' stepper (number), and the audio toggle (boolean) — asserting
#      each setting changed.
# Usage: scripts/smoke-voice-picker.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
SEED="$(mktemp -d /tmp/tui-voices-XXXXXX)"
FIX="$(mktemp -d /tmp/tui-voicefix-XXXXXX)"
# Per-run ISOLATED HOME so settings start from DEFAULTS every launch — the harness otherwise points HOME
# at a SHARED artifacts/home whose ~/.config/invar/settings.json persists across gate smokes (a prior
# settings smoke leaves agentNarrationVoice/agentNarrationRate set, and this smoke would read that stale
# state instead of the auto/1.0 defaults it asserts). Overriding HOME via `env` below wins over the
# harness's HOME= assignment.
VOICE_HOME="$(mktemp -d /tmp/tui-voicehome-XXXXXX)"; mkdir -p "$VOICE_HOME/.config/invar"
S="voice-$$"
FRAME="$ROOT/artifacts/frame-$S.json"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
# Screen cell (col rowY) of `glyph` inside the settings row containing `label`. Uses Array.from so the
# per-cell index is right despite FrameProbe's astral remapping of box-drawing glyphs.
cell_of() {
  "$BUN" -e '
    const f = JSON.parse(require("fs").readFileSync(process.argv[1]));
    const rowIndex = f.rows.findIndex((r) => r.text.includes(process.argv[2]));
    if (rowIndex < 0) { process.stdout.write("-1 -1"); process.exit(0); }
    const col = Array.from(f.rows[rowIndex].text).indexOf(process.argv[3]);
    process.stdout.write(`${col} ${rowIndex}`);
  ' "$FRAME" "$1" "$2"
}
click_widget() { # label glyph
  read -r cx cy < <(cell_of "$1" "$2")
  if [ "${cx:--1}" -lt 0 ]; then echo "  FAIL  could not locate '$2' on the '$1' row"; fail=1; return 1; fi
  "$H" click "$S" "$cx" "$cy" >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
}

# Seed a fake voices dir: two top-level + one in library/ (proving library discovery). Dummy .onnx.
mkdir -p "$SEED/piper-voices/library"
: > "$SEED/piper-voices/aaa.onnx"; : > "$SEED/piper-voices/bbb.onnx"; : > "$SEED/piper-voices/library/ccc.onnx"

trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$SEED" "$FIX" "$VOICE_HOME"' EXIT INT TERM

echo "== A) deterministic unit tests (discovery + resolve + dynamic-enum) =="
if "$BUN" test src/modules/narration/VoiceDiscovery.test.ts src/modules/settings/SettingsPanel.test.ts >/tmp/voice-unit-$$.log 2>&1; then
  echo "  PASS  voice-picker unit tests (dir+library discovery, selected-over-first, dynamic-enum cycle)"
else
  echo "  FAIL  voice-picker unit tests"; tail -25 /tmp/voice-unit-$$.log; fail=1
fi
rm -f /tmp/voice-unit-$$.log

echo "== B) launch (seeded voices dir; mock TTS = no audio) =="
"$H" launch "$S" 120x44 env HOME="$VOICE_HOME" XDG_DATA_HOME="$SEED" INVAR_TTS_BACKEND=mock TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi

echo "== the Test-Voice command is registered (discoverable in the palette) =="
"$H" send "$S" F1 >/dev/null; sleep 0.4
tmux send-keys -t "$S" -l 'Test Voice'; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
matches="$(f paletteMatches)"
if [ "${matches:-0}" -ge 1 ]; then echo "  PASS  'Narration: Test Voice' is registered ($matches match)"; else echo "  FAIL  Test-Voice command not found in palette"; fail=1; fi
"$H" send "$S" Escape >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1

echo "== open settings + navigate to the Narration-voice row =="
"$H" send "$S" C-, >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "settings panel open" "$(f settingsOpen)" "true"
found=0
for _ in $(seq 1 30); do
  [ "$(f settingsSelectedLabel)" = "Narration voice" ] && { found=1; break; }
  "$H" send "$S" Down >/dev/null; sleep 0.05
done
"$H" settle "$S" >/dev/null 2>&1
chk "navigated to the Narration voice row" "$found" "1"
chk "voice row is a dynamic-enum defaulting to auto" "$(f settingsSelectedValue)" "auto (first found)"

echo "== keyboard: cycle the dynamic-enum picker to the first discovered voice =="
"$H" send "$S" Right >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
chk "voice setting cycled to first discovered (aaa)" "$(f narrationVoice)" "aaa"
chk "row value shows the selected voice" "$(f settingsSelectedValue)" "aaa"

echo "== mouse: click the voice '>' arrow → next discovered voice =="
click_widget "Narration voice" ">" && chk "mouse arrow advanced the voice (aaa -> bbb)" "$(f narrationVoice)" "bbb"

echo "== mouse: click the rate '[+]' stepper → rate steps up =="
click_widget "Narration rate" "+" && chk "mouse stepper raised the rate (1.0 -> 1.1)" "$(f narrationRate)" "1.1"

echo "== mouse: click the audio-narration toggle → boolean flips =="
before="$(f narrationEnabled)"
click_widget "Speak agent replies" "]" && {
  after="$(f narrationEnabled)"
  if [ "$after" != "$before" ]; then echo "  PASS  mouse toggle flipped agentAudioNarration ($before -> $after)"; else echo "  FAIL  toggle did not flip ($before -> $after)"; fail=1; fi
}

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
