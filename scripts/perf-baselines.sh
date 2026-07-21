#!/usr/bin/env bash
# perf-baselines.sh — measured performance baselines for the TUI editor (PROGRESS item 8).
#
# Four measurements, all session-scoped (unique tmux session names + per-session status files,
# so a live user demo instance is never touched):
#   1. IDLE QUIESCENCE  boot on fixtures/, interact briefly, then 10s untouched; sample the
#                       status-channel frame counter at t=0/5/10s (final-5s frame delta must be 0)
#                       and the process CPU over each 5s window from /proc/<pid>/stat.
#   2. MEMORY           bun runtime floor RSS; editor RSS after boot; after opening a generated
#                       5MB/50k-line file; across 3 open/close (re-open) cycles; after 60s idle.
#   3. LIFECYCLE        5x launch -> ready -> Ctrl+Q; boot-to-ready milliseconds (harness-
#                       inclusive: tmux session + login shell + bun start); clean-exit check;
#                       bun process count before == after (no orphans).
#   4. INPUT LATENCY    keypress -> status-file cursor flush, 20 presses, p50/p95, 20ms poll grain.
#
# Verdicts are printed as PASS/FAIL against the brief's targets (idle CPU ~0 (<2%), frame delta 0,
# idle memory < 100MB). Most target misses are DATA, not script errors (they inform, they don't
# block). The ONE exception is idle frame quiescence: frame-delta==0 is an INVARIANT ('rendering is
# demand-driven'), so a violation makes the script EXIT NON-ZERO — a check that doesn't block is not
# enforcement. Exit code = measurements-that-could-not-be-taken + idle-quiescence violations.
# Rerunnable; traps kill every tmux session it creates.
set -uo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIRECTORY/.." && pwd)"
HARNESS="$SCRIPT_DIRECTORY/tui-harness.sh"
BUN="${BUN:-$HOME/.bun/bin/bun}"
CLOCK_TICKS_PER_SECOND="$(getconf CLK_TCK)"
RUN_TAG="perf$$"

CREATED_SESSIONS=()
SPAWNED_BUN_PROCESS_IDS=()
SCRATCH_WORKSPACE=""
cleanup() {
  for session in "${CREATED_SESSIONS[@]:-}"; do
    [ -n "$session" ] || continue
    tmux kill-session -t "$session" 2>/dev/null
    rm -f "$ROOT/artifacts/status-$session.json" "$ROOT/artifacts/frame-$session.json"
  done
  [ -n "$SCRATCH_WORKSPACE" ] && rm -rf "$SCRATCH_WORKSPACE"
}
trap cleanup EXIT INT TERM

harness() { bash "$HARNESS" "$@"; }
session_status_path() { echo "$ROOT/artifacts/status-$1.json"; }
now_milliseconds() { date +%s%3N; }

# Resolve the bun process of a tmux session by walking down from the pane's process.
bun_process_id_of_session() {
  local candidate
  candidate="$(tmux display-message -p -t "$1" '#{pane_pid}' 2>/dev/null)" || return 1
  for _ in 1 2 3 4; do
    [ -n "$candidate" ] || return 1
    if [ "$(cat "/proc/$candidate/comm" 2>/dev/null)" = "bun" ]; then
      echo "$candidate"
      return 0
    fi
    candidate="$(pgrep -P "$candidate" | head -1)"
  done
  return 1
}

cpu_ticks_of() { awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null; }
resident_kilobytes_of() { awk '/VmRSS/{print $2}' "/proc/$1/status" 2>/dev/null; }
kilobytes_to_megabytes() { awk -v kb="$1" 'BEGIN{printf "%.1f", kb / 1024}'; }

status_frame_of() { sed -n 's/^  "frame": \([0-9]*\),*$/\1/p' "$(session_status_path "$1")" | head -1; }
status_focus_of() { sed -n 's/^  "focus": "\(.*\)",*$/\1/p' "$(session_status_path "$1")" | head -1; }
status_active_buffer_of() { sed -n 's/^  "activeBuffer": "\(.*\)",*$/\1/p' "$(session_status_path "$1")" | head -1; }
status_cursor_column_of() { sed -n 's/.*"col": \([0-9]*\).*/\1/p' "$(session_status_path "$1")" | head -1; }

# Percent CPU over a window: (tick_delta / (seconds * CLK_TCK)) * 100.
window_cpu_percent() { awk -v ticks="$1" -v seconds="$2" -v hz="$CLOCK_TICKS_PER_SECOND" \
  'BEGIN{printf "%.2f", (ticks * 100) / (seconds * hz)}'; }

