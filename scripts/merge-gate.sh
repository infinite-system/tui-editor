#!/usr/bin/env bash
# THE merge gate — every HARD-BLOCKING check a feature commit/merge must pass. This exists because
# conventions-gate.sh alone ran only tsc + the mechanical/meta checks, so the behavioral CONTRACTS
# (momentum-glide, wrap-scroll, idle-quiescence), the driving SMOKES, and the REAL per-field settings
# applied-effect drives DID NOT BLOCK A COMMIT — build-but-don't-wire applied to the gates themselves,
# violating project.requirements.md "MEASURED != ENFORCED". This wrapper runs them all; ANY non-zero
# exit fails the gate. Slow (many app launches) — it is the MERGE gate, not the every-keystroke check;
# conventions-gate.sh stays the fast inner loop (and is step 1 here).
#
# Usage: bash scripts/merge-gate.sh          (run everything)
#        FAST=1 bash scripts/merge-gate.sh   (skip the multi-launch smokes; conventions + contracts + meta only)
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.bun/bin:$PATH"
# Hermetic git for the WHOLE gate. When invoked from the pre-commit hook, git exports
# GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / … into the environment; any `git` a test, smoke, or
# fixture spawns would then operate on the PARENT repo instead of its own temp fixture — a
# non-deterministic, parent-state-dependent failure (a fixture `git init` re-inits the parent, etc.).
# The app is already hermetic (Processes.hermeticEnvironment); clearing here also covers the shell
# fixtures. Harmless when run directly (these are normally unset). One boundary, whole gate hermetic.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX GIT_INDEX_VERSION GIT_NAMESPACE
fail=0
step() {
  local name="$1"; shift
  echo "== merge-gate: $name =="
  if "$@" >/tmp/merge-gate-step.$$.log 2>&1; then
    echo "  OK    $name"
  else
    echo "  FAIL  $name"; tail -25 /tmp/merge-gate-step.$$.log | sed 's/^/    | /'
    fail=1
  fi
  rm -f /tmp/merge-gate-step.$$.log
}
# A SOFT step: it RUNS and REPORTS (so a regression surfaces in the gate), but a non-zero exit does
# NOT block the commit. Use only where the numbers are informational and the load-bearing invariant is
# hard-gated elsewhere (perf's idle-quiescence is enforced by behavioral-contracts).
soft_step() {
  local name="$1"; shift
  echo "== merge-gate: $name (SOFT — reports, does not block) =="
  if "$@" >/tmp/merge-gate-soft.$$.log 2>&1; then
    echo "  OK    $name"
  else
    echo "  WARN  $name — target miss or measurement gap (soft, not blocking)"; tail -20 /tmp/merge-gate-soft.$$.log | sed 's/^/    | /'
  fi
  rm -f /tmp/merge-gate-soft.$$.log
}

# 1) Fast inner gate: tsc + conventions + unwired-capability + settings-applied META.
step "conventions-gate (tsc + conventions + unwired + settings-meta)" bash scripts/conventions-gate.sh
# 2) Unit tests.
step "unit tests (bun test)" bun test
# 3) Behavioral CONTRACTS — the felt-invariants (momentum-glide, wrap-scroll, idle-quiescence).
step "behavioral-contracts (felt invariants)" bash scripts/behavioral-contracts.sh

if [ "${FAST:-0}" != "1" ]; then
  # 4) Driving SMOKES — the real user paths.
  step "smoke: editor"      bash scripts/smoke-editor.sh
  step "smoke: tabs"        bash scripts/smoke-tabs.sh
  step "smoke: tree-scroll" bash scripts/smoke-tree-scroll.sh
  step "smoke: wrap"        bash scripts/smoke-wrap.sh
  step "smoke: git-watch"   bash scripts/smoke-git-watch.sh
  step "smoke: find"        bash scripts/smoke-find.sh
  step "smoke: quick-open"  bash scripts/smoke-quickopen.sh
  # 5) The REAL settings applied-effect drives (all 13 fields, not just the --meta enumeration).
  step "settings applied-effect (all 13 driven)" bash scripts/smoke-settings-applied.sh
  # 6) Perf baselines — SOFT: memory/CPU/latency are measured + REPORTED so a regression surfaces in
  #    the gate (it was previously unwired = a perf regression could ship). Non-blocking: the numbers
  #    are informational and the load-bearing idle-quiescence invariant is hard-gated above. Slow
  #    (idle-hold + lifecycle) — SKIP_PERF=1 to skip for fast local iteration.
  if [ "${SKIP_PERF:-0}" != "1" ]; then
    soft_step "perf-baselines (memory/CPU/latency)" bash scripts/perf-baselines.sh
  else
    echo "== merge-gate: (SKIP_PERF=1) skipped perf-baselines =="
  fi
else
  echo "== merge-gate: (FAST) skipped the multi-launch smokes + real settings drives =="
fi

echo ""
if [ "$fail" = 0 ]; then echo "merge-gate: ALL-PASS"; else echo "merge-gate: FAILURES — commit/merge BLOCKED"; fi
exit "$fail"
