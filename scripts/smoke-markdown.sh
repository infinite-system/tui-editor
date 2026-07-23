#!/usr/bin/env bash
# Driven Markdown split-preview contract: real tab-bar click, rendered output, file-reference hover
# chord, persisted splitter, preview drag/autoscroll/copy + source paste, and independent pane find.
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
SESSION_NAME="markdown-smoke-$$"
FIXTURE_ROOT="$(mktemp -d /tmp/tui-markdown-smoke.XXXXXX)"
FAILURE_COUNT=0
trap '"$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1; rm -rf "$FIXTURE_ROOT"' EXIT INT TERM

python3 - "$FIXTURE_ROOT" <<'PY'
import os
import sys

root = sys.argv[1]
lines = [
    '# Rendered heading',
    '',
    'Open `target.ts` or [the target](target.ts).',
    '',
    'Rendered preview find term.',
    '',
]
for number in range(1, 90):
    lines.extend([f'## Section {number:02d}', f'Rendered row {number:02d} carries selectable preview text.', ''])
lines.append('TRUE MARKDOWN TAIL')
with open(os.path.join(root, 'README.md'), 'w', encoding='utf-8') as markdown_file:
    markdown_file.write('\n'.join(lines) + '\n')
with open(os.path.join(root, 'target.ts'), 'w', encoding='utf-8') as target_file:
    target_file.write('export const openedFromMarkdown = true;\n')
PY

field() { "$HARNESS" field "$SESSION_NAME" "$1" 2>/dev/null; }
settle() { "$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURE_COUNT=$((FAILURE_COUNT + 1)); }
frame_value() {
  FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" CONTENT_OFFSET="${content_offset:-0}" python3 - "$1" <<'PY'
import json
import os
import sys

rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
texts = [row.get('text', '') for row in rows]
# The buffer tab bar sits directly under the workspace tab strip; when the strip grows past 1 line
# (two-line workspace tabs) the tab bar row shifts down by this offset.
content_offset = int(os.environ.get('CONTENT_OFFSET', '0'))
tab_bar_row = 1 + content_offset
operation = sys.argv[1]
if operation == 'preview-button-column':
    print(texts[tab_bar_row].find('1/1') - 3)
elif operation == 'preview-border-column':
    print(next((text.find('╭─Preview') for text in texts if '╭─Preview' in text), -1))
elif operation == 'source-border-column':
    row = next((text for text in texts if '╭─README.md' in text), '')
    print(row.find('╭─README.md'))
elif operation == 'reference-cell':
    preview_column = next((text.find('╭─Preview') for text in texts if '╭─Preview' in text), -1)
    for row_index, text in enumerate(texts):
        column = text.find('target.ts', preview_column)
        if column >= 0:
            print(f'{column},{row_index}')
            break
elif operation == 'markdown-link-cell':
    preview_column = next((text.find('╭─Preview') for text in texts if '╭─Preview' in text), -1)
    for row_index, text in enumerate(texts):
        column = text.find('the target', preview_column)
        if column >= 0:
            print(f'{column},{row_index}')
            break
elif operation == 'rendered-heading':
    preview_column = next((text.find('╭─Preview') for text in texts if '╭─Preview' in text), -1)
    right = '\n'.join(text[preview_column:] for text in texts if preview_column >= 0)
    print('yes' if 'Rendered heading' in right and '# Rendered heading' not in right else 'no')
PY
}

echo '== launch and open Markdown source =='
"$HARNESS" launch "$SESSION_NAME" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
"$HARNESS" ready "$SESSION_NAME" 20 >/dev/null
# Height-robust content offset: the buffer tab bar and the source/preview panes sit below the
# workspace tab strip, so they shift down by this many rows when the strip grows past 1 line (two-line
# workspace tabs -> offset 1). Every hardcoded tab-bar/pane-content y below adds it.
content_offset="$("$HARNESS" content-offset "$SESSION_NAME" 2>/dev/null)"; content_offset="${content_offset:-0}"
tab_bar_row=$((1 + content_offset))
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null
sleep 0.7
settle
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/README.md" ] && [ "$(field markdownPreviewOpen)" = "false" ]; then
  pass 'Markdown opens source-only by default'
else
  fail "unexpected open state buffer=$(field activeBuffer) preview=$(field markdownPreviewOpen)"
fi

echo '== click the tab-bar preview button and verify rendered Markdown =='
preview_button_column="$(frame_value preview-button-column)"
"$HARNESS" click "$SESSION_NAME" "$preview_button_column" "$tab_bar_row" >/dev/null
sleep 0.8
settle
if [ "$(field markdownPreviewOpen)" = "true" ] && [ "$(frame_value rendered-heading)" = "yes" ]; then
  pass 'tab-bar button mounted source and rendered preview panes'
else
  fail 'split did not render the heading without raw Markdown punctuation'
fi
"$HARNESS" click "$SESSION_NAME" "$preview_button_column" "$tab_bar_row" >/dev/null
sleep 0.4
if [ "$(field markdownPreviewOpen)" = "false" ]; then pass 'second click returned to source-only'; else fail 'second click did not close preview'; fi
"$HARNESS" click "$SESSION_NAME" "$preview_button_column" "$tab_bar_row" >/dev/null
sleep 0.7
settle

echo '== hover a backtick file reference and open it with Ctrl+Enter =='
reference_cell="$(frame_value reference-cell)"
reference_column="${reference_cell%,*}"
reference_row="${reference_cell#*,}"
printf -v reference_move '\033[<35;%d;%dM' "$((reference_column + 1))" "$((reference_row + 1))"
tmux send-keys -t "$SESSION_NAME" -l "$reference_move"
sleep 0.7
if [ "$(field markdownHoveredReference)" = "$FIXTURE_ROOT/target.ts" ]; then
  pass 'hover resolved the rendered inline-code path inside the workspace'
else
  fail "hovered reference did not resolve: $(field markdownHoveredReference)"
fi
markdown_link_cell="$(frame_value markdown-link-cell)"
markdown_link_column="${markdown_link_cell%,*}"
markdown_link_row="${markdown_link_cell#*,}"
printf -v markdown_link_move '\033[<35;%d;%dM' "$((markdown_link_column + 1))" "$((markdown_link_row + 1))"
tmux send-keys -t "$SESSION_NAME" -l "$markdown_link_move"
sleep 0.5
if [ "$(field markdownHoveredReference)" = "$FIXTURE_ROOT/target.ts" ]; then
  pass 'hover resolved the standard Markdown link inside the workspace'
else
  fail "standard Markdown link did not resolve: $(field markdownHoveredReference)"
fi
# Kitty Ctrl+Enter, the deliverable chord used by the real keybinding registry.
tmux send-keys -t "$SESSION_NAME" -l "$(printf '\033[13;5u')"
sleep 0.8
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/target.ts" ]; then
  pass 'hover chord opened the referenced file through Workspace.openFileInTab'
else
  fail "reference activation left activeBuffer=$(field activeBuffer)"
fi

# Return to the Markdown tab by clicking its visible tab label; its per-path preview mode must return.
readme_tab_column="$(FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" CONTENT_OFFSET="${content_offset:-0}" python3 - <<'PY'
import json, os
tab_bar_row = 1 + int(os.environ.get('CONTENT_OFFSET', '0'))
text=json.load(open(os.environ['FRAME_PATH']))['rows'][tab_bar_row].get('text','')
print(text.find('README.md') + 2)
PY
)"
"$HARNESS" click "$SESSION_NAME" "$readme_tab_column" "$tab_bar_row" >/dev/null
sleep 0.8
settle

