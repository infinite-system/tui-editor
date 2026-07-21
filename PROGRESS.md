# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated every turn so state survives context
compaction. **If you are resuming: read this, then `HANDOFF.md`, then continue at the first
unchecked item.** Full authority granted to finish end-to-end to the §5.1 gate.

## RESUME HERE (frontier as of commit 43cb602)
- **State:** 11 module contracts · 108 tests pass · tsc green · checker 0 problems · end-to-end tmux
  smoke ALL-PASS. codex modules git/markdown/lsp INTEGRATED. Editor rework: reactive frame
  (established), grapheme coordinate model, native-cursor caret, selection + clipboard (model works),
  editor split into gutter + `SelectableText` code renderable. **FrameProbe visual-observation
  channel built + tested** (`TUI_FRAME_DUMP=1` → `artifacts/frame.json`, per-cell char/fg/bg/attrs).
- **OBSERVATION TOOLING (answered):** `tmux capture-pane -e` is LOSSY for truecolor bg (verified —
  even Box backgroundColors don't round-trip). Correct model: drive with tmux, assert STATE from
  status.json (authoritative), assert VISUAL from the app's own render buffer via `FrameProbe`
  (built). Only reach for a headless xterm emulator (xterm-headless / MS `tui-test`) to verify the
  SGR *encoder* end-to-end — low priority. Frame-diff (before/after) isolates a change's cells with
  no offset/color math — that's the gold-standard visual assertion.
- **Selection highlight — DONE, ungated, invariant established.** Editor splits into a gutter
  renderable + a `SelectableText` code renderable; `applySelection` drives native
  `TextBufferView.setLocalSelection` with viewport-local cells. The earlier "~4× coord bug" was a
  **FrameProbe defect**, not a render bug: OpenTUI stores fg/bg as FOUR Uint16 RGBA lanes per cell,
  and FrameProbe read stride-1 (aliasing one cell's change across four). FrameProbe now decodes 4
  lanes (regression-tested). Verified by frame-diff: selection on line N shades line N's row at the
  selected code columns, multi-line = anchor→EOL then BOL→cursor, no gutter. Delegated the root-cause
  probe to a codex worktree; it independently confirmed + I applied the minimal fix in main tree.
  **LESSON:** a visual-oracle is only as good as its decode of the buffer layout — verify the tool
  before trusting its verdict (the frame-diff was noise-free, but the per-cell decode was wrong).

- **NEW REQUIREMENT — M4 git sidebar (VSCode-style, when git pane active):**
  - **Top region:** changes list — staged / unstaged / created / deleted (git module already parses
    porcelain-v2), each row stage/unstage-able (mouse click + key); a commit-message input box
    (clickable) that commits the staged set.
  - **Bottom region:** the commit log as a **virtualized** list (render only the visible window; do
    NOT materialize 10k commits) — backed by a compact paged git-log source, one lightweight record
    per row, evicted outside the window. Realizes *Cost tracks the actively observed set*.
    DONE (foundation): `git.window.ts` (`missingRanges` + `evictable`, pure, 9 tests) +
    `GitCommands.log` offset paging (`--skip=N`). TODO: the reactive `CommitLog` window model
    (sparse cache + `ensureRange` via the paged source, stale-superseded by revision) + the list UI.
  - **Commit drill-down (VSCode-style):** click/open a commit in the log → show that commit's
    CHANGED FILES (`git show --name-status <sha>` / `diff-tree`) → open a file → show its DIFF in the
    editor area (reuse the planned `diff` module: DiffEngine/DiffModel/DiffView, or `git show <sha>
    -- <path>`). A back/breadcrumb path: log → commit files → file diff.
  - **Draggable:** the sidebar width AND the top/bottom separator — a thin divider renderable that
    captures mouse-drag → updates a reactive split-ratio (ivue state) → yoga re-layout via the frame
    effect.
  - **Feasibility: YES** — OpenTUI gives flex/yoga layout, mouse (click + drag) events, ScrollBox +
    manual windowing, and input primitives; ivue gives the reactive split state + the flyweight
    virtualization. New wiring needed: a mouse-event input path (current input is keyboard-only) and
    a paged commit-log source in the git module. Verify mouse/drag + virtualization with FrameProbe.
- **Then, in order:** M4 git sidebar (above) + split editable diff → multi-workspace (WorkspaceManager
  + tabs + per-workspace snapshot restore) → file search → piece-table undo → M5 lsp editor wiring →
  M6 markdown split-preview → M7 plugins → 5-pass gauntlet → isolated blackline test → §5.1 gate.
- **Verify the app end-to-end:** `bash scripts/smoke-editor.sh` (drives the real TUI via
  `scripts/tui-harness.sh`; asserts from `artifacts/status.json`). Harness verbs: launch/ready/
  settle/send/capture/status/field/kill (internal `sleep` works inside the invoked script).
  status.json fields: ready, frame (settle counter), renderQuiescent, activeWorkspace, activeBuffer,
  bufferRevision, dirty, cursor{line,col}, focus, treeRows, treeSelected, overlay, paletteQuery,
  paletteMatches, width, height, git*. Assert STATE from here; pane-capture for visual only.
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
      (d) selection + copy/cut/paste — DONE functional (d9a91b8, Clipboard capability, 7 tests;
      HIGHLIGHT render pending); (e) multi-workspace; (f) search; (g) piece-table undo.
      tmux harness (`scripts/tui-harness.sh`) + smoke (`scripts/smoke-editor.sh`) built, ALL-PASS.
      **NEXT: selection-highlight render (see RESUME HERE), then re-smoke + promote invariants.**
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