launch_session() { # launch_session <session> <workspace-directory>
  local session="$1" workspace_directory="$2"
  CREATED_SESSIONS+=("$session")
  harness launch "$session" 120x40 bun run src/main.ts "$workspace_directory" >/dev/null
}

wait_for_ready() { # wait_for_ready <session> <timeout-seconds> ; 20ms poll grain
  local status_file deadline
  status_file="$(session_status_path "$1")"
  deadline=$(( $(now_milliseconds) + $2 * 1000 ))
  while [ "$(now_milliseconds)" -lt "$deadline" ]; do
    if grep -q '"ready": true' "$status_file" 2>/dev/null \
       && grep -q '"renderQuiescent": true' "$status_file" 2>/dev/null; then
      return 0
    fi
    sleep 0.02
  done
  return 1
}

ensure_files_focus() { # cycle Tab (focus.toggle) until the tree pane has focus
  local session="$1"
  for _ in 1 2 3; do
    [ "$(status_focus_of "$session")" = "files" ] && return 0
    tmux send-keys -t "$session" Tab
    sleep 0.3
  done
  [ "$(status_focus_of "$session")" = "files" ]
}

open_file_from_tree() { # open_file_from_tree <session> <basename> — walk the tree top-down with Enter
  local session="$1" target_basename="$2" active_buffer
  ensure_files_focus "$session" || { echo "  ERROR could not focus the file tree" >&2; return 1; }
  tmux send-keys -t "$session" Up Up Up Up Up Up Up Up Up Up Up Up Up Up Up
  sleep 0.4
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    tmux send-keys -t "$session" Enter
    sleep 0.35
    active_buffer="$(status_active_buffer_of "$session")"
    case "$active_buffer" in */"$target_basename"|"$target_basename") return 0 ;; esac
    ensure_files_focus "$session" || return 1
    tmux send-keys -t "$session" Down
    sleep 0.2
  done
  echo "  ERROR never opened $target_basename (activeBuffer=$active_buffer)" >&2
  return 1
}

open_any_file_from_tree() { # smoke-style walk: Enter/Down until any buffer is active
  local session="$1" active_buffer
  for _ in 1 2 3 4 5 6 7 8; do
    active_buffer="$(status_active_buffer_of "$session")"
    [ -n "$active_buffer" ] && return 0
    tmux send-keys -t "$session" Enter
    sleep 0.35
    tmux send-keys -t "$session" Down
    sleep 0.2
  done
  return 1
}

record_spawned_bun_process() { # remember every bun pid this run creates for the orphan audit
  [ -n "${1:-}" ] && SPAWNED_BUN_PROCESS_IDS+=("$1")
}

measurement_failures=0
# Idle frame quiescence is an INVARIANT, not a soft target: a violation blocks (non-zero exit).
idle_quiescence_violations=0
echo "== perf-baselines $(date -Is) on $(uname -m) $(uname -s) · CLK_TCK=$CLOCK_TICKS_PER_SECOND · targetFps=30 =="
bun_process_count_before="$(pgrep -c -f 'bun run src/main\.ts' || true)"
echo "pre-existing 'bun run src/main.ts' processes: $bun_process_count_before (left untouched; other agents/demos may churn this count)"

# ---------------------------------------------------------------- 1. IDLE QUIESCENCE
echo ""
echo "== 1. IDLE QUIESCENCE (fixtures/, brief interaction, then 10s untouched) =="
IDLE_SESSION="${RUN_TAG}idle"
launch_session "$IDLE_SESSION" "$ROOT/fixtures"
if ! wait_for_ready "$IDLE_SESSION" 25; then
  echo "  ERROR idle session never became ready"; measurement_failures=$((measurement_failures + 1))
