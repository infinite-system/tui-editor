#!/usr/bin/env bash
# SETTINGS APPLIED-EFFECT gate (audit P3): every Settings field is DRIVEN through its real path and its
# OBSERVABLE effect asserted (status.json / FrameProbe) — the discipline the requirements doc prescribes
# and the existing Settings.test (ref-only) does NOT provide. This is why 8 dead settings shipped.
#
# Two parts:
#   1. Per-field applied-effect drives (below) — change the setting the way the panel does, assert the
#      real effect changed, ideally with a second value proving the direction.
#   2. A schema-enumeration META-GATE (--meta / run at the end): every key in Settings' schema MUST appear
#      in COVERED_SETTINGS, else FAIL — a NEW setting without an applied-effect drive breaks the gate.
#
# Usage: scripts/smoke-settings-applied.sh [--meta]
#   --meta : run ONLY the cheap schema-enumeration check (no app launches). conventions-gate calls this.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
H="$DIR/tui-harness.sh"
BUN="$HOME/.bun/bin/bun"
SETTINGS_HOME="$(mktemp -d /tmp/tui-sa-home.XXXXXX)"   # per-run isolated HOME — never the real ~/.config, never shared across concurrent runs
SET="$SETTINGS_HOME/.config/invar/settings.json"
mkdir -p "$(dirname "$SET")"
export PATH="$HOME/.bun/bin:$PATH"

# EVERY schema field must be listed here with a real drive below. Keep in sync with Settings' schema; the
# meta-gate enforces it. diffSplitRatio and markdownSplitRatio are driven by their real split-pane
# smokes: drag the divider, assert pane movement, then assert the persisted ratio is reused.
# typescriptServer's applied effect is WHICH language server starts — driven end-to-end in
# smoke-hover.sh (forced to tsgo), since this smoke deliberately never spawns a language server.
# lspFileSizeLimitKb is driven at the end of THIS file (the ONE drive here that spawns tsgo): a file
# over the limit is size-suppressed (LSP off), a file within it attaches (diagnostics arrive).
COVERED_SETTINGS="verticalFlingCeiling scrollAccelGain scrollFriction linesPerNotch horizontalScrollModifier fastScrollModifier fastScrollMultiplier scrollbarThickness glyphMode theme wordWrap showActivityBar workspaceTabPosition typescriptServer lspFileSizeLimitKb sidebarWidth gitSplitRatio diffSplitRatio markdownSplitRatio"

# ---- schema-enumeration META-GATE (cheap; the enforcing check) -------------------------------------
meta_gate() {
  local schema_keys covered missing=0
  # Schema keys = the fields of Settings.defaults (the authoritative SettingsValues shape).
  schema_keys="$(awk '/static get defaults/{f=1} f&&/:/{ if (match($0,/^[[:space:]]*([A-Za-z0-9_]+):/,m)) print m[1] } f&&/};/{exit}' "$ROOT/src/modules/settings/Settings.ts")"
  for key in $schema_keys; do
    case " $COVERED_SETTINGS " in
      *" $key "*) ;;
      *) echo "  META-FAIL: settings field '$key' has NO applied-effect drive in smoke-settings-applied.sh"; missing=1 ;;
    esac
  done
  if [ "$missing" -ne 0 ]; then
    echo "settings-applied META-GATE: FAIL — add a driving test for the field(s) above (isolated ref test is NOT enough)."
    return 1
  fi
  echo "settings-applied META-GATE: PASS (every schema field has an applied-effect drive)"
  return 0
}

if [ "${1:-}" = "--meta" ]; then
  meta_gate
  exit $?
fi

