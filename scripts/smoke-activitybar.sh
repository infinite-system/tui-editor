#!/usr/bin/env bash
# Driven activity-bar contract: the VS-Code-style left view-switcher. Clicking each button switches
# the sidebar CONTENT for the workspace, the active `▎` accent moves to the clicked item (exactly one
# active), the Ctrl+Shift+E/G/X chords switch the same views, and a glyph renders in the portable
# fallback tier (the default no-Nerd-Font env). Semantic state -> per-session status channel; visual
# (accent + glyph + switched content) -> FrameProbe.
# invariant: The active activity item determines the sidebar content (src/modules/ui/ui.invariants.md)
set -uo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_directory/.." && pwd)"
harness="$script_directory/tui-harness.sh"
fixture_root="$(mktemp -d /tmp/tui-activitybar.XXXXXX)"
test_home="$(mktemp -d /tmp/tui-activitybar-home.XXXXXX)"
session_name="activitybar-$$"
failure_count=0
# We force the PORTABLE FALLBACK glyph tier (glyphMode='ascii' via the settings file below) so the
# assertions are deterministic on any host — this is exactly the no-Nerd-Font degradation the dual-tier
# table must survive. The ascii tier draws letters F/G/X and a `|` accent (all single-byte, so
# FrameProbe reports them verbatim; the nerd tier's PUA glyphs are remapped into an opaque plane and
# can't be asserted char-for-char). Auto-detection on a real non-nerd terminal picks unicode/ascii the
# same way; the detection logic itself is covered by unit tests.
files_glyph='F'
git_glyph='G'
extensions_glyph='X'
accent_bar='|'

cleanup() {
  "$harness" kill "$session_name" >/dev/null 2>&1 || true
  rm -rf "$fixture_root" "$test_home"
}
trap cleanup EXIT INT TERM

field() { "$harness" field "$session_name" "$1" 2>/dev/null; }
settle() { sleep 0.35; "$harness" settle "$session_name" 12 >/dev/null 2>&1; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; failure_count=$((failure_count + 1)); }

expect_equal() {
  if [ "$1" = "$2" ]; then pass "$3 ($1)"; else fail "$3 (expected $2, got $1)"; fi
}

# Kitty CSI-u key: <codepoint>;<modifier>u, modifier = 1 + (shift 1 | alt 2 | ctrl 4). Ctrl+Shift = 6.
# The app enables the kitty keyboard protocol, so these deliver a real ctrl+shift+<letter> event.
send_kitty() {
  tmux send-keys -t "$session_name" -l "$(printf '\033[%s' "$1")"
  sleep 0.3
}

frame_path="$repository_root/artifacts/frame-$session_name.json"

# The screen row whose activity-bar glyph cell (column 2) holds $1, or -1.
glyph_row() {
  FRAME_PATH="$frame_path" GLYPH="$1" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
for i, row in enumerate(rows):
    text = row.get('text', '')
    if len(text) > 2 and text[2] == os.environ['GLYPH']:
        print(i); break
else:
    print(-1)
PY
}

# Char at (row, col) in the frame, or empty.
char_at() {
  FRAME_PATH="$frame_path" ROW="$1" COL="$2" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
r, c = int(os.environ['ROW']), int(os.environ['COL'])
text = rows[r].get('text', '') if 0 <= r < len(rows) else ''
print(text[c] if c < len(text) else '')
PY
}

# Count activity-bar column-0 cells equal to the accent bar (== number of active items).
accent_count_col0() {
  FRAME_PATH="$frame_path" ACCENT="$accent_bar" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
print(sum(1 for row in rows if (row.get('text','') or ' ')[:1] == os.environ['ACCENT']))
PY
}

frame_contains() {
  FRAME_PATH="$frame_path" NEEDLE="$1" python3 - <<'PY'
import json, os, sys
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
sys.exit(0 if any(os.environ['NEEDLE'] in row.get('text','') for row in rows) else 1)
PY
}

expect_frame_contains() {
  if frame_contains "$1"; then pass "$2"; else fail "$2 (frame missing '$1')"; fi
}
expect_frame_absent() {
  if frame_contains "$1"; then fail "$2 (frame unexpectedly contains '$1')"; else pass "$2"; fi
}

echo '== build a git repo with a committed tree file and one uncommitted change =='
printf 'unchanged tree file\n' > "$fixture_root/tree-marker.txt"
printf 'original\n' > "$fixture_root/change-me.txt"
git -C "$fixture_root" init -q
git -C "$fixture_root" config user.name activitybar-smoke
git -C "$fixture_root" config user.email activitybar-smoke@example.test
git -C "$fixture_root" add .
git -C "$fixture_root" commit -qm base
printf 'edited\n' >> "$fixture_root/change-me.txt"   # one working-tree change -> git badge + changes row

