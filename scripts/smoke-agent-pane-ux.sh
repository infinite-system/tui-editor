#!/usr/bin/env bash
# Agent-pane UX smoke (tier S) — drives the three UX upgrades through the REAL panel path:
#   1) SCROLLABLE, WRAPPING transcript — many turns overflow the pane; it tail-anchors to newest, PageUp
#      unsticks + reveals earlier history, and long replies WRAP (never scroll horizontally).
#   2) COLLAPSIBLE tool calls — a tool-use/tool-result renders as a ONE-LINE summary by default; a click
#      on the row EXPANDS it to the pretty-printed input/output (asserted via agentExpandedCount).
#   3) THINKING SPINNER — while the session is busy an animated glyph + label renders above the composer,
#      and it is GONE at idle.
# Backend: EchoAgentBackend with INVAR_AGENT_ECHO_DELAY_MS set — the env-gated driving path emits a
# scripted tool-use (holds a busy window so the spinner is observable) and finishes after the delay with a
# multi-line tool-result to collapse/expand. No real Claude, no network. Mirrors scripts/smoke-agent.sh.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-agent-ux-$$"
FIX="${1:-$ROOT/fixtures}"
DELAY_MS=1500
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -16; fail=1; fi; }
hasnt() { if "$H" capture "$S" | grep -qF "$2"; then echo "  FAIL  $1 ('$2' unexpectedly in pane)"; fail=1; else echo "  PASS  $1"; fi; }

# Ctrl+Shift+A in modifyOtherKeys form (97 = 'a') — the panel.toggleAgent chord.
toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
# Type a prompt and submit it; DOES NOT wait for the turn to finish (so a spinner is observable).
submit() { "$H" send "$S" -l "$1" >/dev/null; sleep 0.15; "$H" send "$S" Enter >/dev/null; sleep 0.2; }
# Wait for the in-flight turn to settle back to idle.
wait_idle() { local n=0; while [ "$(f agentBusy)" = "true" ] && [ "$n" -lt 40 ]; do sleep 0.2; n=$((n+1)); done; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== boot with the delayed echo backend (spinner + scripted tool observable) =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 INVAR_AGENT_BACKEND=echo INVAR_AGENT_ECHO_DELAY_MS="$DELAY_MS" bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1; fi
toggle_agent
chk "agent pane open + focused" "$(f terminalFocused)" "true"
chk "active pane content is the agent" "$(f panelActiveContent)" "agent"

echo "== (3) THINKING SPINNER shows while busy, then disappears at idle =="
submit "alpha-scroll-marker"
# The turn holds a busy state for ~DELAY_MS (scripted tool-use → awaiting-tool); sample it mid-flight.
sleep 0.4
chk "session is busy mid-turn" "$(f agentBusy)" "true"
has "spinner label renders above the composer while busy" "Running"
wait_idle
chk "session returns to idle after the turn" "$(f agentBusy)" "false"
hasnt "spinner is gone at idle" "Running"

echo "== (2) COLLAPSIBLE tool calls: collapsed by default, expand on click =="
has "tool-use renders as a one-line collapsed summary (caret + gear + name)" "▸ ⚙ Bash"
has "tool-result renders collapsed (caret + check)" "▸ ✓ result"
hasnt "pretty (indented) tool input is hidden while collapsed" '  "command"'
chk "nothing expanded yet" "$(f agentExpandedCount)" "0"
# Click the tool-use summary row. At idle (no spinner) the rows above the composer are, bottom-up:
# composer (screen y = height-3), tool-result (height-4), tool-use (height-5).
screen_h="$(f height)"
tooluse_y=$(( screen_h - 5 ))
"$H" click "$S" 4 "$tooluse_y" >/dev/null
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "clicking the tool row expands exactly one entry" "$(f agentExpandedCount)" "1"
has "expanded tool-use shows the expanded caret" "▾ ⚙ Bash"
has "expanded tool-use shows the pretty (indented) input" '  "command"'
# Click it again to collapse (toggle round-trip).
"$H" click "$S" 4 "$tooluse_y" >/dev/null
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "clicking again collapses it" "$(f agentExpandedCount)" "0"

echo "== long replies WRAP (no horizontal scroll) — the reply spans multiple lines =="
has "reply head is visible" "You said"
# The reply is longer than the pane width; it WRAPS, so its tail sits at the START of a later line
# (a horizontal-scroll pane would instead clip it off-screen). "phase 2)." only appears once wrapped.
has "reply tail wrapped onto a later line" "phase 2)."

echo "== (1) SCROLL + tail-anchor: build history, then PageUp reveals earlier turns =="
submit "beta-second-prompt"; wait_idle
submit "gamma-newest-prompt"; wait_idle
chk "view auto-sticks to the newest turn" "$(f agentStuckToBottom)" "true"
has "newest turn is visible at the tail" "gamma-newest-prompt"
hasnt "the FIRST turn has scrolled above the fold" "alpha-scroll-marker"
# PageUp scrolls the transcript up (pane focused, composer empty).
"$H" send "$S" PPage >/dev/null; sleep 0.15
"$H" send "$S" PPage >/dev/null; sleep 0.15
"$H" send "$S" PPage >/dev/null; sleep 0.2; "$H" settle "$S" >/dev/null 2>&1
chk "PageUp unsticks the tail anchor" "$(f agentStuckToBottom)" "false"
has "PageUp revealed the earliest turn" "alpha-scroll-marker"

echo "== wheel scroll works too, and reaching the bottom re-sticks =="
compose_y=$(( screen_h - 3 ))
"$H" scroll "$S" 20 "$compose_y" down 40 >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "scrolling back to the bottom re-arms auto-stick" "$(f agentStuckToBottom)" "true"
has "newest turn is visible again after re-sticking" "gamma-newest-prompt"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