fail=0
set_setting() {
  python3 - "$SET" "$1" "$2" "$3" <<'PY'
import json
import os
import sys

settings_path, setting_name, value_kind, raw_value = sys.argv[1:]
with open(settings_path) as settings_file:
    settings = json.load(settings_file)
if value_kind == 'number':
    setting_value = json.loads(raw_value)
elif value_kind == 'boolean':
    setting_value = raw_value == 'true'
else:
    setting_value = raw_value
settings[setting_name] = setting_value
temporary_path = settings_path + '.temporary'
with open(temporary_path, 'w') as temporary_file:
    json.dump(settings, temporary_file, indent=2)
    temporary_file.write('\n')
os.replace(temporary_path, settings_path)
PY
}
printf '{}\n' > "$SET"
setk() { set_setting "$1" number "$2"; }
sets() { set_setting "$1" string "$2"; }
setb() { set_setting "$1" boolean "$2"; }
changed() { if [ "$1" != "$2" ]; then echo "  PASS  $3 ($1 != $2)"; else echo "  FAIL  $3 (unchanged: $1)"; fail=1; fi; }
open_file() { for _ in 1 2 3 4; do b="$("$H" field "$1" activeBuffer 2>/dev/null)"; [ -n "$b" ] && [ "$b" != "null" ] && return 0; "$H" send "$1" Enter >/dev/null; sleep 0.2; done; }
check() { if [ "$1" = "$2" ]; then echo "  PASS  $3"; else echo "  FAIL  $3 (got: $1 vs $2)"; fail=1; fi; }
check_gt() { if [ "${1:-0}" -gt "${2:-0}" ] 2>/dev/null; then echo "  PASS  $3 ($1 > $2)"; else echo "  FAIL  $3 ($1 not > $2)"; fail=1; fi; }

# Baseline the activity bar OFF for every drive below: mounted, it shifts sidebar+editor content right
# by 4 columns, which would move the scrollbar/glyph/gutter cells these drives read. Its OWN applied
# effect gets a dedicated drive at the end (and smoke-activitybar covers it in depth).
setb showActivityBar false

LONG=$(mktemp -d /tmp/tui-sa-long.XXXXXX); python3 -c "open('$LONG/long.txt','w').write(''.join('line %03d '%i + 'x'*180 + '\n' for i in range(300)))"
TREE=$(mktemp -d /tmp/tui-sa-tree.XXXXXX); for n in $(seq -w 1 60); do printf 'x\n' > "$TREE/file-$n.txt"; done
WRAP=$(mktemp -d /tmp/tui-sa-wrap.XXXXXX); python3 -c "open('$WRAP/w.txt','w').write('A'*300+chr(10)+'MARKERLINE'+chr(10))"
REPO=$(mktemp -d /tmp/tui-sa-repo.XXXXXX); ( cd "$REPO" && git init -q && printf 'a\n'>f.txt && git add f.txt && git commit -qm init && printf 'b\n'>>f.txt && printf 'n\n'>g.txt )
# TS fixture for the lspFileSizeLimitKb drive: a >1 KB .ts file with a deliberate type error, plus the
# node_modules symlink + tsconfig tsgo needs to resolve + type-check it. big.ts is tree index 1
# (node_modules dir sorts first), so ONE Down + Enter opens it — the smoke-diagnostics pattern.
LSPFIX=$(mktemp -d /tmp/tui-sa-lsp.XXXXXX)
ln -s "$ROOT/node_modules" "$LSPFIX/node_modules"
printf '{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "strict": true }, "include": ["*.ts"] }\n' > "$LSPFIX/tsconfig.json"
python3 -c "open('$LSPFIX/big.ts','w').write('// padding '+'x'*1500+'\n'+'const bad: number = \"nope\";\n')"
trap 'rm -rf "$LONG" "$TREE" "$WRAP" "$REPO" "$LSPFIX" "$SETTINGS_HOME"; for s in $SESSIONS; do "$H" kill "$s" >/dev/null 2>&1; done' EXIT INT TERM
SESSIONS=""

# scrollTop after ONE wheel-down over the editor of the long fixture, with the given settings patch fn.
scrolltop_after_notch() { # <session> <sgr-button>
  local session_name="$1" sgr_button="$2" measured_scroll_top
  "$H" launch "$session_name" 120x40 env HOME="$SETTINGS_HOME" bun run src/main.ts "$LONG" >/dev/null; "$H" ready "$session_name" 20 >/dev/null
  open_file "$session_name"
  tmux send-keys -t "$session_name" -l "$(printf '\033[<%d;60;12M' "$sgr_button")"; sleep 0.5; "$H" settle "$session_name" >/dev/null 2>&1
  measured_scroll_top="$("$H" field "$session_name" editorScrollTop)"
  "$H" kill "$session_name" >/dev/null 2>&1
  printf '%s\n' "$measured_scroll_top"
}
scrolltop_after_fling() { # <session> — many fast wheel-downs (a hard fling)
  local session_name="$1" measured_scroll_top
  "$H" launch "$session_name" 120x40 env HOME="$SETTINGS_HOME" bun run src/main.ts "$LONG" >/dev/null; "$H" ready "$session_name" 20 >/dev/null
  open_file "$session_name"
  for _ in $(seq 1 10); do tmux send-keys -t "$session_name" -l "$(printf '\033[<65;60;12M')"; sleep 0.03; done; sleep 1.2; "$H" settle "$session_name" >/dev/null 2>&1
  measured_scroll_top="$("$H" field "$session_name" editorScrollTop)"
  "$H" kill "$session_name" >/dev/null 2>&1
  printf '%s\n' "$measured_scroll_top"
}

