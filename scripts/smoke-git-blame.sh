#!/usr/bin/env bash
# Current-line git blame smoke (GitLens parity). Two layers:
#   A) deterministic unit tests via `bun test` (porcelain parse incl. metadata reuse + uncommitted; the
#      relative-date formatter) — no git spawn, no app.
#   B) real drives under tmux:
#      - a scratch git repo with a committed file authored by "Blame Tester": open it, move the cursor,
#        and assert the STATUS BAR shows that line's author (probe field + the visible bar text).
#      - an UNTRACKED file in that repo: open it and assert NO blame author (git blame exits nonzero on
#        an unblamable path → the negative-cache/no-blame path). (Quick-open lists it via `--others`.)
# Usage: scripts/smoke-git-blame.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
REPO="$(mktemp -d /tmp/tui-blame-repo.XXXXXX)"
SESSIONS=""
fail=0
f()   { "$H" field "$1" "$2"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
# Poll a status field until it equals want (async blame lands a beat after the file opens).
wait_field() {
  local S="$1" name="$2" want="$3" tries=0
  while [ "$tries" -lt 30 ]; do
    [ "$(f "$S" "$name")" = "$want" ] && return 0
    "$H" settle "$S" >/dev/null 2>&1; sleep 0.2; tries=$((tries+1))
  done
  return 1
}
type_str() { local S="$1"; shift; local i; for ((i=0;i<${#1};i++)); do "$H" send "$S" "${1:$i:1}" >/dev/null; sleep 0.04; done; }

# Scratch repo: a committed file (author "Blame Tester", all lines) — so any cursor line blames to it —
# plus an UNTRACKED file (created, never `git add`ed) — blame exits nonzero → no author.
# env -u GIT_AUTHOR_*/GIT_COMMITTER_*: a hook-invoked caller (`git commit` running the merge gate)
# exports the PARENT repo's identity, which would override the explicit -c author below and break the
# author assertion — the scratch commit must be self-hermetic no matter who launched this smoke.
( cd "$REPO" && git init -q && git config user.name "Blame Tester" && git config user.email blame@test.local \
  && printf 'first line\nsecond line\nthird line\n' > tracked.txt \
  && git add tracked.txt \
  && env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_AUTHOR_DATE -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL -u GIT_COMMITTER_DATE \
    git -c user.name="Blame Tester" -c user.email=blame@test.local commit -qm "add tracked file" \
  && printf 'untracked one\nuntracked two\n' > untracked.txt )

trap 'for s in $SESSIONS; do "$H" kill "$s" >/dev/null 2>&1; done; rm -rf "$REPO"' EXIT INT TERM

echo "== A) deterministic unit tests (porcelain parse + relative-date formatter; no git spawn) =="
if "$BUN" test src/modules/git/GitBlame.test.ts src/modules/git/RelativeTime.test.ts >/tmp/blame-unit-$$.log 2>&1; then
  echo "  PASS  blame unit tests (porcelain parse, metadata reuse, uncommitted, relative-date buckets)"
else
  echo "  FAIL  blame unit tests"; tail -25 /tmp/blame-unit-$$.log; fail=1
fi
rm -f /tmp/blame-unit-$$.log

echo "== B1) a committed line shows its author in the status bar =="
S="blame-git-$$"; SESSIONS="$SESSIONS $S"
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$REPO" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
# Open tracked.txt via Ctrl+P (go-to-file), then move the cursor to line 2.
"$H" send "$S" C-p >/dev/null; sleep 1.0; "$H" settle "$S" >/dev/null 2>&1
type_str "$S" "tracked"
"$H" send "$S" Enter >/dev/null; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
opened="$(f "$S" activeBuffer)"
case "$opened" in *tracked.txt) echo "  PASS  opened tracked.txt";; *) echo "  FAIL  did not open tracked.txt (activeBuffer=$opened)"; fail=1;; esac
"$H" send "$S" Down >/dev/null; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1   # cursor -> line 2
if wait_field "$S" currentLineBlameAuthor "Blame Tester"; then
  echo "  PASS  cursor-line blame author is 'Blame Tester' (probe)"
else
  echo "  FAIL  blame author not resolved (got '$(f "$S" currentLineBlameAuthor)')"; fail=1
fi
# The visible status bar (last row) shows the author — the real user-facing surface.
if "$H" capture "$S" | tail -1 | grep -qF "Blame Tester"; then
  echo "  PASS  status bar renders the blame author"
else
  echo "  FAIL  status bar did not show the author"; "$H" capture "$S" | tail -1; fail=1
fi

echo "== B2) an UNTRACKED document shows NO blame (git blame nonzero → no author) =="
# Same session: open the untracked file (quick-open lists it via `git ls-files --others`).
"$H" send "$S" C-p >/dev/null; sleep 1.0; "$H" settle "$S" >/dev/null 2>&1
type_str "$S" "untracked"
"$H" send "$S" Enter >/dev/null; sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
opened2="$(f "$S" activeBuffer)"
case "$opened2" in *untracked.txt) echo "  PASS  opened untracked.txt";; *) echo "  FAIL  did not open untracked.txt (activeBuffer=$opened2)"; fail=1;; esac
# Untracked → git blame exits nonzero → negative-cached → no author. Give the async load a beat to settle
# (it resolves to "" either way; a pause rules out a transient-empty false pass).
"$H" settle "$S" >/dev/null 2>&1; sleep 0.5
chk "untracked document has no blame author" "$(f "$S" currentLineBlameAuthor)" ""

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
