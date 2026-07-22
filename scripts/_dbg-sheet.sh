#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"
cd /tmp/hover-build
HARNESS=./scripts/tui-harness.sh
F="$(mktemp -d /tmp/tui-sheet.XXXXXX)"
printf 'alpha\nbeta\ngamma\n' > "$F/doc.txt"
S="sheet-$$"
trap '"$HARNESS" kill "$S" >/dev/null 2>&1; rm -rf "$F"' EXIT
"$HARNESS" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$F" >/dev/null
"$HARNESS" ready "$S" 20 >/dev/null
"$HARNESS" send "$S" Enter >/dev/null; sleep 0.5
has() { FRAME_PATH="artifacts/frame-$S.json" python3 - "$1" <<'PY'
import json,os,sys
rows=json.load(open(os.environ['FRAME_PATH']))['rows']
print('YES' if any(sys.argv[1] in r.get('text','') for r in rows) else 'no')
PY
}
"$HARNESS" send "$S" S-F1 >/dev/null; "$HARNESS" settle "$S" 8 >/dev/null 2>&1 || true; sleep 0.3
echo "sheet open -> 'Keyboard Shortcuts': $(has 'Keyboard Shortcuts')"
"$HARNESS" send "$S" Escape >/dev/null; "$HARNESS" settle "$S" 8 >/dev/null 2>&1 || true; sleep 0.3
echo "after Escape -> 'Keyboard Shortcuts': $(has 'Keyboard Shortcuts')"
