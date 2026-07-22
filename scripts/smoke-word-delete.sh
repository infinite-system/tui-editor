#!/usr/bin/env bash
# Driven contract for delete-previous-word. Exercises the real terminal byte sequences through tmux,
# the keybinding registry, editor undo/delete machinery, and the find-bar text-input path.
set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
BUN_EXECUTABLE="$HOME/.bun/bin/bun"
SESSION="word-delete-smoke-$$"
WORKSPACE_DIRECTORY="$(mktemp -d /tmp/tui-word-delete-smoke.XXXXXX)"
STATUS_FILE="$PROJECT_ROOT/artifacts/status-$SESSION.json"
FRAME_FILE="$PROJECT_ROOT/artifacts/frame-$SESSION.json"
failure=0

trap '"$HARNESS" kill "$SESSION" >/dev/null 2>&1; rm -rf "$WORKSPACE_DIRECTORY"' EXIT INT TERM

touch "$WORKSPACE_DIRECTORY/word-delete.txt"

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; failure=1; }

cursor_column() {
  STATUS_FILE="$STATUS_FILE" "$BUN_EXECUTABLE" -e '
    const status = JSON.parse(require("fs").readFileSync(process.env.STATUS_FILE, "utf8"));
    process.stdout.write(String(status.cursor?.col ?? ""));
  ' 2>/dev/null
}

editor_text_verdict() {
  FRAME_FILE="$FRAME_FILE" EXPECTED="$1" FORBIDDEN="$2" "$BUN_EXECUTABLE" -e '
    const frame = JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE, "utf8"));
    const text = frame.rows.map((row) => row.text).join("\n");
    const expected = process.env.EXPECTED ?? "";
    const forbidden = process.env.FORBIDDEN ?? "";
    process.stdout.write(text.includes(expected) && (!forbidden || !text.includes(forbidden)) ? "yes" : "no");
  ' 2>/dev/null
}

find_query_verdict() {
  FRAME_FILE="$FRAME_FILE" "$BUN_EXECUTABLE" -e '
    const frame = JSON.parse(require("fs").readFileSync(process.env.FRAME_FILE, "utf8"));
    const queryRow = frame.rows
      .map((row) => row.text)
      .find((text) => text.includes("no results") || /\d+ of \d+/.test(text)) ?? "";
    process.stdout.write(queryRow.includes("foo") && !queryRow.includes("bar") ? "yes" : "no");
  ' 2>/dev/null
}

settle() {
  sleep 0.25
  "$HARNESS" settle "$SESSION" >/dev/null 2>&1
}

send_option_backspace() {
  # macOS Option+Backspace commonly sends ESC DEL. OpenTUI decodes it as backspace+meta.
  tmux send-keys -t "$SESSION" -l "$(printf '\033\177')"
}

send_alt_delete() {
  # Legacy modified Delete: CSI 3;3~. Kitty's equivalent is covered by the decoder unit test.
  tmux send-keys -t "$SESSION" -l "$(printf '\033[3;3~')"
}

echo "== launch + open empty editor buffer =="
"$HARNESS" launch "$SESSION" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$WORKSPACE_DIRECTORY" >/dev/null
"$HARNESS" ready "$SESSION" 20 >/dev/null
"$HARNESS" send "$SESSION" Enter >/dev/null
"$HARNESS" send "$SESSION" Right >/dev/null
settle
active_buffer_before="$("$HARNESS" field "$SESSION" activeBuffer 2>/dev/null)"
if [ -n "$active_buffer_before" ] && [ "$active_buffer_before" != "null" ]; then
  pass "opened word-delete.txt"
else
  fail "no editor buffer opened"
fi

echo "== editor Option+Backspace deletes exactly the previous word =="
tmux send-keys -t "$SESSION" -l "hello world"
settle
send_option_backspace
settle
if [ "$(cursor_column)" = "6" ] && [ "$(editor_text_verdict 'hello ' 'world')" = "yes" ]; then
  pass "Option+Backspace changed 'hello world' to 'hello '"
else
  fail "Option+Backspace did not leave 'hello ' (cursor=$(cursor_column))"
fi

echo "== editor Alt+Delete uses the same action and never closes the file =="
tmux send-keys -t "$SESSION" -l "world"
settle
send_alt_delete
settle
active_buffer_after="$("$HARNESS" field "$SESSION" activeBuffer 2>/dev/null)"
if [ "$(cursor_column)" = "6" ] && [ "$active_buffer_after" = "$active_buffer_before" ]; then
  pass "Alt+Delete deleted the word and kept the active buffer open"
else
  fail "Alt+Delete changed buffer identity or boundary (before=$active_buffer_before after=$active_buffer_after cursor=$(cursor_column))"
fi

send_option_backspace
settle
if [ "$(cursor_column)" = "0" ]; then
  pass "repeating word delete removed trailing whitespace plus 'hello'"
else
  fail "repeated word delete did not reach document start (cursor=$(cursor_column))"
fi

echo "== editor punctuation is a distinct run =="
tmux send-keys -t "$SESSION" -l "foo..."
settle
send_option_backspace
settle
if [ "$(cursor_column)" = "3" ] && [ "$(editor_text_verdict 'foo' 'foo...')" = "yes" ]; then
  pass "punctuation run deleted without deleting the word"
else
  fail "punctuation boundary was not preserved (cursor=$(cursor_column))"
fi
send_alt_delete
settle

echo "== find-bar query uses the same word deletion =="
"$HARNESS" send "$SESSION" C-f >/dev/null
tmux send-keys -t "$SESSION" -l "foo bar"
settle
send_option_backspace
settle
if [ "$(find_query_verdict)" = "yes" ]; then
  pass "find query changed 'foo bar' to 'foo '"
else
  fail "find query did not use the shared previous-word boundary"
fi

echo "== RESULT: $([ "$failure" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$failure"
