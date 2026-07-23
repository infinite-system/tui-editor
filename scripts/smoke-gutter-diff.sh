#!/usr/bin/env bash
# Driven editor-gutter contract: edit a tracked file through the real TUI and assert the exact
# modified/added/deleted glyph + palette color in the framebuffer. The fixture is a disposable git
# repository so the comparison side is the real HEAD blob, not a test double.
set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
FIXTURE_ROOT="$(mktemp -d /tmp/tui-gutter-diff.XXXXXX)"
TEST_HOME="$(mktemp -d /tmp/tui-gutter-home.XXXXXX)"
EDIT_SESSION="gutter-edit-$$"
DELETE_SESSION="gutter-delete-$$"
fail=0

shutdown_session() {
  local session="$1"
  tmux send-keys -t "$session" C-q 2>/dev/null || true
  sleep 0.3
  "$HARNESS" kill "$session" >/dev/null 2>&1 || true
}

trap 'shutdown_session "$EDIT_SESSION"; shutdown_session "$DELETE_SESSION"; rm -rf "$FIXTURE_ROOT" "$TEST_HOME"' EXIT INT TERM

git -C "$FIXTURE_ROOT" init -q
git -C "$FIXTURE_ROOT" config user.email gutter-diff@example.test
git -C "$FIXTURE_ROOT" config user.name 'Gutter Diff Smoke'
printf 'alpha\nbeta\ngamma\n' > "$FIXTURE_ROOT/tracked.txt"
git -C "$FIXTURE_ROOT" add tracked.txt
git -C "$FIXTURE_ROOT" commit -qm 'fixture'

frame_has_marker() {
  local session="$1" line_text="$2" glyph="$3" color="$4"
  if ! SESSION_FRAME="$PROJECT_ROOT/artifacts/frame-$session.json" \
    LINE_TEXT="$line_text" COLOR="$color" python3 - <<'PY'
import json
import os

with open(os.environ['SESSION_FRAME'], encoding='utf-8') as frame_file:
    rows = json.load(frame_file)['rows']

for row in rows:
    text = row.get('text', '')
    line_column = text.find(os.environ['LINE_TEXT'])
    glyph_column = line_column - 1
    foreground = row.get('fg', [])
    if (
        line_column >= 0
        and 0 <= glyph_column < line_column
        and glyph_column < len(foreground)
        and text[glyph_column] != ' '
        and foreground[glyph_column] == os.environ['COLOR']
    ):
        raise SystemExit(0)
raise SystemExit(1)
PY
  then
    return 1
  fi
  "$HARNESS" capture "$session" | grep -F "$line_text" | grep -F "$glyph" >/dev/null
}

frame_has_no_diff_marker() {
  local session="$1"
  # Scan from column 4 onward: the activity bar (cols 0-3) draws its ACTIVE-item accent with the same
  # ▎ glyph a diff marker uses, but diff markers live in the editor gutter well to the right. A
  # whole-screen grep would mistake the bar's own accent for a gutter marker.
  ! SESSION_FRAME="$PROJECT_ROOT/artifacts/frame-$session.json" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['SESSION_FRAME'], encoding='utf-8'))['rows']
for row in rows:
    if any(character in '▎▁' for character in row.get('text', '')[4:]):
        raise SystemExit(0)   # a gutter marker is present
raise SystemExit(1)           # none found
PY
}

open_only_file() {
  local session="$1"
  # Height-robust: the tree rows shift down when the workspace tab strip grows past 1 line (two-line
  # workspace tabs -> offset 1). tracked.txt sits at .git+1; derive the strip offset from the frame so
  # the click lands on it at any strip height.
  local content_offset
  content_offset="$("$HARNESS" content-offset "$session" 2>/dev/null)"; content_offset="${content_offset:-0}"
  for _attempt in 1 2 3 4; do
    local active_buffer
    active_buffer="$("$HARNESS" field "$session" activeBuffer 2>/dev/null)"
    if [ -n "$active_buffer" ] && [ "$active_buffer" != "null" ]; then return 0; fi
    # The fixture root rows are .git then tracked.txt (base row 3 for the 1-row strip). Click the
    # visible file affordance directly, avoiding traversal into .git if it begins selected.
    "$HARNESS" click "$session" 5 $((3 + content_offset)) >/dev/null
  done
  return 1
}

echo '== tracked file: clean then modified and added markers =='
"$HARNESS" launch "$EDIT_SESSION" 100x30 env HOME="$TEST_HOME" COLORTERM=truecolor TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
if ! "$HARNESS" ready "$EDIT_SESSION" 20 >/dev/null || ! open_only_file "$EDIT_SESSION"; then
  echo '  FAIL  editor did not open the tracked fixture file'
  exit 1