echo '== drag the preview splitter and verify live plus persisted geometry =='
preview_column_before="$(frame_value preview-border-column)"
divider_column=$((preview_column_before - 1))
ratio_before_drag="$(field markdownSplitRatio)"
if awk "BEGIN { exit !($ratio_before_drag <= 0.3) }"; then
  divider_target_column=$((divider_column + 10))
else
  divider_target_column=$((divider_column - 10))
fi
"$HARNESS" drag "$SESSION_NAME" "$divider_column" $((8 + content_offset)) "$divider_target_column" $((8 + content_offset)) >/dev/null
sleep 0.7
settle
persisted_ratio="$(field markdownSplitRatio)"
preview_column_after="$(frame_value preview-border-column)"
if [ "$preview_column_after" != "$preview_column_before" ] && [ "$persisted_ratio" != "$ratio_before_drag" ]; then
  pass "splitter moved preview edge $preview_column_before -> $preview_column_after and persisted ratio $persisted_ratio"
else
  fail "splitter did not resize panes (columns $preview_column_before -> $preview_column_after, ratio $persisted_ratio)"
fi
preview_button_column="$(frame_value preview-button-column)"
"$HARNESS" click "$SESSION_NAME" "$preview_button_column" "$tab_bar_row" >/dev/null
sleep 0.3
"$HARNESS" click "$SESSION_NAME" "$preview_button_column" "$tab_bar_row" >/dev/null
sleep 0.7
settle
if [ "$(field markdownSplitRatio)" = "$persisted_ratio" ] && [ "$(frame_value preview-border-column)" = "$preview_column_after" ]; then
  pass 'reopened preview reused the completed split drag'
