#!/usr/bin/env bash
# Live regression for quick-open / go-to-file (Ctrl+P): drives the REAL chord path — open the modal,
# type a fuzzy query, Enter opens the ranked file as a tab. Proves the WIRING (chord -> modal -> project
# file enumeration [rg --files, git ls-files fallback] -> fuzzy rank -> activate -> openFileInTab), not
# just the QuickOpen unit logic. Runs in the merge-gate.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
S="quickopen-smoke-$$"
W="$(mktemp -d /tmp/tui-qo-smoke.XXXXXX)"
fail=0
trap '"$H" kill "$S" >/dev/null 2>&1; rm -rf "$W"' EXIT INT TERM

( cd "$W" && git init -q && for n in alpha beta gamma; do echo x > "$n.txt"; done && mkdir -p src && echo "content" > src/widget.txt )

echo "== launch (git repo so the git ls-files fallback works where rg is absent) =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$W" >/dev/null
"$H" ready "$S" 20 >/dev/null

echo "== Ctrl+P opens the modal; typing 'widget' ranks src/widget.txt; Enter opens it =="
"$H" send "$S" C-p >/dev/null; sleep 1.0   # wait for the async project-file enumeration
"$H" settle "$S" >/dev/null 2>&1
title_ok=$(python3 -c "
import json
rows=json.load(open('$DIR/../artifacts/frame-$S.json'))['rows']
print('yes' if any('Go to File' in r.get('text','') for r in rows) else 'no')
")
[ "$title_ok" = "yes" ] && echo "  PASS  Ctrl+P opened the Go-to-File modal" || { echo "  FAIL  Ctrl+P did not open the modal"; fail=1; }

for c in w i d g e t; do "$H" send "$S" "$c" >/dev/null; sleep 0.06; done; sleep 0.3
"$H" send "$S" Enter >/dev/null; sleep 0.4
opened="$("$H" field "$S" activeBuffer 2>/dev/null)"
if [ -n "$opened" ] && [ "$opened" != "null" ] && case "$opened" in *widget.txt) true;; *) false;; esac; then
  echo "  PASS  Enter opened the fuzzy-matched file ($(basename "$opened"))"
else
  echo "  FAIL  Enter did not open src/widget.txt (activeBuffer=$opened)"; fail=1
fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