else
  idle_bun_process_id="$(bun_process_id_of_session "$IDLE_SESSION")" || idle_bun_process_id=""
  record_spawned_bun_process "$idle_bun_process_id"
  echo "  bun pid: ${idle_bun_process_id:-NOT FOUND}"
  # Brief interaction: open a file, focus the editor, type one character.
  open_any_file_from_tree "$IDLE_SESSION" || echo "  WARN no buffer opened before idling"
  tmux send-keys -t "$IDLE_SESSION" Right; sleep 0.3
  tmux send-keys -t "$IDLE_SESSION" -l "x"; sleep 0.3
  harness settle "$IDLE_SESSION" 10 >/dev/null 2>&1
  idle_rss_after_boot_kb="$(resident_kilobytes_of "$idle_bun_process_id")"

  frame_at_0="$(status_frame_of "$IDLE_SESSION")"; ticks_at_0="$(cpu_ticks_of "$idle_bun_process_id")"
  sleep 5
  frame_at_5="$(status_frame_of "$IDLE_SESSION")"; ticks_at_5="$(cpu_ticks_of "$idle_bun_process_id")"
  sleep 5
  frame_at_10="$(status_frame_of "$IDLE_SESSION")"; ticks_at_10="$(cpu_ticks_of "$idle_bun_process_id")"

  frame_delta_first_window=$((frame_at_5 - frame_at_0))
  frame_delta_final_window=$((frame_at_10 - frame_at_5))
  cpu_percent_first_window="$(window_cpu_percent $((ticks_at_5 - ticks_at_0)) 5)"
  cpu_percent_final_window="$(window_cpu_percent $((ticks_at_10 - ticks_at_5)) 5)"
  lifetime_cpu_percent="$(ps -o %cpu= -p "$idle_bun_process_id" | tr -d ' ')"

  echo "  frame counter t=0/5/10s: $frame_at_0 / $frame_at_5 / $frame_at_10"
  echo "  frame delta 0-5s: $frame_delta_first_window (settle tail allowed)"
  echo "  frame delta 5-10s (FINAL window): $frame_delta_final_window  target: 0"
  echo "  windowed CPU%: 0-5s=$cpu_percent_first_window  5-10s=$cpu_percent_final_window  target: <2.0"
  echo "  ps lifetime-average CPU%: $lifetime_cpu_percent (cumulative since start — NOT the idle figure)"
  echo "  RSS at rest (fixtures + one open file): $(kilobytes_to_megabytes "$idle_rss_after_boot_kb") MB"
  if [ "$frame_delta_final_window" -eq 0 ]; then echo "  PASS idle frame quiescence"; else
    frames_per_second="$(awk -v d="$frame_delta_final_window" 'BEGIN{printf "%.1f", d/5}')"
    echo "  FAIL idle frame quiescence: $frames_per_second frames/s in the final 5s window"
    echo "        evidence: rate ~= targetFps(30) -> the RENDER LOOP itself, not a momentum/drag tick"
    # This is an INVARIANT violation ('rendering is demand-driven'), not a soft target miss: it must
    # BLOCK (non-zero exit), otherwise a live idle loop ships as a false-green (as it once did).
    idle_quiescence_violations=$((idle_quiescence_violations + 1))
  fi
  awk -v cpu="$cpu_percent_final_window" 'BEGIN{exit !(cpu < 2.0)}' \
    && echo "  PASS idle CPU <2% ($cpu_percent_final_window%)" \
    || echo "  FAIL idle CPU <2% ($cpu_percent_final_window%)"
fi
tmux kill-session -t "$IDLE_SESSION" 2>/dev/null

# ---------------------------------------------------------------- 2. MEMORY
echo ""
echo "== 2. MEMORY (bun floor · boot · 5MB file · 3 re-open cycles · 60s idle) =="
"$BUN" -e 'setInterval(() => {}, 1000000)' &
bun_floor_process_id=$!
sleep 1.5
bun_floor_rss_kb="$(resident_kilobytes_of "$bun_floor_process_id")"
kill "$bun_floor_process_id" 2>/dev/null; wait "$bun_floor_process_id" 2>/dev/null
echo "  bun runtime floor (bun -e with an event loop): $(kilobytes_to_megabytes "$bun_floor_rss_kb") MB"

SCRATCH_WORKSPACE="$(mktemp -d /tmp/tui-perf-workspace.XXXXXX)"
awk 'BEGIN{for(line = 1; line <= 50000; line++){printf "line %06d ", line; for(chunk = 0; chunk < 9; chunk++) printf "abcdefghij"; printf "\n"}}' \
  > "$SCRATCH_WORKSPACE/big.txt"
printf 'small file\nsecond line\n' > "$SCRATCH_WORKSPACE/small.txt"
large_file_bytes="$(wc -c < "$SCRATCH_WORKSPACE/big.txt")"
echo "  generated big.txt: $large_file_bytes bytes, 50000 lines"

MEMORY_SESSION="${RUN_TAG}mem"
launch_session "$MEMORY_SESSION" "$SCRATCH_WORKSPACE"
if ! wait_for_ready "$MEMORY_SESSION" 25; then
  echo "  ERROR memory session never became ready"; measurement_failures=$((measurement_failures + 1))
