#!/usr/bin/env bash
# Driven contract for the one input-overlay modal slot. It switches through the real key path,
# asserts semantic state from the per-session status channel, checks the projected overlay title in
# FrameProbe output, and launches fresh sessions to prove reserved Ctrl+Q quits from captured input.
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
bun_executable="$HOME/.bun/bin/bun"
workspace_directory="$(mktemp -d /tmp/tui-mode-coherence.XXXXXX)"
primary_session="mode-coherence-$$"
active_sessions="$primary_session"
failure_count=0

trap 'for active_session in $active_sessions; do "$harness" kill "$active_session" >/dev/null 2>&1; done; rm -rf "$workspace_directory"' EXIT INT TERM

printf 'alpha\nbeta target\ngamma target\n' > "$workspace_directory/document.txt"

pass() {
  echo "  PASS  $1"
}

fail() {
  echo "  FAIL  $1"
  failure_count=$((failure_count + 1))
}

field() {
  "$harness" field "$1" "$2" 2>/dev/null
}

settle() {
  "$harness" settle "$1" 10 >/dev/null 2>&1
}

open_document() {
  local session_name="$1"
  for open_attempt in 1 2 3 4; do
    local active_buffer
    active_buffer="$(field "$session_name" activeBuffer)"
    if [ -n "$active_buffer" ] && [ "$active_buffer" != "null" ]; then return 0; fi
    "$harness" send "$session_name" Enter >/dev/null
    sleep 0.2
  done
  return 1
}

frame_contains() {
  local session_name="$1"
  local expected_text="$2"
  python3 - "$repository_root/artifacts/frame-$session_name.json" "$expected_text" <<'PYTHON'
import json
import sys

frame_path, expected_text = sys.argv[1:]
with open(frame_path) as frame_file:
    rows = json.load(frame_file)['rows']
raise SystemExit(0 if any(expected_text in row.get('text', '') for row in rows) else 1)
PYTHON
}

assert_only_overlay() {
  local session_name="$1"
  local expected_overlay="$2"
  local expected_frame_text="$3"
  local actual_overlay
  local actual_count
  actual_overlay="$(field "$session_name" inputOverlay)"
  actual_count="$(field "$session_name" inputOverlayCount)"
  if [ "$actual_overlay" = "$expected_overlay" ] && [ "$actual_count" = "1" ]; then
    pass "only $expected_overlay is active"
  else
    fail "expected only $expected_overlay (inputOverlay=$actual_overlay count=$actual_count open=$(field "$session_name" openInputOverlays))"
  fi
  if frame_contains "$session_name" "$expected_frame_text"; then
    pass "$expected_frame_text is projected in the framebuffer"
  else
    fail "$expected_frame_text is absent from the framebuffer"
  fi
}

echo "== modal slot: Find -> Quick Open -> Command Palette -> Settings =="
"$harness" launch "$primary_session" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$workspace_directory" >/dev/null
"$harness" ready "$primary_session" 20 >/dev/null || { fail "primary app did not become ready"; exit 1; }
open_document "$primary_session" || { fail "document did not open"; exit 1; }

"$harness" send "$primary_session" C-f >/dev/null
settle "$primary_session"
assert_only_overlay "$primary_session" findBar "Find"

"$harness" send "$primary_session" C-p >/dev/null
sleep 0.8
settle "$primary_session"
assert_only_overlay "$primary_session" quickOpen "Go to File"
if [ "$(field "$primary_session" findOpen)" = "false" ]; then
  pass "opening Quick Open closed Find"
else
  fail "Find stayed open behind Quick Open"
fi

"$harness" send "$primary_session" F1 >/dev/null
settle "$primary_session"
assert_only_overlay "$primary_session" commandPalette "Command Palette"
if [ "$(field "$primary_session" quickOpenOpen)" = "false" ]; then
  pass "opening the command palette closed Quick Open"
else
  fail "Quick Open stayed open behind the command palette"
fi

"$harness" send "$primary_session" C-, >/dev/null
settle "$primary_session"
assert_only_overlay "$primary_session" settingsPanel "Settings"
if [ "$(field "$primary_session" paletteOpen)" = "false" ]; then
  pass "opening Settings closed the command palette"
else
  fail "the command palette stayed open behind Settings"
fi

echo "== one FindBar: Ctrl+F then Ctrl+H changes mode in place =="
"$harness" send "$primary_session" Escape >/dev/null
"$harness" send "$primary_session" C-f >/dev/null
"$harness" send "$primary_session" C-h >/dev/null
settle "$primary_session"
assert_only_overlay "$primary_session" findBar "Find / Replace"
if [ "$(field "$primary_session" findMode)" = "replace" ] && [ "$(field "$primary_session" findOpen)" = "true" ]; then
  pass "Ctrl+H changed the open FindBar to replace mode"
