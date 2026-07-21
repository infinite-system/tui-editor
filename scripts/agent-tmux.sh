#!/usr/bin/env bash
# agent-tmux.sh — a reliable driver for interactive CLI agents (claude/codex) in tmux.
#
# WHY THIS EXISTS: driving an interactive agent through tmux send-keys is fragile in
# exactly four ways, and every caller re-derives (and re-breaks) the same workarounds:
#   1. send-keys races — text + Enter in one call lands Enter mid-paste → split them.
#   2. "not at the prompt yet" — startup + approval dialogs (MCP / trust / bypass) must
#      be dismissed before the session can take input → blank-pane failures otherwise.
#   3. "is the turn done?" — you must poll a busy indicator, not guess with a fixed sleep.
#   4. reading — capture a BOUNDED window, not the whole scrollback.
# This script encapsulates all four so callers (a human, the director, a test) just call
# verbs. It does NOT remove tmux's architectural limits (a pty is still required; a live
# session is single-owner) — only the drive-flakiness.
#
# Interactive sessions bill the INTERACTIVE quota bucket (not the Agent-SDK pool, which is
# `claude -p` only) — which is the bucket we want. claude profile launches PERSISTED +
# promoted so the session survives a tmux/host death and can be `--resume`d.
#
# Verbs:
#   launch <name> [--cwd D] [--timeout S] [--profile claude|codex] [--ready RE] [--busy RE] -- <cmd...>
#   send       <name> "<msg>"          split-send + Enter, nudge if it didn't submit
#   wait       <name> [cap_seconds]    block until idle (default 300); prints idle|timeout|dead
#   send-wait  <name> "<msg>" [cap]    send, wait for idle, then peek the reply
#   peek       <name> [lines]          bounded capture-pane (default 40), plain text
#   status     <name>                  idle | busy | starting | dead
#   kill       <name>
#   list                               logical names of live agent-tmux sessions
#
# Sessions are namespaced `at_<name>` (override with $AGENT_TMUX_PREFIX). Per-session the
# ready/busy regexes are stored as tmux options so every verb is profile-aware.
set -uo pipefail

SP="${AGENT_TMUX_PREFIX:-at_}"
DEFAULT_TIMEOUT="${AGENT_TMUX_TIMEOUT:-60}"
DEFAULT_CAP="${AGENT_TMUX_CAP:-300}"

_sess()  { printf '%s%s' "$SP" "$1"; }
_alive() { tmux has-session -t "$(_sess "$1")" 2>/dev/null; }
_pane()  { tmux capture-pane -t "$(_sess "$1")" -p 2>/dev/null; }
_get()   { tmux show-option -t "$(_sess "$1")" -qv "@$2" 2>/dev/null; }

# Profile: sets READY_RE (at an input prompt), BUSY_RE (a turn is running), LAUNCH_ENV.
# --ready/--busy overrides win. claude is verified; codex is [UNVERIFIED] — tune when tested.
_profile() {
  case "$1" in
    claude)
      # idle footer is "? for shortcuts · ← for agents", but --dangerously-skip-permissions
      # replaces "? for shortcuts" with "⏵⏵ bypass permissions on …" — both keep "for agents".
      READY_RE='for shortcuts|for agents'
      BUSY_RE='esc to interrupt'
      LAUNCH_ENV='env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 '
      ;;
    codex) # [UNVERIFIED] placeholders — confirm codex's interactive markers, then tune
      READY_RE='to send|esc to interrupt'
      BUSY_RE='esc to interrupt|Working|Thinking'
      LAUNCH_ENV=''
      ;;
    *)
      READY_RE='.'
      BUSY_RE=''
      LAUNCH_ENV=''
      ;;
  esac
  [ -n "${READY_OVERRIDE:-}" ] && READY_RE="$READY_OVERRIDE"
  [ -n "${BUSY_OVERRIDE:-}" ]  && BUSY_RE="$BUSY_OVERRIDE"
}

# Dismiss claude's startup/approval dialogs. Returns 0 if it acted on one.
_dismiss() {
  local s p; s="$(_sess "$1")"; p="$(_pane "$1")"
  if printf '%s' "$p" | grep -qiE 'New MCP server found'; then
    tmux send-keys -t "$s" Down; sleep 0.2; tmux send-keys -t "$s" Down; sleep 0.2
    tmux send-keys -t "$s" Enter; return 0           # option 3: continue without
  fi
  # NB: match the dialog's own words ("accept the risk"/"Yes, I accept"), NOT the bare
  # "bypass permissions" string — that also appears in the persistent idle footer
  # ("⏵⏵ bypass permissions on …"), which would make _dismiss fire forever.
  if printf '%s' "$p" | grep -qiE 'Do you trust|accept the risk|Yes, I accept'; then
    tmux send-keys -t "$s" Enter; return 0
  fi
  return 1
}