else
  memory_bun_process_id="$(bun_process_id_of_session "$MEMORY_SESSION")" || memory_bun_process_id=""
  record_spawned_bun_process "$memory_bun_process_id"
  sleep 2
  rss_after_boot_kb="$(resident_kilobytes_of "$memory_bun_process_id")"
  echo "  RSS after boot (scratch workspace): $(kilobytes_to_megabytes "$rss_after_boot_kb") MB"

  if open_file_from_tree "$MEMORY_SESSION" "big.txt"; then
    harness settle "$MEMORY_SESSION" 10 >/dev/null 2>&1; sleep 2
    rss_after_large_open_kb="$(resident_kilobytes_of "$memory_bun_process_id")"
    echo "  RSS after opening the 5MB/50k-line file: $(kilobytes_to_megabytes "$rss_after_large_open_kb") MB"

    echo "  re-open cycles (open small.txt then big.txt again; open REPLACES the single document):"
    cycle_rss_values=()
    for cycle in 1 2 3; do
      open_file_from_tree "$MEMORY_SESSION" "small.txt" || break
      open_file_from_tree "$MEMORY_SESSION" "big.txt" || break
      harness settle "$MEMORY_SESSION" 10 >/dev/null 2>&1; sleep 1
      cycle_rss_kb="$(resident_kilobytes_of "$memory_bun_process_id")"
      cycle_rss_values+=("$cycle_rss_kb")
      echo "    cycle $cycle: $(kilobytes_to_megabytes "$cycle_rss_kb") MB"
    done
    if [ "${#cycle_rss_values[@]}" -eq 3 ]; then
      cycle_growth_kb=$((cycle_rss_values[2] - cycle_rss_values[0]))
      echo "  growth cycle1 -> cycle3: $(kilobytes_to_megabytes "$cycle_growth_kb") MB (flat = no leak signal; GC slack makes small negatives/positives normal)"
    else
      echo "  WARN not all re-open cycles completed"; measurement_failures=$((measurement_failures + 1))
    fi

    echo "  waiting 60s idle (large file open) ..."
    sleep 60
    rss_after_idle_kb="$(resident_kilobytes_of "$memory_bun_process_id")"
    echo "  RSS after 60s idle: $(kilobytes_to_megabytes "$rss_after_idle_kb") MB  target: <100 MB"
    if [ "$rss_after_idle_kb" -lt 102400 ]; then echo "  PASS idle memory <100MB"; else echo "  FAIL idle memory <100MB"; fi
    app_delta_kb=$((rss_after_boot_kb - bun_floor_rss_kb))
    echo "  itemization: bun floor $(kilobytes_to_megabytes "$bun_floor_rss_kb") MB + OpenTUI/app delta $(kilobytes_to_megabytes "$app_delta_kb") MB = boot $(kilobytes_to_megabytes "$rss_after_boot_kb") MB"
  else
    echo "  ERROR could not open big.txt"; measurement_failures=$((measurement_failures + 1))
  fi
fi
tmux kill-session -t "$MEMORY_SESSION" 2>/dev/null
rm -rf "$SCRATCH_WORKSPACE"; SCRATCH_WORKSPACE=""

# ---------------------------------------------------------------- 3. LIFECYCLE
echo ""
echo "== 3. LIFECYCLE (5x launch -> ready -> Ctrl+Q; clean exit; no orphans) =="
lifecycle_boot_times=()
lifecycle_clean_exits=0
for cycle in 1 2 3 4 5; do
  LIFECYCLE_SESSION="${RUN_TAG}lc$cycle"
  launch_started_at="$(now_milliseconds)"
  launch_session "$LIFECYCLE_SESSION" "$ROOT/fixtures"
  if wait_for_ready "$LIFECYCLE_SESSION" 25; then
    boot_milliseconds=$(( $(now_milliseconds) - launch_started_at ))
    lifecycle_boot_times+=("$boot_milliseconds")
    lifecycle_bun_process_id="$(bun_process_id_of_session "$LIFECYCLE_SESSION")"
    record_spawned_bun_process "$lifecycle_bun_process_id"
    tmux send-keys -t "$LIFECYCLE_SESSION" C-q
    exit_deadline=$(( $(now_milliseconds) + 5000 ))
    while [ -d "/proc/$lifecycle_bun_process_id" ] && [ "$(now_milliseconds)" -lt "$exit_deadline" ]; do
      sleep 0.05
    done
    if [ ! -d "/proc/$lifecycle_bun_process_id" ]; then
      lifecycle_clean_exits=$((lifecycle_clean_exits + 1))
      echo "  cycle $cycle: boot-to-ready ${boot_milliseconds}ms, clean exit"
    else
      echo "  cycle $cycle: boot-to-ready ${boot_milliseconds}ms, STILL RUNNING after Ctrl+Q (5s)"
    fi
  else
    echo "  cycle $cycle: ERROR never became ready"; measurement_failures=$((measurement_failures + 1))
  fi
  tmux kill-session -t "$LIFECYCLE_SESSION" 2>/dev/null
