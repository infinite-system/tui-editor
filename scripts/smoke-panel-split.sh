#!/usr/bin/env bash
# Bottom-panel SPLIT smoke. Proves the PanelHost split capability end to end with the TWO REAL citizens
# — the AGENT pane on the LEFT and the terminal on the RIGHT — by DRIVING it, not measuring internals:
#   A) deterministic PanelHost unit tests (split layout, focus routing, per-cell resize, divider re-flow).
#   B) launch under tmux, open the panel (F8), then SPLIT it (F9) into two side-by-side cells and assert:
#        - two cells render (agent,terminal), each into its OWN sub-region (the terminal's `stty size`
#          reports its sub-width — proof the per-cell onResize really sized the child);
#        - keystrokes go ONLY to the focused cell, and click-to-focus moves the target;
#        - dragging the intra-panel divider re-flows both cells' widths;
#        - un-splitting (F9) restores the single full-width pane.
# The agent pane uses the hermetic echo backend (INVAR_AGENT_BACKEND=echo) so no real claude spawns.
# Usage: scripts/smoke-panel-split.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-split-$$"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
gt()  { if [ "${2:-0}" -gt "${3:-0}" ] 2>/dev/null; then echo "  PASS  $1 ($3->$2)"; else echo "  FAIL  $1 ($3->$2)"; fail=1; fi; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== A) deterministic PanelHost split unit tests (no shell) =="
if "$BUN" test src/modules/ui/PanelHost.test.ts >/tmp/split-unit-$$.log 2>&1; then
  echo "  PASS  PanelHost unit tests (split layout, focus routing, per-cell resize, divider re-flow)"
else
  echo "  FAIL  PanelHost unit tests"; tail -25 /tmp/split-unit-$$.log; fail=1
fi
rm -f /tmp/split-unit-$$.log

echo "== B) launch + boot (agent uses hermetic echo backend) =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 INVAR_AGENT_BACKEND=echo bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1
fi
chk "panel hidden at boot" "$(f terminalVisible)" "false"

echo "== open the panel (F8): one full-width cell (the degenerate single-pane case, the terminal) =="
"$H" send "$S" F8 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "panel visible" "$(f terminalVisible)" "true"
chk "single cell = terminal" "$(f panelCellIds)" "terminal"
chk "focused cell index 0" "$(f panelFocusedIndex)" "0"
full_cols="$(f panelCellColumns)"
gt "single cell has real width" "$full_cols" "1"
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1   # let the shell print its first prompt

echo "== SPLIT the panel (F9): agent on the LEFT, terminal on the RIGHT =="
"$H" send "$S" F9 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "two cells, left-to-right" "$(f panelCellIds)" "agent,terminal"
chk "left cell (agent) is focused" "$(f panelFocusedIndex)" "0"
cols_csv="$(f panelCellColumns)"
col0="${cols_csv%%,*}"; col1="${cols_csv##*,}"
gt "left cell has its own width" "$col0" "1"
gt "right cell has its own width" "$col1" "1"
if [ "${col0:-0}" -lt "${full_cols:-0}" ] && [ "${col1:-0}" -lt "${full_cols:-0}" ]; then
  echo "  PASS  both cells narrower than full ($col0 & $col1 < $full_cols) — width shared across the split"
else
  echo "  FAIL  a cell is not narrower than the un-split pane ($col0,$col1 vs $full_cols)"; fail=1
fi

echo "== the AGENT pane renders in the LEFT cell (composer prompt + empty-state) =="
if "$H" capture "$S" | grep -qF "❯"; then
  echo "  PASS  left cell shows the agent composer prompt (❯)"
else
  echo "  FAIL  agent composer not rendered in the left cell"; "$H" capture "$S" | tail -14; fail=1
fi

echo "== keystrokes reach ONLY the focused cell (agent LEFT); its composer echoes them =="
"$H" send "$S" -l "AGENTKEY" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
if "$H" capture "$S" | grep -qF "AGENTKEY"; then
  echo "  PASS  focused left (agent) cell received the keys (composer shows AGENTKEY)"
else
  echo "  FAIL  agent composer did not receive the keys"; "$H" capture "$S" | tail -14; fail=1
fi

echo "== click the RIGHT cell (terminal) → focus moves; terminal reports its OWN sub-width via stty =="
right_click_x=$(( col0 + 6 ))
panel_row=$(( $(f height) - 8 ))
"$H" click "$S" "$right_click_x" "$panel_row" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "click moved focus to the right cell" "$(f panelFocusedIndex)" "1"
"$H" send "$S" -l "stty size" >/dev/null; "$H" send "$S" Enter >/dev/null
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
# The terminal child sized to its RIGHT sub-region MINUS its 2-col L/R gutter reports "<rows> <col1-4>"
# — proof of per-cell onResize AND the terminal pane's padding (keep in sync with TERMINAL_PAD_COLUMNS).
exp_col1=$(( col1 - 4 ))
if "$H" capture "$S" | grep -qE "(^|[^0-9])[0-9]+ ${exp_col1}([^0-9]|\$)"; then
  echo "  PASS  terminal reported its padded sub-width ${exp_col1} (sub-cell ${col1} minus gutter)"
else
  echo "  FAIL  terminal did not report padded sub-width ${exp_col1} (sub-cell ${col1})"; "$H" capture "$S" | grep -E '[0-9]+ [0-9]+' | tail -3; fail=1
fi
# The agent composer (now blurred) kept AGENTKEY — the terminal keystrokes did not leak into it.
if "$H" capture "$S" | grep -qF "AGENTKEY"; then
  echo "  PASS  blurred agent cell kept its composer text (keys did not leak across cells)"
else
  echo "  FAIL  agent composer lost its text — a key leaked across the split"; fail=1
fi

echo "== drag the intra-panel divider: both cells re-flow =="
divider_x=$(( col0 + 1 ))
target_x=$(( divider_x - 18 ))   # push the divider LEFT → left cell shrinks, right cell grows
"$H" drag "$S" "$divider_x" "$panel_row" "$target_x" "$panel_row" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
cols_csv2="$(f panelCellColumns)"
col0b="${cols_csv2%%,*}"; col1b="${cols_csv2##*,}"
if [ "${col0b:-0}" -lt "${col0:-0}" ] && [ "${col1b:-0}" -gt "${col1:-0}" ]; then
  echo "  PASS  divider drag re-flowed both cells (left $col0->$col0b, right $col1->$col1b)"
else
  echo "  FAIL  divider drag did not re-flow (left $col0->$col0b, right $col1->$col1b)"; fail=1
fi

echo "== un-split (F9): back to one full-width cell =="
"$H" send "$S" F9 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "single cell restored" "$(f panelCellIds)" "terminal"
chk "focused cell index reset" "$(f panelFocusedIndex)" "0"
restored_cols="$(f panelCellColumns)"
gt "restored cell reclaimed the full width" "$restored_cols" "$col0b"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