fi
sleep 0.8
"$HARNESS" settle "$EDIT_SESSION" >/dev/null 2>&1
if frame_has_no_diff_marker "$EDIT_SESSION"; then
  echo '  PASS  clean HEAD file has no diff glyph'
else
  echo '  FAIL  clean HEAD file painted a diff glyph'
  fail=1
fi

"$HARNESS" send "$EDIT_SESSION" End >/dev/null
"$HARNESS" send "$EDIT_SESSION" -l X >/dev/null
"$HARNESS" settle "$EDIT_SESSION" >/dev/null 2>&1
if frame_has_marker "$EDIT_SESSION" 'alphaX' '▎' '249,226,175,255'; then
  echo '  PASS  edited existing line paints the modified-colored ▎ glyph'
else
  echo '  FAIL  edited existing line lacks the modified-colored ▎ glyph'
  fail=1
fi

# Save through the real binding; HEAD is unchanged, so the modified marker must survive the save and
# the existing GitWatcher reconciliation that follows it.
"$HARNESS" send "$EDIT_SESSION" C-s >/dev/null
sleep 0.6
"$HARNESS" settle "$EDIT_SESSION" >/dev/null 2>&1
if frame_has_marker "$EDIT_SESSION" 'alphaX' '▎' '249,226,175,255'; then
  echo '  PASS  modified marker converges after save and git reconciliation'
else
  echo '  FAIL  modified marker disappeared after save/reconciliation'
  fail=1
fi

# Advance HEAD outside the app, then produce a normal watched-tree event so the existing
# GitWatcher -> GitRepository.lastRefreshAt reconciliation signal fires. The gutter must refetch HEAD
# from that SAME signal and clear the now-committed marker.
git -C "$FIXTURE_ROOT" add tracked.txt
git -C "$FIXTURE_ROOT" commit -qm 'advance HEAD'
printf 'reconcile\n' > "$FIXTURE_ROOT/zz-reconcile-trigger.txt"
sleep 1.2
"$HARNESS" settle "$EDIT_SESSION" >/dev/null 2>&1
if frame_has_no_diff_marker "$EDIT_SESSION"; then
  echo '  PASS  external HEAD advance clears the marker after git reconciliation'
else
  echo '  FAIL  marker stayed based on the previous HEAD after reconciliation'
  fail=1
fi

"$HARNESS" send "$EDIT_SESSION" End >/dev/null
"$HARNESS" send "$EDIT_SESSION" Enter >/dev/null
"$HARNESS" send "$EDIT_SESSION" -l 'added line' >/dev/null
"$HARNESS" settle "$EDIT_SESSION" >/dev/null 2>&1
if frame_has_marker "$EDIT_SESSION" 'added line' '▎' '166,227,161,255'; then
  echo '  PASS  appended buffer line paints the added-colored ▎ glyph'
else
  echo '  FAIL  appended buffer line lacks the added-colored ▎ glyph'
  fail=1
fi

shutdown_session "$EDIT_SESSION"

# Restore the committed bytes for an independent deletion drive. Backspace at the start of beta joins
# it into alpha; DiffAlignment leaves gamma as the next surviving line, where the deletion hint belongs.
git -C "$FIXTURE_ROOT" checkout -q -- tracked.txt
echo '== tracked file: deleted-line marker =='
"$HARNESS" launch "$DELETE_SESSION" 100x30 env HOME="$TEST_HOME" COLORTERM=truecolor TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
if ! "$HARNESS" ready "$DELETE_SESSION" 20 >/dev/null || ! open_only_file "$DELETE_SESSION"; then
  echo '  FAIL  editor did not reopen the tracked fixture file'
  exit 1
fi
sleep 0.8
"$HARNESS" send "$DELETE_SESSION" Down >/dev/null
"$HARNESS" send "$DELETE_SESSION" Home >/dev/null
"$HARNESS" send "$DELETE_SESSION" BSpace >/dev/null
"$HARNESS" settle "$DELETE_SESSION" >/dev/null 2>&1
if frame_has_marker "$DELETE_SESSION" 'gamma' '▁' '243,139,168,255'; then
  echo '  PASS  removed line paints the deleted-colored ▁ hint on the following line'
else
  echo '  FAIL  removed line lacks the deleted-colored ▁ hint on the following line'
  fail=1
fi

if [ "$fail" = 0 ]; then
  echo 'smoke-gutter-diff: ALL-PASS'
else
  echo 'smoke-gutter-diff: FAILURES'
fi
exit "$fail"
