#!/usr/bin/env bash
# Driven TS-diagnostics RENDER contract: a real language server surfaces a type error and the editor
# paints (a) a severity-coloured gutter mark and (b) a coloured underline over the diagnostic range.
# Runs the SAME assertion against BOTH supported servers:
#   - tsgo (@typescript/native-preview): PULL-model — never publishes; the client must send
#     textDocument/diagnostic and feed the report into the diagnostics store.
#   - typescript-language-server: PUSH-model — publishDiagnostics populates the same store.
# The render is source-agnostic, so both must light up the same cells.
# invariant: TS diagnostics render as a gutter mark and an underline (src/modules/ui/ui.invariants.md)
# invariant: Diagnostics reach the store by push or pull (src/modules/lsp/lsp.invariants.md)
set -uo pipefail
SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
export PATH="$HOME/.bun/bin:$PATH"
FAILS=0

if [ ! -d "$PROJECT_ROOT/node_modules/typescript" ]; then
  echo "SKIP  typescript not installed — diagnostics smoke skipped"; exit 0
fi

# Assert the red gutter mark + red underline for one server. Returns non-zero on failure.
# Args: <server-name> <executable-check-path>
run_case() {
  local SERVER_NAME="$1" SERVER_BIN="$2"
  if [ ! -x "$SERVER_BIN" ]; then
    echo "SKIP  $SERVER_NAME not installed ($SERVER_BIN) — case skipped"; return 0
  fi
  local SESSION="diagnostics-${SERVER_NAME}-$$"
  local FIX HOME2
  FIX="$(mktemp -d /tmp/tui-diag-smoke.XXXXXX)"; HOME2="$(mktemp -d /tmp/tui-diag-home.XXXXXX)"
  # shellcheck disable=SC2064
  trap "\"$HARNESS\" kill \"$SESSION\" >/dev/null 2>&1; rm -rf \"$FIX\" \"$HOME2\"" RETURN
  mkdir -p "$HOME2/.config/invar"
  printf '{"typescriptServer":"%s"}\n' "$SERVER_NAME" > "$HOME2/.config/invar/settings.json"
  ln -s "$PROJECT_ROOT/node_modules" "$FIX/node_modules"
  cat > "$FIX/tsconfig.json" <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true }, "include": ["*.ts"] }
JSON
  printf 'const okValue: number = 42;\nconst badValue: number = "not a number";\n' > "$FIX/e.ts"
  "$HARNESS" launch "$SESSION" 120x36 env HOME="$HOME2" COLORTERM=truecolor TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
  "$HARNESS" ready "$SESSION" 20 >/dev/null || { echo "  FAIL  [$SERVER_NAME] app not ready"; return 1; }
  # Open e.ts (second entry in the tree) so the server activates and diagnostics flow.
  "$HARNESS" send "$SESSION" Down >/dev/null; "$HARNESS" send "$SESSION" Enter >/dev/null; sleep 0.8
  local dc _k
  for _k in $(seq 1 25); do
    dc=$(python3 -c "import json;print(json.load(open('$PROJECT_ROOT/artifacts/status-$SESSION.json')).get('diagnosticsCount',0))" 2>/dev/null || echo 0)
    [ "$dc" -gt 0 ] 2>/dev/null && break; sleep 2
  done
  local result gutter underline
  result="$(FRAME="$PROJECT_ROOT/artifacts/frame-$SESSION.json" python3 - <<'PY'
import json, os
rows=json.load(open(os.environ['FRAME']))['rows']
red='247,118,142'  # palette.error (dark) — Tokyo Night red #f7768e
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
  local local_fails=0
  if [ "${gutter:-0}" -ge 1 ]; then echo "  PASS  [$SERVER_NAME] severity-coloured gutter mark on the error line ($gutter)"; else echo "  FAIL  [$SERVER_NAME] no red gutter mark on the error line (diagnosticsCount=$dc)"; local_fails=$((local_fails+1)); fi
  if [ "${underline:-0}" -ge 1 ]; then echo "  PASS  [$SERVER_NAME] coloured underline over the diagnostic range ($underline cells)"; else echo "  FAIL  [$SERVER_NAME] no red underline over the diagnostic range (diagnosticsCount=$dc)"; local_fails=$((local_fails+1)); fi

  # HOVER surfaces the diagnostic MESSAGE (not just `any`): dwell on badValue, poll for a bordered card
  # carrying the error text. This is the fix for "hover shows `any` instead of the tsgo error message".
  local badcol badrow
  read -r badcol badrow <<<"$(FRAME="$PROJECT_ROOT/artifacts/frame-$SESSION.json" python3 -c "
import json,os
rows=json.load(open(os.environ['FRAME']))['rows']
for i,r in enumerate(rows):
    t=r.get('text','')
    j=t.find('badValue')
    if j>=0 and 'const' in t: print(j,i); break
")"
  local hover_seen='no'
  if [ -n "${badcol:-}" ]; then
    local hpoll=$((SECONDS+25))
    while [ $SECONDS -lt $hpoll ]; do
      tmux send-keys -t "$SESSION" -l "$(printf '\033[<35;%d;%dM' "$((badcol+1))" "$((badrow+1))")"; sleep 0.5
      if FRAME="$PROJECT_ROOT/artifacts/frame-$SESSION.json" python3 -c "
import json,os,sys
rows=json.load(open(os.environ['FRAME']))['rows']
sys.exit(0 if any('│' in r.get('text','') and ('error:' in r.get('text','').lower() or 'not assignable' in r.get('text','')) for r in rows) else 1)
" 2>/dev/null; then hover_seen='yes'; break; fi
    done
  fi
  if [ "$hover_seen" = 'yes' ]; then echo "  PASS  [$SERVER_NAME] hover card surfaces the diagnostic message"; else echo "  FAIL  [$SERVER_NAME] hover over the error showed no diagnostic message"; local_fails=$((local_fails+1)); fi
  return "$local_fails"
}

# tsgo — the PULL path (default server). This is the case pull-diagnostics unlocks.
run_case "tsgo" "$PROJECT_ROOT/node_modules/.bin/tsgo" || FAILS=$((FAILS+$?))
# typescript-language-server — the PUSH path must keep working unchanged.
run_case "typescript-language-server" "$PROJECT_ROOT/node_modules/.bin/typescript-language-server" || FAILS=$((FAILS+$?))

echo "== RESULT: $([ "$FAILS" -eq 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$FAILS"
