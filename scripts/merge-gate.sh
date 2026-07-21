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
  # 5) The REAL settings applied-effect drives (all 13 fields, not just the --meta enumeration).
  step "settings applied-effect (all 13 driven)" bash scripts/smoke-settings-applied.sh
else
  echo "== merge-gate: (FAST) skipped the multi-launch smokes + real settings drives =="
fi

echo ""
if [ "$fail" = 0 ]; then echo "merge-gate: ALL-PASS"; else echo "merge-gate: FAILURES — commit/merge BLOCKED"; fi
exit "$fail"
