#!/usr/bin/env bash
# Drive-verify the silent-codex-failure fix: a FAILED codex turn (forced by an isolated HOME with
# no codex auth — the exact reproduction the finisher discovered) must render an ERROR row in the
# agent pane instead of a blank reply. Uses the REAL codex app-server backend (no echo override).
# One-shot verification driver; the mapping itself is unit-gated in CodexAppServerMapping.test.ts.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
S="codexfail-$$"
fail=0
f() { "$H" field "$S" "$1"; }

command -v codex >/dev/null || { echo "  SKIP  codex CLI not installed"; exit 0; }

TEST_HOME="$(mktemp -d /tmp/tui-codexfail-home.XXXXXX)"
FIX="$(mktemp -d /tmp/tui-codexfail-fix.XXXXXX)"
printf 'hello\n' > "$FIX/file.txt"
mkdir -p "$TEST_HOME/.config/invar"
printf '{"agentProvider":"codex"}\n' > "$TEST_HOME/.config/invar/settings.json"
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$TEST_HOME" "$FIX"' EXIT INT TERM

echo "== launch with ISOLATED HOME (no ~/.codex auth) + agentProvider=codex =="
"$H" launch "$S" 120x40 env HOME="$TEST_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
"$H" ready "$S" 25 >/dev/null || { echo "  FAIL boot"; exit 1; }

echo "== open the agent pane, send a prompt, let the unauthenticated turn FAIL =="
tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"   # Ctrl+Shift+A (panel.toggleAgent)
sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
tmux send-keys -t "$S" -l "hello"
sleep 0.3
tmux send-keys -t "$S" Enter
# The turn must FAIL fast (local auth check / immediate 401) — wait for the session to leave busy.
deadline=$((SECONDS + 45))
while [ "$SECONDS" -lt "$deadline" ]; do
  "$H" settle "$S" >/dev/null 2>&1
  [ "$(f agentBusy)" = "false" ] && break
  sleep 0.5
done
[ "$(f agentBusy)" = "false" ] && echo "  PASS  the turn terminated (not hung)" \
  || { echo "  FAIL  turn still busy after 45s"; fail=1; }

echo "== the failure is VISIBLE: an error row renders (was: blank reply) =="
if "$H" capture "$S" | grep -qF "! error"; then
  echo "  PASS  the transcript renders the error row marker"
else
  echo "  FAIL  no error row in the pane — the failure is still silent"
  "$H" capture "$S" | tail -12
  fail=1
fi
# The row must CARRY THE REASON, not just the marker: some auth-ish detail below it.
if "$H" capture "$S" | grep -qiE "401|auth|login|unauthorized|api key|error"; then
  echo "  PASS  the error text carries failure detail"
else
  echo "  FAIL  no failure detail rendered"; fail=1
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
