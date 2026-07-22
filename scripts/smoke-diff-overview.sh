#!/usr/bin/env bash
# Driven side-by-side diff contract: overview distribution, unambiguous toolbar, persisted pane
# split, shared drag-autoscroll selection, exact clipboard bytes, and Open current all travel through
# the real git panel -> DiffView user path and are asserted from FrameProbe/status.json.
set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
FIXTURE_ROOT="$(mktemp -d /tmp/tui-diff-overview.XXXXXX)"
TEST_HOME="$(mktemp -d /tmp/tui-diff-home.XXXXXX)"
SESSION_NAME="diff-overview-$$"
FAILURE_COUNT=0

shutdown_session() {
  tmux send-keys -t "$SESSION_NAME" C-q 2>/dev/null || true
  sleep 0.2
  "$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1 || true
}

trap 'shutdown_session; rm -rf "$FIXTURE_ROOT" "$TEST_HOME"' EXIT INT TERM

git -C "$FIXTURE_ROOT" init -q
git -C "$FIXTURE_ROOT" config user.email diff-overview@example.test
git -C "$FIXTURE_ROOT" config user.name 'Diff Overview Smoke'
for line_number in $(seq 1 120); do
  printf 'line %03d original content for selection\n' "$line_number"
done > "$FIXTURE_ROOT/long.txt"
git -C "$FIXTURE_ROOT" add long.txt
git -C "$FIXTURE_ROOT" commit -qm fixture
sed -i '5s/original/modified/' "$FIXTURE_ROOT/long.txt"
sed -i '60a line 060 added content for overview' "$FIXTURE_ROOT/long.txt"
sed -i '116d' "$FIXTURE_ROOT/long.txt"

field() {
  "$HARNESS" field "$SESSION_NAME" "$1" 2>/dev/null
}

settle() {
  "$HARNESS" settle "$SESSION_NAME" 12 >/dev/null 2>&1
}

open_diff() {
  for _attempt in 1 2 3 4; do
    "$HARNESS" send "$SESSION_NAME" C-g >/dev/null
    sleep 0.35
    if [ "$(field focus)" = "git" ]; then break; fi
  done
  for _attempt in 1 2 3 4; do
    "$HARNESS" send "$SESSION_NAME" o >/dev/null
    sleep 0.45
    if [ "$(field showingDiff)" = "true" ]; then
      settle
      return 0
    fi
  done
  return 1
}

frame_text_column() {
  local row_index="$1" text="$2"
  FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" \
    ROW_INDEX="$row_index" NEEDLE="$text" python3 - <<'PY'
import json
import os
with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']
print(rows[int(os.environ['ROW_INDEX'])].get('text', '').find(os.environ['NEEDLE']))
PY
}

echo '== open a real long working-tree diff =='
"$HARNESS" launch "$SESSION_NAME" 120x40 \
  env HOME="$TEST_HOME" COLORTERM=truecolor TUI_FRAME_DUMP=1 \
  bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
if ! "$HARNESS" ready "$SESSION_NAME" 20 >/dev/null || ! open_diff; then
  echo '  FAIL  git panel did not open the changed file in DiffView'
  exit 1
fi
echo '  PASS  git panel opened the changed file in DiffView'

echo '== overview ruler: top middle bottom marks and unchanged gap =='
if FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json
import os

with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']

colors = {
    'modified': '249,226,175,255',
    'added': '166,227,161,255',
    'deleted': '243,139,168,255',
}
width = max(len(row.get('bg', [])) for row in rows)
candidate_columns = []
for column in range(max(0, width - 8), width):
    found = {
        name: [row_index for row_index, row in enumerate(rows)
               if column < len(row.get('bg', [])) and row['bg'][column] == color]
        for name, color in colors.items()
    }
    if all(found.values()):
        candidate_columns.append((column, found))

if not candidate_columns:
    raise SystemExit('no right-edge column carries all three overview colors')
overview_column, found_rows = candidate_columns[-1]
track_top = 2
track_bottom = len(rows) - 2
track_extent = max(1, track_bottom - track_top)
modified_position = (min(found_rows['modified']) - track_top) / track_extent
added_position = (min(found_rows['added']) - track_top) / track_extent
deleted_position = (max(found_rows['deleted']) - track_top) / track_extent
if not (modified_position < 0.2 and 0.35 < added_position < 0.65 and deleted_position > 0.8):
    raise SystemExit(f'wrong distribution at column {overview_column}: {found_rows}')
