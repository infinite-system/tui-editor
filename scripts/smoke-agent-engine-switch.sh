#!/usr/bin/env bash
# Engine-switch smoke (tier S) — drives the live provider switcher through the REAL panel path,
# hermetically: INVAR_AGENT_BACKEND=echo forces the local echo backend and INVAR_AGENT_ENGINES=claude,codex
# forces both engines "available" so the switcher is cyclable without a real claude/codex subprocess.
# Asserts: the mode line shows the current engine + a ⇄ affordance; Ctrl+E AND a click on the segment
# cycle claude⇄codex (frame-dump agentEngine flips) and inject a "— switched to X — context ported —"
# system note; and the CONTEXT PORTS — a fact stated before the switch reaches the new engine (the echo
# reply after the switch contains the ported-context preamble carrying it). Idle quiescence holds.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-agent-engine-$$"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -16; fail=1; fi; }

toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
submit() { "$H" send "$S" -l "$1" >/dev/null; sleep 0.15; "$H" send "$S" Enter >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
ctrl_e() { tmux send-keys -t "$S" -l "$(printf '\033[27;5;101~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== boot with the echo backend + two forced engines =="
"$H" launch "$S" 110x34 env TUI_FRAME_DUMP=1 INVAR_AGENT_BACKEND=echo INVAR_AGENT_ENGINES=claude,codex bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot"; else echo "  FAIL  boot"; "$H" capture "$S"; exit 1; fi
toggle_agent
chk "agent pane open + focused" "$(f terminalFocused)" "true"

echo "== the mode line shows the engine segment + cycle affordance =="
chk "starting engine is claude" "$(f agentEngine)" "claude"
has "engine segment renders" "engine: claude"
has "cycle affordance renders" "⇄"
has "hint mentions ctrl+e" "ctrl+e"

echo "== establish a fact on engine A, then Ctrl+E cycles to engine B + injects the system note =="
submit "Please remember this token for later: MAGENTA-8842."
chk "engine still claude before switch" "$(f agentEngine)" "claude"
ctrl_e
chk "Ctrl+E switched the engine to codex" "$(f agentEngine)" "codex"
has "the switch system note renders" "switched to codex"
has "the note says context ported" "context ported"
has "mode line now shows codex" "engine: codex"

echo "== the CONTEXT PORTS: the fact carries into the new engine's next turn =="
submit "What token did I ask you to remember?"
# The echo backend echoes what it RECEIVED — which now includes the ported-context preamble carrying the
# fact. Its presence proves the transcript context was serialized + prepended for the new engine.
has "the new engine received the ported-context preamble" "Context ported from the previous engine"
has "the ported context carried the fact" "MAGENTA-8842"

echo "== a CLICK on the engine segment also cycles (back to claude) =="
sb_h="$(f height)"; mode_y=$(( sb_h - 2 ))
"$H" click "$S" 4 "$mode_y" >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "clicking the engine segment switched back to claude" "$(f agentEngine)" "claude"
has "second switch note renders" "switched to claude"

echo "== idle quiescence (no runaway frames) =="
"$H" settle "$S" >/dev/null 2>&1; i0="$(f frame)"; sleep 4; i1="$(f frame)"; d=$(( i1 - i0 ))
if [ "$d" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s (frame $i0 -> $i1)"; else echo "  FAIL  idle loop ticking: +$d"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
