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
  # Focus the pane first — a wheel over an unfocused editor can be swallowed before the glide starts.
  tmux send-keys -t "$S" -l "$(printf '\033[<0;%d;12M' "$wcol")"; tmux send-keys -t "$S" -l "$(printf '\033[<0;%d;12m' "$wcol")"; sleep 0.2
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

# ---- CONTRACT: wrap-mode momentum + visual-row extent (RATCHET: the "momentum gone in wrap" report) ----
# Wrap mode feeds the SAME momentum engine in VISUAL-ROW units, so it glides like non-wrap AND reaches
# the true last visual row (extent = wrapped visual rows, not logical lines). Both were user-felt gaps.
echo "== CONTRACT wrap-scroll: wrap-mode wheel glides-then-decays + reaches the true last visual row =="
WRAP=$(mktemp -d /tmp/tui-bc-wrap.XXXXXX); python3 -c "open('$WRAP/w.txt','w').write(''.join('L%03d '%i + 'word '*40 + '\n' for i in range(200)))"
python3 -c "import json,os;p=os.path.expanduser('$SET');d=json.load(open(p));d['wordWrap']=True;json.dump(d,open(p,'w'),indent=2)"
S="bc-wrap-$$"; SESSIONS="$SESSIONS $S"
"$H" launch "$S" 120x40 bun run src/main.ts "$WRAP" >/dev/null; "$H" ready "$S" 20 >/dev/null
open_file "$S"
tmux send-keys -t "$S" -l "$(printf '\033[<0;60;12M')"; tmux send-keys -t "$S" -l "$(printf '\033[<0;60;12m')"; sleep 0.2  # focus
tmux send-keys -t "$S" -l "$(printf '\033[<65;60;12M')"   # ONE wheel-down
sleep 0.12; wearly="$("$H" field "$S" editorScrollTop)"
sleep 1.4; "$H" settle "$S" >/dev/null 2>&1; wsettled="$("$H" field "$S" editorScrollTop)"
sleep 0.6; wrest="$("$H" field "$S" editorScrollTop)"
if [ "${wsettled:-0}" -gt 1 ] 2>/dev/null && [ "${wsettled:-0}" -ge "${wearly:-0}" ] 2>/dev/null && [ "${wrest:-0}" = "${wsettled:-0}" ]; then
  pass "wrap-mode glide-then-decay (early=$wearly settled=$wsettled rest=$wrest)"
else
  bad "wrap-mode NO glide/decay (early=$wearly settled=$wsettled rest=$wrest)"
fi
# Extent: PageDown to the end reaches a visual-row scrollTop that EXCEEDS the 200 logical lines (a
# logical-line extent would cap near lineCount-height ~162; visual rows go much further).
for _ in $(seq 1 25); do "$H" send "$S" PageDown >/dev/null 2>&1; done; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
wbottom="$("$H" field "$S" editorScrollTop)"
if [ "${wbottom:-0}" -gt 200 ] 2>/dev/null; then
  pass "wrap-mode reaches true last visual row (scrollTop=$wbottom > 200 logical lines)"
else
  bad "wrap-mode capped at logical lines (scrollTop=$wbottom, expected > 200 visual rows)"
fi
python3 -c "import json,os;p=os.path.expanduser('$SET');d=json.load(open(p));d['wordWrap']=False;json.dump(d,open(p,'w'),indent=2)"
"$H" kill "$S" >/dev/null 2>&1; rm -rf "$WRAP"

# ---- CONTRACT: idle quiescence (the MIRROR of momentum-glide — motion STOPS at rest) ----
# Rendering is demand-driven: over a fully-untouched window the FRAME COUNTER must not advance at all
# (authoritative signal — CPU stays low even while an empty loop ticks, the false-green a pre-fix build
# shipped). Paired with momentum-glide, these two bound the feel: motion continues when pushed, and the
# loop halts when left alone.
echo "== CONTRACT idle-quiescence: at rest the render loop STOPS (frame delta == 0) =="
S="bc-idle-$$"; SESSIONS="$SESSIONS $S"
"$H" launch "$S" 120x40 bun run src/main.ts "$TREE" >/dev/null; "$H" ready "$S" 20 >/dev/null
"$H" send "$S" Escape >/dev/null; "$H" settle "$S" >/dev/null 2>&1; sleep 1
istart="$("$H" field "$S" frame)"; sleep 3; iend="$("$H" field "$S" frame)"
if [ "$(( ${iend:-0} - ${istart:-0} ))" -eq 0 ]; then
  pass "idle frame delta == 0 over 3s untouched (frame stayed $istart)"
else
  bad "idle loop still ticking ($istart -> $iend) — rendering is NOT demand-driven"
fi
"$H" kill "$S" >/dev/null 2>&1

echo ""
if [ "$fail" = 0 ]; then echo "behavioral-contracts: ALL-PASS"; else echo "behavioral-contracts: FAILURES"; fi
exit "$fail"
