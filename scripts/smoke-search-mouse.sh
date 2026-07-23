#!/usr/bin/env bash
# Driven MOUSE contract for the search surfaces — the real user path, asserted through FrameProbe cells
# (paint) with the per-session status channel as corroboration (state):
#   1. QuickOpen (Ctrl+P go-to-file): NO selected-row arrow; selection + hover shown by row background;
#      a click on a result row opens that file.
#   2. FindBar (Ctrl+F / Ctrl+H): the action buttons are mouse-clickable — next advances the match, the
#      Aa case toggle flips case-sensitivity and re-filters, replace-all mutates the document.
#   3. Open-project path navigator: a live directory listing that re-roots as the path changes, a click
#      drills into a folder, and an un-openable path raises a warning alert glyph in the warning colour.
# Runs in ASCII glyph mode (LANG=C, isolated HOME) so the alert glyph is a visible, assertable cell and
# the find-button columns are deterministic; the mouse hit-testing is glyph-width independent anyway.
#
# invariant: Search results are click-set and highlight-shown (src/modules/search/search.invariants.md)
# invariant: Find bar controls are mouse-clickable buttons (src/modules/search/search.invariants.md)
# invariant: Case sensitivity is a live toggle that re-runs the query (src/modules/search/search.invariants.md)
# invariant: The open-project path input is a live directory navigator (src/modules/search/search.invariants.md)
# invariant: An un-openable open-project path is flagged live (src/modules/search/search.invariants.md)
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
navigator_base="$(mktemp -d /tmp/tui-search-nav.XXXXXX)"
project_root="$navigator_base/proj"   # the app is rooted here, so the navigator's parent IS navigator_base
test_home="$(mktemp -d /tmp/tui-search-home.XXXXXX)"
session_name="search-mouse-$$"
failure_count=0
frame_path="$repository_root/artifacts/frame-$session_name.json"

cleanup() {
  "$harness" kill "$session_name" >/dev/null 2>&1 || true
  rm -rf "$navigator_base" "$test_home"
}
trap cleanup EXIT INT TERM

field() { "$harness" field "$session_name" "$1" 2>/dev/null; }
settle() { sleep 0.30; "$harness" settle "$session_name" 12 >/dev/null 2>&1; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; failure_count=$((failure_count + 1)); }

expect_equal() {
  if [ "$1" = "$2" ]; then pass "$3 ($1)"; else fail "$3 (expected $2, got $1)"; fi
}
expect_contains() {
  case "$1" in *"$2"*) pass "$3";; *) fail "$3 (got '$1')";; esac
}

# Screen row of the first frame row whose text contains the marker, or -1.
row_of() {
  FRAME_PATH="$frame_path" MARKER="$1" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
for y, row in enumerate(rows):
    if os.environ['MARKER'] in row.get('text', ''):
        print(y); break
else:
    print(-1)
PY
}

# Print the background colour string at (x,y) — or 'none'.
bg_at() {
  FRAME_PATH="$frame_path" CX="$1" CY="$2" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
y = int(os.environ['CY']); x = int(os.environ['CX'])
bg = rows[y].get('bg', []) if 0 <= y < len(rows) else []
print(bg[x] if 0 <= x < len(bg) else 'none')
PY
}

# Assert the quick-open result list contains NO '›' (the removed selected-row arrow) on any row.
expect_no_arrow() {
  if FRAME_PATH="$frame_path" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
raise SystemExit(1 if any('›' in r.get('text', '') for r in rows) else 0)
PY
  then pass "$1"; else fail "$1 (a '›' arrow marker is present)"; fi
}

# Locate the find-bar button row and the screen x of the 'A' in the 'Aa' case button — every other
# button column is a fixed offset from it (one geometry source), so clicks are terminal-width independent.
aa_column() {
  FRAME_PATH="$frame_path" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
for y, row in enumerate(rows):
    text = row.get('text', '')
    index = text.find('Aa')
    if index >= 0 and 'esc' in text:  # the find-bar button row carries both 'Aa' and the 'esc' hint
        print(f"{y} {index}"); break
else:
    print("-1 -1")
PY
}