# Force the portable ascii fallback tier through the user settings file (HOME is the test home below).
mkdir -p "$test_home/.config/invar"
printf '{"glyphMode":"ascii"}\n' > "$test_home/.config/invar/settings.json"

"$harness" launch "$session_name" 100x36 \
  env HOME="$test_home" COLORTERM=truecolor TUI_FRAME_DUMP=1 \
  bun run src/main.ts "$fixture_root" >/dev/null
if "$harness" ready "$session_name" 20 >/dev/null; then pass 'fixture booted'; else fail 'fixture did not boot'; exit "$failure_count"; fi
settle

echo '== the fallback glyph tier renders one glyph per view =='
files_row="$(glyph_row "$files_glyph")"
git_row="$(glyph_row "$git_glyph")"
extensions_row="$(glyph_row "$extensions_glyph")"
if [ "$files_row" -ge 0 ] 2>/dev/null; then pass "Explorer glyph '$files_glyph' rendered (row $files_row)"; else fail "Explorer glyph '$files_glyph' not found"; fi
if [ "$git_row" -ge 0 ] 2>/dev/null; then pass "Source Control glyph '$git_glyph' rendered (row $git_row)"; else fail "Source Control glyph '$git_glyph' not found"; fi
if [ "$extensions_row" -ge 0 ] 2>/dev/null; then pass "Extensions glyph '$extensions_glyph' rendered (row $extensions_row)"; else fail "Extensions glyph '$extensions_glyph' not found"; fi
if [ "$files_row" -lt 0 ] 2>/dev/null; then echo 'activity bar not located; aborting'; exit "$failure_count"; fi

echo '== initial state: Explorer active, accent on it, exactly one accent, tree content shown =='
expect_equal "$(field sidebarView)" 'files' 'boots on the Explorer view'
expect_equal "$(char_at "$files_row" 0)" "$accent_bar" 'active accent sits on the Explorer button'
expect_equal "$(accent_count_col0)" '1' 'exactly one activity item is active'
expect_frame_contains 'tree-marker.txt' 'Explorer view renders the file tree'

echo '== click Source Control: view + accent + content switch, badge shows the change count =='
"$harness" click "$session_name" 1 "$git_row" >/dev/null
settle
expect_equal "$(field sidebarView)" 'git' 'clicking Source Control switched the view'
expect_equal "$(char_at "$git_row" 0)" "$accent_bar" 'accent moved to the Source Control button'
expect_equal "$(char_at "$files_row" 0)" ' ' 'the Explorer button is no longer accented'
expect_equal "$(accent_count_col0)" '1' 'still exactly one active item after switch'
expect_frame_contains 'Git' 'Source Control view renders the git panel (sidebar title)'
# Optional corner badge: the git change count digit in the Source Control button's bottom-right cell.
expect_equal "$(char_at "$((git_row + 1))" 3)" '1' 'git badge shows the working-tree change count'

echo '== click Extensions: content switches to the placeholder =='
"$harness" click "$session_name" 1 "$extensions_row" >/dev/null
settle
expect_equal "$(field sidebarView)" 'extensions' 'clicking Extensions switched the view'
expect_equal "$(char_at "$extensions_row" 0)" "$accent_bar" 'accent moved to the Extensions button'
expect_equal "$(accent_count_col0)" '1' 'still exactly one active item on Extensions'
expect_frame_contains 'Coming soon' 'Extensions view renders the placeholder'
expect_frame_absent 'tree-marker.txt' 'the file tree is gone while Extensions is shown'

echo '== click Explorer: back to the tree =='
"$harness" click "$session_name" 1 "$files_row" >/dev/null
settle
expect_equal "$(field sidebarView)" 'files' 'clicking Explorer returned to the tree'
expect_frame_contains 'tree-marker.txt' 'Explorer content is back'

echo '== keyboard parity: Ctrl+Shift+G / +E / +X switch the same views =='
send_kitty '103;6u'   # Ctrl+Shift+G -> Source Control
settle
expect_equal "$(field sidebarView)" 'git' 'Ctrl+Shift+G switched to Source Control'
expect_equal "$(char_at "$git_row" 0)" "$accent_bar" 'chord moved the accent to Source Control'

send_kitty '101;6u'   # Ctrl+Shift+E -> Explorer
settle
expect_equal "$(field sidebarView)" 'files' 'Ctrl+Shift+E switched to Explorer'

send_kitty '120;6u'   # Ctrl+Shift+X -> Extensions
settle
expect_equal "$(field sidebarView)" 'extensions' 'Ctrl+Shift+X switched to Extensions'
expect_frame_contains 'Coming soon' 'the chord switched the rendered content too'

echo ''
if [ "$failure_count" = '0' ]; then
  echo 'smoke-activitybar: ALL-PASS'
else
  echo "smoke-activitybar: FAILURES ($failure_count)"
fi
exit "$failure_count"
