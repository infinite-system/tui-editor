#!/usr/bin/env bash
# Driven indent-guides contract: a faint vertical bar at each indent level in the leading whitespace,
# drawn IN PLACE of the space (columns unchanged), in the dim/border colour — and gone when the
# showIndentGuides setting is off. Asserts rendered cells + fg colour from FrameProbe, and that the
# caret column is unaffected. Usage: scripts/smoke-indent-guides.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
fail=0
FIX="$(mktemp -d /tmp/tui-indent-fix.XXXXXX)"
TEST_HOME="$(mktemp -d /tmp/tui-indent-home.XXXXXX)"
trap 'rm -rf "$FIX" "$TEST_HOME"; [ -n "${S1:-}" ] && "$H" kill "$S1" >/dev/null 2>&1; [ -n "${S2:-}" ] && "$H" kill "$S2" >/dev/null 2>&1' EXIT INT TERM

# Nested indentation with 4-space levels: 'deep()' sits at indent 12 (three levels -> three guides).
printf 'function outer() {\n    const a = 1;\n    if (a) {\n        const b = 2;\n        while (b) {\n            deep();\n        }\n    }\n}\n' > "$FIX/nested.ts"

open_nested() { # <session>
  for _ in 1 2 3 4 5; do
    b="$("$H" field "$1" activeBuffer 2>/dev/null)"; [ -n "$b" ] && [ "$b" != "null" ] && return 0
    "$H" send "$1" Down >/dev/null; "$H" send "$1" Enter >/dev/null; sleep 0.3
  done; return 1
}

# Report, for the 12-cell indent immediately before 'deep(' on its rendered row:
#   <guideCount> <guideFg> <textFg>
# Cells are iterated as CODE POINTS (Array.from), one per display column — FrameProbe remaps the
# box-drawing guide into an astral-plane glyph (2 UTF-16 units), so a raw string slice would misalign;
# the fg array is per display cell, so code-point index maps to the fg index. Guides are the only
# non-space cells in the leading indent, so counting non-space == counting guides.
probe() { # <session-frame-file>
  FRAME_FILE="$1" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
for(const row of f.rows){
  const cells=Array.from(row.text||""), fgs=row.fg||[];
  let deepIndex=-1;
  for(let k=0;k+5<=cells.length;k++){ if(cells.slice(k,k+5).join("")==="deep("){ deepIndex=k; break; } }
  if(deepIndex<12) continue;
  const indent=cells.slice(deepIndex-12, deepIndex);
  const guideCount=indent.filter(cell=>cell!==" ").length;   // only guides are non-space here
  let guideFg="none";
  for(let k=deepIndex-12;k<deepIndex;k++){ if(cells[k]!==" "){ guideFg=fgs[k]||"none"; break; } }
  const textFg=fgs[deepIndex]||"none";                        // colour of the "d" of deep()
  process.stdout.write(guideCount+" "+guideFg+" "+textFg);
  process.exit(0);
}
process.stdout.write("NOROW");
'; }

echo "== guides ON (default): a vertical bar at each indent level, in the border colour =="
S1="indent-on-$$"
"$H" launch "$S1" 120x40 env HOME="$TEST_HOME" TUI_FRAME_DUMP=1 COLORTERM=truecolor bun run src/main.ts "$FIX" >/dev/null
if ! "$H" ready "$S1" 20 >/dev/null || ! open_nested "$S1"; then echo "  FAIL  editor did not open nested.ts"; exit 1; fi
sleep 0.3; "$H" settle "$S1" >/dev/null 2>&1
FR1="$ROOT/artifacts/frame-$S1.json"
read -r on_count guide_fg text_fg <<<"$(probe "$FR1")"
if [ "${on_count:-0}" = "3" ]; then echo "  PASS  three indent guides render on the indent-12 line (deep())"; else echo "  FAIL  expected 3 guides on the indent-12 line, got '${on_count:-?}'"; fail=1; fi
if [ -n "$guide_fg" ] && [ "$guide_fg" != "none" ] && [ "$guide_fg" != "$text_fg" ]; then echo "  PASS  the guide is drawn in a distinct dim colour ($guide_fg vs text $text_fg)"; else echo "  FAIL  guide colour '$guide_fg' is not distinct from the code text '$text_fg'"; fail=1; fi

echo "== caret is NOT shifted by the guides: clicking 'deep' lands on grapheme column 12 =="
deep_coord="$(FRAME_FILE="$FR1" "$BUN" -e '
const f=JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE));
for(let y=0;y<f.rows.length;y++){const cells=Array.from(f.rows[y].text||"");for(let k=0;k+5<=cells.length;k++){if(cells.slice(k,k+5).join("")==="deep("){console.log(k+" "+y);process.exit(0);}}}')"
dcol="${deep_coord%% *}"; drow="${deep_coord##* }"
"$H" click "$S1" "$dcol" "$drow" >/dev/null; "$H" settle "$S1" >/dev/null 2>&1
# The cursor field is an object ("[object Object]" via the field printer), so read col from status JSON.
caret_col="$(STATUS_FILE="$ROOT/artifacts/status-$S1.json" "$BUN" -e 'const j=JSON.parse(require("fs").readFileSync(process.env.STATUS_FILE));process.stdout.write(String(j.cursor?.col ?? ""))' 2>/dev/null)"
if [ "${caret_col:-}" = "12" ]; then echo "  PASS  caret landed on column 12 (guides did not shift columns)"; else echo "  FAIL  caret column ${caret_col:-?} != 12 — guides shifted the columns"; fail=1; fi

echo "== guides OFF (showIndentGuides:false): plain spaces, no bars =="
mkdir -p "$TEST_HOME/.config/invar"; printf '{"showIndentGuides":false}\n' > "$TEST_HOME/.config/invar/settings.json"
S2="indent-off-$$"
"$H" launch "$S2" 120x40 env HOME="$TEST_HOME" TUI_FRAME_DUMP=1 COLORTERM=truecolor bun run src/main.ts "$FIX" >/dev/null
if ! "$H" ready "$S2" 20 >/dev/null || ! open_nested "$S2"; then echo "  FAIL  editor did not open nested.ts (off run)"; exit 1; fi
sleep 0.3; "$H" settle "$S2" >/dev/null 2>&1
read -r off_count _ _ <<<"$(probe "$ROOT/artifacts/frame-$S2.json")"
if [ "${off_count:-x}" = "0" ]; then echo "  PASS  no indent guides render when showIndentGuides is off"; else echo "  FAIL  expected 0 guides when off, got '${off_count:-?}'"; fail=1; fi

echo ""
if [ "$fail" = 0 ]; then echo "== RESULT: ALL-PASS =="; else echo "== RESULT: FAILURES =="; fi
exit "$fail"
