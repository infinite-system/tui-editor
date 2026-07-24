#!/usr/bin/env bash
# Image-preview smoke: proves the WHOLE path — ImageDecoders registry (PNG + JPEG) → half-block cell
# projection → editor mount — by driving the real TUI, not just the unit logic. Layers:
#   A) bun test src/modules/image/  (PNG round-trips, jpeg-js round-trips, registry answers, half-block
#      semantics; no external files)
#   B) pure decode of the REAL /tmp/ivue-cart-dark.png (independent-encoder cross-check for the scanline
#      filters, incl. Paeth) + a GENERATED tricolour-band JPEG decoded through the registry's '.jpg'
#      instance: sane dims, rgba.length == w*h*4, band colours within lossy tolerance
#   C) launch the app on a temp project, open the PNG via quick-open, assert activeFileIsImage + that the
#      editor pane is NON-BLANK half-block cells with MANY distinct fg/bg colours (▀ glyphs present);
#      open a .ts file and assert it renders as TEXT (no regression); open the JPEG and assert the
#      half-block cells carry the EXPECTED colours (red band above green above blue in the framebuffer);
#      open a non-image .bin and assert it STILL hits the binary guard — never the preview.
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

echo "== B2) generate a real JPEG fixture + pure decode through the registry's '.jpg' instance =="
# Tricolour horizontal bands (top red, middle green, bottom blue), 600x399, quality 95 — encoded by
# jpeg-js's ENCODER, decoded by the registry's '.jpg' decoder: an in-process round-trip on REAL file
# bytes, and the fixture the app opens in C. Band order is the colour assertion's ground truth.
if "$BUN" -e "
import { encode as encodeJpeg } from 'jpeg-js';
import { ImageDecoders } from './src/modules/image/ImageDecoders';
import { writeFileSync } from 'node:fs';
const width = 600, height = 399;
const bands = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
const frame = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const band = bands[Math.min(2, Math.floor(y / (height / 3)))];
  const offset = (y * width + x) * 4;
  frame[offset] = band[0]; frame[offset + 1] = band[1]; frame[offset + 2] = band[2]; frame[offset + 3] = 255;
}
writeFileSync('$W/photo.jpg', encodeJpeg({ data: frame, width, height }, 95).data);
const decoder = ImageDecoders.Class.decoderFor('.jpg');
if (!decoder) { console.error('no .jpg decoder registered'); process.exit(1); }
const image = decoder(new Uint8Array(require('node:fs').readFileSync('$W/photo.jpg')));
const okDims = image.width === width && image.height === height;
const okLen = image.rgba.length === width * height * 4;
const centerOf = (bandIndex) => (Math.floor(height / 6) + bandIndex * Math.floor(height / 3)) * width * 4 + (width / 2) * 4;
const red = image.rgba[centerOf(0)] > 200 && image.rgba[centerOf(0) + 1] < 60;
const green = image.rgba[centerOf(1) + 1] > 200 && image.rgba[centerOf(1)] < 60;
const blue = image.rgba[centerOf(2) + 2] > 200 && image.rgba[centerOf(2)] < 60;
if (okDims && okLen && red && green && blue) { console.log('OK ' + image.width + 'x' + image.height); process.exit(0); }
console.error('dims=' + okDims + ' len=' + okLen + ' red=' + red + ' green=' + green + ' blue=' + blue); process.exit(1);
" 2>/tmp/img-jpeg-$$.log; then
  echo "  PASS  generated JPEG decodes via the registry: dims, rgba.length, band colours ($(cat /tmp/img-jpeg-$$.log))"
else
  echo "  FAIL  generated-JPEG decode assertion: $(cat /tmp/img-jpeg-$$.log)"; fail=1
fi
rm -f /tmp/img-jpeg-$$.log

echo "== C) drive the app: open the PNG, assert a real half-block image renders =="
( cd "$W" && git init -q && cp "$PNG" picture.png && printf 'export const answer = 42;\nconst greeting = "hello";\n' > sample.ts && printf 'BIN\0\0DATA\0not an image\0trailing\0bytes' > data.bin )
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 COLORTERM=truecolor bun run src/main.ts "$W" >/dev/null
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

