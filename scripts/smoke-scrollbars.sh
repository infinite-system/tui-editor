#!/usr/bin/env bash
# Driven scrollbar contract: every overflowing sidebar pane gets a horizontal bar, real Option-wheel
# reaches clipped content, horizontal bar renders plain at the same settings thickness as the vertical (no axis-balanced overlay), and panes
# whose content fits paint no horizontal bar. Semantic movement is asserted from FrameProbe because
# the user-visible clipped/revealed text and sub-cell glyph shape are the authoritative outcomes.
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
overflow_session="scrollbars-overflow-$$"
fits_session="scrollbars-fits-$$"
overflow_workspace="$(mktemp -d /tmp/tui-scrollbars-overflow.XXXXXX)"
fits_workspace="$(mktemp -d /tmp/tui-scrollbars-fits.XXXXXX)"
failure_count=0

cleanup() {
  "$harness" kill "$overflow_session" >/dev/null 2>&1 || true
  "$harness" kill "$fits_session" >/dev/null 2>&1 || true
  rm -rf "$overflow_workspace" "$fits_workspace"
}
trap cleanup EXIT INT TERM

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; failure_count=$((failure_count + 1)); }
frame_path() { echo "$repository_root/artifacts/frame-$1.json"; }
frame_contains() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
frame = json.load(open(sys.argv[1]))
marker = sys.argv[2]
raise SystemExit(0 if any(marker in row.get('text', '') for row in frame['rows']) else 1)
PY
}
wait_for_frame_text() {
  local frame_file="$1" marker="$2"
  for attempt in $(seq 1 40); do
    frame_contains "$frame_file" "$marker" && return 0
    sleep 0.15
  done
  return 1
}
send_option_wheel_right() {
  local session_name="$1" pointer_column="$2" pointer_row="$3" repeat_count="$4"
  for repeat_index in $(seq 1 "$repeat_count"); do
    tmux send-keys -t "$session_name" -l "$(printf '\033[<75;%d;%dM' "$pointer_column" "$pointer_row")"
    sleep 0.025
  done
  sleep 0.8
  "$harness" settle "$session_name" 10 >/dev/null 2>&1
}
horizontal_bar_row_count() {
  python3 - "$1" <<'PY'
import json
import sys
frame = json.load(open(sys.argv[1]))
sidebar_end = 27
count = 0
for row in frame['rows']:
    text = row.get('text', '')[1:sidebar_end]
    if sum(character in '█▌▐' for character in text) >= 8:
        count += 1
print(count)
PY
}
vertical_bar_column_count() {
  python3 - "$1" <<'PY'
import json
import sys
frame = json.load(open(sys.argv[1]))
sidebar_end = 27
horizontal_rows = set()
for row_index, row in enumerate(frame['rows']):
    text = row.get('text', '')[1:sidebar_end]
    if sum(character in '█▌▐' for character in text) >= 8:
        horizontal_rows.add(row_index)
columns = 0
for column in range(1, sidebar_end):
    painted_rows = 0
    for row_index, row in enumerate(frame['rows']):
        if row_index in horizontal_rows:
            continue
        text = row.get('text', '')
        if column < len(text) and text[column] in '█▀▄▌▐':
            painted_rows += 1
    if painted_rows >= 1:
        columns += 1
print(columns)
PY
}

echo "== build narrow overflowing repository fixture =="
mkdir -p "$overflow_workspace/.invar"
printf '%s\n' \
  '{"sidebarWidth":28,"scrollbarThickness":1,"horizontalScrollModifier":"alt","linesPerNotch":3,"gitSplitRatio":0.5,"showActivityBar":false}' \
  > "$overflow_workspace/.invar/settings.json"
(
  cd "$overflow_workspace" || exit 1
  git init -q
  git config user.name scrollbar-smoke
  git config user.email scrollbar-smoke@example.com
  printf '.invar/\n' > .gitignore
  printf 'base\n' > base.txt
  for file_number in $(seq -w 1 50); do printf 'short\n' > "short-$file_number.txt"; done
  git add .gitignore base.txt short-*.txt
  git commit -qm base
  for commit_number in $(seq -w 1 22); do
    printf '%s\n' "$commit_number" >> base.txt
    git add base.txt
    git commit -qm "short-$commit_number"
  done
  long_file_name='000-VERY-LONG-CHANGES-FILENAME-THAT-ENDS-WITH-CHANGES-END-MARKER.txt'
  printf 'one\n' > "$long_file_name"
  git add "$long_file_name"
  git commit -qm 'VERY-LONG-COMMIT-SUBJECT-THAT-ENDS-WITH-LOG-END-MARKER'
  printf 'two\n' >> "$long_file_name"
)

