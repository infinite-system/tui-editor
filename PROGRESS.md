# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated every turn so state survives context
compaction. **If you are resuming: read this, then `HANDOFF.md`, then continue at the first
unchecked item.** Full authority granted to finish end-to-end to the §5.1 gate.

## RESUME HERE (frontier as of commit db0d9a1)
- **State:** 11 module contracts · 136 tests pass · tsc green · checker 0 problems · smoke ALL-PASS
  (20 assertions incl. caret-cell, no-wrap gutter, drag-select persistence, copy, tree-click, hover).
- **HUMAN-QA BATCH COMPLETE (all committed):** caret off-by-one (1-based ANSI + layout-anchored,
  bc06ee8) · wrap-off root cause + right-arrow-opens (80e4c2c) · selection persistence + Ctrl+C
  (one-writer mouse->model, d23dca7) · tree clicks + click-to-focus (966fc8d) · goal-column
  DISPLAY-preservation (e83d89d) · hover highlighting (c0b50b4). De-abbreviation pass landed
  (7254c3c+0a0ea67); naming convention binding (full names, no abbreviations, ALL code).
- **NEXT (user-QA priority order):**
  1. **GIT-PANEL TREATMENT (user actively QA-ing; changes render as raw porcelain + clip):**
     (a) Legibility: 'Staged Changes (n)' / 'Changes (n)' / 'Untracked (n)' section headers; human
     status glyphs (M/A/D/R/U, theme-colored) instead of raw xy codes; '(no changes)' placeholder.
     (b) Scroll parity with the log: wheel+momentum on the changes list, VERTICAL and HORIZONTAL
     (long paths — h-scroll or middle-truncate + full path on h-scroll); THIN DRAGGABLE SCROLLBARS
     both axes on BOTH git regions (changes + log). Reuse scroll-momentum + the frame tick.
     (c) Interactions: single-click selects + acts (stage/unstage toggle via git.stage/unstage),
     hover-bg rows (same StyledText treatment as the tree), then commit->files->diff drill-down.
  2. **Word-wrap MODE (toggleable; user wants it):** view.toggleWordWrap (palette + Alt+Z). ON:
     soft-wrap at viewport width on display-column boundaries; gutter numbers LOGICAL lines
     (continuation rows blank gutter); caret Y via a logical<->visual row mapping layer (build on
     display-column machinery + grapheme memoization); vertical movement by VISUAL row; selection
     spans wrapped rows; horizontal scroll disabled while wrapped. OFF: current clip+h-scroll.
     Record in editor.invariants (caret invariant holds in BOTH modes); FrameProbe-verify both.
  3. Rest of scroll rollout: editor/tree wheel momentum (reuse pattern) + editor scrollbars.
  4. Static-capability pass (single owner, AFTER scroll files settle).
  5. M5 diagnostics/definition + editable diff -> M6 markdown split-preview -> multi-workspace ->
     search -> piece-table undo -> M7 plugins -> 5-pass gauntlet (fuller Claude panel; codex
     cautious/cross-model-only) -> isolated blackline acceptance test -> §5.1 gate.

## Environment (established)
- Bun `~/.bun/bin/bun` (v1.3.14). Prefix: `export PATH="$HOME/.bun/bin:$PATH"`. Node also on PATH.
- Deps: `ivue@2.0.0`, `vue@3.5.40`, `@opentui/core@0.4.5`, `web-tree-sitter@0.26.11`.
- Runbook: DB-free. Run `bun run <file>`; test `bun test`; typecheck `bunx tsc --noEmit`
  (NEVER pipe tsc through tail/tee — masks the exit code; use `; echo TSC=$?`).
