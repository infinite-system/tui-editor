# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated every turn so state survives context
compaction. **If you are resuming: read this, then `project.handoff.md`, then continue at the first
unchecked item.** Full authority granted to finish end-to-end to the §5.1 gate.

## USER PIPELINE (durable — no user request drops; statused per item)

- [x] QA-A. **Shift+wheel horizontal scroll.** RESOLVED — it was already working in the current tree
      (the momentum merge 77dee65 added the `event.modifiers.shift` horizontal branch to the editor
      wheel handler; the user's report predated that merge). FrameProbe-confirmed by DRIVING it:
      SGR shift+wheel-down `\e[<69;…M` shifts content `ABC…`→`345…` (scrollLeft 0→33) and shift+wheel-up
      `\e[<68;…M` reverses to 0. Locked with a smoke assertion in smoke-editor.sh.
- [x] QA-B. **File-list scroll-swim** + **QA-C click-jumps-to-top** (same root cause). The tree window
      was DERIVED from the selection index (`treeWindowTop = selectedIndex - height + 1`), pinning the
      highlight to a screen edge (swim) and snapping to top when a click set a low selection index.
      FIX: FileTree now has an INDEPENDENT scroll offset (scrollTop + viewportHeight) like git-changes —
      wheel scrolls the window (selection stays put), click (setSelection) leaves the scroll untouched,
      keyboard (moveSelection) reveals minimally only when off-screen. Verified live: wheel scrollTop
      0→23 with selection at 0; click a visible row keeps scrollTop 23 and opens the clicked file.
      Locked: 4 FileTree unit tests + scripts/smoke-tree-scroll.sh (ALL-PASS).

- [x] 1. All-scrollbars geometry audit — ONE source (scrollbar-geometry.ts) + visibility predicate
      + 17 property tests + FrameProbe sweep; log-bar alignment FIXED, phantom tree bar FIXED,
      range-reaches-end FIXED (5984766, c679dad). Remaining: fold the sweep into the smoke.
- [x] 2. Keybindings completion — defaults+mac data, kitty super, Bootstrap dissolved, 12 resolver
      tests, tmux sequences verified (1990558). Remaining: fuller Claude review panel on the module.
- [~] 3. Git round 3 — multi-select MODEL + collective actions landed (5984766: selectedPaths,
      stage/unstage/discard-selected w/ multi-path confirm). TODO: ContextMenu component +
      right-click (SGR button-2) + Ctrl/Shift-click + selection-bg render + icons on action buttons
      (theme ladder) + keyboard parity (Space toggle, Ctrl+A, Shift+F10) + checkbox decision record.
- [ ] 4. Hover tooltips on action buttons (reusable Tooltip: ~400ms dwell via frame tick, edge-
      clamped; later: scrollbars/tree/diagnostics).
- [ ] 5. Commit drill-down TREE-STYLE — commits expand INLINE (▸/▾) to changed files (lazy per-sha,
      cached, disposed on collapse); file click -> per-commit diff (read-only unified OK first);
      variable-height virtualization (1+fileCount rows); Right/Left/Enter parity.
- [ ] 6. Word-wrap toggleable mode (palette + Alt+Z; logical-line gutter, wrap-aware caret/
      selection/movement; exclusive with h-scroll; both modes regression-tested).
- [ ] 7. Momentum parity on ALL panes (editor V+H, tree, changes) — one shared engine.
- [x] 8. Idle quiescence — DEMAND-DRIVEN rendering (renderer.auto() + live-request on animations,
      dropLive at quiescence). OpenTUI's loop reschedules itself at targetFps for as long as
      liveRequestCount>0; at rest our only live-holder (syncAnimationLiveness) drops to 0, so the
      loop STOPS. Prod profile: NODE_ENV=production default + TUI_OBSERVE-gated I/O. (68f897e).
      NOW ENFORCED, not just measured: smoke-editor.sh asserts idle FRAME DELTA == 0 over 5s
      untouched (the authoritative signal — the always-run gate, HARD FAIL); perf-baselines.sh's
      idle assertion now exits non-zero on violation too. Re-verified on current HEAD: frame delta 0
      over 5s untouched via the status frame counter (clean env, no instrumentation).
      NOTE on Worker D's 142/145-frame "FAIL": that was measured against the perfbaselines worktree
      BASE (f8771ab), which PREDATES the demand-driven fix (68f897e) — at f8771ab Bootstrap had NO
      dropLive logic, so ~28fps at rest was real THEN and is fixed NOW. The measurement was correct
      for a stale build; it was not a false-green in shipped code. The real gap it exposed — that
      quiescence was measured-once, not enforced-always — is now closed by the smoke assertion.
      BUILD TARGET: `bun run build:prod` -> dist/fable standalone (--external web-tree-sitter unblocks
      --compile; lazy wasm never fires as tree-sitter is unwired; BUILD.md documents run modes +
      the ship-wasm-when-wired follow-up) (bae00b7). Worker D's project.performance-baselines.md folds in on
      merge (its idle numbers are the stale pre-fix build; other metrics — RSS itemization, lifecycle,
      latency-at-30fps — stand and should be re-measured on current HEAD). — 10s at-rest assertion (frame delta 0, CPU ~0; 14% live
      sample to disambiguate), RSS 110MB vs 100MB target itemized (project.performance-baselines.md),
      create/dispose lifecycle stability.
- [~] 9. Static-capability pass — ACCELERATED by partition: codex converting the STABLE legacy bags
      NOW (worktree codex-static, per-file commits, gate-verified, allowlist shrinks per commit;
      log .claude/worktrees/codex-static.log). Tail (editor.coordinates, scroll-momentum, RootView
      shape) converts after the click/scroll/wrap churn lands. NEW-FILE RULE enforced from birth
      (conventions-gate); git.rows + scrollbar-geometry already converted (9ea13f8).
- [ ] 10a. **EDITOR BUFFER TABS (USER PRIORITY — opening a file currently REPLACES the buffer;
      user opened 10 files, no tabs).** Sequence AFTER the in-flight fleet merges to a clean
      checkpoint (touches Workspace+RootView+Editor — conflicts with every running worker; self-do).
      SPEC: (1) open-buffer SET on Workspace — openFile adds/activates (never replaces); a tab bar
      above the editor (name + dirty dot + close ✕, active highlighted); click tab=activate,
      ✕/Ctrl+W=close (dirty→confirm, reuse the confirm-overlay pattern), Ctrl+Tab / Ctrl+PageUp/Down
      cycle, reopening a file focuses its existing tab. (2) LAYERING: buffer tabs (editor region) are
      a DIFFERENT layer from workspace/project tabs (10b) — do NOT conflate; record in
      workspace.invariants ("Workspace and file navigation are separate layers" already exists —
      extend: buffer tabs are the editor layer, workspace tabs the project layer). (3) FLYWEIGHT
      (the real memory concern — tabs RETAIN buffers now): only the ACTIVE buffer holds a live
      reactive document + syntax/undo; background tabs hold a light handle (path + cursor/scroll +
      dirty), rehydrated on activation; closing a tab FULLY disposes its document/undo/syntax
      (coordinate with lifecycle audit item D). IMPOSSIBILITY: "N open tabs do not cost N live
      documents' worth of reactive state." (4) tab bar reuses shared row/hover/click discipline;
      overflow scrolls horizontally (shared momentum engine); keyboard parity throughout.
      VERIFY: open 5 → 5 tabs; click switches active; dirty dot on edit; close disposes (RSS returns
      after closing all — measured); reopen focuses existing; tabs FrameProbe-rendered. Shares the
      buffer-set model with 10b.
- [ ] 14. **SIDE-BY-SIDE DIFF (upgrades the read-only unified diff; user).** Sequence after 10a (or
      interleave — self-contained in the diff module + a DiffView renderable). SPEC: two-pane split
      (LEFT=previous, read-only cold projection; RIGHT=current — the SAME live editable Buffer for
      working-tree diffs [edit recomputes diff live, revision-stamped, stale-discarded], read-only
      cold for commit-drilldown); aligned diff (Myers/LCS → hunks) with BLANK filler rows so panes
      stay row-aligned; per-side gutters (left=old nums, right=new nums, filler blank); added/deleted/
      modified palette colors; jump next/prev change (buttons + Alt+Down/Up or ]c/[c) scrolling BOTH
      panes + "N of M changes" counter; SYNCED vertical scroll (shared momentum engine + scrollbars);
      ONE hunk model feeds render + jump-nav; flyweight (window over the hunk model, never
      materialize the full aligned sequence); close disposes the cold-blob buffer. Record aligned-diff
      + synced-scroll in the diff contract ("Diff mode decorates the live buffer" invariant ported).
- [ ] 10b. Milestone road: M5 diagnostics/definition + editable side-by-side diff · M6 markdown
      split-preview · multi-workspace · file search · piece-table undo · M7 plugins (ScrollPhysics
      or theme plugin demo) · 5-pass gauntlet (fuller Claude panel) · isolated blackline-worktree
      acceptance test · §5.1 gate all-six-green.
- [x] 11. Scroll-feel regression ROOT-CAUSED + fixed (68f897e): the glide halted every frame because
      applyBarGeometry's programmatic scrollPosition sync fired the scrollbar onChange -> halt;
      guarded with applyingBarGeometry (onChange acts only on real thumb drags). Glide now
      self-sustains + settles. FEEL TUNE (bigger impulse/snappier) still open as polish.
- [ ] 11b. (was 11) commit-log wheel scroll FEEL tune — bigger impulse, snappier decay; compare
      IMPULSES (not direct steps) after the per-region routing rework; tick self-sustaining; dt
      clamp unchanged; then tune FASTER (bigger impulse, snappier decay); compare 158ce95 feel;
      verify post-input glide cadence under tmux.
- [x] 12. Diff-open from git panel (VS Code-style; panel stays; read-only colored diff) (0cf3d88).
- [x] 13. Click-double-dispatch + shared status.json (f8771ab): channels are now PER-INSTANCE
      (TUI_STATUS_PATH/TUI_FRAME_PATH; harness per-session status-<s>.json; `field <session> <name>`);
      double-dispatch REFUTED on a clean channel (instrumented: tree click -> cursor {0,0}, zero
      codeBody fires — the reported evidence matched the polluted-channel failure mode) and LOCKED
      by a smoke regression (23 assertions).

### FLEET (launched this turn; worktree-isolated; coordinator merges serially)
- Worker A (Sub-Fable): items 3-remainder + 4 — ContextMenu + right-click + Ctrl/Shift-click +
  tooltips. Worker B: item 5 — inline commit expansion. Worker C: item 6 — word-wrap mode.
- Worker D (Sub-Fable, verification): item 8 — perf-baselines script + project.performance-baselines.md.
- codex #1: item 7 — momentum parity port (worktree codex-momentum, log .claude/worktrees/codex-momentum.log).
- codex #2: item 9 stable partition — Static conversions (worktree codex-static, per-file commits).
- COORDINATOR (me): item 11 scroll-feel regression tune (after codex lands — same code), reviews +
  merges (review gates: naming convention, contracts+checker, session-scoped verification evidence,
  RootView merge conflicts resolved by hand).
- Standing conventions (in `project.handoff.md` + decisions): full descriptive names · one-canonical-set+overlay
  keybindings · destructive ops need confirmation · authoritative-channel verification · delegation
  = full-parity packet, worktree/disjoint isolation, IBR+invariants embedded.

## RESUME HERE (frontier as of commit 77dee65)
- **State:** 256 tests pass · tsc green · checker 0 problems · conventions-gate PASS · smoke ALL-PASS
  (incl. always-run **idle frame-delta == 0**). smoke-wrap ALL-PASS. `conventions @ f41a241`.
- **ALL 4 STALLED WORKERS NOW MERGED** (D perf-baselines b076759 · C word-wrap 23ee28f · A context
  menu+tooltip+git-multiselect ab98fb8 · codex wheel-momentum-parity 77dee65). The momentum merge
  was the high-risk one and was verified clean on all three flagged axes: demand-driven liveness
  (idle delta 0 + a real wheel glide observed to carry past input, settle, and STOP), the
  applyingBarGeometry guard (kept HEAD's per-bar mechanism), and the commit-log glide (unchanged).
- **LANDED THIS BLOCK:**
  - Conventions infrastructure: file-name-follows-content + atomic-bind + `$`-raw-form (replaces the
    `...Implementation` suffix) + fractal-delegation, all with HARD conventions-gate checks
    (fault-injection verified). 9-file PascalCase sweep done (ThemeIcons/ThemePalettes/CommandScoring/
    CommandDefaults/GitParsers/GitWindow/GitRows/GitLogRows/ScrollbarGeometry) + Highlighter $-rework.
  - `Static` migrated to `import { Static } from 'ivue/extras'` (ivue ^2.1.0); vendored copy deleted;
    build:prod recompiles.
  - **Idle quiescence ENFORCED (item 8):** root-caused (OpenTUI loop reschedules while
    liveRequestCount>0; our syncAnimationLiveness drops to 0 at rest → loop stops). The 142/145-frame
    "FAIL" was a STALE measurement of the pre-fix build (f8771ab, predates 68f897e). Now asserted in
    smoke (frame-delta==0, HARD FAIL) + perf-baselines exits non-zero on violation. Re-measured on
    current HEAD: idle delta 0, CPU 0.60%, input latency p50 5ms/p95 7ms (the fix improved latency too).
  - Merged 3 of 4 stalled workers: D (perf-baselines, b076759), C (word wrap, 23ee28f), A (context
    menu + tooltip + git multi-select, ab98fb8). Each reconciled to current conventions on merge.
- **NEXT (in order):**
  1. **Item 10a buffer tabs (SELF-DO).** Foundation `OpenBufferSet.ts` already landed (e193574,
     Reactive flyweight set with injected create/dispose seams + tests). Integrate into
     Workspace/RootView/Editor: open = add-or-focus (never replace), a tab bar above the editor
     (name + dirty dot + close ✕, active highlighted), click=activate, ✕/Ctrl+W=close (dirty→confirm),
     Ctrl+Tab / Ctrl+PageUp-Down cycle. FLYWEIGHT/dispose discipline: only the active buffer (and any
     dirty background tab) holds a live document; clean background tabs dehydrate to a light handle
     and rehydrate on activation; close fully disposes. Impossibility to preserve: "N open tabs do not
     cost N live documents." Buffer tabs are the EDITOR layer; workspace/project tabs are 10b.
  2. **Item 14 side-by-side diff.**
  3. Item 9 tail: convert editor.coordinates/scroll-momentum/RootView to Static (deferred while these
     files churned under the merges); item 11b scroll-feel tune. NOTE: `scroll-momentum.ts` is still a
     bare-function module (on the gate allowlist) — good candidate to convert to `ScrollMomentum.ts`.
  4. → M5 diagnostics/definition + editable diff → M6 markdown split-preview → multi-workspace →
     search → piece-table undo → M7 plugins → 5-pass gauntlet → blackline acceptance → §5.1 gate.
- **Worktrees:** all 4 worker worktrees are merged; their `.claude/worktrees/*` dirs can be pruned
  (`git worktree remove`) when convenient — they hold committed-and-merged branches now.

## Environment (established)
- Bun `~/.bun/bin/bun` (v1.3.14). Prefix: `export PATH="$HOME/.bun/bin:$PATH"`. Node also on PATH.
- Deps: `ivue@2.1.0` (Static via the `ivue/extras` subpath), `vue@3.5.40`, `@opentui/core@0.4.5`,
  `web-tree-sitter@0.26.11`.
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
      + **large-project acceptance test (blackline, isolated worktree)** — see project.verification-results.md.
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
