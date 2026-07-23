#!/usr/bin/env bash
# Bottom-panel SPLIT smoke (experiment-panel-split). Proves the PanelHost split capability end to end by
# DRIVING it, not by measuring internals:
#   A) deterministic PanelHost unit tests (split layout, focus routing, per-cell resize, divider re-flow).
#   B) launch under tmux, open the panel (F8), then SPLIT it (F9) into two side-by-side cells — a mock
#      "Pane B" on the LEFT and the real terminal on the RIGHT — and assert:
#        - two cells render, each into its OWN sub-region (the left cell literally prints its sub-width);
#        - keystrokes go ONLY to the focused cell, and click-to-focus moves the target;
#        - dragging the intra-panel divider re-flows both cells' widths;
#        - un-splitting (F9) restores the single full-width pane.
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

echo "== B) launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1
fi
chk "panel hidden at boot" "$(f terminalVisible)" "false"

echo "== open the panel (F8): one full-width cell (the degenerate single-pane case) =="
"$H" send "$S" F8 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "panel visible" "$(f terminalVisible)" "true"
chk "single cell = terminal" "$(f panelCellIds)" "terminal"
chk "focused cell index 0" "$(f panelFocusedIndex)" "0"
full_cols="$(f panelCellColumns)"
gt "single cell has real width" "$full_cols" "1"
sleep 0.5; "$H" settle "$S" >/dev/null 2>&1

echo "== SPLIT the panel (F9): Pane B on the LEFT, terminal on the RIGHT =="
"$H" send "$S" F9 >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "two cells, left-to-right" "$(f panelCellIds)" "panel-b,terminal"
chk "left cell (Pane B) is focused" "$(f panelFocusedIndex)" "0"
cols_csv="$(f panelCellColumns)"
col0="${cols_csv%%,*}"; col1="${cols_csv##*,}"
gt "left cell has its own width" "$col0" "1"
gt "right cell has its own width" "$col1" "1"
# Each cell is NARROWER than the un-split pane — proof the width was actually shared, not duplicated.
if [ "${col0:-0}" -lt "${full_cols:-0}" ] && [ "${col1:-0}" -lt "${full_cols:-0}" ]; then
  echo "  PASS  both cells narrower than full ($col0 & $col1 < $full_cols) — width shared across the split"
else
  echo "  FAIL  a cell is not narrower than the un-split pane ($col0,$col1 vs $full_cols)"; fail=1
fi

echo "== each cell renders into its OWN sub-region (Pane B prints its converged sub-width) =="
# StaticPaneContent renders '<title> <width>x<height>'. If the child saw its sub-region, the left cell
# shows its own col0 — NOT the full panel width. This is the load-bearing per-cell-onResize proof.
if "$H" capture "$S" | grep -qE "Pane B ${col0}x"; then
  echo "  PASS  left cell rendered 'Pane B ${col0}x…' (child sized to its sub-region, not the full panel)"
else
  echo "  FAIL  left cell did not render its sub-width ${col0}"; "$H" capture "$S" | grep -i "Pane B" | head -2; fail=1
fi
# The real terminal occupies the RIGHT cell simultaneously (its prompt / a shell glyph renders there).
"$H" send "$S" -l "echo SPLIT_RIGHT" >/dev/null; "$H" send "$S" Enter >/dev/null
sleep 0.6; "$H" settle "$S" >/dev/null 2>&1

echo "== keystrokes reach ONLY the focused cell; click-to-focus moves the target =="
# Left (Pane B) is focused: a printable key lands in it and its render shows 'key:z'.
"$H" send "$S" -l "z" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
if "$H" capture "$S" | grep -qE "key:z"; then
  echo "  PASS  focused left cell received 'z' (key:z rendered)"
else
  echo "  FAIL  focused left cell did not receive the key"; "$H" capture "$S" | grep -i "Pane B" -A2 | head -4; fail=1
fi
# Click the RIGHT cell to focus it. The divider sits at inner-x = 1 + col0; the right cell starts just
# past it. Click a column safely inside the right cell, on a row inside the panel body.
right_click_x=$(( col0 + 6 ))
panel_row=$(( $(f height) - 8 ))
"$H" click "$S" "$right_click_x" "$panel_row" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
chk "click moved focus to the right cell" "$(f panelFocusedIndex)" "1"
# Pane B is now blurred, and a further key does NOT reach it (still shows key:z, not the new key).
"$H" send "$S" -l "q" >/dev/null
"$H" settle "$S" >/dev/null 2>&1
if "$H" capture "$S" | grep -qE "key:z" && ! "$H" capture "$S" | grep -qE "key:q"; then
  echo "  PASS  blurred left cell ignored later keys (key stayed 'z', never 'q')"
else
  echo "  FAIL  a key leaked to the unfocused cell"; "$H" capture "$S" | grep -i "Pane B" -A2 | head -4; fail=1
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
