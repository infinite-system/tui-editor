#!/usr/bin/env bash
# Driven TS-diagnostics RENDER contract: a real language server reports a type error and the editor
# paints (a) a severity-coloured gutter mark and (b) a coloured underline over the diagnostic range.
# Forces typescript-language-server because it PUSHES diagnostics (publishDiagnostics); the default
# tsgo/native-preview build does not publish diagnostics (pull-model), so this smoke pins the server
# that exercises the render path.
# invariant: TS diagnostics render as a gutter mark and an underline (src/modules/ui/ui.invariants.md)
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
SESSION="diagnostics-$$"
FAILS=0
SERVER="$PROJECT_ROOT/node_modules/.bin/typescript-language-server"
if [ ! -x "$SERVER" ] || [ ! -d "$PROJECT_ROOT/node_modules/typescript" ]; then
  echo "SKIP  typescript-language-server/typescript not installed — diagnostics smoke skipped"; exit 0
fi
FIX="$(mktemp -d /tmp/tui-diag-smoke.XXXXXX)"; HOME2="$(mktemp -d /tmp/tui-diag-home.XXXXXX)"
trap '"$HARNESS" kill "$SESSION" >/dev/null 2>&1; rm -rf "$FIX" "$HOME2"' EXIT INT TERM
mkdir -p "$HOME2/.config/invar"; echo '{"typescriptServer":"typescript-language-server"}' > "$HOME2/.config/invar/settings.json"
ln -s "$PROJECT_ROOT/node_modules" "$FIX/node_modules"
cat > "$FIX/tsconfig.json" <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true }, "include": ["*.ts"] }
JSON
printf 'const okValue: number = 42;\nconst badValue: number = "not a number";\n' > "$FIX/e.ts"
"$HARNESS" launch "$SESSION" 120x36 env HOME="$HOME2" COLORTERM=truecolor TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
"$HARNESS" ready "$SESSION" 20 >/dev/null || { echo "  FAIL  app not ready"; echo "== RESULT: FAILURES =="; exit 1; }
"$HARNESS" send "$SESSION" Down >/dev/null; "$HARNESS" send "$SESSION" Enter >/dev/null; sleep 0.8
for _k in $(seq 1 20); do
  dc=$(python3 -c "import json;print(json.load(open('$PROJECT_ROOT/artifacts/status-$SESSION.json')).get('diagnosticsCount',0))" 2>/dev/null || echo 0)
  [ "$dc" -gt 0 ] 2>/dev/null && break; sleep 2
done
result="$(FRAME="$PROJECT_ROOT/artifacts/frame-$SESSION.json" python3 - <<'PY'
import json, os
rows=json.load(open(os.environ['FRAME']))['rows']
red='243,139,168'  # palette.error (dark)
gutter=underline=0
for r in rows:
    t=r.get('text','')
    if 'badValue' in t and 'const' in t:
        fgs=r.get('fg',[])
        for i,c in enumerate(fgs):
            if not c.startswith(red): continue
            ch=t[i] if i<len(t) else ''
            if ch in ('▎','▁') or (ch and ord(ch) >= 0x10000): gutter+=1   # marker glyph (raw or substituted)
            elif ch.strip(): underline+=1
        break
print(f'{gutter} {underline}')
PY
)"
gutter="${result% *}"; underline="${result#* }"
if [ "${gutter:-0}" -ge 1 ]; then echo "  PASS  severity-coloured gutter mark on the error line ($gutter)"; else echo "  FAIL  no red gutter mark on the error line"; FAILS=$((FAILS+1)); fi
if [ "${underline:-0}" -ge 1 ]; then echo "  PASS  coloured underline over the diagnostic range ($underline cells)"; else echo "  FAIL  no red underline over the diagnostic range"; FAILS=$((FAILS+1)); fi
echo "== RESULT: $([ "$FAILS" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILS"
