#!/usr/bin/env bash
# Image-preview smoke: proves the WHOLE path — dependency-free PNG decode → half-block cell projection →
# editor mount — by driving the real TUI, not just the unit logic. Layers:
#   A) bun test src/modules/image/  (synthetic-PNG decode round-trips + half-block semantics; no files)
#   B) pure decode of the REAL /tmp/ivue-cart-dark.png: sane dims, rgba.length == w*h*4, varied pixels
#      (the independent-encoder cross-check for the scanline filters, incl. Paeth)
#   C) launch the app on a temp project, open the PNG via quick-open, assert activeFileIsImage + that the
#      editor pane is NON-BLANK half-block cells with MANY distinct fg/bg colours (▀ glyphs present);
#      then open a .ts file and assert it renders as TEXT (no regression) and the app stays alive.
# PID-namespaced tmux sessions (img-$$-*) so concurrent gate runs never collide.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
export PATH="$HOME/.bun/bin:$PATH"
S="img-$$-preview"
W="$(mktemp -d /tmp/tui-img-smoke.XXXXXX)"
PNG="/tmp/ivue-cart-dark.png"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$W"' EXIT INT TERM

echo "== A) unit: PNG decode round-trips + half-block semantics (no external files) =="
if "$BUN" test src/modules/image/ >/tmp/img-unit-$$.log 2>&1; then
  echo "  PASS  image-module unit tests (filters incl. Paeth, colour types 0/2/3/6, half-block top→fg bottom→bg)"
else
  echo "  FAIL  image-module unit tests"; tail -20 /tmp/img-unit-$$.log; fail=1
fi
rm -f /tmp/img-unit-$$.log

echo "== B) pure decode of the real PNG on disk =="
if [ ! -f "$PNG" ]; then echo "  FAIL  missing test image $PNG"; fail=1; else
  if "$BUN" -e "
import { PngDecoder } from './src/modules/image/PngDecoder';
import { readFileSync } from 'node:fs';
const img = PngDecoder.Class.decode(new Uint8Array(readFileSync('$PNG')));
const okDims = img.width > 0 && img.height > 0;
const okLen = img.rgba.length === img.width * img.height * 4;
const distinct = new Set();
for (let i = 0; i < img.rgba.length && distinct.size < 5; i += 4) distinct.add(img.rgba[i] + ',' + img.rgba[i+1] + ',' + img.rgba[i+2]);
if (okDims && okLen && distinct.size >= 2) { console.log('OK ' + img.width + 'x' + img.height); process.exit(0); }
console.error('dims=' + okDims + ' len=' + okLen + ' distinct=' + distinct.size); process.exit(1);
" 2>/tmp/img-decode-$$.log; then
    echo "  PASS  real PNG decodes to sane dims, rgba.length == w*h*4, varied pixels ($(cat /tmp/img-decode-$$.log))"
  else
    echo "  FAIL  real PNG decode assertion: $(cat /tmp/img-decode-$$.log)"; fail=1
  fi
  rm -f /tmp/img-decode-$$.log
fi

echo "== C) drive the app: open the PNG, assert a real half-block image renders =="
( cd "$W" && git init -q && cp "$PNG" picture.png && printf 'export const answer = 42;\nconst greeting = "hello";\n' > sample.ts )
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$W" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
chk "no image at boot" "$(f activeFileIsImage)" "false"

# Quick-open the PNG (Ctrl+P → type 'picture' → Enter) — the real chord/enumeration/rank/open path.
"$H" send "$S" C-p >/dev/null; sleep 1.0
"$H" settle "$S" >/dev/null 2>&1
for c in p i c t u r e; do "$H" send "$S" "$c" >/dev/null; sleep 0.06; done; sleep 0.3
"$H" send "$S" Enter >/dev/null; sleep 0.5
"$H" settle "$S" >/dev/null 2>&1
chk "active buffer is the image after quick-open" "$(f activeFileIsImage)" "true"
opened="$(f activeBuffer)"
case "$opened" in *picture.png) echo "  PASS  activeBuffer is picture.png";; *) echo "  FAIL  activeBuffer=$opened"; fail=1;; esac

# Half-block GLYPHS come from the real terminal (tmux capture-pane shows the actual ▀; the framebuffer
# dump pools complex glyphs into astral IDs, so the glyph channel is the pane, the colour channel is the
# framebuffer). The image pane must be hundreds of ▀ cells — the borders use │ ─ ╭, never ▀.
glyphs="$("$H" capture "$S" | grep -o "▀" | wc -l | tr -d ' ')"
if [ "${glyphs:-0}" -gt 500 ]; then
  echo "  PASS  editor pane is full of half-block ▀ glyphs ($glyphs cells)"
else
  echo "  FAIL  too few ▀ glyphs in the pane ($glyphs)"; "$H" capture "$S" | sed -n '4,9p'; fail=1
fi
# COLOUR variety comes from the exact framebuffer (per-column RGBA lanes): a real image has MANY distinct
# fg AND bg colours across the editor region — a blank/mono pane would have one or two.
colors_ok="$("$BUN" -e "
const dump = require('$ROOT/artifacts/frame-$S.json');
const fgs = new Set(), bgs = new Set();
for (let y = 2; y < 34; y++) {
  const row = dump.rows[y]; if (!row) continue;
  for (let x = 30; x < 115; x++) { if (row.fg[x]) fgs.add(row.fg[x]); if (row.bg[x]) bgs.add(row.bg[x]); }
}
if (fgs.size > 15 && bgs.size > 15) console.log('OK fg=' + fgs.size + ' bg=' + bgs.size);
else console.log('BAD fg=' + fgs.size + ' bg=' + bgs.size);
" 2>&1)"
case "$colors_ok" in
  OK*) echo "  PASS  editor pane carries many distinct fg/bg colours — a real image ($colors_ok)";;
  *)   echo "  FAIL  editor pane colour variety too low ($colors_ok)"; fail=1;;
esac

echo "== app still alive + a .ts file renders as TEXT (no regression) =="
chk "app alive after image render" "$(f ready)" "true"
"$H" send "$S" C-p >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
for c in s a m p l e; do "$H" send "$S" "$c" >/dev/null; sleep 0.06; done; sleep 0.3
"$H" send "$S" Enter >/dev/null; sleep 0.5
"$H" settle "$S" >/dev/null 2>&1
chk "sample.ts is not treated as an image" "$(f activeFileIsImage)" "false"
if "$H" capture "$S" | grep -q "answer"; then
  echo "  PASS  .ts source renders as text after the image (no regression)"
else
  echo "  FAIL  .ts source did not render as text"; "$H" capture "$S" | tail -8; fail=1
fi
chk "app alive after reopening a text file" "$(f ready)" "true"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
