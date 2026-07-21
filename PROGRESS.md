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
- [ ] **EDITOR REWORK (current, mine):** (a) reactive frame effect — DONE (3b244b2, app.invariants.md);
      (b) grapheme-safe coordinate model — DONE (2a06da1, editor.coordinates.ts + Unicode matrix);
      (c) real caret at display column — DONE (e560996, OpenTUI native cursor; tmux-visual pending);
      (d) selection + copy/cut/paste (Clipboard capability) ← NEXT; (e) multi-workspace; (f) search;
      (g) piece-table undo. Then a tmux end-to-end smoke to promote frame/coordinate/caret invariants.
- [~] M4 — git module INTEGRATED (b5cf988, 7 tests). Remaining: `diff` module (DiffEngine/DiffModel/
      DiffView/DiffRenderable) + the git sidebar UI (staged/unstaged, stage/unstage) + the
      split editable-diff view (left read-only blob, right live buffer).
- [~] M5 — lsp module: codex code + subagent completing contract+tests+2 tsc fixes (running). Then
      integrate + wire to editor (diagnostics render; definition jump; coordinate map grapheme↔UTF-16).
- [~] M6 — markdown MODULE integrated (6cae817, 17 tests, 1+5 contract). Remaining: split-preview UI
      (MarkdownRenderable in a split pane) + toggle command + revision-synced refresh wiring.
- [ ] M7 — plugin demo (kernel composition + one contribution plugin).
- [ ] Gauntlet — 5 refinement passes + independent subagent panel + completeness-critic-until-dry.
- [ ] §5.1 gate green — traceability matrix + checker + lifecycle audit + benchmarks + panel + critic
      + **large-project acceptance test (blackline, isolated worktree)** — see VERIFICATION_RESULTS.md.
      REQUIRED for done; isolation mandatory (throwaway worktree, never touch live blackline-app).

## Delegation (see project.delegation-log.md)
- codex WORKERS FINISHED (they do NOT self-commit — integration is the main loop's job):
  - **git**: reviewed (high quality: stale-supersede, porcelain-v2 parser, non-vacuous 5-record
    contract), fixed $stopEffects cast, INTEGRATED to master (b5cf988). 7 tests pass. ✓
  - **markdown**: code done + typechecks, but codex SKIPPED contract + tests. Completion
    (review + markdown.invariants.md + tests) delegated to subagent — running in codex-markdown worktree.
  - **lsp**: code done but 2 tsc errors (JsonRpc TextDecoder('ascii'); LspTransport stream type) +
    SKIPPED contract + tests. Completion (fix + review + lsp.invariants.md + tests) delegated to
    subagent — running in codex-lsp worktree.
- On subagent return: review its diff/output, run tsc + bun test + checker in the worktree, then
  copy the module into master + commit (credit codex + subagent). LSP↔editor coordinate mapping
  (grapheme↔UTF-16 via editor.coordinates) is wired at M5 integration, not in the module.
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

## Next action (precise, in order)
1. **Integrate lsp** when its completion subagent returns (writes fixes+contract+tests into
   `.claude/worktrees/codex-lsp`): review output, run `bunx tsc --noEmit` + `bun test src/modules/lsp`
   + checker in the worktree, then `cp -r .claude/worktrees/codex-lsp/src/modules/lsp/. src/modules/lsp/
   && rm -f src/modules/lsp/.gitkeep`, verify on master, commit crediting codex + subagent.
   (git + markdown already integrated.)
2. **Selection + copy/cut/paste** (active editor item) — anchor on `Cursor` (add `anchor {line,col}`,
   set/clear + `hasSelection`), shift+arrow + mouse-drag extend, selection-aware insert/delete
   (replace-selection), a `Clipboard` capability (`src/modules/system/Clipboard.ts`, Static:
   wl-copy/xclip/pbcopy + OSC 52 fallback), selection highlight in RootView (bg over the selected
   graphemes via StyleAttrs.bg/reverse). All grapheme-boundary correct (use editor.coordinates).
3. **tmux end-to-end smoke** — build a `scripts/tui-harness.sh` (settle-signal wait via status.json,
   not sleep), drive boot + edit + caret; promote reactive-frame/coordinate/caret invariants to established.
4. Then M4 `diff` module + git sidebar UI + split editable-diff; M5 lsp editor wiring (diagnostics/
   definition, grapheme↔UTF-16 map); M6 markdown split-preview UI + toggle; M7 plugins; gauntlet;
   blackline large-project test (VERIFICATION_RESULTS.md, isolated worktree); §5.1 gate.

## Last commit
6cae817 — M6 markdown module integrated. (Also: b5cf988 git module; editor rework 3b244b2 reactive
frame, 2a06da1 grapheme coordinate model, e560996 native-cursor caret; handoff 6591b0e.)
