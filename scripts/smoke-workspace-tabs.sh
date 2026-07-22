#!/usr/bin/env bash
# Driven contract for project/workspace tabs: add a real second root through the visible plus/input,
# switch by clicking painted tabs, verify tree + git follow the active root, verify watcher flyweight,
# and move the same strip top -> left -> top through the real settings panel.
set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
BUN="$HOME/.bun/bin/bun"
SESSION_NAME="workspace-tabs-$$"
FAILURES=0
FIRST_ROOT="$(mktemp -d /tmp/tui-workspace-first.XXXXXX)"
SECOND_ROOT="$(mktemp -d /tmp/tui-workspace-second.XXXXXX)"
SETTINGS_HOME="$(mktemp -d /tmp/tui-workspace-settings.XXXXXX)"
FIRST_NAME="$(basename "$FIRST_ROOT")"
SECOND_NAME="$(basename "$SECOND_ROOT")"
SECOND_VERTICAL_LABEL="${SECOND_NAME:0:17}"
FRAME_PATH="$SCRIPT_DIRECTORY/../artifacts/frame-$SESSION_NAME.json"

cleanup() {
  "$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1
  rm -rf "$FIRST_ROOT" "$SECOND_ROOT" "$SETTINGS_HOME"
}
trap cleanup EXIT INT TERM

field() { "$HARNESS" field "$SESSION_NAME" "$1"; }
frame_text() {
  "$BUN" -e 'const frame=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(frame.rows.map((row)=>row.text).join("\n"));' "$FRAME_PATH"
}
frame_coordinate() {
  "$BUN" -e 'const frame=JSON.parse(require("fs").readFileSync(process.argv[1]));const target=process.argv[2];for(let rowIndex=0;rowIndex<frame.rows.length;rowIndex+=1){const columnIndex=frame.rows[rowIndex].text.indexOf(target);if(columnIndex>=0){console.log(columnIndex+" "+rowIndex);process.exit(0)}}process.exit(1);' "$FRAME_PATH" "$1"
}
check_equal() {
  if [ "$1" = "$2" ]; then
    echo "  PASS  $3 ($1)"
  else
    echo "  FAIL  $3 (got $1, expected $2)"
    FAILURES=1
  fi
}
check_frame_contains() {
  if frame_text | grep -Fq "$1"; then
    echo "  PASS  $2"
  else
    echo "  FAIL  $2 (missing '$1')"
    FAILURES=1
  fi
}

git -C "$FIRST_ROOT" init -q
git -C "$FIRST_ROOT" config user.email smoke@example.invalid
git -C "$FIRST_ROOT" config user.name Smoke
printf 'first committed\n' > "$FIRST_ROOT/first-root-change.txt"
printf 'first tree\n' > "$FIRST_ROOT/FIRST_TREE_ONLY.txt"
git -C "$FIRST_ROOT" add .
git -C "$FIRST_ROOT" commit -qm first
printf 'first modified\n' >> "$FIRST_ROOT/first-root-change.txt"

git -C "$SECOND_ROOT" init -q
git -C "$SECOND_ROOT" config user.email smoke@example.invalid
git -C "$SECOND_ROOT" config user.name Smoke
printf 'second committed\n' > "$SECOND_ROOT/second-root-change.txt"
printf 'second tree\n' > "$SECOND_ROOT/SECOND_TREE_ONLY.txt"
git -C "$SECOND_ROOT" add .
git -C "$SECOND_ROOT" commit -qm second
printf 'second modified\n' >> "$SECOND_ROOT/second-root-change.txt"

