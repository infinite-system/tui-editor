#!/usr/bin/env bash
# Driven list-selection contract: click chooses an item, wheel and hover move only their own state,
# blur preserves a dim highlight, and refocused keyboard movement resumes from the same item.
# FrameProbe is authoritative for paint; the per-session status channel is authoritative for state.
# invariant: Selection is item-anchored click-set keyboard-moved and stays (src/modules/ui/ui.invariants.md)
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
fixture_root="$(mktemp -d /tmp/tui-selection.XXXXXX)"
test_home="$(mktemp -d /tmp/tui-selection-home.XXXXXX)"
session_name="selection-$$"
failure_count=0
focused_selection_color='40,52,87,255'   # Tokyo Night selection #283457
# The git changes/staging panel paints its selected rows with the softer-blue selectionMuted token
# (#33467c) so a multi-selection stays legible; tree + commit-log still use the standard selection bg.
changes_focused_selection_color='51,70,124,255'   # selectionMuted #33467c
unfocused_selection_color='44,51,80,255'   # cursorLine #2c3350

cleanup() {
  "$harness" kill "$session_name" >/dev/null 2>&1 || true
  rm -rf "$fixture_root" "$test_home"
}
trap cleanup EXIT INT TERM

field() {
  "$harness" field "$session_name" "$1" 2>/dev/null
}

settle() {
  sleep 0.35
  "$harness" settle "$session_name" 12 >/dev/null 2>&1
}

pass() {
  echo "  PASS  $1"
}

fail() {
  echo "  FAIL  $1"
  failure_count=$((failure_count + 1))
}

expect_equal() {
  local actual_value="$1"
  local expected_value="$2"
  local label="$3"
  if [ "$actual_value" = "$expected_value" ]; then
    pass "$label ($actual_value)"
  else
    fail "$label (expected $expected_value, got $actual_value)"
  fi
}

expect_greater_than() {
  local actual_value="$1"
  local lower_bound="$2"
  local label="$3"
  if [ "${actual_value:-0}" -gt "$lower_bound" ] 2>/dev/null; then
    pass "$label ($actual_value > $lower_bound)"
  else
    fail "$label (expected > $lower_bound, got $actual_value)"
  fi
}

