#!/usr/bin/env bash
# Driven navigation-history contract (VS Code "Go Back / Go Forward"): the REAL app over two temp
# files. Opens alpha.ts from the tree, moves the cursor down into it, opens beta.ts, then presses
# Alt+[ and asserts the editor is back on alpha.ts WITH the cursor where it was left, then Alt+] and
# asserts it returns to beta.ts. No LSP — plain file opens exercise the same record/restore path
# go-to-definition uses, so this runs unconditionally in the gate.
#
# invariant: Programmatic history navigation does not record new history (src/modules/navigation/navigation.invariants.md)
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
SESSION_NAME="nav-$$-history"
FAILURE_COUNT=0

FIXTURE_ROOT="$(mktemp -d /tmp/tui-nav-smoke.XXXXXX)"
trap '"$HARNESS" kill "$SESSION_NAME" >/dev/null 2>&1; rm -rf "$FIXTURE_ROOT"' EXIT INT TERM

# Two files; the tree sorts them alphabetically (no directories), so alpha.ts is row 0, beta.ts row 1.
printf 'alpha one\nalpha two\nalpha three\nalpha four\nalpha five\n' > "$FIXTURE_ROOT/alpha.ts"
printf 'beta one\nbeta two\nbeta three\nbeta four\nbeta five\n' > "$FIXTURE_ROOT/beta.ts"

field() { "$HARNESS" field "$SESSION_NAME" "$1" 2>/dev/null; }
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILURE_COUNT=$((FAILURE_COUNT + 1)); }

# The status channel's cursor as "line,col" (semantic state — the authoritative channel).
cursor_position() {
  STATUS_PATH="$PROJECT_ROOT/artifacts/status-$SESSION_NAME.json" python3 - <<'PY'
import json, os
snapshot = json.load(open(os.environ['STATUS_PATH'], encoding='utf-8'))
cursor = snapshot.get('cursor')
print(f"{cursor['line']},{cursor['col']}" if cursor else 'none')
PY
}

# Alt+[ / Alt+] via the modifyOtherKeys form (CSI 27 ; 3=alt ; keycode ~): 91='[', 93=']'. This form
# decodes to {name, option:true} under BOTH legacy and kitty fidelity, so the smoke is robust
# regardless of how tmux negotiates the keyboard protocol (verified against @opentui/core parseKeypress).
send_alt_open_bracket()  { tmux send-keys -t "$SESSION_NAME" -l "$(printf '\033[27;3;91~')"; sleep 0.35; }
send_alt_close_bracket() { tmux send-keys -t "$SESSION_NAME" -l "$(printf '\033[27;3;93~')"; sleep 0.35; }

echo '== launch and open alpha.ts from the file tree =='
"$HARNESS" launch "$SESSION_NAME" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIXTURE_ROOT" >/dev/null
"$HARNESS" ready "$SESSION_NAME" 20 >/dev/null
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null   # row 0 = alpha.ts
sleep 0.4
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/alpha.ts" ]; then
  pass 'alpha.ts opened as the active buffer'
else
  fail "expected alpha.ts active, got activeBuffer=$(field activeBuffer)"
fi

echo '== move the cursor down into alpha.ts, then open beta.ts =='
"$HARNESS" send "$SESSION_NAME" Down >/dev/null   # focus is the editor after a tree open
"$HARNESS" send "$SESSION_NAME" Down >/dev/null
"$HARNESS" send "$SESSION_NAME" Down >/dev/null
sleep 0.2
alpha_cursor="$(cursor_position)"
if [ "$alpha_cursor" = '3,0' ]; then
  pass "cursor moved to alpha.ts line 3 ($alpha_cursor)"
else
  fail "expected cursor 3,0 in alpha.ts, got $alpha_cursor"
fi
"$HARNESS" send "$SESSION_NAME" Escape >/dev/null  # back to the file tree
"$HARNESS" send "$SESSION_NAME" Down >/dev/null     # row 1 = beta.ts
"$HARNESS" send "$SESSION_NAME" Enter >/dev/null
sleep 0.4
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/beta.ts" ]; then
  pass 'beta.ts opened as the active buffer'
else
  fail "expected beta.ts active, got activeBuffer=$(field activeBuffer)"
fi

echo '== Alt+[ goes BACK to alpha.ts with the cursor restored =='
send_alt_open_bracket
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
back_buffer="$(field activeBuffer)"
back_cursor="$(cursor_position)"
if [ "$back_buffer" = "$FIXTURE_ROOT/alpha.ts" ]; then
  pass 'Alt+[ restored alpha.ts as the active buffer'
else
  fail "Alt+[ did not return to alpha.ts (activeBuffer=$back_buffer)"
fi
if [ "$back_cursor" = '3,0' ]; then
  pass "Alt+[ restored the cursor to where it was left ($back_cursor)"
else
  fail "Alt+[ reached alpha.ts but the cursor was not restored (cursor=$back_cursor, want 3,0)"
fi

echo '== Alt+] goes FORWARD to beta.ts =='
send_alt_close_bracket
"$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
forward_buffer="$(field activeBuffer)"
if [ "$forward_buffer" = "$FIXTURE_ROOT/beta.ts" ]; then
  pass 'Alt+] returned forward to beta.ts'
else
  fail "Alt+] did not return to beta.ts (activeBuffer=$forward_buffer)"
fi

echo '== the ‹ › breadcrumb buttons drive the same navigation on click =='
# Locate the breadcrumb row + the ‹ button column from the real pane (tmux capture renders the actual
# glyphs). The row is the one carrying ‹ AND the active filename — the workspace strip's own ‹ › pan
# controls live on a different row and carry no filename. The › button sits two columns right of ‹.
button_location="$("$HARNESS" capture "$SESSION_NAME" | python3 -c "
import sys
for row_index, line in enumerate(sys.stdin.read().split(chr(10))):
    column = line.find('‹')
    if column >= 0 and 'beta.ts' in line:
        print(f'{column} {row_index}'); break
")"
if [ -z "$button_location" ]; then
  fail 'could not find the breadcrumb ‹ › buttons in the rendered pane'
else
  back_column="${button_location% *}"; button_row="${button_location#* }"
  forward_column=$((back_column + 2))
  pass "breadcrumb buttons rendered (‹ at col $back_column, row $button_row)"
  "$HARNESS" click "$SESSION_NAME" "$back_column" "$button_row" >/dev/null   # ‹ back
  "$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
  if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/alpha.ts" ]; then
    pass 'clicking ‹ went back to alpha.ts'
  else
    fail "clicking ‹ did not go back (activeBuffer=$(field activeBuffer))"
  fi
  "$HARNESS" click "$SESSION_NAME" "$forward_column" "$button_row" >/dev/null   # › forward
  "$HARNESS" settle "$SESSION_NAME" 8 >/dev/null 2>&1 || true
  if [ "$(field activeBuffer)" = "$FIXTURE_ROOT/beta.ts" ]; then
    pass 'clicking › went forward to beta.ts'
  else
    fail "clicking › did not go forward (activeBuffer=$(field activeBuffer))"
  fi
fi

echo "== RESULT: $([ "$FAILURE_COUNT" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILURE_COUNT"
