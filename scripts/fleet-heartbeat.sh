#!/usr/bin/env bash
# fleet-heartbeat.sh — a PULL liveness floor for a fleet of background build workers.
#
# WHY: workers (codex/agents building modules in parallel) signal COMPLETION and nothing else. That
# notify signal is an accelerator, not a floor: a worker starved under load can HANG SILENTLY — its whole
# process tree sleeping, ~0 CPU accumulated, and because it never completes it emits NO event. Such a hang
# is invisible for hours. A silent hang is exactly a "dropped event" — and the only thing that catches a
# dropped event is a periodic PULL that re-reads ground truth. This is that pull. (Same notify-over-pull
# shape as the app's own GitWatcher reconcile-floor.)
#
# THE LIVENESS SIGNAL — CPU across the worker's whole process tree. A working worker is EITHER the parent
# codex orchestrating OR a child (`bun test`, `tsc`, `git`) burning CPU while the parent sleeps waiting.
# So the correct signal is the SUM of CPU ticks over {the worker's codex procs} + {all their descendants}.
# A worker is HUNG only when that total stops advancing for STALL_LIMIT beats. (A naive file-write signal
# false-positives during the test phase — the worker writes nothing but is very much alive; CPU sees it.)
# File-writes are still shown per beat as a secondary, informational progress indicator.
#
# EXITS (so the orchestrator is notified without polling; it RE-ARMS while any worker runs):
#   0 — all workers' codex processes are gone (finished/died): verify + merge.
#   2 — STALL: a worker's process-tree CPU stopped advancing for STALL_LIMIT beats (hung): kill + respawn.
#   0 — MAX_BEATS window elapsed, everything still alive: re-arm.
#
# USAGE:   scripts/fleet-heartbeat.sh <worker> [<worker> ...]
#   <worker> resolves to a worktree at "$WORKTREE_BASE-<worker>" (default base /tmp/conductor).
# CONFIG (env): BEAT=70  STALL_LIMIT=3  MAX_BEATS=45  WORKTREE_BASE=/tmp/conductor  PULSE_LOG=<path>
#
# Keep the fleet SMALL (~2-3 concurrent workers): over-parallelizing is what starves workers into the
# silent hang this tool exists to catch — detection here, prevention by the cap.
set -uo pipefail

BEAT="${BEAT:-70}"; STALL_LIMIT="${STALL_LIMIT:-3}"; MAX_BEATS="${MAX_BEATS:-45}"
WORKTREE_BASE="${WORKTREE_BASE:-/tmp/conductor}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PULSE_LOG="${PULSE_LOG:-$SCRIPT_DIR/../artifacts/heartbeat.pulse}"
WORKERS="$*"
[ -z "$WORKERS" ] && { echo "usage: $0 <worker> [<worker> ...]  (worktrees at $WORKTREE_BASE-<worker>)"; exit 64; }
mkdir -p "$(dirname "$PULSE_LOG")" 2>/dev/null || true

_cpu() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo 0; }   # utime+stime (ticks)

# Total CPU ticks of the worker's codex procs (matched by cwd) + ALL their descendants.
tree_cpu() {
  local w="$1" total=0 pid queue next
  queue="$(for pid in $(ps -eo pid,comm | awk '$2=="codex"{print $1}'); do
             [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$WORKTREE_BASE-$w" ] && echo "$pid"; done)"
  while [ -n "$queue" ]; do
    next=""
    for pid in $queue; do total=$(( total + $(_cpu "$pid") )); next="$next $(pgrep -P "$pid" 2>/dev/null || true)"; done
    queue="$next"
  done
  echo "$total"
}
# Newest mtime of real work files (secondary, informational).
work_mtime() {
  find "$WORKTREE_BASE-$1" \( -name node_modules -prune \) -o \
    \( -type f \( -name '*.ts' -o -name '*.sh' -o -name '*.md' \) ! -name 'prompt-*' -printf '%T@\n' \) 2>/dev/null \
    | sort -rn | head -1 | cut -d. -f1
}

declare -A last_cpu last_mt quiet
for w in $WORKERS; do last_cpu["$w"]="$(tree_cpu "$w")"; last_mt["$w"]="$(work_mtime "$w")"; quiet["$w"]=0; done

for ((beat = 1; beat <= MAX_BEATS; beat++)); do
  sleep "$BEAT"
  codex_alive="$(ps -eo comm= | grep -c '^codex')"
  line="[heartbeat t+$((beat * BEAT))s | codex=$codex_alive]"; stalled=""
  for w in $WORKERS; do
    cpu="$(tree_cpu "$w")"; mt="$(work_mtime "$w")"
    files="$(git -C "$WORKTREE_BASE-$w" status --short 2>/dev/null | grep -cE '\.ts$|\.sh$|\.md$')"
    dcpu=$(( ${cpu:-0} - ${last_cpu[$w]:-0} ))
    if [ "$dcpu" -gt 0 ] || [ "${mt:-0}" != "${last_mt[$w]:-0}" ]; then
      quiet["$w"]=0; tag="beating(+${dcpu}cpu,${files}f)"
    else
      quiet["$w"]=$(( ${quiet[$w]} + 1 )); tag="quiet x${quiet[$w]}(${files}f)"
    fi
    last_cpu["$w"]="$cpu"; last_mt["$w"]="$mt"
    line="$line  $w:$tag"
    [ "${quiet[$w]}" -ge "$STALL_LIMIT" ] && stalled="$w"
  done
  echo "$line" | tee -a "$PULSE_LOG"
  if [ "$codex_alive" -eq 0 ]; then echo "HEARTBEAT: all codex processes gone — workers finished/died (verify + merge)"; exit 0; fi
  if [ -n "$stalled" ]; then echo "HEARTBEAT: STALL — '$stalled' process-tree CPU flat for $STALL_LIMIT beats (kill + respawn)"; exit 2; fi
done
echo "HEARTBEAT: window elapsed ($((MAX_BEATS * BEAT))s), workers still alive — re-arm"; exit 0