frame_row_has_background() {
  local row_marker="$1"
  local expected_color="$2"
  FRAME_PATH="$repository_root/artifacts/frame-$session_name.json" \
    ROW_MARKER="$row_marker" EXPECTED_COLOR="$expected_color" python3 - <<'PY'
import json
import os

with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']

for row in rows:
    text = row.get('text', '')
    marker_column = text.find(os.environ['ROW_MARKER'])
    if marker_column < 0:
        continue
    backgrounds = row.get('bg', [])
    marker_end = marker_column + len(os.environ['ROW_MARKER'])
    if any(
        column < len(backgrounds) and backgrounds[column] == os.environ['EXPECTED_COLOR']
        for column in range(marker_column, marker_end)
    ):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

expect_row_background() {
  local row_marker="$1"
  local expected_color="$2"
  local label="$3"
  if frame_row_has_background "$row_marker" "$expected_color"; then
    pass "$label"
  else
    fail "$label (marker '$row_marker' lacks background $expected_color)"
  fi
}

# Screen row index of the first frame row whose text contains the marker, or -1. Used to click a list
# item by its rendered position instead of a hardcoded row — robust to any layout shift. Unlike the
# top-anchored tree/changes lists, the commit log is bottom-anchored, so a uniform strip offset does
# not describe its row; locating the item text directly does.
frame_row_of() {
  local row_marker="$1"
  FRAME_PATH="$repository_root/artifacts/frame-$session_name.json" ROW_MARKER="$row_marker" python3 - <<'PY'
import json
import os

with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']
for row_index, row in enumerate(rows):
    if os.environ['ROW_MARKER'] in row.get('text', ''):
        print(row_index)
        break
else:
    print(-1)
PY
}

echo '== build a repository with overflowing tree, changes, and commit-log lists =='
for directory_number in $(seq -w 1 20); do
  mkdir "$fixture_root/directory-$directory_number"
done
for file_number in $(seq -w 1 35); do
  printf 'base %s\n' "$file_number" > "$fixture_root/file-$file_number.txt"
done
git -C "$fixture_root" init -q
git -C "$fixture_root" config user.name selection-smoke
git -C "$fixture_root" config user.email selection-smoke@example.test
git -C "$fixture_root" add .
git -C "$fixture_root" commit -qm base
for commit_number in $(seq -w 1 24); do
  printf '%s\n' "$commit_number" >> "$fixture_root/file-35.txt"
  git -C "$fixture_root" add file-35.txt
  git -C "$fixture_root" commit -qm "commit-$commit_number selection subject"
done
for file_number in $(seq -w 1 25); do
  printf 'changed %s\n' "$file_number" >> "$fixture_root/file-$file_number.txt"
done

"$harness" launch "$session_name" 100x36 \
  env HOME="$test_home" COLORTERM=truecolor TUI_FRAME_DUMP=1 \
  bun run src/main.ts "$fixture_root" >/dev/null
if "$harness" ready "$session_name" 20 >/dev/null; then
  pass 'fixture booted'
else
  fail 'fixture did not boot'
  exit "$failure_count"
fi

# Height-robust content offset: the tree/changes/log lists (and the whole UI below the workspace tab
# strip) shift down by this many rows when the strip grows past 1 line (two-line workspace tabs ->
# offset 1). Every hardcoded list-row click/scroll/hover y below adds it, so the smoke passes at any
# strip height. Derived from the rendered frame, not a compiled-in constant.
content_offset="$("$harness" content-offset "$session_name" 2>/dev/null)"; content_offset="${content_offset:-0}"

echo '== file tree: click, hover, wheel, blur, refocus, and open preserve one selection =='
# Tree index 15 is directory-15 (.git is index 0); screen row = index + 2 before scrolling, plus the
# workspace-strip height offset.
"$harness" click "$session_name" 10 $((17 + content_offset)) >/dev/null
settle
expect_equal "$(field treeSelected)" '15' 'tree click selected item 15'
expect_equal "$(field focus)" 'files' 'directory click kept tree keyboard focus'
expect_row_background 'directory-15' "$focused_selection_color" 'focused tree selection paints the full token'

# Real pointer motion over another row changes hover only.
tmux send-keys -t "$session_name" -l "$(printf '\033[<35;11;%dM' "$((7 + content_offset))")"
settle
expect_equal "$(field treeSelected)" '15' 'tree hover did not move selection'

tree_selection_before_scroll="$(field treeSelected)"
"$harness" scroll "$session_name" 10 $((17 + content_offset)) down 1 >/dev/null
settle
expect_equal "$(field treeSelected)" "$tree_selection_before_scroll" 'tree wheel kept the selected item'
expect_greater_than "$(field treeScrollTop)" '0' 'tree wheel moved only the viewport'
expect_row_background 'directory-15' "$focused_selection_color" 'tree highlight travelled with its item after scroll'

"$harness" send "$session_name" Tab >/dev/null
settle
expect_equal "$(field focus)" 'editor' 'Tab moved focus away from tree'
expect_equal "$(field treeSelected)" "$tree_selection_before_scroll" 'tree selection survived blur'
expect_row_background 'directory-15' "$unfocused_selection_color" 'blurred tree selection stayed visibly dimmed'

"$harness" send "$session_name" Tab >/dev/null
"$harness" send "$session_name" Down >/dev/null
settle
expect_equal "$(field treeSelected)" '16' 'refocused tree arrow resumed one item after selection'
expect_row_background 'directory-16' "$focused_selection_color" 'keyboard-moved tree selection paints full token'

# Move from directory-16 to the first file (index 21), then open it. Opening focuses the editor but
# must leave that clicked/keyboard-selected tree item intact and dimly highlighted.
for movement_count in 1 2 3 4 5; do
  "$harness" send "$session_name" Down >/dev/null
done
"$harness" send "$session_name" Enter >/dev/null
settle
expect_equal "$(field focus)" 'editor' 'opening a file focused the editor'
expect_equal "$(field treeSelected)" '21' 'opening a file preserved its tree selection'
expect_row_background 'file-01.txt' "$unfocused_selection_color" 'opened file remained selected and dimmed in tree'

echo '== git changes: click selection survives hover, scroll, blur, and keyboard resume =='
"$harness" send "$session_name" C-g >/dev/null
sleep 0.8
settle
# Changes row index 10 is file-10.txt; screen row = index + 3 at scrollTop 0, plus the strip offset.
"$harness" click "$session_name" 10 $((13 + content_offset)) >/dev/null
settle
expect_equal "$(field gitRegion)" 'changes' 'changes click focused the changes region'
expect_equal "$(field gitChangesIndex)" '10' 'changes click selected item 10'
expect_equal "$(field focus)" 'editor' 'opening a change moved keyboard focus to its diff'
expect_row_background 'file-10.txt' "$unfocused_selection_color" 'clicked changes selection stayed visibly dimmed after diff focus'

"$harness" send "$session_name" C-g >/dev/null
settle
expect_row_background 'file-10.txt' "$changes_focused_selection_color" 'refocused changes selection paints the full token'

tmux send-keys -t "$session_name" -l "$(printf '\033[<35;11;%dM' "$((7 + content_offset))")"
settle
expect_equal "$(field gitChangesIndex)" '10' 'changes hover did not move selection'

changes_selection_before_scroll="$(field gitChangesIndex)"
"$harness" scroll "$session_name" 10 $((13 + content_offset)) down 1 >/dev/null
settle
expect_equal "$(field gitChangesIndex)" "$changes_selection_before_scroll" 'changes wheel kept the selected item'
expect_greater_than "$(field changesScrollTop)" '0' 'changes wheel moved only the viewport'
expect_row_background 'file-10.txt' "$changes_focused_selection_color" 'changes highlight travelled with its item after scroll'

"$harness" send "$session_name" Tab >/dev/null
settle
expect_equal "$(field gitChangesIndex)" "$changes_selection_before_scroll" 'changes selection survived blur'
expect_row_background 'file-10.txt' "$unfocused_selection_color" 'blurred changes selection stayed visibly dimmed'

"$harness" send "$session_name" C-g >/dev/null
"$harness" send "$session_name" Down >/dev/null
settle
expect_equal "$(field gitChangesIndex)" '11' 'refocused changes arrow resumed one item after selection'
expect_row_background 'file-11.txt' "$changes_focused_selection_color" 'keyboard-moved changes selection paints full token'

echo '== commit log: click selection survives scroll and blur, then keyboard resumes =='
# Commit-log row 10 is commit-14 before expansion. The commit log is bottom-anchored (unlike the
# top-anchored tree/changes lists it does not travel with the strip), so click its rendered row found
# directly in the frame rather than a hardcoded/offset row.
commit_log_row="$(frame_row_of 'commit-14')"
"$harness" click "$session_name" 10 "$commit_log_row" >/dev/null
sleep 0.6
settle
expect_equal "$(field gitRegion)" 'log' 'commit click focused the log region'
expect_equal "$(field gitLogIndex)" '10' 'commit click selected flat item 10'
expect_row_background 'commit-14' "$focused_selection_color" 'focused commit selection paints the full token'

log_selection_before_scroll="$(field gitLogIndex)"
"$harness" scroll "$session_name" 10 "$commit_log_row" down 1 >/dev/null
settle
expect_equal "$(field gitLogIndex)" "$log_selection_before_scroll" 'log wheel kept the selected item'
expect_greater_than "$(field gitLogScrollTop)" '0' 'log wheel moved only the viewport'
expect_row_background 'commit-14' "$focused_selection_color" 'commit highlight travelled with its item after scroll'

"$harness" send "$session_name" Tab >/dev/null
settle
expect_equal "$(field gitLogIndex)" "$log_selection_before_scroll" 'commit selection survived blur'
expect_row_background 'commit-14' "$unfocused_selection_color" 'blurred commit selection stayed visibly dimmed'

# Ctrl+G returns keyboard focus to the still-visible git pane. The region is intentionally preserved,
# so Down advances from the commit header into its expanded file row instead of resetting to changes.
"$harness" send "$session_name" C-g >/dev/null
"$harness" send "$session_name" Down >/dev/null
settle
expect_equal "$(field gitLogIndex)" '11' 'refocused log arrow resumed one item after selection'
expect_row_background 'file-35.txt' "$focused_selection_color" 'keyboard-moved log selection paints full token'

echo ''
if [ "$failure_count" = '0' ]; then
  echo 'smoke-selection: ALL-PASS'
else
  echo "smoke-selection: FAILURES ($failure_count)"
fi
exit "$failure_count"
