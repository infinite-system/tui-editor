#!/usr/bin/env bash
# Driven LSP hover-card contract: a REAL typescript-language-server behind the real app.
# In a temp TS project (answer.ts declares `export const answer: number = 42`) the smoke opens the
# file, MOVES the mouse onto the `answer` symbol (an SGR motion event), and asserts:
#   1. under the 0.5s dwell (a quick move-through), NO card is shown;
#   2. after dwelling >0.5s, a BORDERED card carrying the server's type text ("answer" + "number",
#      the `const answer: number` hover — distinct from the source line which also carries "export"
#      and "42") is projected in the framebuffer.
# GUARDED SKIP: when typescript-language-server/typescript are not installed the smoke skips cleanly.
#
# invariant: A hover card reflects the language server's type at the pointed symbol (src/modules/ui/ui.invariants.md)
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
SESSION_NAME="hover-smoke-$$"
FAILURE_COUNT=0

SERVER_BINARY="$PROJECT_ROOT/node_modules/.bin/typescript-language-server"
if [ ! -x "$SERVER_BINARY" ] || [ ! -d "$PROJECT_ROOT/node_modules/typescript" ]; then
  echo "SKIP  typescript-language-server/typescript not installed — hover smoke skipped"
  echo "      (install with: bun add -d typescript-language-server typescript)"
  exit 0
fi

FIXTURE_ROOT="$(mktemp -d /tmp/tui-hover-smoke.XXXXXX)"
trap '"$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1; rm -rf "$FIXTURE_ROOT"' EXIT INT TERM

# The workspace symlinks the repo's node_modules so the server binary AND the typescript library
# resolve from the workspace root (mirrors smoke-goto-definition.sh).
ln -s "$PROJECT_ROOT/node_modules" "$FIXTURE_ROOT/node_modules"
cat > "$FIXTURE_ROOT/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true },
  "include": ["*.ts"]
}
JSON
cat > "$FIXTURE_ROOT/answer.ts" <<'TS'
export const answer: number = 42;
export const doubled = answer * 2;
TS

field() { "$HARNESS" field "$SESSION_NAME" "$1" 2>/dev/null; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURE_COUNT=$((FAILURE_COUNT + 1)); }

# Screen cell (column,row) of the `answer` symbol inside its CODE declaration line, from the frame
# dump. The file tree and editor share screen rows, and the tree also shows the filename "answer.ts",
# so the symbol is located as the `answer` that follows `export const answer` (the code occurrence),
# never the earlier tree-filename match.
symbol_cell() {
  FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
for row_index, row in enumerate(rows):
    text = row.get('text', '')
    declaration = text.find('export const answer')
    if declaration >= 0:
        column = text.find('answer', declaration)
        if column >= 0:
            print(f'{column},{row_index}')
        break
PY
}

# Is the hover CARD showing the server's type? The card's content row carries the `const answer:
# number` hover — it contains BOTH "answer" and "number" and a box border glyph, but NOT the source
# line's "export"/"42". That uniquely distinguishes the card from the underlying code line.
card_type_visible() {
  FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
def is_card(text):
    return ('answer' in text and 'number' in text
            and 'export' not in text and '42' not in text
            and '│' in text)  # │ box border on the same row
print('yes' if any(is_card(row.get('text', '')) for row in rows) else 'no')
PY
}

# A move-through motion event: SGR mouse MOTION with no button (32 motion bit + 3 = 35). 1-based.
move_mouse_to() {
  local column="$1" row="$2"
  printf -v motion '\033[<35;%d;%dM' "$((column + 1))" "$((row + 1))"
  tmux send-keys -t "$SESSION_NAME" -l "$motion"
}

echo '== launch and open answer.ts from the file tree =='
"$HARNESS" launch "$SESSION_NAME" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
"$HARNESS" ready "$SESSION_NAME" 20 >/dev/null || { fail "app did not become ready"; echo "== RESULT: FAILURES =="; exit 1; }
# Tree rows sort directories first: node_modules, answer.ts, tsconfig.json.
"$HARNESS" send "$SESSION_NAME" Down >/dev/null
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null
sleep 0.7
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/answer.ts" ]; then
  pass 'answer.ts opened as the active buffer'
else
  fail "expected answer.ts active, got activeBuffer=$(field activeBuffer)"
fi

cell="$(symbol_cell)"
if [ -z "$cell" ]; then
  fail 'could not locate the answer symbol in the frame dump'
  echo "== RESULT: FAILURES =="
  exit 1
fi
symbol_column="${cell%,*}"
symbol_row="${cell#*,}"
pass "located the answer symbol at cell ($symbol_column,$symbol_row)"

echo '== a sub-dwell move-through (<0.5s) shows NO card =='
# Dismiss any prior state with a keypress-free reset: just move the pointer onto the symbol and read
# the frame well before the 0.5s dwell elapses.
move_mouse_to "$symbol_column" "$symbol_row"
sleep 0.2
if [ "$(card_type_visible)" = 'no' ]; then
  pass 'no hover card before the dwell threshold (0.2s < 0.5s)'
else
  fail 'a hover card appeared before the 0.5s dwell elapsed'
fi

echo '== dwelling >0.5s shows the bordered type card (server ground truth) =='
# The SAME dwell continues (no intervening key/click to disarm it). After 0.5s the request fires; the
# first LSP hover includes a lazy server start, so poll the frame for the card up to a generous limit.
card_seen='no'
poll_end=$((SECONDS + 30))
while [ $SECONDS -lt $poll_end ]; do
  if [ "$(card_type_visible)" = 'yes' ]; then card_seen='yes'; break; fi
  # Nudge the same cell so the dwell/anchor stays live even if the frame loop quiesced between polls.
  move_mouse_to "$symbol_column" "$symbol_row"
  sleep 0.4
done
if [ "$card_seen" = 'yes' ]; then
  pass 'the hover card renders the server type text ("answer"/"number") inside a bordered box'
else
  fail "no hover card appeared after dwelling (lsp=$(field lspStatus) $(field lspProvider))"
fi

echo '== a keypress dismisses the card (VS Code behaviour) =='
if [ "$card_seen" = 'yes' ]; then
  "$HARNESS" send "$SESSION_NAME" Escape >/dev/null
  sleep 0.3
  if [ "$(card_type_visible)" = 'no' ]; then
    pass 'Escape dismissed the hover card'
  else
    fail 'the hover card survived a keypress'
  fi
fi

echo "== RESULT: $([ "$FAILURE_COUNT" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILURE_COUNT"
