#!/usr/bin/env bash
# Driven contract for the shortcut cheat-sheet (the status-bar `?` + Shift+F1 overlay).
# Drives the REAL user path via tmux + FrameProbe: CLICK the status-bar `?` and assert the sheet
# opens showing real binding rows (registry-derived, not constants); the bound chord also opens it;
# Esc closes it; the sheet joins the exclusive overlay slot; the chord the sheet ADVERTISES for
# Go to File actually opens Quick Open when pressed (advertised = deliverable, rebinding-proof);
# and reserved Ctrl+Q still quits from inside the sheet.
#
# invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
# invariant: Input overlays share one modal slot (src/modules/ui/ui.invariants.md)
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
workspace_directory="$(mktemp -d /tmp/tui-shortcut-help.XXXXXX)"
primary_session="shortcut-help-$$"
quit_session="shortcut-help-quit-$$"
failure_count=0

trap '"$harness" kill "$primary_session" >/dev/null 2>&1; "$harness" kill "$quit_session" >/dev/null 2>&1; rm -rf "$workspace_directory"' EXIT INT TERM

printf 'alpha\nbeta\ngamma\n' > "$workspace_directory/document.txt"

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

# The status-bar `?` button: the LAST occurrence of '?' on the LAST frame row (the status bar).
help_button_geometry() {
  local session_name="$1"
  python3 - "$repository_root/artifacts/frame-$session_name.json" <<'PYTHON'
import json
import sys

with open(sys.argv[1]) as frame_file:
    rows = json.load(frame_file)['rows']
status_row_index = len(rows) - 1
status_text = rows[status_row_index].get('text', '')
column = status_text.rfind('?')
print(f"{column} {status_row_index}")
PYTHON
}

# The chord label the sheet ADVERTISES on the row titled "Go to File", as a tmux send-keys name
# (Ctrl+P -> C-p). Empty when the row is absent.
advertised_quick_open_key() {
  local session_name="$1"
  python3 - "$repository_root/artifacts/frame-$session_name.json" <<'PYTHON'
import json
import re
import sys

with open(sys.argv[1]) as frame_file:
    rows = json.load(frame_file)['rows']
for row in rows:
    row_text = row.get('text', '')
    match = re.search(r'(\S+)\s{2,}Go to File', row_text)
    if match:
        chord_label = match.group(1)
        ctrl_match = re.fullmatch(r'Ctrl\+(.)', chord_label)
        if ctrl_match:
            print('C-' + ctrl_match.group(1).lower())
        elif re.fullmatch(r'Shift\+F(\d+)', chord_label):
            print('S-F' + re.fullmatch(r'Shift\+F(\d+)', chord_label).group(1))
        else:
            print(chord_label)
        raise SystemExit(0)
print('')
PYTHON
}

# PageDown through the OPEN sheet until the expected text is on screen (also drives the sheet's
# scrollability — the row window really moves). Leaves the sheet wherever the text was found.
scroll_sheet_until() {
  local session_name="$1"
  local expected_text="$2"
  for scroll_attempt in 1 2 3 4 5 6 7 8; do
    if frame_contains "$session_name" "$expected_text"; then return 0; fi
    "$harness" send "$session_name" PageDown >/dev/null
    settle "$session_name"
  done
  frame_contains "$session_name" "$expected_text"
}

scroll_sheet_top() {
  local session_name="$1"
  for scroll_attempt in 1 2 3 4 5 6 7 8; do
    "$harness" send "$session_name" PageUp >/dev/null
  done
  settle "$session_name"
}

assert_sheet_open() {
  local session_name="$1"
  local step_label="$2"
  if [ "$(field "$session_name" shortcutHelpOpen)" = "true" ] &&
     [ "$(field "$session_name" inputOverlay)" = "shortcutHelp" ] &&
     [ "$(field "$session_name" inputOverlayCount)" = "1" ]; then
    pass "$step_label: the cheat-sheet is the only open input overlay"
  else
    fail "$step_label: sheet not exclusively open (open=$(field "$session_name" shortcutHelpOpen) overlay=$(field "$session_name" inputOverlay) count=$(field "$session_name" inputOverlayCount))"
  fi
  if frame_contains "$session_name" "Keyboard Shortcuts"; then
    pass "$step_label: the sheet is projected in the framebuffer"
  else
    fail "$step_label: 'Keyboard Shortcuts' is absent from the framebuffer"
  fi
}

echo "== the clickable status-bar ? opens the sheet with REAL binding rows =="
"$harness" launch "$primary_session" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$workspace_directory" >/dev/null
"$harness" ready "$primary_session" 20 >/dev/null || { fail "app did not become ready"; exit 1; }
open_document "$primary_session" || { fail "document did not open"; exit 1; }

button_geometry="$(help_button_geometry "$primary_session")"
button_column="${button_geometry%% *}"
button_row="${button_geometry##* }"
if [ "$button_column" -ge 0 ] 2>/dev/null; then
  pass "found the status-bar ? button at ($button_column, $button_row)"
