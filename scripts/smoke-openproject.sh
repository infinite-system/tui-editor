#!/usr/bin/env bash
# Live regression for the Open-Project (workspace-path) navigator's two freeze/usability defects:
#   1. SCROLL-TO-SELECTION — a folder list longer than the render window (14 rows) must keep the SELECTED
#      row visible as you arrow past the bottom: the window scrolls with the selection instead of leaving
#      the highlight stranded below the window (the "I can arrow beyond the last element" report).
#   2. HARDENED ENUMERATION — a parent directory containing a BAD entry (broken symlink) must NOT freeze
#      the app: the listing skips the bad entry and stays fully responsive (Down keys keep advancing the
#      selection, the status channel keeps updating — a blocked event loop would do neither).
# Drives the REAL chord path (open navigator -> arrow -> frame) asserted through FrameProbe cells (paint)
# and the per-session status channel (state). Runs in the merge-gate. PID-namespaced session (op-$$-*).
#
# invariant: The selected quick-open row is always visible (src/modules/search/search.invariants.md)
# invariant: The open-project path input is a live directory navigator (src/modules/search/search.invariants.md)
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"

navigator_base="$(mktemp -d /tmp/tui-op-nav.XXXXXX)"
project_root="$navigator_base/proj"   # app rooted here, so the navigator lists navigator_base's subfolders
test_home="$(mktemp -d /tmp/tui-op-home.XXXXXX)"
session_name="op-$$-nav"
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
expect_equal() { if [ "$1" = "$2" ]; then pass "$3 ($1)"; else fail "$3 (expected $2, got $1)"; fi; }
expect_contains() { case "$1" in *"$2"*) pass "$3";; *) fail "$3 (got '$1')";; esac; }

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

# The navigator lists project_root's PARENT (navigator_base). Fill it with more folders than the 14-row
# render window so the selection must scroll, plus a BROKEN SYMLINK — the pathological entry whose stat
# would hang/throw an unhardened enumeration.
mkdir -p "$project_root"
( cd "$project_root" && git init -q && echo x > file.txt )
for n in $(seq -w 0 39); do mkdir -p "$navigator_base/folder-$n"; done
ln -s /nonexistent/definitely/not/here "$navigator_base/broken-link"

echo "== launch (ascii glyph mode: isolated HOME + LANG=C) =="
"$harness" launch "$session_name" 130x44 env \
  TUI_FRAME_DUMP=1 HOME="$test_home" NERD_FONT=0 TERM_PROGRAM=xterm LANG=C \
  bun run src/main.ts "$project_root" >/dev/null
"$harness" ready "$session_name" 20 >/dev/null

echo "== 1. Open the navigator: it lists the parent's folders, skipping the broken symlink (no freeze) =="
"$harness" send "$session_name" F1 >/dev/null; sleep 0.4
for character in O p e n Space F o l d e r; do "$harness" send "$session_name" "$character" >/dev/null; sleep 0.04; done
"$harness" send "$session_name" Enter >/dev/null; sleep 0.6; settle
expect_contains "$(field quickOpenMode)" "workspacePath" "the open-project navigator opened"
# 40 folders + proj = 41 real directories; the broken symlink is skipped, NOT counted, and did not hang.
expect_equal "$(field quickOpenMatches)" "41" "the listing has 41 folders (broken symlink skipped, no freeze)"
expect_equal "$(field quickOpenSelected)" "0" "the first folder is selected on open"

echo "== 2. Arrow DEEP past the render window: the selection stays VISIBLE (the list scrolls) =="
for _ in $(seq 1 20); do "$harness" send "$session_name" Down >/dev/null; sleep 0.03; done
sleep 0.3; settle
# A blocked event loop would never advance the selection or update the status channel — this IS the
# responsiveness proof: 20 Down keys were processed and reflected.
expect_equal "$(field quickOpenSelected)" "20" "arrowing down 20x advanced the selection (app stayed responsive)"
# Folders sort alphabetically for the empty filter, so index 20 == folder-20 and index 0 == folder-00.
selected_row="$(row_of "folder-20")"
if [ "$selected_row" != "-1" ] && [ "$(bg_at 31 "$selected_row")" != "none" ]; then
  pass "the selected folder (folder-20) is drawn and carries a selection background ($(bg_at 31 "$selected_row"))"
else
  fail "the selected folder-20 is not visible with a selection background (row=$selected_row)"
fi
# The window scrolled: folder-00 (the original top) is now OFF-SCREEN — the highlight did not strand.
expect_equal "$(row_of "folder-00")" "-1" "the list scrolled — the original top row (folder-00) is off-screen"

echo "== 3. Arrow to the LAST element and beyond: it clamps, stays visible, never freezes =="
for _ in $(seq 1 40); do "$harness" send "$session_name" Down >/dev/null; sleep 0.02; done
sleep 0.3; settle
expect_equal "$(field quickOpenSelected)" "40" "the selection clamped at the last folder (index 40)"
last_row="$(row_of "proj")"
if [ "$last_row" != "-1" ] && [ "$(bg_at 31 "$last_row")" != "none" ]; then
  pass "the last folder (proj) is visible with a selection background at the bottom of the window"
else
  fail "the last folder (proj) is not visible with a selection background (row=$last_row)"
fi

echo "== 4. Click-drill into a scrolled-visible folder: the navigator re-enumerates without freezing =="
drill_row="$(row_of "folder-38")"
if [ "$drill_row" != "-1" ]; then
  "$harness" click "$session_name" 33 "$drill_row" >/dev/null; sleep 0.4; settle
  expect_contains "$(field quickOpenQuery)" "folder-38/" "clicking a folder drilled into it (path completed)"
  expect_equal "$(field quickOpenOpen)" "true" "the navigator stayed open and responsive after drilling in"
else
  fail "could not locate a visible folder row to drill into"
fi

echo "== RESULT: $([ "$failure_count" = 0 ] && echo ALL-PASS || echo "FAILURES ($failure_count)") =="
exit "$failure_count"
