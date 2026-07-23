#!/usr/bin/env bash
# Native agent-harness smoke (tier S). Two layers, mirroring smoke-terminal.sh:
#   A) deterministic MockAgentBackend + AgentSession assertions via `bun test` (no subprocess — scripted
#      events in, asserted transcript out) so the gate is hermetic and non-flaky.
#   B) ONE real drive: toggle the agent pane (Ctrl+Shift+A), type a prompt, press Enter, and assert the
#      EchoAgentBackend's structured reply RENDERS in the panel cells — proving the whole projection
#      pipeline (send → events → transcript → pane) end-to-end through the normal panel path.
# Usage: scripts/smoke-agent.sh [fixture-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-agent-$$"
BUN="$HOME/.bun/bin/bun"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -14; fail=1; fi; }

# Ctrl+Shift+A in modifyOtherKeys form (97 = 'a') — the panel.toggleAgent chord.
toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== A) deterministic MockAgentBackend + AgentSession (no subprocess) =="
if "$BUN" test src/modules/agent/ >/tmp/agent-unit-$$.log 2>&1; then
  echo "  PASS  agent-core unit tests (scripted events -> transcript, coalescing, tool pairing, status)"
else
  echo "  FAIL  agent-core unit tests"; tail -25 /tmp/agent-unit-$$.log; fail=1
fi
rm -f /tmp/agent-unit-$$.log

echo "== B) launch + boot =="
"$H" launch "$S" 120x40 env TUI_FRAME_DUMP=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot: ready+quiescent"; else
  echo "  FAIL  boot never ready"; "$H" capture "$S"; exit 1
fi
chk "agent pane hidden at boot" "$(f terminalVisible)" "false"

echo "== click the status-bar AGENT glyph opens the pane (the chord-free path) =="
# Cluster pinned to the right edge, 3 cells each: [ agent ][ terminal ][ gear ][ ? ]. The terminal
# button's middle cell is width-8 (per smoke-terminal); the agent button sits one button (3 cells) left.
sb_width="$(f width)"; sb_height="$(f height)"
agent_btn_x=$(( sb_width - 11 )); status_row=$(( sb_height - 1 ))
"$H" click "$S" "$agent_btn_x" "$status_row" >/dev/null
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "clicking the agent glyph OPENS the pane" "$(f terminalVisible)" "true"
chk "active pane content is the agent (via button)" "$(f panelActiveContent)" "agent"
"$H" click "$S" "$agent_btn_x" "$status_row" >/dev/null
sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "clicking the agent glyph again HIDES the pane" "$(f terminalVisible)" "false"

echo "== toggle the agent pane (Ctrl+Shift+A) opens it in the bottom slot, focused =="
toggle_agent
chk "panel visible after toggle" "$(f terminalVisible)" "true"
chk "panel focused after toggle" "$(f terminalFocused)" "true"
chk "active pane content is the agent" "$(f panelActiveContent)" "agent"
case "$(f panelContentIds)" in *agent*) echo "  PASS  agent registered in the panel switcher order";; *) echo "  FAIL  agent not in panelContentIds ($(f panelContentIds))"; fail=1;; esac
has "empty-state hint renders before any prompt" "Ask Claude"
has "composer prompt glyph renders" "❯"

echo "== type a prompt + Enter: the structured echo reply renders in the pane (round-trip) =="
"$H" send "$S" -l "ping the harness" >/dev/null
sleep 0.15; "$H" settle "$S" >/dev/null 2>&1
has "composer echoes the typed text" "ping the harness"
"$H" send "$S" Enter >/dev/null
sleep 0.4; "$H" settle "$S" >/dev/null 2>&1
has "the user turn is in the transcript" "You"
has "the assistant reply streamed into the transcript" "You said"
has "the reply quoted the exact prompt" "ping the harness"

echo "== idle quiescence with the agent pane open (demand-driven; frame delta <= 1) =="
"$H" settle "$S" >/dev/null 2>&1
idle_start="$(f frame)"; sleep 4; idle_end="$(f frame)"
idle_delta=$(( idle_end - idle_start ))
if [ "$idle_delta" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s with agent open (frame $idle_start -> $idle_end)"; else
  echo "  FAIL  idle loop ticking with agent open: +$idle_delta over 4s"; fail=1; fi

echo "== toggle again hides the slot (VS Code panel parity) =="
toggle_agent
chk "panel hidden after second toggle" "$(f terminalVisible)" "false"

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