done
if [ "${#lifecycle_boot_times[@]}" -gt 0 ]; then
  echo "  boot-to-ready (harness-inclusive: tmux + login shell + bun + first quiescent frame):" \
    "$(printf '%s ' "${lifecycle_boot_times[@]}")ms"
  echo "  note: 20ms ready-poll grain; the brief's <150ms cold-start target is for the BARE process, not this harness path"
fi
[ "$lifecycle_clean_exits" -eq 5 ] && echo "  PASS 5/5 clean exits" || echo "  FAIL clean exits: $lifecycle_clean_exits/5"

# ---------------------------------------------------------------- 4. INPUT LATENCY PROXY
echo ""
echo "== 4. INPUT LATENCY PROXY (keypress -> status-flush cursor change; 20ms poll grain) =="
LATENCY_SESSION="${RUN_TAG}lat"
launch_session "$LATENCY_SESSION" "$ROOT/fixtures"
if ! wait_for_ready "$LATENCY_SESSION" 25; then
  echo "  ERROR latency session never became ready"; measurement_failures=$((measurement_failures + 1))
else
  open_any_file_from_tree "$LATENCY_SESSION" || echo "  WARN no buffer opened"
  tmux send-keys -t "$LATENCY_SESSION" Right; sleep 0.3   # focus the editor
  tmux send-keys -t "$LATENCY_SESSION" Right Right; sleep 0.4  # get off column 0 so Left/Right both move
  latency_samples=()
  for press in $(seq 1 20); do
    if [ $((press % 2)) -eq 1 ]; then key_to_send="Right"; else key_to_send="Left"; fi
    column_before="$(status_cursor_column_of "$LATENCY_SESSION")"
    press_sent_at="$(now_milliseconds)"
    tmux send-keys -t "$LATENCY_SESSION" "$key_to_send"
    poll_deadline=$((press_sent_at + 3000))
    while [ "$(now_milliseconds)" -lt "$poll_deadline" ]; do
      [ "$(status_cursor_column_of "$LATENCY_SESSION")" != "$column_before" ] && break
      sleep 0.02
    done
    flush_observed_at="$(now_milliseconds)"
    latency_samples+=("$((flush_observed_at - press_sent_at))")
    sleep 0.1
  done
  sorted_samples="$(printf '%s\n' "${latency_samples[@]}" | sort -n)"
  p50_milliseconds="$(echo "$sorted_samples" | sed -n '10p')"
  p95_milliseconds="$(echo "$sorted_samples" | sed -n '19p')"
  echo "  samples (ms): $(printf '%s ' "${latency_samples[@]}")"
  echo "  p50=${p50_milliseconds}ms p95=${p95_milliseconds}ms over 20 presses"
  echo "  note: 20ms poll grain + ~1-3ms timestamp/read cost; the status flush itself is quantized to the ~33ms frame cadence,"
  echo "        so this is an UPPER BOUND proxy for input-to-screen latency, not the render latency itself"
fi
tmux kill-session -t "$LATENCY_SESSION" 2>/dev/null

# ---------------------------------------------------------------- wrap-up: orphan audit
# Concurrent agents/demos launch their own instances, so a GLOBAL process count is unstable;
# the authoritative check is that every bun pid THIS RUN spawned is gone.
echo ""
sleep 1
orphaned_process_ids=""
for spawned_process_id in "${SPAWNED_BUN_PROCESS_IDS[@]:-}"; do
  [ -n "$spawned_process_id" ] && [ -d "/proc/$spawned_process_id" ] \
    && orphaned_process_ids="$orphaned_process_ids $spawned_process_id"
done
if [ -z "$orphaned_process_ids" ]; then
  echo "  PASS no orphan bun processes from this run (${#SPAWNED_BUN_PROCESS_IDS[@]} spawned, all exited)"
else
  echo "  FAIL orphan bun processes from this run:$orphaned_process_ids"
  measurement_failures=$((measurement_failures + 1))
fi
bun_process_count_final="$(pgrep -c -f 'bun run src/main\.ts' || true)"
echo "== wrap-up: global bun-editor count before=$bun_process_count_before final=$bun_process_count_final (informational) · measurement failures=$measurement_failures · idle-quiescence violations=$idle_quiescence_violations =="
exit "$(( measurement_failures + idle_quiescence_violations ))"