cmd_launch() {
  local name="${1:?launch: need a name}"; shift
  local cwd="" timeout="$DEFAULT_TIMEOUT" profile="" p=""
  READY_OVERRIDE=""; BUSY_OVERRIDE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --cwd) cwd="$2"; shift 2;;
      --timeout) timeout="$2"; shift 2;;
      --profile) profile="$2"; shift 2;;
      --ready) READY_OVERRIDE="$2"; shift 2;;
      --busy) BUSY_OVERRIDE="$2"; shift 2;;
      --) shift; break;;
      *) break;;
    esac
  done
  [ $# -gt 0 ] || { echo "launch: missing command (use: launch <name> [flags] -- <cmd...>)" >&2; return 2; }
  [ -n "$profile" ] || profile="$(basename "$1")"
  _profile "$profile"
  local s; s="$(_sess "$name")"
  tmux kill-session -t "$s" 2>/dev/null
  local q="" a; for a in "$@"; do q+=" $(printf '%q' "$a")"; done
  if [ -n "$cwd" ]; then
    tmux new-session -d -s "$s" -x 220 -y 50 -c "$cwd" "${LAUNCH_ENV}${q}" || { echo "launch: tmux new-session failed" >&2; return 1; }
  else
    tmux new-session -d -s "$s" -x 220 -y 50 "${LAUNCH_ENV}${q}" || { echo "launch: tmux new-session failed" >&2; return 1; }
  fi
  tmux set-option -t "$s" @ready "$READY_RE" 2>/dev/null
  tmux set-option -t "$s" @busy  "$BUSY_RE"  2>/dev/null
  tmux set-option -t "$s" @profile "$profile" 2>/dev/null
  local i
  for ((i=0; i<timeout; i++)); do
    _alive "$name" || { echo "launch: session died during startup" >&2; return 1; }
    if _dismiss "$name"; then sleep 1.2; continue; fi
    p="$(_pane "$name")"
    if printf '%s' "$p" | grep -qE "$READY_RE" \
       && { [ -z "$BUSY_RE" ] || ! printf '%s' "$p" | grep -qE "$BUSY_RE"; }; then
      echo "ready"; return 0
    fi
    sleep 1
  done
  echo "launch: timed out after ${timeout}s waiting for the prompt" >&2; return 1
}

cmd_send() {
  local name="${1:?send: need a name}" msg="${2?send: need a message}"
  _alive "$name" || { echo "send: no session '$name'" >&2; return 1; }
  local s busy i; s="$(_sess "$name")"; busy="$(_get "$name" busy)"
  tmux send-keys -t "$s" -l -- "$msg"   # -l: literal text, no key-name interpretation
  sleep 0.3
  tmux send-keys -t "$s" Enter
  for ((i=0; i<6; i++)); do             # confirm it submitted (turn went busy)
    sleep 0.4
    [ -n "$busy" ] && _pane "$name" | grep -qE "$busy" && return 0
  done
  tmux send-keys -t "$s" Enter          # belt-and-suspenders: nudge once (no-op at empty prompt)
  return 0
}

cmd_wait() {
  local name="${1:?wait: need a name}" cap="${2:-$DEFAULT_CAP}"
  local ready busy p i; ready="$(_get "$name" ready)"; busy="$(_get "$name" busy)"
  for ((i=0; i<cap; i++)); do
    _alive "$name" || { echo dead; return 1; }
    p="$(_pane "$name")"
    if [ -n "$busy" ] && printf '%s' "$p" | grep -qE "$busy"; then sleep 2; continue; fi
    if printf '%s' "$p" | grep -qE "$ready"; then echo idle; return 0; fi
    sleep 1
  done
  echo timeout; return 1
}

cmd_peek() {
  local name="${1:?peek: need a name}" lines="${2:-40}"
  _alive "$name" || { echo "(no session '$name')"; return 1; }
  tmux capture-pane -t "$(_sess "$name")" -p -S "-${lines}" 2>/dev/null | sed -e 's/[[:space:]]*$//'
}

cmd_status() {
  local name="${1:?status: need a name}"
  _alive "$name" || { echo dead; return 0; }
  local p ready busy; p="$(_pane "$name")"; ready="$(_get "$name" ready)"; busy="$(_get "$name" busy)"
  if   [ -n "$busy" ] && printf '%s' "$p" | grep -qE "$busy";  then echo busy
  elif [ -n "$ready" ] && printf '%s' "$p" | grep -qE "$ready"; then echo idle
  else echo starting; fi
}

cmd_send_wait() {
  local name="${1:?}" msg="${2?}" cap="${3:-$DEFAULT_CAP}" lines="${4:-40}"
  cmd_send "$name" "$msg" || return 1
  cmd_wait "$name" "$cap" >/dev/null
  cmd_peek "$name" "$lines"
}

cmd_kill() { tmux kill-session -t "$(_sess "$1")" 2>/dev/null && echo "killed $1" || echo "no session '$1'"; }
cmd_list() { tmux list-sessions -F '#{session_name}' 2>/dev/null | sed -n "s/^${SP}//p"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  case "${1:-help}" in
    launch)    shift; cmd_launch "$@";;
    send)      shift; cmd_send "$@";;
    wait)      shift; cmd_wait "$@";;
    send-wait) shift; cmd_send_wait "$@";;
    peek)      shift; cmd_peek "$@";;
    status)    shift; cmd_status "$@";;
    kill)      shift; cmd_kill "$@";;
    list)      cmd_list;;
    help|-h|--help) usage;;
    *) echo "unknown verb: $1" >&2; usage; return 2;;
  esac
}

# Run only when executed, not when sourced (so the test suite can call functions directly).
[ "${BASH_SOURCE[0]}" = "${0}" ] && main "$@"
