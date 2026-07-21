#!/usr/bin/env bash
# BEHAVIORAL CONTRACT SUITE — executable assertions for LOAD-BEARING felt invariants.
#
# The *.invariants.md files document invariants in PROSE; a prose contract that doesn't gate is just a
# description (the audit found DiffView had a full invariants.md while being DEAD). This suite pairs the
# load-bearing invariants with DRIVEN assertions (FrameProbe/tmux) that run at the merge gate — so a
# change that silently breaks an adjacent felt invariant FAILS instead of shipping.
#
# PRINCIPLES (see project.requirements.md "Invariant-contract system"):
#  - ASSERT ESSENCE, NOT EXPRESSION: assert refactor-proof behavior ("a fling glides then decays to
#    rest"), never an implementation detail ("the wheel calls addImpulse"). Impl-coupled asserts are a
#    smell — they gate the expression, not the invariant.
#  - LOAD-BEARING ONLY: gate what must be true for the subsystem to be itself; decorative behavior
#    (exact pixels/curves) stays ungated (a false invariant increases rigidity).
#  - RATCHET: every user-reported regression, once fixed, becomes a PERMANENT entry here BEFORE the fix
#    commits. The protected set only grows; the same break can't recur.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
H="$DIR/tui-harness.sh"
SET="$HOME/.config/fable/settings.json"
export PATH="$HOME/.bun/bin:$PATH"
fail=0
SESSIONS=""
pass() { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

# Neutral scroll settings so the assertions are deterministic (one row per notch, no fast modifier).
python3 -c "import json,os;p=os.path.expanduser('$SET');d=json.load(open(p)) if os.path.exists(p) else {};d.update({'linesPerNotch':1,'wordWrap':False,'fastScrollModifier':'none','horizontalScrollModifier':'alt'});json.dump(d,open(p,'w'),indent=2)"

LONG=$(mktemp -d /tmp/tui-bc-long.XXXXXX); python3 -c "open('$LONG/l.txt','w').write(''.join('line %04d content\n'%i for i in range(800)))"
TREE=$(mktemp -d /tmp/tui-bc-tree.XXXXXX); for n in $(seq -w 1 200); do printf 'x\n' > "$TREE/file-$n.txt"; done
trap 'rm -rf "$LONG" "$TREE"; for s in $SESSIONS; do "$H" kill "$s" >/dev/null 2>&1; done' EXIT

open_file() { for _ in 1 2 3 4; do b="$("$H" field "$1" activeBuffer 2>/dev/null)"; [ -n "$b" ] && [ "$b" != "null" ] && return 0; "$H" send "$1" Enter >/dev/null; sleep 0.2; done; }

# ---- CONTRACT: momentum glide (editor.invariants / ui.invariants: wheel fling glides then decays) ----
# ESSENCE: one wheel notch produces MORE travel than its immediate single-row step (the impulse feeds a
# momentum glide), and the motion then DECAYS TO REST (a later sample equals the settled value). The
# mirror of idle-quiescence. This is the exact invariant the "momentum gone" report was about; gating it
# means that regression can never recur silently. NOT asserted: the specific decel curve (decorative).
echo "== CONTRACT momentum-glide: a wheel notch glides past its step, then decays to rest =="

glide_pane() { # <label> <fixture> <status-field> <needs-open> <wheel-col>
  local label="$1" fixture="$2" fld="$3" needsopen="$4" wcol="$5"
  local S="bc-${label}-$$"
  "$H" launch "$S" 120x40 bun run src/main.ts "$fixture" >/dev/null; SESSIONS="$SESSIONS $S"; "$H" ready "$S" 20 >/dev/null
  [ "$needsopen" = "open" ] && open_file "$S"
  tmux send-keys -t "$S" -l "$(printf '\033[<65;%d;12M' "$wcol")"   # ONE wheel-down over the pane
  sleep 0.12; local early="$("$H" field "$S" "$fld")"
  sleep 1.4; "$H" settle "$S" >/dev/null 2>&1; local settled="$("$H" field "$S" "$fld")"
  sleep 0.6; local rest="$("$H" field "$S" "$fld")"
  "$H" kill "$S" >/dev/null 2>&1
  # glide: settled travel exceeds a single-row step (>1); continued past the wheel (settled >= early);
  # decayed to rest (rest == settled, no further drift).
  if [ "${settled:-0}" -gt 1 ] 2>/dev/null && [ "${settled:-0}" -ge "${early:-0}" ] 2>/dev/null && [ "${rest:-0}" = "${settled:-0}" ]; then
    pass "$label glide-then-decay (early=$early settled=$settled rest=$rest)"
  else
    bad "$label NO glide/decay (early=$early settled=$settled rest=$rest) — a pure step gives ~1 and no continuation"
  fi
}

glide_pane editor "$LONG" editorScrollTop open   60
glide_pane tree   "$TREE" treeScrollTop  noopen 10

# NOTE (documented, not yet a passing contract): WRAP-MODE vertical scroll is currently a DIRECT step
# (no momentum) by design — see the wrap-scroll rework (project.progress.md bug 2). When that lands with
# momentum over VISUAL rows, add a wrap-mode glide contract here (ratchet).

echo ""
if [ "$fail" = 0 ]; then echo "behavioral-contracts: ALL-PASS"; else echo "behavioral-contracts: FAILURES"; fi
exit "$fail"