unchanged_row = track_top + track_extent // 4
unchanged_color = rows[unchanged_row]['bg'][overview_column]
if unchanged_color in colors.values():
    raise SystemExit(f'unchanged quarter-row {unchanged_row} painted {unchanged_color}')
print(f'  PASS  ruler column {overview_column}: modified={found_rows["modified"]}, '
      f'added={found_rows["added"]}, deleted={found_rows["deleted"]}; '
      f'unchanged row {unchanged_row} is clear')
PY
then
  :
else
  echo '  FAIL  overview ruler did not match the separated changes'
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

echo '== toolbar: base/current labels, right-side Open current, clickable Next =='
base_title_column="$(frame_text_column 2 'Base (HEAD)')"
current_title_column="$(frame_text_column 2 'Current (working)')"
open_current_column="$(frame_text_column 1 'Open current')"
next_change_column="$(frame_text_column 1 'Next')"
if [ "$base_title_column" -ge 0 ] && [ "$current_title_column" -gt "$base_title_column" ] && \
   [ "$open_current_column" -ge "$current_title_column" ]; then
  echo "  PASS  Base (HEAD) is left, Current (working) is right, Open current is over current ($open_current_column >= $current_title_column)"
else
  echo "  FAIL  toolbar/title placement base=$base_title_column current=$current_title_column open=$open_current_column"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

scroll_before_next="$(field diffScrollTop)"
"$HARNESS" click "$SESSION_NAME" "$((next_change_column + 1))" 1 >/dev/null
sleep 0.4
settle
scroll_after_next="$(field diffScrollTop)"
if [ "${scroll_after_next:-0}" -gt "${scroll_before_next:-0}" ] 2>/dev/null; then
  echo "  PASS  clicking Next advanced the aligned diff offset ($scroll_before_next -> $scroll_after_next)"
else
  echo "  FAIL  clicking Next did not advance the diff ($scroll_before_next -> $scroll_after_next)"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

echo '== draggable split: live width change and persistence to a second diff open =='
current_column_before_drag="$(frame_text_column 2 'Current (working)')"
divider_column=$((current_column_before_drag - 2))
"$HARNESS" drag "$SESSION_NAME" "$divider_column" 10 "$((divider_column + 14))" 10 >/dev/null
sleep 0.4
settle
current_column_after_drag="$(frame_text_column 2 'Current (working)')"
persisted_ratio="$(field diffSplitRatio)"
if [ "$current_column_after_drag" -gt "$current_column_before_drag" ] && \
   awk "BEGIN { exit !($persisted_ratio > 0.5) }"; then
  echo "  PASS  divider drag moved current pane right ($current_column_before_drag -> $current_column_after_drag), ratio=$persisted_ratio"
else
  echo "  FAIL  divider did not live-resize/persist ($current_column_before_drag -> $current_column_after_drag), ratio=$persisted_ratio"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

"$HARNESS" send "$SESSION_NAME" Escape >/dev/null
sleep 0.3
if ! open_diff; then
  echo '  FAIL  second diff did not reopen'
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
else
  current_column_after_reopen="$(frame_text_column 2 'Current (working)')"
  if [ "$current_column_after_reopen" = "$current_column_after_drag" ]; then
    echo "  PASS  second diff reused the persisted split column $current_column_after_reopen"
  else
    echo "  FAIL  second diff reset split ($current_column_after_drag -> $current_column_after_reopen)"
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
  fi
fi

echo '== diff selection: held bottom-edge drag autoscrolls, paints, and copies exact text =='
current_title_column="$(frame_text_column 2 'Current (working)')"
selection_column=$((current_title_column + 7))
# SGR coordinates are 1-based. Press near the top of current text, establish capture inside the
# pane, then hold at the last code row so SelectionDragBehavior keeps advancing before release.
printf -v selection_press '\033[<0;%d;%dM' "$((selection_column + 1))" 6
printf -v selection_drag_inside '\033[<32;%d;%dM' "$((selection_column + 1))" 31
printf -v selection_drag_edge '\033[<32;%d;%dM' "$((selection_column + 1))" 38
printf -v selection_release '\033[<0;%d;%dm' "$((selection_column + 1))" 38
tmux send-keys -t "$SESSION_NAME" -l "$selection_press"
sleep 0.08
tmux send-keys -t "$SESSION_NAME" -l "$selection_drag_inside"
sleep 0.08
tmux send-keys -t "$SESSION_NAME" -l "$selection_drag_edge"
sleep 1.1
tmux send-keys -t "$SESSION_NAME" -l "$selection_release"
sleep 0.4
# Some terminal/tmux stacks coalesce a release that lands on the last renderable row; repeat the
# idempotent release once so pointer capture is certainly cleared before keyboard/click assertions.
tmux send-keys -t "$SESSION_NAME" -l "$selection_release"
sleep 0.2
settle

