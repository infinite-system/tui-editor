#!/usr/bin/env bash
# Agent-pane UX smoke (tier S) — drives the full agent-pane experience through the REAL panel path:
#   • Scrollable/wrapping transcript on the SHARED ScrollableTextViewport engine (momentum glide, a
#     vertical scrollbar, tail-anchor, wrap/no-horizontal), collapsible tool calls, turn spacing.
#   • Multi-line composer (wraps, never overflows horizontally) framed by rules, with a permission mode
#     line and Shift+Tab to cycle it.
#   • Selectable + copyable transcript AND composer (Ctrl+C and Cmd+C land on the clipboard).
#   • Animated thinking indicator (rotating IBR words + shimmer + sparkle + elapsed) and a calm waiting
#     note (pending tool + elapsed) — all idle-quiescent.
# Backend: EchoAgentBackend with INVAR_AGENT_ECHO_DELAY_MS (env-gated driving path) emits a scripted
# tool-use + delayed completion so the busy state, spinner, and a collapsible tool row are observable.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-agent-ux-$$"
FIX="${1:-$ROOT/fixtures}"
DELAY_MS=2000
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -16; fail=1; fi; }
hasnt() { if "$H" capture "$S" | grep -qF "$2"; then echo "  FAIL  $1 ('$2' unexpectedly in pane)"; fail=1; else echo "  PASS  $1"; fi; }
# Screen row (0-based y) of the first captured line containing the pattern, or empty.
row_of() { local n; n="$("$H" capture "$S" | grep -nF "$1" | head -1 | cut -d: -f1)"; [ -n "$n" ] && echo $((n-1)); }

toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
submit() { "$H" send "$S" -l "$1" >/dev/null; sleep 0.15; "$H" send "$S" Enter >/dev/null; sleep 0.2; }
wait_idle() { local n=0; while [ "$(f agentBusy)" = "true" ] && [ "$n" -lt 40 ]; do sleep 0.2; n=$((n+1)); done; "$H" settle "$S" >/dev/null 2>&1; }
ctrl_c() { tmux send-keys -t "$S" -l "$(printf '\033[27;5;99~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
cmd_c()  { tmux send-keys -t "$S" -l "$(printf '\033[27;9;99~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
shift_tab() { tmux send-keys -t "$S" -l "$(printf '\033[Z')"; sleep 0.25; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== boot + open the agent pane =="
"$H" launch "$S" 110x34 env TUI_FRAME_DUMP=1 INVAR_AGENT_BACKEND=echo INVAR_AGENT_ECHO_DELAY_MS="$DELAY_MS" bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot"; else echo "  FAIL  boot"; "$H" capture "$S"; exit 1; fi
toggle_agent
chk "agent pane open + focused" "$(f terminalFocused)" "true"

echo "== framed composer chrome: rules, mode line, transcript padding =="
has "top+bottom horizontal rules frame the composer" "──────────"
has "permission mode line renders" "bypass permissions"
has "mode line hint renders" "(shift+tab to cycle)"
has "composer prompt glyph renders" "❯"
has "transcript text is padded (leading space before the hint)" " Ask Claude"

echo "== Shift+Tab cycles the permission mode live =="
mode0="$("$H" capture "$S" | grep -o 'bypass permissions o[nf]*' | head -1)"
shift_tab
mode1="$("$H" capture "$S" | grep -o 'bypass permissions o[nf]*' | head -1)"
if [ "$mode0" != "$mode1" ]; then echo "  PASS  Shift+Tab toggled the mode ($mode0 -> $mode1)"; else echo "  FAIL  Shift+Tab did not toggle ($mode0)"; fail=1; fi

echo "== (thinking) animated indicator + (waiting) pending-tool note while busy =="
submit "alpha-marker tell me something with enough words to wrap nicely"
sleep 0.5
chk "session is busy mid-turn" "$(f agentBusy)" "true"
# The primary line shows a rotating IBR word (any of the curated set) + an elapsed counter.
if "$H" capture "$S" | grep -qE 'Reducing|Distilling|Carving|Removing|Collapsing|Converging|Generating|Synthesizing|Triangulating|Grounding|Scoping|Testing|Refining|Isolating|Auditing|Breaking|Reframing|invariant|Crystallizing|Quantum|negative space|ineffable|limit'; then
  echo "  PASS  animated thinking word renders"; else echo "  FAIL  no thinking word"; "$H" capture "$S" | tail -14; fail=1; fi
has "elapsed-seconds counter renders" "0s"
has "waiting note shows the pending tool" "⧗ Bash"
wait_idle
chk "session returns to idle" "$(f agentBusy)" "false"
hasnt "waiting note is gone at idle" "⧗ Bash"

echo "== collapsible tool call: collapsed by default, click-to-expand (row located dynamically) =="
has "tool-use renders collapsed (caret + gear + name)" "▸ ⚙ Bash"
hasnt "pretty (indented) tool input hidden while collapsed" '  "command"'
chk "nothing expanded yet" "$(f agentExpandedCount)" "0"
tool_y="$(row_of '▸ ⚙ Bash')"
if [ -n "$tool_y" ]; then
  "$H" click "$S" 4 "$tool_y" >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
  chk "clicking the tool row expands one entry" "$(f agentExpandedCount)" "1"
  has "expanded tool-use shows the pretty (indented) input" '  "command"'
  tool_y2="$(row_of '▾ ⚙ Bash')"
  [ -n "$tool_y2" ] && { "$H" click "$S" 4 "$tool_y2" >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
  chk "clicking again collapses it" "$(f agentExpandedCount)" "0"
else echo "  FAIL  could not locate the tool-use row"; fail=1; fi

echo "== wrap: a long reply wraps (no horizontal scroll) =="
has "reply tail wrapped onto a later line" "phase 2)."

echo "== scroll + tail-anchor + momentum + vertical scrollbar =="
submit "beta-second-prompt"; wait_idle
submit "gamma-newest-prompt"; wait_idle
chk "view auto-sticks to the newest turn" "$(f agentStuckToBottom)" "true"
has "newest turn is visible at the tail" "gamma-newest-prompt"
hasnt "the FIRST turn scrolled above the fold" "alpha-marker"
has "vertical scrollbar thumb renders while overflowing" "█"
# Momentum: a few wheel-up notches over the transcript GLIDE up (poll the low point) then decay to rest.
wheel_y="$(row_of 'gamma-newest-prompt')"; [ -z "$wheel_y" ] && wheel_y=$(( $(f height) / 2 ))
maxtop="$(f agentScrollTop)"
"$H" scroll "$S" 6 "$wheel_y" up 4 >/dev/null
minobs="$maxtop"
for _ in $(seq 1 10); do st="$(f agentScrollTop)"; [ "${st:-0}" -lt "$minobs" ] && minobs="$st"; sleep 0.12; done
"$H" settle "$S" >/dev/null 2>&1
if [ "$minobs" -lt "$maxtop" ]; then echo "  PASS  momentum wheel-up glided the transcript up (scrollTop $maxtop -> min $minobs)"; else echo "  FAIL  wheel-up did not scroll ($maxtop -> $minobs)"; fail=1; fi
rest1="$(f agentScrollTop)"; sleep 0.4; rest2="$(f agentScrollTop)"
if [ "$rest1" = "$rest2" ]; then echo "  PASS  momentum glide settled to rest (stable at $rest2)"; else echo "  FAIL  glide did not settle ($rest1 -> $rest2)"; fail=1; fi
chk "scroll-up unsticks the tail anchor" "$(f agentStuckToBottom)" "false"
# PageUp scrolls toward the top; keep paging until the earliest turn appears (robust to the glide's
# settle position), bounded so a genuine failure still terminates.
found_alpha=0
for _ in $(seq 1 8); do
  "$H" send "$S" PPage >/dev/null; sleep 0.12; "$H" settle "$S" >/dev/null 2>&1
  if "$H" capture "$S" | grep -qF "alpha-marker"; then found_alpha=1; break; fi
done
if [ "$found_alpha" = 1 ]; then echo "  PASS  PageUp reveals the earliest turn"; else echo "  FAIL  PageUp never revealed alpha-marker"; "$H" capture "$S" | tail -14; fail=1; fi
# Scroll all the way back down re-arms tail-anchor.
"$H" scroll "$S" 6 "$wheel_y" down 80 >/dev/null; sleep 0.5; "$H" settle "$S" >/dev/null 2>&1
chk "scrolling back to the bottom re-sticks" "$(f agentStuckToBottom)" "true"

echo "== transcript selection + copy (Ctrl+C) =="
gy="$(row_of 'gamma-newest-prompt')"
if [ -n "$gy" ]; then
  "$H" drag "$S" 2 "$gy" 20 "$gy" >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
  ctrl_c
  cc="$(f lastCopyChars)"
  if [ "${cc:-0}" -ge 5 ]; then echo "  PASS  Ctrl+C copied the transcript selection ($cc chars)"; else echo "  FAIL  transcript copy ($cc)"; fail=1; fi
else echo "  FAIL  could not locate a transcript line to select"; fail=1; fi

echo "== composer selection + copy (Cmd+C / super) =="
"$H" send "$S" -l "COPYCOMPOSER text"; sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
cy="$(row_of 'COPYCOMPOSER')"
if [ -n "$cy" ]; then
  "$H" drag "$S" 2 "$cy" 13 "$cy" >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
  cmd_c
  cc2="$(f lastCopyChars)"
  if [ "${cc2:-0}" -ge 5 ]; then echo "  PASS  Cmd+C copied the composer selection ($cc2 chars)"; else echo "  FAIL  composer copy ($cc2)"; fail=1; fi
else echo "  FAIL  could not locate the composer line"; fail=1; fi

echo "== multi-line composer: a long input WRAPS (never overflows horizontally) =="
for _ in $(seq 1 30); do "$H" send "$S" BSpace >/dev/null; done; sleep 0.1
"$H" send "$S" -l "this is a deliberately long composer message that must wrap across multiple visual rows rather than running off the right edge under the neighbor pane at the end here"; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
# The composer prompt line and the wrapped TAIL land on different rows: assert both the head and the tail.
if "$H" capture "$S" | grep -q "❯ this is a deliberately" && "$H" capture "$S" | grep -q "at the end here"; then
  echo "  PASS  long composer input wrapped across rows (head + tail both visible)"; else echo "  FAIL  composer did not wrap"; "$H" capture "$S" | tail -10; fail=1; fi

echo "== idle quiescence (demand-driven; animation timer torn down at idle) =="
wait_idle; "$H" settle "$S" >/dev/null 2>&1
i0="$(f frame)"; sleep 4; i1="$(f frame)"; d=$(( i1 - i0 ))
if [ "$d" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s (frame $i0 -> $i1)"; else echo "  FAIL  idle loop ticking: +$d over 4s"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
