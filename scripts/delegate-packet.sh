#!/usr/bin/env bash
# Mechanical delegate-packet assembly: a delegate CANNOT be spawned without the conventions,
# because the packet is built by this script, never by memory.
#   scripts/delegate-packet.sh <task-spec-file> [module-contract...]
# Emits to stdout: conventions + method essentials + the given contracts + the task spec.
set -euo pipefail
cd "$(dirname "$0")/.."
task_spec="$1"; shift || true
echo "==================== PROJECT REQUIREMENTS (persistent brief; READ FIRST; still-live decisions) ===================="
cat project.requirements.md
echo
echo "==================== PROJECT CONVENTIONS (binding; violations fail review) ===================="
cat project.conventions.md
echo
echo "==================== FRACTAL INHERITANCE (binding, recursive) ===================="
echo "If YOU spawn a sub-agent for any part of this task, you MUST build its prompt with THIS script"
echo "(scripts/delegate-packet.sh) — never hand-assembled. This is how conventions propagate to every"
echo "clone at every depth. Spawning a sub-agent without it is a convention violation."
echo
echo "==================== METHOD (IBR + /invariants — apply, do not just read) ===================="
echo "Skills (in your worktree): .claude/skills/ibr/SKILL.md · .claude/skills/invariants/SKILL.md"
echo "Contract essentials: both section headings ('## Reality-based invariants', '## Chosen invariants');"
echo "records = '### <unnumbered declarative name>' with Invariant/Scope/Mechanism/Generates/Evidence/"
echo "Impossible if true/Verification/Status/Last refined; names use letters/digits/spaces/hyphens ONLY;"
echo "annotate code '// invariant: <exact record name> (<path>)'; checker MUST pass:"
echo "  node .claude/skills/invariants/scripts/check_invariants.mjs --all --refs   (0 problems)"
echo "Merge gate you must satisfy: bunx tsc --noEmit; echo TSC=\$? · bun test · bash scripts/smoke-editor.sh ·"
echo "the checker · bash scripts/conventions-gate.sh"
echo
for contract in "$@"; do
  echo "==================== CONTRACT: $contract ===================="
  cat "$contract"
  echo
done
echo "==================== TASK ===================="
cat "$task_spec"