selection_scroll_offset="$(field diffScrollTop)"
selection_character_count="$(field diffSelectionChars)"
selection_painted_rows="$(FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json
import os
with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']
selection_color = '69,71,90,255'
print(sum(1 for row in rows if selection_color in row.get('bg', [])))
PY
)"
if [ "${selection_scroll_offset:-0}" -gt 0 ] && [ "${selection_character_count:-0}" -gt 200 ] && \
   [ "${selection_painted_rows:-0}" -gt 10 ]; then
  echo "  PASS  held edge drag scrolled to $selection_scroll_offset and selected $selection_character_count chars across $selection_painted_rows painted rows"
else
  echo "  FAIL  drag result scroll=$selection_scroll_offset chars=$selection_character_count paintedRows=$selection_painted_rows"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

for _attempt in 1 2 3; do
  "$HARNESS" send "$SESSION_NAME" C-c >/dev/null
  sleep 0.6
  if [ "$(field lastCopyChars)" = "$selection_character_count" ]; then break; fi
done
settle
if STATUS_PATH="$PROJECT_ROOT/artifacts/status-$SESSION_NAME.json" \
   CURRENT_PATH="$FIXTURE_ROOT/long.txt" python3 - <<'PY'
import hashlib
import json
import os

with open(os.environ['STATUS_PATH'], encoding='utf-8') as status_file:
    status = json.load(status_file)
selection = status.get('diffSelection')
if not selection or selection.get('side') != 'current':
    raise SystemExit('selection is not in the current pane')
with open(os.environ['CURRENT_PATH'], encoding='utf-8') as current_file:
    lines = current_file.read().split('\n')
start = selection['start']
end = selection['end']
if start['line'] == end['line']:
    selected_text = lines[start['line']][start['col']:end['col']]
else:
    parts = [lines[start['line']][start['col']:]]
    parts.extend(lines[start['line'] + 1:end['line']])
    parts.append(lines[end['line']][:end['col']])
    selected_text = '\n'.join(parts)
expected_hash = hashlib.sha256(selected_text.encode('utf-8')).hexdigest()
if status.get('lastCopyChars') != len(selected_text):
    raise SystemExit(f'clipboard length mismatch: {status.get("lastCopyChars")} != {len(selected_text)}')
if status.get('lastCopyHash') != expected_hash:
    raise SystemExit(f'clipboard hash mismatch: {status.get("lastCopyHash")} != {expected_hash}')
print(f'  PASS  Ctrl+C delivered the exact selected span ({len(selected_text)} chars, SHA-256 matched)')
PY
then
  :
else
  echo '  FAIL  Ctrl+C bytes did not match the selected current-file span'
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

echo '== Open current: right-side affordance opens the working editable file =='
open_current_column="$(frame_text_column 1 'Open current')"
for _attempt in 1 2 3; do
  "$HARNESS" click "$SESSION_NAME" "$((open_current_column + 2))" 1 >/dev/null
  sleep 0.5
  if [ "$(field showingDiff)" = "false" ]; then break; fi
done
settle
active_buffer="$(field activeBuffer)"
current_file_visible="$(FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json
import os
with open(os.environ['FRAME_PATH'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']
print('true' if any('line 005 modified content' in row.get('text', '') for row in rows) else 'false')
PY
)"
if [ "$(field showingDiff)" = "false" ] && [ "$active_buffer" = "$FIXTURE_ROOT/long.txt" ] && \
   [ "$current_file_visible" = "true" ]; then
  echo '  PASS  Open current dismissed the diff and opened the working long.txt editor'
else
  echo "  FAIL  Open current result showingDiff=$(field showingDiff) activeBuffer=$active_buffer"
  FAILURE_COUNT=$((FAILURE_COUNT + 1))
fi

echo ''
if [ "$FAILURE_COUNT" -eq 0 ]; then
  echo 'smoke-diff-overview: ALL-PASS'
else
  echo "smoke-diff-overview: FAILURES ($FAILURE_COUNT)"
fi
exit "$FAILURE_COUNT"
