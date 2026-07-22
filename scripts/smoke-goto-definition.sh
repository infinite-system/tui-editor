#!/usr/bin/env bash
# Driven go-to-definition contract: a REAL typescript-language-server behind the real app.
# In a temp TS project (foo.ts declares greetWidget, bar.ts uses it) the smoke opens bar.ts,
# Ctrl+clicks the use site (SGR mouse with the ctrl modifier bit), and asserts the editor now
# shows foo.ts with the cursor ON the declaration; then it returns to bar.ts and repeats the
# jump via F12 at the cursor. GUARDED SKIP: when typescript-language-server/typescript are not
# installed (repo devDependencies) the smoke skips cleanly — it never false-fails the gate.
#
# invariant: A definition gesture jumps to the declaration (src/modules/lsp/lsp.invariants.md)
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
SESSION_NAME="gotodef-smoke-$$"
FAILURE_COUNT=0

SERVER_BINARY="$PROJECT_ROOT/node_modules/.bin/typescript-language-server"
if [ ! -x "$SERVER_BINARY" ] || [ ! -d "$PROJECT_ROOT/node_modules/typescript" ]; then
  echo "SKIP  typescript-language-server/typescript not installed — goto-definition smoke skipped"
  echo "      (install with: bun add -d typescript-language-server typescript)"
  exit 0
fi

FIXTURE_ROOT="$(mktemp -d /tmp/tui-gotodef-smoke.XXXXXX)"
trap '"$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1; rm -rf "$FIXTURE_ROOT"' EXIT INT TERM

# The workspace symlinks the repo's node_modules so the server binary AND the typescript library
# resolve from the workspace root (mirrors scripts/drive-lsp-real-server.ts).
ln -s "$PROJECT_ROOT/node_modules" "$FIXTURE_ROOT/node_modules"
cat > "$FIXTURE_ROOT/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true },
  "include": ["*.ts"]
}
JSON
cat > "$FIXTURE_ROOT/foo.ts" <<'TS'
export function greetWidget(name: string): string {
  return `hello ${name}`;
}
TS
cat > "$FIXTURE_ROOT/bar.ts" <<'TS'
import { greetWidget } from './foo';

const message = greetWidget('world');
export { message };
TS

field() { "$HARNESS" field "$SESSION_NAME" "$1" 2>/dev/null; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURE_COUNT=$((FAILURE_COUNT + 1)); }

# Screen cell (column,row) of the greetWidget USE inside the row that carries `const message`,
# read from the FrameProbe dump — the renderer's own geometry, never parallel math.
use_site_cell() {
  FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 - <<'PY'
import json
import os

rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
for row_index, row in enumerate(rows):
    text = row.get('text', '')
    if 'const message' in text:
        column = text.find('greetWidget')
        if column >= 0:
            print(f'{column},{row_index}')
        break
PY
}

# The status channel's cursor as "line,col" (semantic state — the authoritative channel).
cursor_position() {
  STATUS_PATH="$PROJECT_ROOT/artifacts/status-$SESSION_NAME.json" python3 - <<'PY'
import json
import os

snapshot = json.load(open(os.environ['STATUS_PATH'], encoding='utf-8'))
cursor = snapshot.get('cursor')
print(f"{cursor['line']},{cursor['col']}" if cursor else 'none')
PY
}

# Poll until activeBuffer ends with the given suffix (the LSP round trip includes a lazy server
# start, so the first jump can take seconds).
wait_for_buffer() {
  local suffix="$1" timeout_seconds="${2:-30}"
  local end=$((SECONDS + timeout_seconds))
  while [ $SECONDS -lt $end ]; do
    case "$(field activeBuffer)" in *"$suffix") return 0 ;; esac
    sleep 0.3
  done
  return 1
}

echo '== launch and open bar.ts from the file tree =='
"$HARNESS" launch "$SESSION_NAME" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
"$HARNESS" ready "$SESSION_NAME" 20 >/dev/null
# Tree rows sort directories first: node_modules, bar.ts, foo.ts, tsconfig.json.
"$HARNESS" send "$SESSION_NAME" Down >/dev/null
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null
sleep 0.7
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/bar.ts" ]; then
  pass 'bar.ts opened as the active buffer'