- Invariants checker (VENDORED project-local via `npx @invariantai/ibr install`; /ibr + /invariants
  + ivue skills in `.claude/skills`, so codex worktrees inherit them):
  `node .claude/skills/invariants/scripts/check_invariants.mjs --all|--refs|--score`
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
      (d) selection + copy/cut/paste + HIGHLIGHT — DONE (d9a91b8 model; 43cb602 highlight ungated +
      established; gutter/code split + native selection + FrameProbe 4-lane fix); (e) multi-workspace;
      (f) search; (g) piece-table undo.
      tmux harness (`scripts/tui-harness.sh`) + smoke (`scripts/smoke-editor.sh`) built, ALL-PASS.
      **M4 done so far:** windowing core + `--skip=N` paging + reactive `CommitLog` model (data layer,
      tested) + **mouse-event input path** (`useMouse:true`, global `renderer.root.onMouse` recorder →
      status `mouse:{type,x,y,button}`; VERIFIED under tmux: real SGR click at (40,5) → {up,39,4,0};
      harness `click <x> <y>` verb + smoke assertion). OpenTUI mouse = handler-based: attach
      `onMouseDown`/`onMouseDrag`/`onMouseUp` on renderables (called with `this`=renderable, hit-tested
      by x,y, has `isDragging`), events bubble to root.
      **M4 git sidebar — LIVE so far:** git wired into the app (GitRepository+CommitLog+GitPanel off
      Workspace, `Ctrl+G` toggle, frame-effect observes git → status flush); sidebar renders real
      changes + VIRTUALIZED commit log (live-verified on this repo); keyboard log scroll; POSITION-
      ROUTED mouse-wheel scroll on editor/tree/git-log (verified headless + tmux); scroll invariants
      recorded (Container-Is-Input reality, One-Writer chosen).
      **IN FLIGHT — retroactive de-abbreviation pass:** a general-purpose subagent
      (id a6beb8c246efac6ec) is renaming ALL abbreviated identifiers → full names across src
      (ed→editor, pal→palette, ws→workspace, gp→gitPanel, cl→commitLog, cur→current*, idx/i→index,
      etc.), green-gated (tsc + `bun test` + checker). Behavior-preserving. On completion: REVIEW the
      diff for naming quality (esp. context-sensitive sel/cur names), re-verify green, commit. Blocks
      code edits on those files until integrated. Convention recorded (project.decisions.md; codex
      preamble). **codex scroll-port was PULLED** (naming-convention conflict + horizontal x-mapping
      subtlety) — scroll port is now SELF-DO after the rename lands.
      **(a) SMOOTH scroll — commit log DONE** (`scroll-momentum.ts` pure physics + 7 tests; wheel→
      impulse, onFrame steps by real dt clamped [paused-clock], halt on keyboard/jump [One-Writer],
      O(window); live-verified glide+settle). **PORT to editor(vert+horiz)+tree DELEGATED to codex**
      (worktree `codex/scroll`, bg `b3perok2j`, log `.claude/worktrees/codex-scroll.log`,
      prompt `scripts/codex/scroll-port.prompt.txt`). On completion: REVIEW hard — esp. editor
      HORIZONTAL (scrollLeft applied in `renderEditor` display-col-aware + caret/selection x shifted
      by scrollLeft WITHOUT regressing the established x-mapping) — re-verify with FrameProbe
      frame-diff (text shifts left, gutter fixed, caret under cursor) + tmux; merge only if it passes,
      else redo the subtle parts myself. codex told NOT to modify scroll-momentum.ts.
      **Superseded plan text below (a) is stale for the smooth-scroll bullet only.**
      (a-legacy) SMOOTH animated scroll — animate scrollTop over frames via the
      reactive frame effect + inertia (OpenTUI `LinearScrollAccel` in lib/scroll-acceleration);
      regular line-crossing cadence (reparameterized crossing-regularity: device-px→cell-row; sub-cell
      is impossible, don't chase); the animation loop MUST reset its dt clock on resume (paused-clock
      invariant) and adopt-stop on programmatic jumps (One-Writer); still O(window) (fetch+evict while
      animating). Verify: headless `createMockMouse(renderer).scroll` drives the loop (assert cadence/
      final offset) + tmux `scroll` verb (assert scrollTop progression) + FrameProbe frame-diff
      (window advances by whole rows at a regular cadence). Record crossing-regularity + paused-clock
      in the scroll/editor contract. (b) mouse click-to-select + stage/unstage on change rows; (c)
      commit→files→diff drill-down (click/Enter a commit → `git show --name-status` → file → diff;
      breadcrumb back); (d) changes-list scroll + region switching; (e) draggable sidebar width +
      top/bottom separator (divider `onMouseDrag` → reactive split-ratio → yoga relayout).
      Below is the earlier detailed wiring plan (git was NOT yet wired — now DONE):
      1. Instantiate `GitRepository` + `CommitLog` for the workspace root (own them off `Workspace`
         via createX seams; `GitRepository.refresh()` on open; `CommitLog` for the log window).
      2. Panel state (add to `Workspace` or a new `GitPanel` model): view mode
         (changes | log | commit-files | file-diff), selected index per view, split ratio, scroll
         positions. Keep it reactive; unit-test the state transitions.
      3. Render the sidebar git view in `RootView` (or a new `GitSidebar` builder): changes list
         (staged/unstaged/untracked, keyboard stage/unstage) + commit-message box (top); virtualized
         commit log via `CommitLog.rows(scrollTop, viewportH)` + `ensureRange` on scroll (bottom).
      4. Drill-down: click/Enter a commit → `git show --name-status <sha>` changed files → open a file
         → diff (reuse the planned `diff` module or `git show <sha> -- <path>`). Breadcrumb back.
      5. Mouse: `onMouseDown` on rows (click to select/stage), `onMouseScroll` on the log (scroll →
         ensureRange). Draggable width/separator: a divider renderable `onMouseDrag` → reactive
         split-ratio → yoga relayout. Verify all via FrameProbe (4-lane) + status assertions.
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
- ALL 3 codex MODULES INTEGRATED into master; worktrees + branches removed. (codex writes code only,
  no self-commit; skipped tests/contract on markdown+lsp → completed by review subagents.)
  - **git** (b5cf988): stale-supersede repo, porcelain-v2 parser, 2+4 contract, 7 tests. Later fixed
    a $stopEffects footgun in dispose (1fd95de).
  - **markdown** (6cae817): lazy/disposable preview, revision-stamped, 1+5 contract, 17 tests.
  - **lsp** (f0f5334): JSON-RPC + lazy/disposable client, fake-server tests, 2+5 contract, 16 tests.
- ivue gotcha found: `$stopEffects()` clears ref-getter STATE cells (not just effects) — only call it
  on effect-owning classes (see project.skill-upgrades.md).
- Remaining codex-buildable modules (later): `diff`, and `commands`/`keybindings` extensions for M7.
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
See **RESUME HERE** at the top of this file — it is the authoritative frontier. lsp integrated
(f0f5334), selection+clipboard functional (d9a91b8), tmux harness + smoke ALL-PASS. Immediate task:
selection-highlight render in `RootView.renderEditorStyled()`, then re-smoke with a selection
assertion and promote caret/selection invariants.

## Last commit
a48c36b — Harden delegation (embed IBR+/invariants in codex preamble; hard compliance gate).
(Chain: df9627d delegation standard, a462265 FrameProbe + selection-render-bug finding,
06c55a6 selection highlight logic, 79b14fc two-switch keys / frame-effect established.)
