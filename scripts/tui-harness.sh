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
STATUS="$ROOT/artifacts/status.json"
BUN="${BUN:-$HOME/.bun/bin/bun}"

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
    # Run inside the repo with bun on PATH.
    tmux send-keys -t "$session" "cd '$ROOT' && PATH=\"\$HOME/.bun/bin:\$PATH\" $* " C-m
    echo "launched $session ($cols x $rows): $*"
    ;;
  ready|settle)
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
  capture)
    session="$1"
    tmux capture-pane -t "$session" -p
    ;;
  status)
    cat "$STATUS" 2>/dev/null || echo "(no status)"
    ;;
  field)
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
