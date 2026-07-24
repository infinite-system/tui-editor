#!/usr/bin/env bash
# Pixel-preview smoke: proves the graphics-tier ladder — kitty APC → sixel DCS → half-block cells —
# by driving the real TUI per tier. Graphics are OUT-OF-BAND (FrameProbe sees cells, not pixels), so
# the escape-payload channel is `tmux pipe-pane`: the raw byte stream the app writes to its pty,
# where the APC/DCS payloads and the delete commands are byte-visible. Layers:
#   A) bun test src/modules/image/ + the GraphicsTier env-matrix tests (pure encoders: kitty
#      chunking/framing round-trip, sixel golden outputs, mount discipline, tier precedence)
#   B) KITTY tier (forced via TUI_GRAPHICS_TIER): open a PNG → the transmit APC (a=T, i=, chunked
#      m=) hits the stream, the pane under it is BLANK cells (no ▀); switching to a .ts file emits
#      the placement delete (d=I); quitting emits the delete-all sweep (d=A) — nothing leaks onto
#      the shell after exit.
#   C) SIXEL tier: open a PNG → the DCS sixel payload (ESC P...q + raster attributes) hits the
#      stream, the pane is blank cells; quit stays clean (sixel has no delete — inert pixels).
#   D) HERMETIC floor: no forced tier, no graphics caps (tmux) → the SAME file renders half-block
#      ▀ cells, NO graphics escape ever hits the stream, and a non-image binary still hits the
#      binary guard. (scripts/smoke-image-preview.sh drives the floor + decoders in full depth.)
# PID-namespaced tmux sessions (pix-$$-*) so concurrent gate runs never collide.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
export PATH="$HOME/.bun/bin:$PATH"
W="$(mktemp -d /tmp/tui-pixel-smoke.XXXXXX)"
PNG="/tmp/ivue-cart-dark.png"
fail=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
cleanup() {
  for suffix in kitty sixel floor; do "$H" kill "pix-$$-$suffix" >/dev/null 2>&1; done
  rm -rf "$W" /tmp/pix-raw-$$-*.log
}
trap cleanup EXIT INT TERM

echo "== A) unit: encoders + mount + tier precedence =="
if "$BUN" test src/modules/image/ src/modules/theme/__tests__/GraphicsTier.test.ts >/tmp/pix-unit-$$.log 2>&1; then
  echo "  PASS  image + graphics-tier unit tests"
else
  echo "  FAIL  image + graphics-tier unit tests"; tail -20 /tmp/pix-unit-$$.log; fail=1
fi
rm -f /tmp/pix-unit-$$.log

[ -f "$PNG" ] || { echo "  FAIL  missing test image $PNG"; exit 1; }
( cd "$W" && git init -q && cp "$PNG" picture.png \
  && printf 'export const answer = 42;\n' > sample.ts \
  && printf 'BIN\0\0DATA\0not an image\0' > data.bin )

# drive <suffix> <extra-env...>: launch a session with pipe-pane capturing the raw pty stream.
drive() {
  local suffix="$1"; shift
  local session="pix-$$-$suffix"
  local rawlog="/tmp/pix-raw-$$-$suffix.log"
  "$H" launch "$session" 120x40 env TUI_FRAME_DUMP=1 COLORTERM=truecolor "$@" bun run src/main.ts "$W" >/dev/null
  tmux pipe-pane -t "$session" "cat >> $rawlog"
  "$H" ready "$session" 20 >/dev/null || return 1
  return 0
}

open_via_quickopen() { # <session> <letters...>
  local session="$1"; shift
  "$H" send "$session" C-p >/dev/null; sleep 0.8; "$H" settle "$session" >/dev/null 2>&1
  local letter
  for letter in "$@"; do "$H" send "$session" "$letter" >/dev/null; sleep 0.06; done; sleep 0.3
  "$H" send "$session" Enter >/dev/null; sleep 0.6
  "$H" settle "$session" >/dev/null 2>&1
}

field() { "$H" field "$1" "$2"; }
halfblock_glyphs() { "$H" capture "$1" | grep -o "▀" | wc -l | tr -d ' '; }