else
  fail 'reopened preview reset its persisted split geometry'
fi

echo '== drag preview selection past its edge, copy, then paste into source =='
preview_border_column="$(frame_value preview-border-column)"
selection_column=$((preview_border_column + 5))
# Press near the top of the preview text (shifted down with the workspace strip); HOLD/RELEASE stay at
# the terminal's last rows -- a fixed screen position at the pane bottom that the strip growth does not
# move -- so the autoscroll keeps advancing before release.
printf -v selection_press '\033[<0;%d;%dM' "$((selection_column + 1))" "$((4 + content_offset))"
printf -v selection_drag_inside '\033[<32;%d;%dM' "$((selection_column + 1))" 35
printf -v selection_drag_edge '\033[<32;%d;%dM' "$((selection_column + 1))" 40
printf -v selection_release '\033[<0;%d;%dm' "$((selection_column + 1))" 40
tmux send-keys -t "$SESSION_NAME" -l "$selection_press"
sleep 0.08
tmux send-keys -t "$SESSION_NAME" -l "$selection_drag_inside"
sleep 0.08
tmux send-keys -t "$SESSION_NAME" -l "$selection_drag_edge"
sleep 1.2
tmux send-keys -t "$SESSION_NAME" -l "$selection_release"
sleep 0.5
selection_characters="$(field markdownPreviewSelectionChars)"
selection_scroll_top="$(field markdownPreviewScrollTop)"
if [ "${selection_scroll_top:-0}" -gt 0 ] && [ "${selection_characters:-0}" -gt 100 ]; then
  pass "preview edge drag autoscrolled to $selection_scroll_top and selected $selection_characters rendered chars"
else
  fail "preview selection did not grow while autoscrolling (scroll=$selection_scroll_top chars=$selection_characters)"
fi
"$HARNESS" send "$SESSION_NAME" C-c >/dev/null
sleep 0.8
if [ "$(field lastCopyChars)" = "$selection_characters" ] && [ -n "$(field lastCopyHash)" ] && [ "$(field lastCopyHash)" != 'null' ]; then
  pass 'Ctrl+C copied exactly the rendered selection model range'
else
  fail "copy mismatch selection=$selection_characters copied=$(field lastCopyChars) hash=$(field lastCopyHash)"
fi

source_border_column="$(frame_value source-border-column)"
"$HARNESS" click "$SESSION_NAME" "$((source_border_column + 8))" $((4 + content_offset)) >/dev/null
revision_before_paste="$(field bufferRevision)"
"$HARNESS" send "$SESSION_NAME" C-v >/dev/null
sleep 1.0
revision_after_paste="$(field bufferRevision)"
if [ "${revision_after_paste:-0}" -gt "${revision_before_paste:-0}" ] && [ "$(field markdownPaneFocus)" = 'source' ]; then
  pass "Ctrl+V pasted into editable source (revision $revision_before_paste -> $revision_after_paste)"
else
  fail "source paste did not mutate the buffer (revision $revision_before_paste -> $revision_after_paste)"
fi

echo '== Ctrl+F keeps independent source and preview state =='
"$HARNESS" send "$SESSION_NAME" C-f >/dev/null
"$HARNESS" send "$SESSION_NAME" '#' >/dev/null
sleep 0.4
"$HARNESS" send "$SESSION_NAME" Escape >/dev/null
preview_border_column="$(frame_value preview-border-column)"
"$HARNESS" click "$SESSION_NAME" "$((preview_border_column + 5))" $((3 + content_offset)) >/dev/null
"$HARNESS" send "$SESSION_NAME" C-f >/dev/null
for character in R e n d e r e d; do "$HARNESS" send "$SESSION_NAME" "$character" >/dev/null; done
sleep 0.5
settle
source_query="$(field sourceFindQuery)"
preview_query="$(field markdownPreviewFindQuery)"
find_target="$(field findTarget)"
find_matches="$(field findMatchCount)"
if [ "$source_query" = '#' ] && [ "$preview_query" = 'Rendered' ] && \
   [ "$find_target" = "markdown-preview:$FIXTURE_ROOT/README.md" ] && [ "${find_matches:-0}" -gt 0 ]; then
  pass 'source and preview retained different queries and the preview owned the active matches'
else
  fail "pane find state source='$source_query' preview='$preview_query' target='$find_target' matches='$find_matches'"
fi

echo "== RESULT: $([ "$FAILURE_COUNT" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILURE_COUNT"
