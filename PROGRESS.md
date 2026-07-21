# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated every turn so state survives context
compaction. **If you are resuming: read this, then `HANDOFF.md`, then continue at the first
unchecked item.** Full authority granted to finish end-to-end to the §5.1 gate.

## Environment (established)
- Bun `~/.bun/bin/bun` (v1.3.14). Prefix: `export PATH="$HOME/.bun/bin:$PATH"`. Node also on PATH.
- Deps: `ivue@2.0.0`, `vue@3.5.40`, `@opentui/core@0.4.5`, `web-tree-sitter@0.26.11`.
- Runbook: DB-free. Run `bun run <file>`; test `bun test`; typecheck `bunx tsc --noEmit`
  (NEVER pipe tsc through tail/tee — masks the exit code; use `; echo TSC=$?`).
- Invariants checker (in ibr repo, DO NOT copy here):
  `node /home/parallels/dev/ibr/.claude/skills/invariants/scripts/check_invariants.mjs --all|--refs|--score`
- codex workers: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C <worktree> "$(cat prompt)"` in `.claude/worktrees/codex-<mod>` (branch `codex/<mod>`, node_modules symlinked). Prompts: `scripts/codex/*.prompt.txt`.
- OpenTUI: `createCliRenderer({exitOnCtrlC:false,targetFps})`→ renderer; `.root`, `.requestRender()`, `.start()`, `.destroy()`, `.keyInput.on('keypress',KeyEvent{name,ctrl,shift,meta,option,sequence,repeated})`, `.on('resize')`, `.on('frame')`. `BoxRenderable`/`TextRenderable`/`StyledText`/`fg` from `@opentui/core`.

## Governance state
- 5 canonical contracts, checker 0 problems: `project.invariants.md` (+ `project.lattice.md`),
  `src/modules/{editor,ui,workspace,system}/*.invariants.md`. 36 records, 35 annotations.
- Docs (convention `project.<role>.md`): invariants/lattice/decisions/architecture/
  implementation-plan/ivue-reference/skill-upgrades/delegation-log.
- Contracts still to bootstrap (M1–M3): `kernel`, `theme`, `syntax`, `storage`, `commands`, `app`.

## Milestones
- [x] M0 — setup, contracts, architecture docs.
- [x] M1 — boot & frame (kernel seal, OpenTUI two-pane, status side-channel) — fork-built, audited.
- [x] M2 core — workspace/file-tree, theme, read-only viewport, syntax highlight — fork-built, audited.
- [x] M3 core — insert/delete/undo/redo/accel-arrows/palette — fork-built, audited.
- [ ] **EDITOR REWORK (current, mine):** (a) reactive frame effect ← DOING NOW; (b) coordinate
      model (kill surrogate corruption; char/UTF-16/display + Unicode test matrix); (c) real caret;
      (d) selection + copy/cut/paste (Clipboard capability); (e) multi-workspace; (f) search;
      (g) piece-table undo.
- [ ] M4 — git (codex) + diff.
- [ ] M5 — TS LSP (codex) + diagnostics + integrate.
- [ ] M6 — markdown preview (codex).
- [ ] M7 — plugin demo (kernel composition + one contribution plugin).
- [ ] Gauntlet — 5 refinement passes + independent subagent panel + completeness-critic-until-dry.
- [ ] §5.1 gate green — traceability matrix + checker + lifecycle audit + benchmarks + panel + critic
      + **large-project acceptance test (blackline, isolated worktree)** — see VERIFICATION_RESULTS.md.
      REQUIRED for done; isolation mandatory (throwaway worktree, never touch live blackline-app).

## Delegation (see project.delegation-log.md)
- codex git/markdown/lsp: RUNNING in worktrees, 0 commits yet. Review+checker+`bun test` each on commit; merge clean; reconcile coordinate model at integration.
- Audits done: Fable + Opus on M1–M3 (broadly sound; coordinate + reactive-frame the deep gaps). tsc-masking trap noted.

## Rework backlog (audits + own review)
1. Reactive frame effect absent — imperative render() in Bootstrap. → wiring NOW (ui.invariants "Rendering is one coarse frame effect").
2. Coordinate model UTF-16 mislabeled logical; surrogate-splitting backspace; no display cols. → next.
3. No real caret (gutter bar). No selection/copy-paste. Horizontal scroll (scrollLeft) unused.
4. Undo = full-document snapshots (Editor.captureBefore) O(document). → piece table.
5. Multi-workspace absent. File search absent.
6. syntax Highlighter per-line regex (multi-line strings/comments mis-highlight); Tree-sitter = deferred layer.

## Verification approach (non-negotiable)
- Drive real TUI under tmux; assert STATE from `artifacts/status.json` (StatusChannel), pane-capture only for visual.
- tsc green + tests pass at every commit; dispose resources; record benchmarks.

## Next action
Wire the coarse reactive frame effect: one owned `app.$watchEffect(() => { view.update(); publish(); requestRender(); })`; remove imperative `void render()` from input handlers; move `viewport.setSize` to resize+boot only (break setSize feedback edge). Verify tsc+tests, tmux smoke via status.json, commit.

## Last commit
080ed91 — system: Static() capability layer + system.invariants.md.