else
  fail "FindBar did not remain open in replace mode"
fi

echo "== context menu occupies the same slot and switches to the palette in one chord =="
# The Find bar covers the count badge at the top-right. Switch to the centered palette first; its
# box starts lower, leaving the real clickable badge visible. Clicking it must replace the palette.
"$harness" send "$primary_session" F1 >/dev/null
settle "$primary_session"
buffer_tab_count="$(field "$primary_session" bufferTabCount)"
badge_geometry="$($bun_executable -e 'const frame=JSON.parse(require("fs").readFileSync(process.argv[1]));const total=process.argv[2];for(let rowIndex=0;rowIndex<frame.rows.length;rowIndex+=1){const cells=Array.from(frame.rows[rowIndex].text);const slashIndex=cells.findIndex((cell,columnIndex)=>cell==="/"&&cells.slice(columnIndex+1,columnIndex+1+total.length).join("")===total);if(slashIndex<0)continue;let start=slashIndex;while(start>0&&/[0-9]/.test(cells[start-1]))start-=1;console.log(start+" "+rowIndex);process.exit(0)}console.log("-1 -1");' "$repository_root/artifacts/frame-$primary_session.json" "$buffer_tab_count")"
badge_column="${badge_geometry%% *}"
badge_row="${badge_geometry##* }"
if [ "$badge_column" -ge 0 ] 2>/dev/null && [ "$badge_row" -ge 0 ] 2>/dev/null; then
  "$harness" click "$primary_session" "$badge_column" "$badge_row" >/dev/null
  settle "$primary_session"
  assert_only_overlay "$primary_session" contextMenu "document.txt"
  if [ "$(field "$primary_session" paletteOpen)" = "false" ]; then
    pass "opening the context menu closed the command palette"
  else
    fail "the command palette stayed open behind the context menu"
  fi
  "$harness" send "$primary_session" F1 >/dev/null
  settle "$primary_session"
  assert_only_overlay "$primary_session" commandPalette "Command Palette"
  if [ "$(field "$primary_session" contextMenuOpen)" = "false" ]; then
    pass "F1 switched the context-menu slot to the palette in one chord"
  else
    fail "the context menu blocked the palette-opening chord"
  fi
else
  fail "could not locate the clickable buffer-count badge"
fi

"$harness" kill "$primary_session" >/dev/null 2>&1

quit_from_overlay() {
  local overlay_label="$1"
  local opening_key="$2"
  local expected_overlay="$3"
  local session_name="mode-quit-${overlay_label//[^a-zA-Z0-9]/-}-$$"
  active_sessions="$active_sessions $session_name"
  "$harness" launch "$session_name" 100x32 env TUI_FRAME_DUMP=1 bun run src/main.ts "$workspace_directory" >/dev/null
  "$harness" ready "$session_name" 20 >/dev/null || { fail "$overlay_label quit session did not become ready"; return; }
  open_document "$session_name" || { fail "$overlay_label quit session did not open a document"; return; }
  "$harness" send "$session_name" "$opening_key" >/dev/null
  if [ "$expected_overlay" = "quickOpen" ]; then sleep 0.8; fi
  settle "$session_name"
  if [ "$(field "$session_name" inputOverlay)" != "$expected_overlay" ]; then
    fail "$overlay_label did not open before the quit drive"
    return
  fi

  "$harness" send "$session_name" C-q >/dev/null
  local pane_command="bun"
  for quit_attempt in 1 2 3 4 5 6 7 8 9 10; do
    pane_command="$(tmux display-message -p -t "$session_name" '#{pane_current_command}' 2>/dev/null || true)"
    if [ "$pane_command" != "bun" ]; then break; fi
    sleep 0.15
  done
  if [ "$(field "$session_name" ready)" = "false" ] && [ "$pane_command" != "bun" ]; then
    pass "reserved Ctrl+Q quit from $overlay_label"
  else
    fail "reserved Ctrl+Q was blocked in $overlay_label (ready=$(field "$session_name" ready) command=$pane_command)"
  fi
  "$harness" kill "$session_name" >/dev/null 2>&1
}

echo "== reserved global quit bypasses every tested input capture =="
quit_from_overlay "Find" C-f findBar
quit_from_overlay "Quick-Open" C-p quickOpen
quit_from_overlay "Command-Palette" F1 commandPalette

if [ "$failure_count" -eq 0 ]; then
  echo "mode-coherence: ALL-PASS"
else
  echo "mode-coherence: FAILURES ($failure_count)"
fi
exit "$failure_count"