echo "== linesPerNotch: bigger notch scrolls further =="
setk linesPerNotch 1; setb wordWrap false; sets fastScrollModifier none; a=$(scrolltop_after_notch sa$$-lpn-a 65)
setk linesPerNotch 8; b=$(scrolltop_after_notch sa$$-lpn-b 65)
check_gt "$b" "$a" "linesPerNotch 8 scrolls further than 1"

echo "== scrollAccelGain: higher gain scrolls further per notch =="
setk linesPerNotch 1; setk scrollAccelGain 5; a=$(scrolltop_after_notch sa$$-gain-a 65)
setk scrollAccelGain 120; b=$(scrolltop_after_notch sa$$-gain-b 65)
check_gt "$b" "$a" "scrollAccelGain 120 scrolls further than 5"
setk scrollAccelGain 34

echo "== verticalFlingCeiling: higher ceiling reaches further on a hard fling =="
setk verticalFlingCeiling 80; a=$(scrolltop_after_fling sa$$-fling-a)
setk verticalFlingCeiling 1500; b=$(scrolltop_after_fling sa$$-fling-b)
check_gt "$b" "$a" "verticalFlingCeiling 1500 flings further than 80"
setk verticalFlingCeiling 220

echo "== scrollFriction: more friction ends a fling sooner =="
setk scrollFriction 0.001; a=$(scrolltop_after_fling sa$$-fric-a)
setk scrollFriction 0.4; b=$(scrolltop_after_fling sa$$-fric-b)
changed "$a" "$b" "scrollFriction changes the glide distance"
setk scrollFriction 0.015

echo "== fastScrollModifier + fastScrollMultiplier: held modifier multiplies the step =="
setk linesPerNotch 1; sets horizontalScrollModifier ctrl; sets fastScrollModifier none; setk fastScrollMultiplier 6
a=$(scrolltop_after_notch sa$$-fast-a 73)   # alt-wheel, fast OFF -> base
sets fastScrollModifier alt; b=$(scrolltop_after_notch sa$$-fast-b 73)  # alt-wheel, fast ON x6
check_gt "$b" "$a" "fastScrollModifier alt + x6 multiplies the step"
sets fastScrollModifier none; sets horizontalScrollModifier alt

echo "== horizontalScrollModifier: configured modifier routes to horizontal =="
S=sa$$-hmod-a; sets horizontalScrollModifier alt; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" bun run src/main.ts "$LONG" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_file "$S"
for _ in 1 2 3; do tmux send-keys -t "$S" -l "$(printf '\033[<73;60;12M')"; sleep 0.12; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
hleft=$("$H" field "$S" editorScrollLeft)
S=sa$$-hmod-b; sets horizontalScrollModifier none; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" bun run src/main.ts "$LONG" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_file "$S"
for _ in 1 2 3; do tmux send-keys -t "$S" -l "$(printf '\033[<73;60;12M')"; sleep 0.12; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
nleft=$("$H" field "$S" editorScrollLeft)
check_gt "$hleft" "$nleft" "horizontalScrollModifier alt scrolls horizontally, none does not"
sets horizontalScrollModifier alt; setk linesPerNotch 1

