#!/usr/bin/env bash
# tmux harness for driving the real TUI (plan §5.2).
# State verdicts come from artifacts/status.json (the observability side channel),
# never from scraping the pane. Pane capture is reserved for visual assertions.
#
# Commands:
#   launch  <session> <WxH> [cmd...]   start the app in a detached tmux pane
#   ready   <session> [timeout_s]      wait until status.json reports ready + quiescent
#   settle  <session> [timeout_s]      wait until status.json renderQuiescent=true
#   send    <session> <keys...>        tmux send-keys (literal), then request a settle window
#   capture <session>                  print the current pane content
#   status                             print artifacts/status.json
#   field   <jq-path>                  print one field from status.json (e.g. .ready)
#   kill    <session>                  kill the tmux session
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Per-session side channels: each launched instance writes its OWN status/frame files, so
# concurrent instances (user demo + harness sessions) never pollute each other's verdicts.
status_path() { echo "$ROOT/artifacts/status-$1.json"; }
frame_path()  { echo "$ROOT/artifacts/frame-$1.json"; }
STATUS="$ROOT/artifacts/status.json" # legacy fallback for single-arg field/status
BUN="${BUN:-$HOME/.bun/bin/bun}"
BUN_BIN="$(dirname "$BUN")"          # real bun dir, captured BEFORE we isolate HOME below
# Per-worktree isolated HOME: each ROOT (worktree) gets its OWN ~/.config/fable/settings.json, so
# concurrent gate runs in different worktrees never share it (or clobber the real ~/.config).
HARNESS_HOME="$ROOT/artifacts/home"

_field() { # read a top-level field from status.json without jq
  local key="$1"
  [ -f "$STATUS" ] || { echo ""; return; }
  "$BUN" -e "try{const s=require('$STATUS');const v=('$key' in s)?s['$key']:'';process.stdout.write(String(v))}catch{process.stdout.write('')}" 2>/dev/null
}

cmd="${1:-}"; shift || true
case "$cmd" in
  launch)
    session="$1"; size="$2"; shift 2
    cols="${size%x*}"; rows="${size#*x}"
    tmux kill-session -t "$session" 2>/dev/null
    rm -f "$STATUS"
    tmux new-session -d -s "$session" -x "$cols" -y "$rows"
    rm -f "$(status_path "$session")" "$(frame_path "$session")"
    mkdir -p "$HARNESS_HOME/.config/fable"
    # Run inside the repo with a WORKTREE-LOCAL HOME (isolated ~/.config, never shared/clobbered),
    # the real bun on PATH (captured before isolation), and a session-scoped side channel.
    tmux send-keys -t "$session" "cd '$ROOT' && HOME='$HARNESS_HOME' PATH='$BUN_BIN':\"\$PATH\" TUI_STATUS_PATH='$(status_path "$session")' TUI_FRAME_PATH='$(frame_path "$session")' $* " C-m
    echo "launched $session ($cols x $rows): $*"
    ;;
  ready|settle)
    STATUS="$(status_path "$1")"

    session="${1:-}"; timeout="${2:-15}"
    end=$((SECONDS + timeout))
    while [ $SECONDS -lt $end ]; do
      r="$(_field ready)"; q="$(_field renderQuiescent)"
      if [ "$cmd" = ready ] && [ "$r" = "true" ] && [ "$q" = "true" ]; then echo "ready"; exit 0; fi
      if [ "$cmd" = settle ] && [ "$q" = "true" ]; then echo "settled"; exit 0; fi
      sleep 0.15
    done
    echo "TIMEOUT waiting for $cmd (ready=$(_field ready) quiescent=$(_field renderQuiescent))" >&2
    exit 1
    ;;
  send)
    session="$1"; shift
    tmux send-keys -t "$session" "$@"
    sleep 0.25
    ;;
  click)
    # click <session> <x> <y> [button]  — send an SGR left-button press+release at 0-based (x,y).
    # SGR mouse is 1-based, so add 1; the app reports the 0-based (x,y) back.
    session="$1"; x="$2"; y="$3"; button="${4:-0}"
    tmux send-keys -t "$session" -l "$(printf '\033[<%d;%d;%dM' "$button" "$((x+1))" "$((y+1))")"
    sleep 0.1
    tmux send-keys -t "$session" -l "$(printf '\033[<%d;%d;%dm' "$button" "$((x+1))" "$((y+1))")"
    sleep 0.2
    ;;
  drag)
    # drag <session> <x1> <y1> <x2> <y2>  — SGR left-press at (x1,y1), drag motion (button+32)
    # through a midpoint to (x2,y2), release at (x2,y2). 0-based cells; SGR is 1-based.
    session="$1"; x1="$2"; y1="$3"; x2="$4"; y2="$5"
    tmux send-keys -t "$session" -l "$(printf '\033[<0;%d;%dM' "$((x1+1))" "$((y1+1))")"
    sleep 0.08
    midX=$(( (x1+x2)/2 + 1 )); midY=$(( (y1+y2)/2 + 1 ))
    tmux send-keys -t "$session" -l "$(printf '\033[<32;%d;%dM' "$midX" "$midY")"
    sleep 0.08
    tmux send-keys -t "$session" -l "$(printf '\033[<32;%d;%dM' "$((x2+1))" "$((y2+1))")"
    sleep 0.08
    tmux send-keys -t "$session" -l "$(printf '\033[<0;%d;%dm' "$((x2+1))" "$((y2+1))")"
    sleep 0.2
    ;;
  focus)
    # focus <session> in|out — inject a terminal focus report (\e[I focus-in, \e[O focus-out).
    # Drives the tab-defocus→refocus recovery path. NOTE: injecting the sequence is NOT the same as
    # the real terminal resetting its session state (termios/mouse/modes) — this drives the app's
    # focus HANDLER (re-setup + repaint), not the actual mode-loss (only a real VS Code tab can).
    session="$1"; mode="$2"
    if [ "$mode" = out ]; then seq="$(printf '\033[O')"; else seq="$(printf '\033[I')"; fi
    tmux send-keys -t "$session" -l "$seq"
    sleep 0.2
    ;;
  scroll)
    # scroll <session> <x> <y> up|down|left|right|shift-up|shift-down [amount] — SGR wheel at (x,y).
    # Buttons: 64=up 65=down 66=left 67=right; +4 = shift bit. Press-only; repeats `amount` times.
    session="$1"; x="$2"; y="$3"; dir="$4"; amount="${5:-1}"
    case "$dir" in
      up) button=64;; down) button=65;; left) button=66;; right) button=67;;
      shift-up) button=68;; shift-down) button=69;;
      *) button=65;;
    esac
    for _ in $(seq 1 "$amount"); do
      tmux send-keys -t "$session" -l "$(printf '\033[<%d;%d;%dM' "$button" "$((x+1))" "$((y+1))")"
      sleep 0.05
    done
    sleep 0.2
    ;;
  capture)
    session="$1"
    tmux capture-pane -t "$session" -p
    ;;
  status)
    cat "$STATUS" 2>/dev/null || echo "(no status)"
    ;;
  field)
    # field <session> <name> (2 args) or legacy field <name> (reads the shared default file).
    if [ $# -ge 2 ]; then STATUS="$(status_path "$1")"; shift; fi
    _field "$1"
    ;;
  kill)
    tmux kill-session -t "$1" 2>/dev/null && echo "killed $1" || echo "no session $1"
    ;;
  *)
    echo "usage: tui-harness.sh {launch|ready|settle|send|capture|status|field|kill} ..." >&2
    exit 2
    ;;
esac