echo "== tree: horizontal bar paints, matches vertical thickness, and reveals clipped tail =="
"$harness" launch "$overflow_session" 54x28 env TUI_FRAME_DUMP=1 bun run src/main.ts "$overflow_workspace" >/dev/null
if "$harness" ready "$overflow_session" 20 >/dev/null; then pass "overflow fixture booted"; else fail "overflow fixture did not boot"; fi
overflow_frame="$(frame_path "$overflow_session")"
tree_horizontal_rows="$(horizontal_bar_row_count "$overflow_frame")"
tree_vertical_columns="$(vertical_bar_column_count "$overflow_frame")"
if [ "$tree_horizontal_rows" = "1" ]; then pass "tree paints one horizontal bar row"; else fail "tree horizontal bar row count is $tree_horizontal_rows, expected 1"; fi
if [ "$tree_vertical_columns" = "1" ]; then pass "tree paints one vertical bar column"; else fail "tree vertical bar column count is $tree_vertical_columns, expected 1"; fi
if [ "$tree_horizontal_rows" = "$tree_vertical_columns" ]; then
  pass "horizontal and vertical bars render at the SAME settings thickness (uniform, plain — no axis-balanced overlay)"
else
  fail "axis-adjusted thickness differs ($tree_horizontal_rows horizontal rows vs $tree_vertical_columns vertical columns)"
fi
if frame_contains "$overflow_frame" 'CHANGES-END-MARKER'; then fail "tree tail was not clipped before scrolling"; else pass "tree tail starts clipped"; fi
send_option_wheel_right "$overflow_session" 10 5 30
if frame_contains "$overflow_frame" 'CHANGES-END-MARKER'; then pass "Option-wheel reveals the tree filename tail"; else fail "Option-wheel did not reveal the tree filename tail"; fi

echo "== git changes + log: each pane owns a horizontal bar and independent offset =="
"$harness" send "$overflow_session" C-g >/dev/null
if wait_for_frame_text "$overflow_frame" 'VERY-LONG-COMM'; then pass "git log loaded in the live panel"; else fail "git log did not load"; fi
"$harness" settle "$overflow_session" 10 >/dev/null 2>&1
git_horizontal_rows="$(horizontal_bar_row_count "$overflow_frame")"
if [ "$git_horizontal_rows" -ge 2 ] 2>/dev/null; then pass "changes and log each paint a horizontal bar"; else fail "git painted $git_horizontal_rows horizontal bar rows, expected at least 2"; fi
if frame_contains "$overflow_frame" 'END-MARKER.txt'; then fail "changes tail was not clipped before scrolling"; else pass "changes tail starts clipped"; fi
if frame_contains "$overflow_frame" 'LOG-END-MARKER'; then fail "log tail was not clipped before scrolling"; else pass "log tail starts clipped"; fi
send_option_wheel_right "$overflow_session" 10 5 30
if frame_contains "$overflow_frame" 'END-MARKER.txt'; then pass "Option-wheel reveals the changes filename tail"; else fail "Option-wheel did not reveal the changes filename tail"; fi
if frame_contains "$overflow_frame" 'LOG-END-MARKER'; then fail "changes scrolling moved the independent log pane"; else pass "changes scrolling leaves the log offset untouched"; fi
send_option_wheel_right "$overflow_session" 10 22 30
if frame_contains "$overflow_frame" 'LOG-END-MARKER'; then pass "Option-wheel reveals the commit subject tail"; else fail "Option-wheel did not reveal the commit subject tail"; fi

echo "== fitting tree + git panes paint no horizontal bar =="
mkdir -p "$fits_workspace/.invar"
printf '%s\n' '{"sidebarWidth":28,"scrollbarThickness":1,"gitSplitRatio":0.5,"showActivityBar":false}' > "$fits_workspace/.invar/settings.json"
(
  cd "$fits_workspace" || exit 1
  git init -q
  git config user.name scrollbar-smoke
  git config user.email scrollbar-smoke@example.com
  printf '.invar/\n' > .gitignore
  printf 'one\n' > a.txt
  git add .gitignore a.txt
  git commit -qm fit
  printf 'two\n' >> a.txt
)
"$harness" launch "$fits_session" 54x28 env TUI_FRAME_DUMP=1 bun run src/main.ts "$fits_workspace" >/dev/null
if "$harness" ready "$fits_session" 20 >/dev/null; then pass "fitting fixture booted"; else fail "fitting fixture did not boot"; fi
fits_frame="$(frame_path "$fits_session")"
fits_tree_horizontal_rows="$(horizontal_bar_row_count "$fits_frame")"
if [ "$fits_tree_horizontal_rows" = "0" ]; then pass "fitting tree paints no horizontal bar"; else fail "fitting tree painted $fits_tree_horizontal_rows horizontal bar rows"; fi
"$harness" send "$fits_session" C-g >/dev/null
if wait_for_frame_text "$fits_frame" 'fit'; then pass "fitting git panel loaded"; else fail "fitting git panel did not load"; fi
"$harness" settle "$fits_session" 10 >/dev/null 2>&1
fits_git_horizontal_rows="$(horizontal_bar_row_count "$fits_frame")"
if [ "$fits_git_horizontal_rows" = "0" ]; then pass "fitting git panes paint no horizontal bar"; else fail "fitting git panes painted $fits_git_horizontal_rows horizontal bar rows"; fi

echo ""
if [ "$failure_count" = "0" ]; then
  echo "smoke-scrollbars: ALL-PASS"
else
  echo "smoke-scrollbars: FAILURES ($failure_count)"
fi
exit "$failure_count"