echo "== wordWrap: ON wraps a long line (MARKER pushed down) =="
markerrow() { python3 -c "
import json
rows=json.load(open('$ROOT/artifacts/frame-$1.json'))['rows']
for y,r in enumerate(rows):
    if 'MARKER' in r.get('text',''): print(y); break
else: print(0)
"; }
setb wordWrap false; S=sa$$-ww-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$WRAP" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_file "$S"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; ma=$(markerrow "$S")
setb wordWrap true; S=sa$$-ww-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$WRAP" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_file "$S"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; mb=$(markerrow "$S")
check_gt "$mb" "$ma" "wordWrap ON pushes MARKER down (line wraps)"
setb wordWrap false

echo "== sidebarWidth: the sidebar occupies the set column count (divider position) =="
sidebar_divider_col() { python3 -c "
import json
rows=json.load(open('$ROOT/artifacts/frame-$1.json'))['rows']
# The sidebar's RIGHT border is the first vertical-border glyph past the left border (col>5),
# at column sidebarWidth-1 — theme-independent, unlike a bg-color probe.
for y in (3,5,7,10):
    t=rows[y].get('text','')
    for x in range(5,90):
        if x<len(t) and t[x]=='│': print(x); exit()
print(-1)
"; }
setk sidebarWidth 28; S=sa$$-sw-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; wa=$(sidebar_divider_col "$S")
setk sidebarWidth 44; S=sa$$-sw-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; wb=$(sidebar_divider_col "$S")
check_gt "$wb" "$wa" "sidebarWidth 44 puts the divider further right than 28"
setk sidebarWidth 32

echo "== scrollbarThickness: the tree bar occupies the set COLUMN count (painted, not the log value) =="
# Assert PAINTED columns, NOT the debug-log thickness value — the exact false-green that shipped the
# moves-not-thickens bug (a bar can log thickness=3 while painting 1 column).
paintedcols() { python3 -c "
import json
from collections import Counter
rows=json.load(open('$ROOT/artifacts/frame-$1.json'))['rows']
sidebar_bg='30,30,46,255'  # dark-theme sidebar interior
cols=Counter()
for y in range(2,34):
    bg=rows[y].get('bg',[])
    for x in range(24,32):
        c=bg[x] if x<len(bg) else ''
        if c and c not in ('0,0,0,255', sidebar_bg): cols[x]+=1
print(len([x for x,n in cols.items() if n>20]))
"; }
sets theme dark; setk scrollbarThickness 1; S=sa$$-sbt-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; for _ in $(seq 1 10); do tmux send-keys -t "$S" -l "$(printf '\033[<65;10;10M')"; sleep 0.05; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1; ta=$(paintedcols "$S")
setk scrollbarThickness 3; S=sa$$-sbt-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; for _ in $(seq 1 10); do tmux send-keys -t "$S" -l "$(printf '\033[<65;10;10M')"; sleep 0.05; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1; tb=$(paintedcols "$S")
check "$ta" "1" "scrollbarThickness 1 -> 1 painted column"; check "$tb" "3" "scrollbarThickness 3 -> 3 painted columns"
setk scrollbarThickness 1

echo "== theme: dark vs light change the framebuffer palette =="
statusbg() { python3 -c "import json;print(json.load(open('$ROOT/artifacts/frame-$1.json'))['rows'][-1].get('bg',[None]*11)[10])"; }
sets theme dark; S=sa$$-th-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; da=$(statusbg "$S")
sets theme light; S=sa$$-th-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; db=$(statusbg "$S")
if [ "$da" != "$db" ]; then echo "  PASS  theme changes the palette (dark $da != light $db)"; else echo "  FAIL  theme did not change the palette ($da == $db)"; fail=1; fi
sets theme dark

echo "== glyphMode: ascii vs nerd change rendered glyphs =="
firstglyph() { python3 -c "import json
rows=json.load(open('$ROOT/artifacts/frame-$1.json'))['rows']
text=next((row.get('text','') for row in rows if 'subfolder' in row.get('text','')), '')
print(repr(text[1:6]))"; }
mkdir -p "$TREE/subfolder"
sets glyphMode ascii; S=sa$$-gm-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; ga=$(firstglyph "$S")
sets glyphMode nerd; S=sa$$-gm-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; gb=$(firstglyph "$S")
if [ "$ga" != "$gb" ]; then echo "  PASS  glyphMode changes glyphs (ascii $ga != nerd $gb)"; else echo "  FAIL  glyphMode did not change glyphs ($ga == $gb)"; fail=1; fi
sets glyphMode auto

echo "== showActivityBar: mounts/unmounts the 4-col bar, shifting sidebar+editor content =="
# Applied-effect drive (schema-meta requires one): with the bar ON the whole sidebar (and its right
# divider) sits 4 columns further right than with it OFF — the bar reclaimed those columns. Reusing
# sidebar_divider_col makes the shift directly measurable from rendered cells.
setb showActivityBar true;  S=sa$$-ab-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; div_on=$(sidebar_divider_col "$S")
setb showActivityBar false; S=sa$$-ab-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$TREE" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; div_off=$(sidebar_divider_col "$S")
check "$((div_on - div_off))" "4" "showActivityBar ON shifts the sidebar divider right by the bar's 4 columns (on=$div_on off=$div_off)"
setb showActivityBar false

echo "== gitSplitRatio: the changes/log divider row moves =="
# Split observable = the COMMIT-LOG region's first commit row ('init'). A bigger changes region (higher
# gitSplitRatio) pushes the log — and its 'init' commit row — DOWN. Robust text search, glyph-independent.
gitdivrow() { python3 -c "
import json
rows=json.load(open('$ROOT/artifacts/frame-$1.json'))['rows']
for y,r in enumerate(rows):
    if 'init' in r.get('text',''): print(y); break
else: print(0)
"; }
open_git() { # open the git panel; retry until sidebarView==git (C-g can miss a beat)
  for _ in 1 2 3; do
    "$H" send "$1" C-g >/dev/null; sleep 0.4; "$H" settle "$1" >/dev/null 2>&1
    [ "$("$H" field "$1" sidebarView 2>/dev/null)" = "git" ] && return 0
  done
}
setk gitSplitRatio 0.3; S=sa$$-gs-a; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$REPO" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_git "$S"; "$H" settle "$S" >/dev/null 2>&1; ra=$(gitdivrow "$S")
setk gitSplitRatio 0.7; S=sa$$-gs-b; "$H" launch "$S" 120x40 env HOME="$SETTINGS_HOME" TUI_FRAME_DUMP=1 bun run src/main.ts "$REPO" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null; open_git "$S"; "$H" settle "$S" >/dev/null 2>&1; rb=$(gitdivrow "$S")
check_gt "$rb" "$ra" "gitSplitRatio 0.7 puts the divider lower than 0.3"
setk gitSplitRatio 0.5

echo "== lspFileSizeLimitKb: a file over the limit is NOT attached to the LSP; within it, it attaches =="
# The guard that exists BECAUSE an unguarded huge file ballooned tsgo and crashed the editor. Same file,
# two budgets: tiny limit -> size-suppressed (LSP off, no diagnostics, app alive); default budget ->
# attaches (diagnostics arrive). Reads lspSizeSuppressed + diagnosticsCount off the status channel.
lsp_drive() { # <session> <limit-kb> -> echoes "<lspSizeSuppressed> <diagnosticsCount>"
  local session_name="$1" limit_kb="$2" diagnostics_count size_suppressed poll
  setk lspFileSizeLimitKb "$limit_kb"; sets typescriptServer tsgo
  "$H" launch "$session_name" 120x36 env HOME="$SETTINGS_HOME" COLORTERM=truecolor bun run src/main.ts "$LSPFIX" >/dev/null
  SESSIONS="$SESSIONS $session_name"
  "$H" ready "$session_name" 20 >/dev/null
  "$H" send "$session_name" Down >/dev/null; "$H" send "$session_name" Enter >/dev/null; sleep 0.8
  for poll in $(seq 1 30); do
    diagnostics_count="$("$H" field "$session_name" diagnosticsCount 2>/dev/null || echo 0)"
    size_suppressed="$("$H" field "$session_name" lspSizeSuppressed 2>/dev/null)"
    { [ "${diagnostics_count:-0}" -gt 0 ] 2>/dev/null || [ "$size_suppressed" = "true" ]; } && break
    sleep 2
  done
  "$H" settle "$session_name" >/dev/null 2>&1
  diagnostics_count="$("$H" field "$session_name" diagnosticsCount 2>/dev/null || echo 0)"
  size_suppressed="$("$H" field "$session_name" lspSizeSuppressed 2>/dev/null)"
  "$H" kill "$session_name" >/dev/null 2>&1
  printf '%s %s\n' "${size_suppressed:-unknown}" "${diagnostics_count:-0}"
}
if [ ! -x "$ROOT/node_modules/.bin/tsgo" ]; then
  echo "  SKIP  tsgo not installed — lspFileSizeLimitKb applied-effect drive skipped"
else
  read -r sup_small dc_small <<<"$(lsp_drive sa$$-lsp-a 1)"
  read -r sup_big   dc_big   <<<"$(lsp_drive sa$$-lsp-b 2048)"
  check "$sup_small" "true" "lspFileSizeLimitKb 1 size-suppresses the LSP for the >1 KB file"
  check "$dc_small" "0" "no diagnostics arrive while the file is size-suppressed (LSP not attached)"
  check "$sup_big" "false" "the default budget attaches the LSP (file within the limit, not suppressed)"
  check_gt "$dc_big" "0" "diagnostics arrive once the file is within the budget (LSP attached)"
  setk lspFileSizeLimitKb 2048
fi

echo ""
meta_gate || fail=1
echo ""
if [ "$fail" = 0 ]; then echo "settings-applied: ALL-PASS"; else echo "settings-applied: FAILURES"; fi
exit "$fail"