# The project (sample files for QuickOpen + Find) sits under navigator_base, so the open-project
# navigator — which lists the project root's PARENT — lists navigator_base's controlled subfolders.
mkdir -p "$project_root" "$navigator_base/sibling-alpha" "$navigator_base/sibling-beta" "$navigator_base/zebra"
( cd "$project_root" && git init -q \
  && printf 'Alpha alpha ALPHA beta\nsecond line\nAlpha again here\n' > sample.txt \
  && printf 'nothing here\n' > other.txt )

echo "== launch (ascii glyph mode: isolated HOME + LANG=C) =="
"$harness" launch "$session_name" 130x40 env \
  TUI_FRAME_DUMP=1 HOME="$test_home" NERD_FONT=0 TERM_PROGRAM=xterm LANG=C \
  bun run src/main.ts "$project_root" >/dev/null
"$harness" ready "$session_name" 20 >/dev/null

echo "== 1. QuickOpen (Ctrl+P): no arrow, selection + hover are row-background highlights, click opens =="
"$harness" send "$session_name" C-p >/dev/null; sleep 1.0; settle
expect_contains "$(field quickOpenMode)" "files" "Ctrl+P opened go-to-file mode"
expect_no_arrow "no selected-row arrow glyph in the result list"

# The first result row is selected by default — its background must differ from a lower, unselected row.
first_row="$(row_of "other.txt")"
second_row="$(row_of "sample.txt")"
selected_bg="$(bg_at 31 "$first_row")"
unselected_bg="$(bg_at 31 "$second_row")"
if [ "$selected_bg" != "$unselected_bg" ] && [ "$selected_bg" != "none" ]; then
  pass "default selection paints a row background ($selected_bg) distinct from an unselected row ($unselected_bg)"
else
  fail "selected row background ($selected_bg) not distinct from unselected ($unselected_bg)"
fi

# Hover the second result row: the highlight must MOVE onto it (read its background), leaving state alone.
tmux send-keys -t "$session_name" -l "$(printf '\033[<35;32;%dM' "$((second_row + 1))")" >/dev/null
sleep 0.3; settle
hover_bg="$(bg_at 31 "$second_row")"
if [ "$hover_bg" != "none" ] && [ "$hover_bg" != "$unselected_bg" ]; then
  pass "hover moved a background highlight onto the pointed row ($hover_bg)"
else
  fail "hover did not highlight the pointed row (bg $hover_bg)"
fi
expect_equal "$(field quickOpenSelected)" "0" "hover left the selection unchanged"

# Click the second result row: it opens that file and the picker closes.
"$harness" click "$session_name" 32 "$second_row" >/dev/null; sleep 0.5; settle
expect_contains "$(field activeBuffer)" "sample.txt" "clicking a result row opened that file"
expect_equal "$(field quickOpenOpen)" "false" "the picker closed after the click"

echo "== 2. FindBar (Ctrl+F): next / case-toggle / replace-all buttons are mouse-clickable =="
"$harness" send "$session_name" C-f >/dev/null; sleep 0.3
for character in a l p h a; do "$harness" send "$session_name" "$character" >/dev/null; sleep 0.05; done
sleep 0.3; settle
expect_equal "$(field findMatchCount)" "4" "case-insensitive 'alpha' finds 4 matches"
expect_equal "$(field findCurrentMatchIndex)" "0" "the first match is current"

read -r button_row aa_x <<<"$(aa_column)"
if [ "${aa_x:-'-1'}" = "-1" ]; then fail "could not locate the find-bar button row"; fi
next_x=$((aa_x - 4)); case_x=$aa_x

"$harness" click "$session_name" "$next_x" "$button_row" >/dev/null; sleep 0.3; settle
expect_equal "$(field findCurrentMatchIndex)" "1" "clicking the next button advanced the current match"
# The counter cell must reflect the advance ('2 of 4' after moving to index 1).
expect_contains "$(python3 -c "import json;print(json.load(open('$frame_path'))['rows'][$((button_row-1))].get('text',''))")" "2 of 4" "the rendered counter advanced to '2 of 4'"

