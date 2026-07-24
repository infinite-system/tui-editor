#!/usr/bin/env bash
# Interactive permission prompts smoke (tier S) — drives the ask-mode approval loop through the REAL
# panel path, hermetically: EchoAgentBackend with INVAR_AGENT_ECHO_PERMISSION=1 PAUSES a scripted Bash
# tool behind a permission-request exactly like the SDK backend's canUseTool (the real SDK path is
# verified by hand — it needs subscription auth, which the gate must not).
# Asserts: the mode line cycles to "? ask permissions"; the prompt renders (human phrase + y/n/a keys)
# and the tool is genuinely PAUSED; y allows (tool runs); n denies (no tool, denial text, turn
# continues); a always-allows (tool runs AND the next turn skips the prompt); idle quiescence holds.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="$DIR/tui-harness.sh"
ROOT="$(cd "$DIR/.." && pwd)"
S="smoke-agent-perm-$$"
FIX="${1:-$ROOT/fixtures}"
fail=0
f()   { "$H" field "$S" "$1"; }
chk() { if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; else echo "  FAIL  $1: got '$2' want '$3'"; fail=1; fi; }
has() { if "$H" capture "$S" | grep -qF "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1 (no '$2' in pane)"; "$H" capture "$S" | tail -16; fail=1; fi; }
hasnt() { if "$H" capture "$S" | grep -qF "$2"; then echo "  FAIL  $1 ('$2' unexpectedly in pane)"; fail=1; else echo "  PASS  $1"; fi; }

toggle_agent() { tmux send-keys -t "$S" -l "$(printf '\033[27;6;97~')"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
shift_tab() { tmux send-keys -t "$S" -l "$(printf '\033[Z')"; sleep 0.25; "$H" settle "$S" >/dev/null 2>&1; }
submit() { "$H" send "$S" -l "$1" >/dev/null; sleep 0.15; "$H" send "$S" Enter >/dev/null; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1; }
wait_idle() { local n=0; while [ "$(f agentBusy)" = "true" ] && [ "$n" -lt 40 ]; do sleep 0.2; n=$((n+1)); done; "$H" settle "$S" >/dev/null 2>&1; }

trap '"$H" kill "$S" >/dev/null 2>&1' EXIT INT TERM

echo "== boot with the permission-gated echo backend =="
"$H" launch "$S" 110x34 env TUI_FRAME_DUMP=1 INVAR_AGENT_BACKEND=echo INVAR_AGENT_ECHO_PERMISSION=1 bun run src/main.ts "$FIX" >/dev/null
if "$H" ready "$S" 20 >/dev/null; then echo "  PASS  boot"; else echo "  FAIL  boot"; "$H" capture "$S"; exit 1; fi
toggle_agent
chk "agent pane open + focused" "$(f terminalFocused)" "true"

echo "== Shift+Tab cycles bypass -> ASK (the new mode label) =="
has "bypass mode label before toggle" "bypass permissions on"
shift_tab
has "ask mode label after toggle" "? ask permissions"

echo "== a gated tool PAUSES behind the interactive prompt =="
submit "first-gated-command"
chk "a permission is pending (frame dump)" "$(f agentPendingPermissionTool)" "Bash"
chk "session is busy while paused" "$(f agentBusy)" "true"
has "prompt renders the human phrase" "? Claude wants to run"
has "prompt shows the gated command" "$ echo gated for: first-gated-command"
has "prompt shows the answer keys" "[y] allow"
hasnt "the tool has NOT run while paused" "▸ ⚙ Bash"

echo "== y ALLOWS: the tool runs and the turn completes =="
tmux send-keys -t "$S" -l "y"; sleep 0.4; wait_idle
chk "pending cleared after y" "$(f agentPendingPermissionTool)" ""
chk "turn completed" "$(f agentBusy)" "false"
has "allowed record renders" "✓ allowed"
has "the gated tool RAN after allow" "▸ ⚙ Bash"

echo "== n DENIES: no tool, denial text, the turn continues =="
submit "second-gated-command"
chk "second prompt pending" "$(f agentPendingPermissionTool)" "Bash"
tmux send-keys -t "$S" -l "n"; sleep 0.4; wait_idle
chk "turn completed after deny" "$(f agentBusy)" "false"
has "denied record renders" "✗ denied"
has "the agent acknowledged the denial" "will not run that command"
# The ✗ denied RECORD contains the phrase; the tool-RESULT row ("▸ ✓ …") must NOT exist for it.
hasnt "the denied command never produced a result row" "▸ ✓ gated for: second-gated-command"

echo "== while pending, stray typing is swallowed (no accidental answer) =="
submit "third-gated-command"
chk "third prompt pending" "$(f agentPendingPermissionTool)" "Bash"
tmux send-keys -t "$S" -l "zqx"; sleep 0.3; "$H" settle "$S" >/dev/null 2>&1
chk "still pending after stray keys" "$(f agentPendingPermissionTool)" "Bash"
tmux send-keys -t "$S" -l "y"; sleep 0.4; wait_idle
chk "resolved by y after the stray keys" "$(f agentPendingPermissionTool)" ""

echo "== a ALWAYS-ALLOWS: tool runs now AND the next turn skips the prompt (must be LAST — it sticks) =="
submit "fourth-gated-command"
chk "fourth prompt pending" "$(f agentPendingPermissionTool)" "Bash"
tmux send-keys -t "$S" -l "a"; sleep 0.4; wait_idle
has "always-allowed tool ran" "gated for: fourth-gated-command"
submit "fifth-auto-allowed"
wait_idle
chk "NO prompt on the fifth turn (session auto-allow)" "$(f agentPendingPermissionTool)" ""
has "fifth tool ran without a prompt" "gated for: fifth-auto-allowed"

echo "== idle quiescence =="
i0="$(f frame)"; sleep 4; i1="$(f frame)"; d=$(( i1 - i0 ))
if [ "$d" -le 1 ]; then echo "  PASS  idle frame delta <= 1 over 4s (frame $i0 -> $i1)"; else echo "  FAIL  idle loop ticking: +$d"; fail=1; fi

echo "== RESULT: $([ "$fail" = 0 ] && echo ALL-PASS || echo FAILURES) =="
exit "$fail"
