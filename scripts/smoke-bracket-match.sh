#!/usr/bin/env bash
# Bracket-matching smoke (editor parity). Two layers:
#   A) deterministic unit tests via `bun test` (the pure finder: nesting, adjacency, multi-line,
#      per-family, unbalanced, scan cap, string-skip; + findInDocument via the real tokenizer).
#   B) real drive under tmux on a .ts fixture: put the cursor on a `{`, assert (i) the probe reports the
#      matching `}` cell, and (ii) via FrameProbe the `}` cell is RECOLOURED (its fg = the accent it
#      shares with the cursor's `{`, distinct from an unhighlighted bracket). Move the cursor OFF → the
#      match clears (probe -1, and the `}` fg reverts). Bracket match highlights via foreground (accent +
#      bold) — a deliberate matching-bracket style (à la Vim MatchParen), distinct from find's background.
# Usage: scripts/smoke-bracket-match.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
FIX="$(mktemp -d /tmp/tui-bracket.XXXXXX)"
S="bracket-$$"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
type_str() { local i; for ((i=0;i<${#1};i++)); do "$H" send "$S" "${1:$i:1}" >/dev/null; sleep 0.04; done; }
# Extract "openerFg|closerFg" from the frame: locate the lone `{`/`}` glyphs and read their FOREGROUND
# colour (the bracket-match highlight recolours fg to the accent). NOTE: FrameProbe remaps box-drawing
# glyphs to ASTRAL codepoints (2 UTF-16 units, 1 display cell), so a UTF-16 indexOf misaligns with the
# per-CELL fg array — index by CODE POINTS (Array.from) instead, where index == display cell.
brace_fgs() {
  "$BUN" -e '
    const f = JSON.parse(require("fs").readFileSync(process.argv[1]));
    const cellOf = (glyph) => {
      for (const r of f.rows) { const cells = Array.from(r.text); const i = cells.indexOf(glyph); if (i >= 0) return r.fg[i]; }
      return null;
    };
    const o = cellOf("{"), c = cellOf("}");
    process.stdout.write(o && c ? [o, c].join("|") : "MISSING");
  ' "$ROOT/artifacts/frame-$S.json"
}

# Allman-brace fixture: the braces sit ALONE on their lines, so they are trivial to locate in the frame.
# `git init` the dir so quick-open (which enumerates via `git ls-files --others`) lists the file — an
# untracked file is enough (no commit needed); bracket matching itself is git-agnostic.
printf 'function f()\n{\n  return 1;\n}\n' > "$FIX/sample.ts"
( cd "$FIX" && git init -q )

trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$FIX"' EXIT INT TERM

echo "== A) deterministic unit tests (pure finder + findInDocument tokenizer gate) =="
if "$BUN" test src/modules/editor/BracketMatch.test.ts >/tmp/bracket-unit-$$.log 2>&1; then
  echo "  PASS  bracket unit tests (nesting, adjacency, multi-line, per-family, unbalanced, cap, string-skip)"
else
  echo "  FAIL  bracket unit tests"; tail -25 /tmp/bracket-unit-$$.log; fail=1
fi
rm -f /tmp/bracket-unit-$$.log

echo "== B) launch + open the .ts fixture =="
# COLORTERM=truecolor so the engine does not quantize colours (accent vs operator would otherwise collapse).
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 COLORTERM=truecolor bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
"$H" send "$S" C-p >/dev/null; sleep 1.0; "$H" settle "$S" >/dev/null 2>&1
type_str "sample"
"$H" send "$S" Enter >/dev/null; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
opened="$(f activeBuffer)"
case "$opened" in *sample.ts) echo "  PASS  opened sample.ts";; *) echo "  FAIL  did not open sample.ts ($opened)"; fail=1;; esac
# Opening via quick-open leaves focus on the file tree; Tab moves focus to the editor so arrows move the
# EDITOR cursor (not the tree selection).
"$H" send "$S" Tab >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
chk "editor focused" "$(f focus)" "editor"

echo "== cursor ON the '{' (line 1): the matching '}' is reported + recoloured =="
# Baseline: the unhighlighted '}' fg (cursor is on 'f', not a bracket).
offFg="$(brace_fgs | cut -d'|' -f2)"
"$H" send "$S" Down >/dev/null; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1   # (0,0) -> (1,0), on the '{'
chk "match line is the '}' line (3)" "$(f matchingBracketLine)" "3"
chk "match column is 0" "$(f matchingBracketColumn)" "0"
on="$(brace_fgs)"; openerFg="${on%%|*}"; closerFg="${on##*|}"
if [ "$on" = "MISSING" ]; then echo "  FAIL  could not locate the brace glyphs in the frame"; fail=1
elif [ "$openerFg" = "$closerFg" ] && [ "$closerFg" != "$offFg" ]; then
  echo "  PASS  the matching '}' is recoloured to the accent shared with '{' (fg $closerFg, was $offFg)"
else
  echo "  FAIL  match not recoloured (opener=$openerFg closer=$closerFg baseline=$offFg)"; fail=1
fi

echo "== move the cursor OFF the bracket: the match clears =="
"$H" send "$S" Up >/dev/null; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1   # (1,0) -> (0,0), on 'f' (not a bracket)
chk "no match when off a bracket" "$(f matchingBracketLine)" "-1"
clearedFg="$(brace_fgs | cut -d'|' -f2)"
if [ "$clearedFg" != "MISSING" ] && [ "$clearedFg" = "$offFg" ]; then
  echo "  PASS  '}' fg reverted to its unhighlighted colour (highlight cleared: $clearedFg)"
else
  echo "  FAIL  highlight did not clear (closer fg=$clearedFg baseline=$offFg)"; fail=1
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