else
  fail "could not locate the status-bar ? button in the frame"
  exit 1
fi

"$harness" click "$primary_session" "$button_column" "$button_row" >/dev/null
settle "$primary_session"
assert_sheet_open "$primary_session" "click"

if frame_contains "$primary_session" "Quit"; then
  pass "the sheet shows the Quit action row"
else
  fail "no Quit row in the sheet"
fi
if scroll_sheet_until "$primary_session" "Go to File"; then
  pass "the sheet shows the Go to File row (scrolling drives the row window)"
  if frame_contains "$primary_session" "Ctrl+P"; then
    pass "the Go to File page shows its real chord (Ctrl+P)"
  else
    fail "no Ctrl+P chord on the Go to File page"
  fi
else
  fail "no Go to File row anywhere in the sheet"
fi
scroll_sheet_top "$primary_session"
if scroll_sheet_until "$primary_session" "Shift+F1"; then
  pass "the sheet lists its own open chord (Shift+F1)"
else
  fail "the sheet does not list itself"
fi

echo "== Esc closes the sheet =="
"$harness" send "$primary_session" Escape >/dev/null
settle "$primary_session"
if [ "$(field "$primary_session" shortcutHelpOpen)" = "false" ] && ! frame_contains "$primary_session" "Keyboard Shortcuts"; then
  pass "Esc closed the sheet (state + framebuffer)"
else
  fail "Esc did not close the sheet (open=$(field "$primary_session" shortcutHelpOpen))"
fi

echo "== the bound chord (Shift+F1) also opens it =="
"$harness" send "$primary_session" S-F1 >/dev/null
settle "$primary_session"
assert_sheet_open "$primary_session" "Shift+F1"

echo "== advertised = deliverable: pressing the chord the sheet SHOWS for Go to File opens Quick Open =="
scroll_sheet_until "$primary_session" "Go to File" >/dev/null
advertised_key="$(advertised_quick_open_key "$primary_session")"
if [ -n "$advertised_key" ]; then
  pass "the sheet advertises a chord for Go to File ($advertised_key)"
  "$harness" send "$primary_session" "$advertised_key" >/dev/null
  sleep 0.8
  settle "$primary_session"
  if [ "$(field "$primary_session" quickOpenOpen)" = "true" ] && [ "$(field "$primary_session" shortcutHelpOpen)" = "false" ]; then
    pass "the advertised chord really opened Quick Open (and the exclusive slot closed the sheet)"
  else
    fail "the advertised chord did not deliver (quickOpen=$(field "$primary_session" quickOpenOpen) sheet=$(field "$primary_session" shortcutHelpOpen))"
  fi
else
  fail "no Go to File row with a chord found in the sheet"
fi

echo "== exclusive slot: reopening the sheet closes Quick Open =="
"$harness" send "$primary_session" S-F1 >/dev/null
settle "$primary_session"
if [ "$(field "$primary_session" shortcutHelpOpen)" = "true" ] && [ "$(field "$primary_session" quickOpenOpen)" = "false" ]; then
  pass "opening the sheet closed Quick Open"
else
  fail "Quick Open stayed open behind the sheet (sheet=$(field "$primary_session" shortcutHelpOpen) quickOpen=$(field "$primary_session" quickOpenOpen))"
fi
"$harness" kill "$primary_session" >/dev/null 2>&1

echo "== reserved Ctrl+Q still quits from inside the sheet =="
"$harness" launch "$quit_session" 100x32 env TUI_FRAME_DUMP=1 bun run src/main.ts "$workspace_directory" >/dev/null
"$harness" ready "$quit_session" 20 >/dev/null || { fail "quit-drive session did not become ready"; exit 1; }
open_document "$quit_session" || { fail "quit-drive session did not open a document"; exit 1; }
"$harness" send "$quit_session" S-F1 >/dev/null
settle "$quit_session"
if [ "$(field "$quit_session" shortcutHelpOpen)" != "true" ]; then
  fail "the sheet did not open before the quit drive"
else
  "$harness" send "$quit_session" C-q >/dev/null
  pane_command="bun"
  for quit_attempt in 1 2 3 4 5 6 7 8 9 10; do
    pane_command="$(tmux display-message -p -t "$quit_session" '#{pane_current_command}' 2>/dev/null || true)"
    if [ "$pane_command" != "bun" ]; then break; fi
    sleep 0.15
  done
  if [ "$(field "$quit_session" ready)" = "false" ] && [ "$pane_command" != "bun" ]; then
    pass "reserved Ctrl+Q quit from inside the sheet"
  else
    fail "reserved Ctrl+Q was blocked by the sheet (ready=$(field "$quit_session" ready) command=$pane_command)"
  fi
fi
"$harness" kill "$quit_session" >/dev/null 2>&1

if [ "$failure_count" -eq 0 ]; then
  echo "shortcut-help: ALL-PASS"
else
  echo "shortcut-help: FAILURES ($failure_count)"
fi
exit "$failure_count"