else
  fail "expected bar.ts active, got activeBuffer=$(field activeBuffer)"
fi

echo '== Ctrl+click the greetWidget use site jumps to the declaration in foo.ts =='
use_cell="$(use_site_cell)"
if [ -z "$use_cell" ]; then
  fail 'could not locate the greetWidget use site in the frame dump'
else
  use_column="${use_cell%,*}"
  use_row="${use_cell#*,}"
  # SGR left button with the ctrl modifier bit (16): press + release at the use-site cell.
  printf -v control_click_press '\033[<16;%d;%dM' "$((use_column + 1))" "$((use_row + 1))"
  printf -v control_click_release '\033[<16;%d;%dm' "$((use_column + 1))" "$((use_row + 1))"
  tmux send-keys -t "$SESSION_NAME" -l "$control_click_press"
  sleep 0.1
  tmux send-keys -t "$SESSION_NAME" -l "$control_click_release"
  if wait_for_buffer '/foo.ts' 30; then
    "$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
    landed_cursor="$(cursor_position)"
    if [ "$landed_cursor" = '0,16' ]; then
      pass "Ctrl+click jumped to foo.ts with the cursor on the greetWidget declaration ($landed_cursor)"
    else
      fail "Ctrl+click reached foo.ts but the cursor missed the declaration (cursor=$landed_cursor, want 0,16)"
    fi
    declaration_visible="$(FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 -c "
import json, os
rows = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows']
print('yes' if any('export function greetWidget' in row.get('text', '') for row in rows) else 'no')
")"
    if [ "$declaration_visible" = 'yes' ]; then
      pass 'the declaration line is visible in the rendered frame'
    else
      fail 'foo.ts is active but the declaration line is not on screen'
    fi
  else
    fail "Ctrl+click did not open foo.ts (activeBuffer=$(field activeBuffer), lsp=$(field lspStatus) $(field lspProvider))"
  fi
fi

echo '== back on bar.ts, F12 at the cursor performs the same jump =='
# Return to bar.ts by clicking its tab in the tab bar (row 1), then place the cursor on the use
# site with a PLAIN click (no modifier — this must stay an ordinary cursor placement).
bar_tab_column="$(FRAME_PATH="$PROJECT_ROOT/artifacts/frame-$SESSION_NAME.json" python3 -c "
import json, os
text = json.load(open(os.environ['FRAME_PATH'], encoding='utf-8'))['rows'][1].get('text', '')
print(text.find('bar.ts') + 2)
")"
"$HARNESS" click "$SESSION_NAME" "$bar_tab_column" 1 >/dev/null
sleep 0.5
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/bar.ts" ]; then
  pass 'tab click returned to bar.ts'
else
  fail "tab click did not return to bar.ts (activeBuffer=$(field activeBuffer))"
fi
use_cell="$(use_site_cell)"
use_column="${use_cell%,*}"
use_row="${use_cell#*,}"
"$HARNESS" click "$SESSION_NAME" "$use_column" "$use_row" >/dev/null
sleep 0.3
plain_click_cursor="$(cursor_position)"
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/bar.ts" ] && [ "${plain_click_cursor%,*}" = '2' ]; then
  pass "plain click placed the cursor on the use line without jumping ($plain_click_cursor)"
else
  fail "plain click misbehaved (activeBuffer=$(field activeBuffer) cursor=$plain_click_cursor)"
fi
"$HARNESS" send "$SESSION_NAME" F12 >/dev/null
if wait_for_buffer '/foo.ts' 20; then
  "$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
  f12_cursor="$(cursor_position)"
  if [ "$f12_cursor" = '0,16' ]; then
    pass "F12 jumped to the declaration ($f12_cursor)"
  else
    fail "F12 reached foo.ts but the cursor missed the declaration (cursor=$f12_cursor, want 0,16)"
  fi
else
  fail "F12 did not open foo.ts (activeBuffer=$(field activeBuffer))"
fi

echo "== RESULT: $([ "$FAILURE_COUNT" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILURE_COUNT"
