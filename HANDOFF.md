# Handoff — resuming the autonomous TUI build

Read `PROGRESS.md` first (state + next action); this file is orientation.

## What this is
A terminal code workspace on Bun + ivue + OpenTUI + Tree-sitter + git, built to the brief
`FABLE_TUI_EDITOR_BUILD_BRIEF_FINAL.md`, governed by the IBR `/invariants` method. Goal: reach the
brief's Definition of Done AND the completion gate in `project.implementation-plan.md` §5.1.

## Your role
Sole builder + governor on this checkout. You own the critical editor core and ALL review/
integration/verification. Delegate well-scoped implementation to **codex** (worktrees) and
**subagents** to keep your own context lean; do the subtle/central work (coordinate model,
reactive frame, integration) yourself. Review every delegated diff against its module contract +
run checker + `bun test` before merging. Deprecate sub-par delegate output (don't patch around it).

## The invariant loop (per module/milestone)
bootstrap/refine `<module>.invariants.md` → build to it → `/invariants`-review the diff →
run checker + tests + tmux → promote provisional→established → benchmark → commit.

## Key conventions
- Files: `PascalCase.ts` = one class w/ the ivue namespace pattern; `<module>.<role>.ts` = role
  collections; `<module>.invariants.md`/`.lattice.md` colocated. NO HTTP roles.
- ivue: import `Reactive` from `'ivue'`, everything else (`ref`/`shallowRef`/`computed`/`watch`)
  from `'vue'`. Plain getters for cheap derived (not `computed()`). Late dep reads (getters,
  never top-level `new`/snapshot). Owned deps via `createX()` seams (NOT field-init `new X.Class()`).
  Capability classes → `Static()` (vendored `system/Static.ts`); stateful → plain instance.
- Full ivue guide: `project.ivue-reference.md`. Decisions + gotchas: `project.decisions.md`.

## Map
- `src/modules/`: app, kernel, system, storage, workspace, editor, syntax, lsp, diagnostics, git,
  diff, markdown, commands, keybindings, ui, theme. Entry `src/main.ts`; boot `app/Bootstrap.ts`.
- Contracts: `project.invariants.md` + per-module `*.invariants.md`. Checker in ibr repo (see PROGRESS).
- Delegation ledger: `project.delegation-log.md`. Skill feedback: `project.skill-upgrades.md`.

## Verification
Drive the real TUI under tmux; assert STATE from `artifacts/status.json` (the `StatusChannel`
side-channel), never by scraping the pane (visual asserts only). Keep tsc green + tests passing at
every commit. Record benchmarks under `artifacts/`. Dispose all resources (effects via
`$stopEffects`, subprocesses/watchers on close).

## Rules
- Never block on a question — pick the best contract-consistent default, record it in
  `project.decisions.md`, keep going. Surface only a TRUE hard blocker (missing credential /
  ambiguous product call with no safe default).
- Commit frequently with clear messages. Update `PROGRESS.md` every turn.
- codex must not be trusted with deletions; commit before delegating; review its diff.
