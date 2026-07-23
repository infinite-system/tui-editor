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
# tui-harness.sh launches every app with this worktree-local HOME. Write the contract settings to
# that SAME isolated path; writing the caller's real $HOME makes the drive depend on stale harness
# state and can silently run the wrap contract with wordWrap=false.
SET="$ROOT/artifacts/home/.config/invar/settings.json"
export PATH="$HOME/.bun/bin:$PATH"
fail=0
SESSIONS=""
pass() { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

# Neutral scroll settings so the assertions are deterministic (one row per notch, no fast modifier).
mkdir -p "$(dirname "$SET")"
python3 -c "import json,os;p=os.path.expanduser('$SET');d=json.load(open(p)) if os.path.exists(p) else {};d.update({'linesPerNotch':1,'wordWrap':False,'fastScrollModifier':'none','horizontalScrollModifier':'alt'});json.dump(d,open(p,'w'),indent=2)"

LONG=$(mktemp -d /tmp/tui-bc-long.XXXXXX); python3 -c "open('$LONG/l.txt','w').write(''.join('line %04d content\n'%i for i in range(800)))"
TREE=$(mktemp -d /tmp/tui-bc-tree.XXXXXX); for n in $(seq -w 1 200); do printf 'x\n' > "$TREE/file-$n.txt"; done
trap 'rm -rf "$LONG" "$TREE"; for s in $SESSIONS; do "$H" kill "$s" >/dev/null 2>&1; done' EXIT INT TERM

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
# Idle is demand-driven, NOT a busy loop. The status-bar minute-clock is the one legitimate periodic
# wake — it repaints EXACTLY once per minute at the boundary — so a few-second window sees 0 frames
# between ticks, at most 1 if a minute boundary falls inside it. A busy loop would be ~90 (30fps×3s):
# the ≤1 bound cleanly separates the two.
echo "== CONTRACT idle-quiescence: at rest the render loop STOPS (frame delta <= 1: clock only) =="
S="bc-idle-$$"; SESSIONS="$SESSIONS $S"
"$H" launch "$S" 120x40 bun run src/main.ts "$TREE" >/dev/null; "$H" ready "$S" 20 >/dev/null
"$H" send "$S" Escape >/dev/null; "$H" settle "$S" >/dev/null 2>&1; sleep 1
istart="$("$H" field "$S" frame)"; sleep 3; iend="$("$H" field "$S" frame)"
if [ "$(( ${iend:-0} - ${istart:-0} ))" -le 1 ]; then
  pass "idle frame delta <= 1 over 3s untouched (frame $istart -> $iend; clock tick at most)"
else
  bad "idle loop still ticking ($istart -> $iend) — rendering is NOT demand-driven"
fi
"$H" kill "$S" >/dev/null 2>&1

# ---- CONTRACT: open a file → scroll reaches the true LAST line AND back to the true FIRST line ----
# THE REAL USER PATH, both directions (user requirement, RATCHET for the focus-on-open/cursor-pin bug):
# open a MODERATE file (a few screenfuls), then FROM THE POST-OPEN STATE — no injected focus click, no
# driving scrollTop directly — scroll via the REAL input. Down (wheel + PageDown) must reach + render the
# TRUE LAST line; Up (wheel + PageUp) must return + render the TRUE FIRST line. Catches THREE bug classes:
# focus-on-open (wheel does nothing after open), a cursor-reveal that re-pins the viewport to the cursor
# (the $watchEffect-over-tracking bug), and wrong max-scroll extent (can't reach an end).
echo "== CONTRACT open-then-scroll: reaches the true last line AND returns to the true first line =="
S="bc-scroll-$$"; SESSIONS="$SESSIONS $S"
SDIR=$(mktemp -d /tmp/tui-bc-scroll.XXXXXX)
# ~110 lines ≈ 3 screenfuls at a 40-row terminal (viewport ~36) — enough to traverse start↔end fast.
python3 -c "open('$SDIR/doc.txt','w').write(''.join('LINE-%03d body\n'%i for i in range(110)))"
python3 -c "import json,os;p=os.path.expanduser('$SET');d=json.load(open(p));d['wordWrap']=False;json.dump(d,open(p,'w'),indent=2)"
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$SDIR" >/dev/null; "$H" ready "$S" 20 >/dev/null
open_file "$S"   # open via the tree (Enter) — DO NOT click into the editor (that would mask focus-on-open)
# 1) From the post-open state, a WHEEL alone must MOVE the viewport (focus-on-open / cursor-pin regression).
for _ in 1 2 3 4 5 6; do tmux send-keys -t "$S" -l "$(printf '\033[<65;60;12M')"; sleep 0.12; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
wheel_moved="$("$H" field "$S" editorScrollTop)"
if [ "${wheel_moved:-0}" -gt 0 ] 2>/dev/null; then pass "wheel scrolls right after open, no click (scrollTop=$wheel_moved)"; else bad "wheel does NOT scroll after open (scrollTop=$wheel_moved) — focus-on-open/cursor-pin regression"; fi
# 2) Continue to the TRUE END via keyboard; assert the LAST line renders near the bottom of the editor.
for _ in $(seq 1 12); do "$H" send "$S" PageDown >/dev/null 2>&1; done; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
"$H" send "$S" PageDown >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
last_ok=$(python3 -c "
import json
rows=json.load(open('$ROOT/artifacts/frame-$S.json'))['rows']
print('yes' if any('LINE-109' in r.get('text','') for r in rows) else 'no')
")
if [ "$last_ok" = "yes" ]; then pass "scrolling DOWN reaches + renders the TRUE last line (LINE-109)"; else bad "cannot reach the true last line (LINE-109 not rendered at the bottom)"; fi
# 3) Scroll back UP via wheel + keyboard to the TRUE START; assert the FIRST line renders + scrollTop 0.
for _ in $(seq 1 6); do tmux send-keys -t "$S" -l "$(printf '\033[<64;60;12M')"; sleep 0.1; done
for _ in $(seq 1 12); do "$H" send "$S" PageUp >/dev/null 2>&1; done; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
top="$("$H" field "$S" editorScrollTop)"
first_ok=$(python3 -c "
import json
rows=json.load(open('$ROOT/artifacts/frame-$S.json'))['rows']
print('yes' if any('LINE-000' in r.get('text','') for r in rows) else 'no')
")
if [ "$first_ok" = "yes" ] && [ "${top:-9}" = "0" ]; then pass "scrolling UP returns to + renders the TRUE first line (LINE-000, scrollTop 0)"; else bad "cannot return to the true first line (LINE-000 rendered=$first_ok, scrollTop=$top)"; fi
"$H" kill "$S" >/dev/null 2>&1; rm -rf "$SDIR"

# ---- CONTRACT: focus-in recovers the terminal session (RATCHET: the VS Code tab-defocus freeze) ----
# A VS Code terminal tab reset the terminal session state (termios raw / mouse / focus / stale frame)
# on tab-hide; the app must re-enter the FULL setup on focus-in and EMIT A FRESH FRAME. Since a focus
# report (\e[I) is NOT a keypress (OpenTUI consumes it), the ONLY thing that can advance the idle,
# demand-driven frame counter after \e[I is the focus handler forcing a repaint — so a frame advance
# is the clean observable proof the recovery ran. The app must also stay RESPONSIVE afterward (wheel
# still scrolls). The real termios/mouse mode-loss can't be faked over tmux (only a real terminal
# resets it) — that half is gated by the terminal-session unit test + confirmed on the user's terminal.
echo "== CONTRACT focus-recovery: focus-out→focus-in emits a fresh frame + keeps the app responsive =="
S="bc-focus-$$"; SESSIONS="$SESSIONS $S"
FDIR=$(mktemp -d /tmp/tui-bc-focus.XXXXXX)
python3 -c "open('$FDIR/doc.txt','w').write(''.join('FLINE-%03d body\n'%i for i in range(200)))"
"$H" launch "$S" 120x40 bun run src/main.ts "$FDIR" >/dev/null; "$H" ready "$S" 20 >/dev/null
open_file "$S"
"$H" send "$S" Escape >/dev/null; "$H" settle "$S" >/dev/null 2>&1; sleep 1
f_before="$("$H" field "$S" frame)"
# Retry the focus cycle a few times: the repaint is real but timing-sensitive, and under heavy
# concurrent load a single settle window can miss it. A genuine freeze regression fails ALL attempts.
f_after="$f_before"
for _focus_attempt in 1 2 3; do
  "$H" focus "$S" out; "$H" focus "$S" in
  "$H" settle "$S" 10 >/dev/null 2>&1; sleep 0.3
  f_after="$("$H" field "$S" frame)"
  [ "$(( ${f_after:-0} - ${f_before:-0} ))" -gt 0 ] && break
  sleep 0.5
done
if [ "$(( ${f_after:-0} - ${f_before:-0} ))" -gt 0 ]; then
  pass "focus-in emits a fresh frame (recovery ran: $f_before -> $f_after)"
else
  bad "focus-in did NOT repaint ($f_before -> $f_after) — stale-screen/freeze regression"
fi
# Responsive after the focus cycle: a wheel notch still moves the viewport (suspend/resume didn't wedge input).
scroll_before="$("$H" field "$S" editorScrollTop)"
scroll_after="$scroll_before"
for _wheel_attempt in 1 2 3; do
  for _ in 1 2 3 4 5 6; do tmux send-keys -t "$S" -l "$(printf '\033[<65;60;12M')"; sleep 0.1; done; sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
  scroll_after="$("$H" field "$S" editorScrollTop)"
  [ "${scroll_after:-0}" -gt "${scroll_before:-0}" ] 2>/dev/null && break
  sleep 0.5
done
if [ "${scroll_after:-0}" -gt "${scroll_before:-0}" ] 2>/dev/null; then
  pass "app stays responsive after focus recovery (wheel scrolled $scroll_before -> $scroll_after)"
else
  bad "app DEAD after focus recovery (scrollTop $scroll_before -> $scroll_after) — suspend/resume wedged input"
fi
"$H" kill "$S" >/dev/null 2>&1; rm -rf "$FDIR"

# ---- CONTRACT: pane independence — a diff open/close never corrupts the editor pane (RATCHET) ----
# ESSENCE (project.invariants "A pane is a self-contained scrollable viewport"): opening a SIBLING pane
# (the side-by-side diff, mounted by swapping editorArea↔diffContainer in editorColumn) must NOT alter
# the editor pane's scroll extent. This is the fae9349 regression (shared-container swap corrupted the
# editor's height so it could not reach its true last line — reverted d01873f, previously UNGATED). The
# drive: reach the editor's TRUE last line → open a change diff → close it → the editor still reaches
# the SAME true last line at the SAME max-scroll. If the swap corrupts the editor pane, the after-scroll
# falls short.
echo "== CONTRACT pane-independence: open+close a diff, the editor pane still reaches its true last line =="
PDIR=$(mktemp -d /tmp/tui-bc-pane.XXXXXX)
S="bc-pane-$$"; SESSIONS="$SESSIONS $S"
python3 -c "open('$PDIR/doc.txt','w').write(''.join('PLINE-%03d body\n'%i for i in range(120)))"
# A committed file, then modify an EARLY line so it is a git change while the TRUE last line stays PLINE-119.
( cd "$PDIR" && env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_OBJECT_DIRECTORY sh -c \
  'git init -q && git add -A && git -c user.email=a@b.c -c user.name=x commit -qm init' )
python3 -c "p='$PDIR/doc.txt';L=open(p).read().splitlines();L[5]='PLINE-005 CHANGED';open(p,'w').write('\n'.join(L)+'\n')"
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$PDIR" >/dev/null; "$H" ready "$S" 20 >/dev/null
PFRAME="$ROOT/artifacts/frame-$S.json"
pane_last(){ python3 -c "import json;rows=json.load(open('$PFRAME'))['rows'];print('yes' if any('PLINE-119' in r.get('text','') for r in rows) else 'no')"; }
# open doc.txt (row 0 is .git; Down selects doc.txt), focus the editor, reach the true last line
for _ in 1 2 3 4; do b="$("$H" field "$S" activeBuffer)"; [ -n "$b" ] && [ "$b" != null ] && break; "$H" send "$S" Down >/dev/null; sleep 0.15; "$H" send "$S" Enter >/dev/null; sleep 0.3; done
"$H" send "$S" Right >/dev/null
for _ in $(seq 1 15); do "$H" send "$S" PageDown >/dev/null 2>&1; done; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
pane_before_top="$("$H" field "$S" editorScrollTop)"; pane_before_last="$(pane_last)"
# open the change diff (Ctrl+G → git panel; 'o' opens the selected change's diff), then close it
"$H" send "$S" C-g >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
"$H" send "$S" o >/dev/null; sleep 0.6; "$H" settle "$S" >/dev/null 2>&1
pane_diff_open="$("$H" field "$S" showingDiff)"
"$H" send "$S" Escape >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
# back in the editor, reach the true last line AGAIN
"$H" send "$S" Right >/dev/null
for _ in $(seq 1 15); do "$H" send "$S" PageDown >/dev/null 2>&1; done; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
pane_after_top="$("$H" field "$S" editorScrollTop)"; pane_after_last="$(pane_last)"
"$H" kill "$S" >/dev/null 2>&1; rm -rf "$PDIR"
if [ "$pane_diff_open" = true ] && [ "$pane_before_last" = yes ] && [ "$pane_after_last" = yes ] \
   && [ "${pane_after_top:-0}" = "${pane_before_top:-1}" ]; then
  pass "editor reaches its true last line + same extent after a diff open/close (top=$pane_before_top, PLINE-119 rendered)"
else
  bad "diff swap corrupted the editor pane (diffOpened=$pane_diff_open before: top=$pane_before_top last=$pane_before_last after: top=$pane_after_top last=$pane_after_last)"
fi

echo ""
if [ "$fail" = 0 ]; then echo "behavioral-contracts: ALL-PASS"; else echo "behavioral-contracts: FAILURES"; fi
exit "$fail"
