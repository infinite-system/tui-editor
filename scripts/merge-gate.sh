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

# PRE-GATE PROCESS HYGIENE — the true determinism seal (NOT architecture: Bun multiplexes every
# fs.watch onto ONE inotify instance per PROCESS, so each running app = 1 instance). Orphaned app
# instances left by prior runs that exited without their cleanup trap firing (a SIGTERM'd/timed-out run)
# accumulate 1 inotify instance each toward the OS max_user_instances cap (128) and non-deterministically
# flake a git/settings smoke (the panel reads a stale/failed watch). Reap orphaned TEST instances so the
# gate starts from ZERO — a `bun … src/main.ts` on a `/tmp/tui-*` fixture — NEVER the user's live demo
# (/tmp/tui-demo) or any instance on a real (non-/tmp) project.
reaped_orphan_instances=0
for orphan_pid in $(pgrep -f 'src/main\.ts /tmp/tui-' 2>/dev/null || true); do
  orphan_cmdline="$(tr '\0' ' ' < "/proc/$orphan_pid/cmdline" 2>/dev/null || true)"
  case "$orphan_cmdline" in
    *"/tmp/tui-demo"*) continue ;;                         # never touch the user's live demo
    *) kill -9 "$orphan_pid" 2>/dev/null && reaped_orphan_instances=$((reaped_orphan_instances + 1)) ;;
  esac
done
if [ "$reaped_orphan_instances" -gt 0 ]; then
  echo "merge-gate: reaped $reaped_orphan_instances orphaned app instance(s) before start (inotify hygiene)"
  sleep 0.5  # let the kernel release their inotify instances before the gate launches fresh ones
fi
echo "merge-gate: starting with $(pgrep -cf 'src/main\.ts /tmp/tui-' 2>/dev/null || echo 0) test app instance(s) live"
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
# 1b) The INVARIANT CONTRACT LAYER — the lattice itself. --all: every *.invariants.md is structurally
#     valid (both headings, required fields, non-empty Evidence). --refs: every `// invariant:` code
#     annotation resolves to a real record (no dangling references) + coverage report. This was RED and
#     unenforced (the checker existed but rode no gate), so the layer that IS the lattice was
#     measured-but-not-enforced — my own commits added annotations to records that did not exist. Both
#     hard-blocking now: a broken/misnamed invariant reference fails the gate.
step "invariant contracts --all (structure)" node .claude/skills/invariants/scripts/check_invariants.mjs --all
step "invariant contracts --refs (annotations resolve)" node .claude/skills/invariants/scripts/check_invariants.mjs --all --refs
# 2) Unit tests.
step "unit tests (bun test)" bun test
# 3) Behavioral CONTRACTS — the felt-invariants (momentum-glide, wrap-scroll, idle-quiescence).
step "behavioral-contracts (felt invariants)" bash scripts/behavioral-contracts.sh

if [ "${FAST:-0}" != "1" ]; then
  # 4) Driving SMOKES — the real user paths.
  step "smoke: editor"      bash scripts/smoke-editor.sh
  step "smoke: tabs"        bash scripts/smoke-tabs.sh
  step "smoke: workspace tabs" bash scripts/smoke-workspace-tabs.sh
  step "smoke: tree-scroll" bash scripts/smoke-tree-scroll.sh
  step "smoke: selection"   bash scripts/smoke-selection.sh
  step "smoke: scrollbars"  bash scripts/smoke-scrollbars.sh
  step "smoke: wrap"        bash scripts/smoke-wrap.sh
  step "smoke: git-watch"   bash scripts/smoke-git-watch.sh
  step "smoke: find"        bash scripts/smoke-find.sh
  step "smoke: mode coherence" bash scripts/smoke-mode-coherence.sh
  step "smoke: shortcut-help" bash scripts/smoke-shortcut-help.sh
  step "smoke: word-delete" bash scripts/smoke-word-delete.sh
  step "smoke: quick-open"  bash scripts/smoke-quickopen.sh
  step "smoke: search-mouse" bash scripts/smoke-search-mouse.sh
  step "smoke: gutter-diff" bash scripts/smoke-gutter-diff.sh
  step "smoke: diff-overview" bash scripts/smoke-diff-overview.sh
  step "smoke: markdown"     bash scripts/smoke-markdown.sh
  # Guarded inside the script: SKIPs cleanly (exit 0) when typescript-language-server is absent.
  step "smoke: goto-definition" bash scripts/smoke-goto-definition.sh
  step "smoke: navigation-history" bash scripts/smoke-navigation-history.sh
  step "smoke: hover" bash scripts/smoke-hover.sh
  step "smoke: diagnostics" bash scripts/smoke-diagnostics.sh
  step "smoke: image-preview" bash scripts/smoke-image-preview.sh
  # 5) The REAL settings applied-effect drives (all 16 fields, not just the --meta enumeration).
  # diffSplitRatio is driven in smoke-diff-overview above through a real divider drag + second open.
  step "settings applied-effect (all 16 driven)" bash scripts/smoke-settings-applied.sh
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
if [ "$fail" = 0 ]; then
  echo "merge-gate: ALL-PASS"
  # Mechanical checks passed — the commit is legit. Now the one thing no checker can do: encode the
  # invariants you LEARNED. A soft reminder, never a gate — encoding, and especially RETIRING, an
  # invariant is a HOLISTIC judgment, not a falsifiable check.
  echo ""
  echo "  +-- invariant bookkeeping (reminder, not a gate) -------------------------------------"
  echo "  | ESTABLISHED or revealed an invariant not yet written down? Annotate its load-bearing"
  echo "  |   line in the same form the existing annotations use, and add/refine its"
  echo "  |   *.invariants.md entry (Invariant / Mechanism / Generates / Impossible-if-true / Verify)."
  echo "  | Suspect a change RETIRED one? Do NOT retire it here — mid-feature you may be wrong, and"
  echo "  |   the call is holistic (other witnesses in the repo? a pervasive APPROACH with no single"
  echo "  |   annotation? a REALITY truth merely de-scoped?). Just flag a POSSIBLE RETIREMENT"
  echo "  |   CANDIDATE; a scheduled retirement sweep decides live-or-die with full attention."
  echo "  | The checker proves annotations resolve and flags dangling ones; the meaning is yours."
  echo "  |   Re-run: node .claude/skills/invariants/scripts/check_invariants.mjs --all --refs"
  echo "  +------------------------------------------------------------------------------------"
else
  echo "merge-gate: FAILURES — commit/merge BLOCKED"
fi
exit "$fail"