"$harness" click "$session_name" "$case_x" "$button_row" >/dev/null; sleep 0.3; settle
expect_equal "$(field findCaseSensitive)" "true" "clicking the Aa button turned case-sensitivity on"
expect_equal "$(field findMatchCount)" "1" "case-sensitive 'alpha' re-filters to the single lowercase match"

# Replace mode via Ctrl+H; an empty replacement + a replace-all click DELETES every match — proving the
# button fires and the document mutates (no reliance on the terminal-flaky Tab-to-replacement-field).
"$harness" send "$session_name" C-h >/dev/null; sleep 0.3; settle
revision_before="$(field bufferRevision)"
read -r button_row aa_x <<<"$(aa_column)"   # replace mode adds a replacement line — re-anchor the row
replace_all_x=$((aa_x + 9))
"$harness" click "$session_name" "$replace_all_x" "$button_row" >/dev/null; sleep 0.4; settle
if [ "$(field bufferRevision)" != "$revision_before" ]; then
  pass "clicking replace-all mutated the document (revision $revision_before -> $(field bufferRevision))"
else
  fail "replace-all click did not mutate the document (revision stayed $revision_before)"
fi
expect_equal "$(field findMatchCount)" "0" "no case-sensitive 'alpha' matches remain after replace-all"
"$harness" send "$session_name" Escape >/dev/null; sleep 0.2

echo "== 3. Open-project path navigator: live re-root, click-drill, warning alert on an un-openable path =="
"$harness" send "$session_name" F1 >/dev/null; sleep 0.4
for character in O p e n Space F o l d e r; do "$harness" send "$session_name" "$character" >/dev/null; sleep 0.04; done
"$harness" send "$session_name" Enter >/dev/null; sleep 0.6; settle
expect_contains "$(field quickOpenMode)" "workspacePath" "the open-project navigator opened"
expect_equal "$(field quickOpenPathOpenable)" "true" "the prefilled parent directory is openable (no alert)"
expect_no_arrow "no selected-row arrow glyph in the folder list"

# Type an invalid trailing segment: the listing filters live AND the current path becomes un-openable,
# so a warning alert glyph appears in the warning colour on the input row.
for character in s i b; do "$harness" send "$session_name" "$character" >/dev/null; sleep 0.05; done
sleep 0.3; settle
expect_equal "$(field quickOpenPathOpenable)" "false" "a partial (non-directory) path is flagged un-openable"
expect_equal "$(field quickOpenMatches)" "2" "the listing filtered live to the two 'sib' folders"
input_row="$(row_of "sibling")"   # the box input row is above the list; find the alert on the input row itself
alert_probe="$(FRAME_PATH="$frame_path" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
# The input row is the one carrying the '+' navigator prompt.
for row in rows:
    text = row.get('text', '')
    exclaim = text.find('!')
    if '+' in text and exclaim >= 0:
        fg = row.get('fg', [])
        print(f"{text[exclaim]} {fg[exclaim] if exclaim < len(fg) else 'none'}"); break
else:
    print("MISSING none")
PY
)"
read -r alert_glyph alert_color <<<"$alert_probe"
expect_equal "$alert_glyph" "!" "an alert glyph is painted next to an un-openable path"
# The warning colour is not the ordinary foreground (215,215,255) — it is a distinct warning tone.
if [ "$alert_color" != "none" ] && [ "$alert_color" != "215,215,255,255" ]; then
  pass "the alert glyph is painted in a distinct warning colour ($alert_color)"
else
  fail "the alert glyph is not in a distinct warning colour ($alert_color)"
fi

# Click a folder row: it drills INTO that folder (the path completes) and re-lists — the picker stays open.
folder_row="$(row_of "sibling-alpha")"
"$harness" click "$session_name" 34 "$folder_row" >/dev/null; sleep 0.4; settle
expect_contains "$(field quickOpenQuery)" "sibling-alpha/" "clicking a folder drilled into it (path completed)"
expect_equal "$(field quickOpenOpen)" "true" "the navigator stayed open after drilling in"
expect_equal "$(field quickOpenPathOpenable)" "true" "the navigated-into real directory shows no alert"

echo "== RESULT: $([ "$failure_count" = 0 ] && echo ALL-PASS || echo "FAILURES ($failure_count)") =="
exit "$failure_count"
