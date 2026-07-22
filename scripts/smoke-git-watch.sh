#!/usr/bin/env bash
# Enforcement smoke for the GitWatcher wiring (the capability existed + passed its own tests but was
# NEVER wired, so external working-tree changes did not refresh the panel). This drives the WHOLE app:
# an EXTERNAL fs change (modify a NESTED file, add a file, delete a file) with NO in-app action must
# live-update the git panel within the debounce window. Asserts gitChangedCount from status.json.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
S="git-watch-$$"
fail=0
f() { "$H" field "$S" "$1"; }

REPO="$(mktemp -d /tmp/tui-git-watch.XXXXXX)"
( cd "$REPO" && git init -q && mkdir -p src \
  && printf 'a\n' > src/nested.ts && printf 'root\n' > root.txt && printf 'gone\n' > src/doomed.ts \
  && git add -A && git -c user.email=a@b.c -c user.name=x commit -qm init )
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$REPO"' EXIT INT TERM

wait_for_count() { # wait_for_count <target-comparison-cmd> <timeout-ds> ; polls gitChangedCount
  local deadline=$(( SECONDS + ${2:-4} ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    "$H" settle "$S" >/dev/null 2>&1
    local count; count="$(f gitChangedCount)"
    if [ "${count:-0}" "$1" 0 ] 2>/dev/null; then echo "$count"; return 0; fi
    sleep 0.2
  done
  f gitChangedCount
}

echo "== launch on a clean repo; git panel starts at 0 changes =="
"$H" launch "$S" 120x40 bun run src/main.ts "$REPO" >/dev/null
"$H" ready "$S" 20 >/dev/null || { echo "  FAIL boot"; exit 1; }
"$H" send "$S" C-g >/dev/null; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
start="$(f gitChangedCount)"
if [ "${start:-9}" = "0" ]; then echo "  PASS  clean repo, 0 changes"; else echo "  FAIL  expected 0 changes, got $start"; fail=1; fi

echo "== EXTERNAL change to a NESTED file (no in-app action) live-updates the panel =="
printf 'a\nEXTERNALLY MODIFIED\n' > "$REPO/src/nested.ts"   # modify nested
printf 'brand new\n' > "$REPO/src/added.ts"                 # add nested
rm -f "$REPO/src/doomed.ts"                                 # delete nested
after="$(wait_for_count -gt 6)"
if [ "${after:-0}" -ge 3 ] 2>/dev/null; then echo "  PASS  external nested modify+add+delete reflected without any in-app action (0 -> $after)"; else echo "  FAIL  git panel did not reflect external nested changes (0 -> $after) — GitWatcher unwired or non-recursive"; fail=1; fi

echo "== reverting the external changes clears them too =="
( cd "$REPO" && git checkout -q -- src/nested.ts src/doomed.ts && rm -f src/added.ts )
cleared="$(wait_for_count -eq 5)"
if [ "${cleared:-9}" = "0" ]; then echo "  PASS  panel returned to 0 after external revert"; else echo "  FAIL  panel stuck at $cleared after revert"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
