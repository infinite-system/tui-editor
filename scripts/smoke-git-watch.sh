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

echo "== opening an untracked DIRECTORY row (node_modules symlink) must NOT crash (EISDIR guard) =="
# The user's exact case: node_modules is a SYMLINK-to-directory (worktree setups symlink it). git lists
# the symlink as an untracked FILE ('?? node_modules'), the git panel makes it a clickable file row, and
# opening it read the symlink target (a directory — exists/read follow symlinks) -> EISDIR -> the throw
# escaped OpenTUI's mouse dispatch and crashed the app. Use a FRESH repo with the symlink PRESENT AT
# LAUNCH (no GitWatcher-detection timing to depend on): the panel shows it on the first C-g.
"$H" kill "$S" >/dev/null 2>&1
DIRREPO="$(mktemp -d /tmp/tui-git-dir.XXXXXX)"; SYMTGT="$(mktemp -d /tmp/tui-nm-target.XXXXXX)"; printf 'module.exports={};\n' > "$SYMTGT/pkg.js"
( cd "$DIRREPO" && git init -q && printf 'a\n' > f.txt && git add -A && git -c user.email=a@b.c -c user.name=x commit -qm init && ln -s "$SYMTGT" node_modules )
trap '"$H" kill "$S" >/dev/null 2>&1; "$H" kill "$S2" >/dev/null 2>&1; rm -rf "$REPO" "$DIRREPO" "$SYMTGT"' EXIT INT TERM
S2="git-dir-$$"
"$H" launch "$S2" 120x40 bun run src/main.ts "$DIRREPO" >/dev/null
if "$H" ready "$S2" 20 >/dev/null; then
  "$H" send "$S2" C-g >/dev/null; sleep 0.5; "$H" settle "$S2" >/dev/null 2>&1   # git panel; the node_modules symlink row is present at boot
  before="$("$H" field "$S2" gitChangedCount)"
  "$H" send "$S2" o >/dev/null                                                   # open the change at the selected (directory) row — the crash trigger
  sleep 0.7; "$H" settle "$S2" >/dev/null 2>&1
  alive="$("$H" field "$S2" gitChangedCount)"   # a crashed app can't answer the side-channel probe
  if [ "${before:-0}" -ge 1 ] 2>/dev/null && [ -n "$alive" ] && [ "${alive:-0}" -ge 1 ] 2>/dev/null; then
    echo "  PASS  opening the untracked node_modules-symlink row did not crash the app (EISDIR guarded)"
  else
    echo "  FAIL  directory-row open crashed or setup wrong (before='$before' after='$alive')"; fail=1
  fi
else
  echo "  FAIL  second instance did not boot"; fail=1
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