echo "== launch with one workspace and add a second through the visible + path input =="
"$HARNESS" launch "$SESSION_NAME" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$FIRST_ROOT" >/dev/null
"$HARNESS" ready "$SESSION_NAME" 20 >/dev/null || { echo "  FAIL  boot"; exit 1; }
check_equal "$(field workspaceCount)" "1" "booted one workspace"
check_frame_contains "$FIRST_NAME" "first workspace tab paints"
PLUS_COLUMN="$($BUN -e 'const frame=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(String(Array.from(frame.rows[0].text).lastIndexOf("+")));' "$FRAME_PATH")"
"$HARNESS" click "$SESSION_NAME" "$PLUS_COLUMN" 0 >/dev/null
sleep 0.2
tmux send-keys -t "$SESSION_NAME" -l "$SECOND_ROOT"
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_equal "$(field workspaceCount)" "2" "second workspace was added"
check_equal "$(field activeWorkspaceRoot)" "$SECOND_ROOT" "new workspace is active"
check_frame_contains "$SECOND_NAME" "second workspace tab paints"
check_frame_contains "SECOND_TREE_ONLY.txt" "file tree follows the second root"

echo "== second-root git panel follows the active workspace =="
"$HARNESS" send "$SESSION_NAME" C-g >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_frame_contains "second-root-change.txt" "git panel shows the second repository"

echo "== clicking the first workspace tab restores its tree and git repository =="
FIRST_COORDINATE="$(frame_coordinate "$FIRST_NAME")"
FIRST_COLUMN="${FIRST_COORDINATE%% *}"
FIRST_ROW="${FIRST_COORDINATE##* }"
"$HARNESS" click "$SESSION_NAME" "$FIRST_COLUMN" "$FIRST_ROW" >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_equal "$(field activeWorkspaceRoot)" "$FIRST_ROOT" "click switched back to the first root"
check_frame_contains "FIRST_TREE_ONLY.txt" "first file tree returned"
"$HARNESS" send "$SESSION_NAME" C-g >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_frame_contains "first-root-change.txt" "git panel returned to the first repository"

echo "== inactive workspaces retain no live GitWatcher =="
check_equal "$(field liveGitWatcherCount)" "1" "two workspaces cost one live GitWatcher"
check_equal "$(field workspaceLiveGitWatchers)" "true,false" "only the active workspace owns a watcher"

echo "== workspaceTabPosition moves and reorients the same strip top <-> left =="
SECOND_TOP_COORDINATE="$(frame_coordinate "$SECOND_NAME")"
SECOND_TOP_ROW="${SECOND_TOP_COORDINATE##* }"
check_equal "$SECOND_TOP_ROW" "0" "horizontal strip paints both projects on the top row"
"$HARNESS" send "$SESSION_NAME" C-, >/dev/null
for _settingRow in $(seq 1 11); do "$HARNESS" send "$SESSION_NAME" Down >/dev/null; done
"$HARNESS" send "$SESSION_NAME" Right >/dev/null
"$HARNESS" send "$SESSION_NAME" Escape >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_equal "$(field workspaceTabPosition)" "left" "settings panel live-applied left orientation"
SECOND_LEFT_COORDINATE="$(frame_coordinate "$SECOND_VERTICAL_LABEL")"
SECOND_LEFT_COLUMN="${SECOND_LEFT_COORDINATE%% *}"
SECOND_LEFT_ROW="${SECOND_LEFT_COORDINATE##* }"
check_equal "$SECOND_LEFT_ROW" "1" "vertical strip stacks the second project on row 1"
if [ "$SECOND_LEFT_COLUMN" -lt 22 ]; then
  echo "  PASS  vertical strip moved to the left column ($SECOND_LEFT_COLUMN)"
else
  echo "  FAIL  vertical strip did not move left (column $SECOND_LEFT_COLUMN)"
  FAILURES=1
fi

"$HARNESS" send "$SESSION_NAME" C-, >/dev/null
"$HARNESS" send "$SESSION_NAME" Left >/dev/null
"$HARNESS" send "$SESSION_NAME" Escape >/dev/null
sleep 0.8
"$HARNESS" settle "$SESSION_NAME" >/dev/null 2>&1
check_equal "$(field workspaceTabPosition)" "top" "settings panel restored top orientation"
SECOND_RESTORED_COORDINATE="$(frame_coordinate "$SECOND_NAME")"
check_equal "${SECOND_RESTORED_COORDINATE##* }" "0" "workspace strip returned to the top row"

echo "== RESULT: $([ "$FAILURES" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILURES"