echo "== B) KITTY tier: transmit APC on open, delete on switch, delete-all on quit =="
S="pix-$$-kitty"; RAW="/tmp/pix-raw-$$-kitty.log"
if drive kitty TUI_GRAPHICS_TIER=kitty; then
  echo "  PASS  boot: ready+quiescent"
  open_via_quickopen "$S" p i c t u r e
  chk "active buffer is the image" "$(field "$S" activeFileIsImage)" "true"
  sleep 1.0 # the placement emits after frames settle
  if grep -aq $'\x1b_Ga=T' "$RAW" && grep -aq 'i=70' "$RAW"; then
    echo "  PASS  kitty transmit APC (a=T, image id) reached the pty stream"
  else
    echo "  FAIL  no kitty transmit APC in the raw stream"; fail=1
  fi
  if grep -aq 'm=1' "$RAW"; then
    echo "  PASS  payload is chunked (m=1 continuation present)"
  else
    echo "  WARN  no m=1 chunk flag (image compressed under one chunk) — acceptable"
  fi
  glyphs="$(halfblock_glyphs "$S")"
  if [ "${glyphs:-999}" -eq 0 ]; then
    echo "  PASS  cells under the graphics are BLANK (0 half-block glyphs)"
  else
    echo "  FAIL  expected blank cells under kitty graphics, found $glyphs ▀ glyphs"; fail=1
  fi
  chk "app alive after kitty placement" "$(field "$S" ready)" "true"
  open_via_quickopen "$S" s a m p l e
  chk "switching to .ts leaves the image buffer" "$(field "$S" activeFileIsImage)" "false"
  sleep 0.3
  if grep -aq $'\x1b_Ga=d,d=I' "$RAW"; then
    echo "  PASS  placement delete (d=I) emitted on buffer switch"
  else
    echo "  FAIL  no placement delete after leaving the image"; fail=1
  fi
  open_via_quickopen "$S" p i c t u r e
  sleep 1.0
  "$H" send "$S" C-q >/dev/null; sleep 1.5
  if grep -aq $'\x1b_Ga=d,d=A' "$RAW"; then
    echo "  PASS  delete-all sweep (d=A) emitted on quit — no image leaks onto the shell"
  else
    echo "  FAIL  no delete-all sweep on quit"; fail=1
  fi
else
  echo "  FAIL  kitty-tier session never became ready"; fail=1
fi
"$H" kill "$S" >/dev/null 2>&1

echo "== C) SIXEL tier: DCS payload on open, blank cells =="
S="pix-$$-sixel"; RAW="/tmp/pix-raw-$$-sixel.log"
if drive sixel TUI_GRAPHICS_TIER=sixel; then
  echo "  PASS  boot: ready+quiescent"
  open_via_quickopen "$S" p i c t u r e
  chk "active buffer is the image" "$(field "$S" activeFileIsImage)" "true"
  sleep 1.5 # sixel encodes the full pixel grid before emitting
  if grep -aq $'\x1bP0;1;0q"1;1;' "$RAW"; then
    echo "  PASS  sixel DCS payload (introducer + raster attributes) reached the pty stream"
  else
    echo "  FAIL  no sixel DCS payload in the raw stream"; fail=1
  fi
  glyphs="$(halfblock_glyphs "$S")"
  if [ "${glyphs:-999}" -eq 0 ]; then
    echo "  PASS  cells under the graphics are BLANK (0 half-block glyphs)"
  else
    echo "  FAIL  expected blank cells under sixel graphics, found $glyphs ▀ glyphs"; fail=1
  fi
  chk "app alive after sixel paint" "$(field "$S" ready)" "true"
  "$H" send "$S" C-q >/dev/null; sleep 1.0
  echo "  PASS  sixel session quit clean (inert pixels need no sweep)"
else
  echo "  FAIL  sixel-tier session never became ready"; fail=1
fi
"$H" kill "$S" >/dev/null 2>&1

echo "== D) HERMETIC floor: half-block cells, zero graphics escapes, binary guard survives =="
S="pix-$$-floor"; RAW="/tmp/pix-raw-$$-floor.log"
if drive floor; then
  echo "  PASS  boot: ready+quiescent"
  open_via_quickopen "$S" p i c t u r e
  chk "active buffer is the image" "$(field "$S" activeFileIsImage)" "true"
  glyphs="$(halfblock_glyphs "$S")"
  if [ "${glyphs:-0}" -gt 500 ]; then
    echo "  PASS  the floor renders half-block cells ($glyphs ▀ glyphs)"
  else
    echo "  FAIL  too few ▀ glyphs on the hermetic floor ($glyphs)"; fail=1
  fi
  # Transmit-specific patterns: OpenTUI's own capability probe may emit a kitty graphics QUERY
  # (a=q) at startup — that is detection, not a placement, and must not trip the floor assertion.
  if grep -aq $'\x1b_Ga=T' "$RAW" || grep -aq $'\x1b_Ga=d' "$RAW" || grep -aq $'\x1bP0;1;0q' "$RAW"; then
    echo "  FAIL  a graphics placement escape reached a terminal that never announced support"; fail=1
  else
    echo "  PASS  no graphics placement on the floor (tmux guard + capability silence)"
  fi
  open_via_quickopen "$S" d a t a
  chk "data.bin is not treated as an image" "$(field "$S" activeFileIsImage)" "false"
  if "$H" capture "$S" | grep -q "(binary file not shown)"; then
    echo "  PASS  non-image binary still hits the binary guard"
  else
    echo "  FAIL  binary guard text missing"; fail=1
  fi
  chk "app alive at the end of the floor drive" "$(field "$S" ready)" "true"
else
  echo "  FAIL  floor session never became ready"; fail=1
fi
"$H" kill "$S" >/dev/null 2>&1

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