echo "== open the JPEG: half-block cells with the EXPECTED colours (red over green over blue) =="
"$H" send "$S" C-p >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
for c in p h o t o; do "$H" send "$S" "$c" >/dev/null; sleep 0.06; done; sleep 0.3
"$H" send "$S" Enter >/dev/null; sleep 0.5
"$H" settle "$S" >/dev/null 2>&1
chk "active buffer is an image after opening the JPEG" "$(f activeFileIsImage)" "true"
opened="$(f activeBuffer)"
case "$opened" in *photo.jpg) echo "  PASS  activeBuffer is photo.jpg";; *) echo "  FAIL  activeBuffer=$opened"; fail=1;; esac
glyphs="$("$H" capture "$S" | grep -o "▀" | wc -l | tr -d ' ')"
if [ "${glyphs:-0}" -gt 500 ]; then
  echo "  PASS  editor pane is full of half-block ▀ glyphs for the JPEG ($glyphs cells)"
else
  echo "  FAIL  too few ▀ glyphs for the JPEG ($glyphs)"; "$H" capture "$S" | sed -n '4,9p'; fail=1
fi
# EXPECTED colours from the exact framebuffer: the fixture is red/green/blue horizontal bands, so the
# fitted image must show red-dominant cell rows ABOVE green-dominant rows ABOVE blue-dominant rows
# (lanes are the engine's packed r,g,b,a — dominance ratios are scale-independent).
bands_ok="$("$BUN" -e "
const dump = require('$ROOT/artifacts/frame-$S.json');
const dominantRows = [];
for (let y = 2; y < 36; y++) {
  const row = dump.rows[y]; if (!row) continue;
  let red = 0, green = 0, blue = 0, cells = 0;
  for (let x = 35; x < 110; x++) {
    const lanes = (row.fg[x] || '').split(',').map(Number);
    if (lanes.length < 3) continue;
    red += lanes[0]; green += lanes[1]; blue += lanes[2]; cells++;
  }
  if (!cells) continue;
  if (red > 2 * green && red > 2 * blue) dominantRows.push('red');
  else if (green > 2 * red && green > 2 * blue) dominantRows.push('green');
  else if (blue > 2 * red && blue > 2 * green) dominantRows.push('blue');
}
const counts = { red: 0, green: 0, blue: 0 };
for (const channel of dominantRows) counts[channel]++;
const order = [...new Set(dominantRows)].join(',');
if (order === 'red,green,blue' && counts.red >= 4 && counts.green >= 4 && counts.blue >= 4)
  console.log('OK red=' + counts.red + ' green=' + counts.green + ' blue=' + counts.blue);
else console.log('BAD order=' + order + ' red=' + counts.red + ' green=' + counts.green + ' blue=' + counts.blue);
" 2>&1)"
case "$bands_ok" in
  OK*) echo "  PASS  JPEG bands render with expected colours in order ($bands_ok)";;
  *)   echo "  FAIL  JPEG band colours wrong ($bands_ok)"; fail=1;;
esac
chk "app alive after the JPEG render" "$(f ready)" "true"

echo "== a non-image binary STILL hits the binary guard (negative case survives) =="
"$H" send "$S" C-p >/dev/null; sleep 0.8; "$H" settle "$S" >/dev/null 2>&1
for c in d a t a; do "$H" send "$S" "$c" >/dev/null; sleep 0.06; done; sleep 0.3
"$H" send "$S" Enter >/dev/null; sleep 0.5
"$H" settle "$S" >/dev/null 2>&1
chk "data.bin is not treated as an image" "$(f activeFileIsImage)" "false"
if "$H" capture "$S" | grep -q "(binary file not shown)"; then
  echo "  PASS  non-image binary shows the binary guard, not the preview"
else
  echo "  FAIL  binary guard text missing for data.bin"; "$H" capture "$S" | tail -8; fail=1
fi
chk "app alive after the binary guard" "$(f ready)" "true"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
