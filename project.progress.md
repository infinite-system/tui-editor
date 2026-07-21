# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated every turn so state survives context
compaction. **If you are resuming: read this, then `project.handoff.md`, then continue at the first
unchecked item.** Full authority granted to finish end-to-end to the §5.1 gate.

## USER PIPELINE (durable — no user request drops; statused per item)

- [x] QA-A. **Horizontal scroll via Option+wheel (SGR 74/75) — confirmed on the user's terminal.**
      The earlier shift+wheel "fix" was a FALSE-GREEN: xterm-family terminals SWALLOW Shift+wheel (68/69)
      for their own scrollback and forward nothing — a tmux-injected smoke passed while the real user
      path stayed dead (injecting into tmux bypasses the terminal layer that fails). The user's `cat -v`
      capture settled it: Option+wheel arrives as **74/75** (delivered), Shift 68/69 swallowed, native
      tilt 66/67 terminal-dependent. FIX: the editor wheel handler routes to horizontal on
      direction left/right (covers 66/67 and 74/75, which OpenTUI decodes as left/right) AND on the
      alt/shift modifier (covers Option-vertical 72/73 + the Shift bonus). Verified by DRIVING:
      Option+wheel-right 75 → scrollLeft 0→27, Option+wheel-left 74 → back to 13, alt-vertical 73 → 32.
      The smoke is a ROUTING test (74/75) — real delivery is terminal-dependent, confirmed out-of-band.
- [x] QA-B. **File-list scroll-swim** + **QA-C click-jumps-to-top** (same root cause). The tree window
      was DERIVED from the selection index (`treeWindowTop = selectedIndex - height + 1`), pinning the
      highlight to a screen edge (swim) and snapping to top when a click set a low selection index.
      FIX: FileTree now has an INDEPENDENT scroll offset (scrollTop + viewportHeight) like git-changes —
      wheel scrolls the window (selection stays put), click (setSelection) leaves the scroll untouched,
      keyboard (moveSelection) reveals minimally only when off-screen. Verified live: wheel scrollTop
      0→23 with selection at 0; click a visible row keeps scrollTop 23 and opens the clicked file.
      Locked: 4 FileTree unit tests + scripts/smoke-tree-scroll.sh (ALL-PASS).

- [ ] QA-BATCH (scroll/scrollbar/glyph/settings — user, approved). Reuse scrollbar-geometry; verify by
      DRIVING; tsc-green gate. Items:
  - [ ] A. Tooltip CENTERED horizontally over the cursor/anchor (midpoint aligns to cursor column),
        still above-by-default with the near-top flip + h-clamp (3ec106d).
  - [ ] B. Glyph ladder (merge w/ #10): nerd→unicode→ascii glyphs for checkbox CHECKMARK + git status
        MODIFIED/DELETED/ADDED/UPDATED + the o/d/+ action buttons. Keep in the theme; degrade cleanly.
  - [ ] C. Scrollbars on EVERY overflowing pane, BOTH axes (git commits + files + all): vertical AND
        horizontal when that axis overflows; inertia; draggable thumb + click-to-page; via scrollbar-geometry.
  - [ ] D. UNIFY scrollbar thickness: vertical & horizontal same; for now = average of the two current
        thickness values, one hardcoded constant everywhere (later a setting).
  - [ ] E. Higher vertical fling ceiling (again) — much faster hard fling; keep decel + gentle precision
        + One-Writer halt. (In flight: VERTICAL_MOMENTUM profile.)
  - [ ] F. Fast-scroll MODIFIER (velocity/step multiplier on top of E), modifier read from SETTINGS
        (not hardwired — Ctrl+wheel is terminal-swallowed like shift; awaiting user's confirmed key+SGR).
  - [ ] G. SETTINGS PANEL (approved): reactive settings.json (~/.config/fable/ + project override),
        ivue reactive state so changes LIVE-APPLY (no restart); Ctrl+, opens it as a pane. Seeds: scroll
        physics (fling ceiling/accel/friction/lines-per-notch), h-scroll modifier (default Option/Meta),
        fast-scroll modifier+multiplier, scrollbar thickness (default = D's averaged constant), glyph mode
        (auto/nerd/unicode/ascii), theme/palette, word-wrap. Migrate E's ceiling into a DEFAULT the panel overrides.

- [x] Cmd+Left/Right → line-start/line-end (user QA). CORRECTED: commit 2da0384 was a FALSE GREEN — it
      verified Home/End via tmux injection and ASSUMED the terminal translates Cmd→Home, but iTerm2
      "Natural Text Editing" actually sends RAW ^A/^E (0x01/0x05), so Cmd+Left was hitting Ctrl+A=Select
      All. FIX: drove the real byte streams and found raw ^A (seq=0x01) is DISTINGUISHABLE from a Kitty
      Ctrl+A (seq='a'); onKey now diverts raw ^A → lineStart (guarded by renderer.useKittyKeyboard so
      legacy Ctrl+A stays Select All), and a Ctrl+E binding gives Cmd+Right (raw ^E) → lineEnd (was
      unbound). Driven-verified: Cmd+Left→col 0, Cmd+Right→col 26, Ctrl+A→Select All — ALL LIVE.
- [ ] SYMLINK node_modules ignore-robustness (LOW priority, defensive): a top-level `node_modules`/`.git`
      that is a SYMLINK isn't matched by the `node_modules/` (dir) gitignore pattern, so it surfaces as
      `?? node_modules` in the demo worktree. Make the watcher-skip AND panel-hide treat a top-level
      node_modules/.git as ignored whether dir or symlink (match the name); keep git's ignore semantics
      for everything else. Verify in a symlinked-node_modules worktree (panel omits it, no watch through it).
- [x] GIT LIVE-REFRESH BUG (user, priority): the git panel ignored EXTERNAL working-tree changes.
      Root cause: GitWatcher existed + passed its own tests but was NEVER wired (built-but-unwired —
      its isolated tests were green precisely because they never checked the app uses it). FIX: wired
      GitWatcher into Workspace.open() (callback → git.refresh(), disposed on teardown via
      workspace.dispose() ← app.onDispose). Bun's recursive fs.watch DOES fire for nested files on
      Linux (verified by driving — no fallback needed). Enforcement: scripts/smoke-git-watch.sh drives
      the whole app — external nested modify+add+delete → panel 0→3 with NO in-app action → revert →0
      (ALL-PASS). AUDIT for other built-but-unwired: MarkdownRenderable (M6) + LanguageClient (M5) are
      referenced only by their own files/tests — but those are FORWARD-milestone modules (built ahead,
      not yet integrated), not bugs; surfaced for when M5/M6 land.

- [x] TAB-BAR AFFORDANCES (user QA): (1) COUNT badge ` active/total ` pinned right, click opens a
      DROPDOWN of ALL buffers (reused ContextMenu; click a row → activates that tab). (2) BIGGER arrows
      (« » in padded 3-cell hit targets), bright when more tabs exist that way, dim at the end. (3)
      CUTOFF ellipsis … at the overflow edge so a clean cut never reads as "no more". PLUS: the arrows
      now PAN the strip viewport (independent tabStripScrollOffset) and NEVER change the active tab
      (VS Code behaviour); active-change auto-reveals but panning doesn't snap back. Driven-verified:
      badge 1/8, badge-click opens dropdown, click-row activates, right-arrow pans [file-2,3,4]→[3,4,5]
      with active UNCHANGED. smoke-tabs.sh extended (ALL-PASS). FOLLOW-UP: keyboard nav INSIDE the
      dropdown (Down/Enter) doesn't activate (click works) — a ContextMenu keyboard-path nuance to chase.

- [x] TAB-BAR QA (user): arrows CLICKABLE + pinned at the RIGHT edge (single geometry source shared by
      render + hit-test, so draw pos and hit-rect can't disagree); Ctrl+PageDown/PageUp cycle is
      DETERMINISTIC positional (advance one, wrap; active index maps 1:1 to visible order); close ✕ has
      consistent padding (never flush); tab hover-highlight + close-hover + arrow idle/hover/pressed
      states, all from the palette. Driven+confirmed: right-arrow click 0→5, cycle 7→0 wrap, hover bg
      change. Lock: scripts/smoke-tabs.sh (ALL-PASS).

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

## LIVE QUEUE (user QA during audit work — priority-ordered)
- ✅ **DONE — Invariant-contract system + behavioral suite** (c7b7cff): scripts/behavioral-contracts.sh
  (essence-based, ratcheted) + scripts/smoke-settings-applied.sh (all 13 settings driven) + meta-gate in
  conventions-gate. Rules in requirements.md (assert-essence, ratchet, subsystem-touch).
- ✅ **DONE — Perf regression: divider drag saved per-tick** (6ab4324): now persists ONCE on release.
- ✅ **DONE — Bug 1 scrollbarThickness moves-not-thickens** (6a0c6a3): the Slider cross-axis wasn't
  stretched; now paints N columns, x-position fixed. Verified by painted-column count.
- ✅ **DONE — Bug 2 wordWrap scroll** (969b96a): wrap scrollTop = VISUAL rows — momentum glide (same
  engine) + visual-row extent (reaches true last visual row, scrollTop 565 >> 200 lines). RATCHETED.
- ✅ **DONE — Momentum "regression"**: driven-disproved (no non-wrap regression; cb85111 kept the impulse
  feed). The felt gap was wrap-mode direct scroll = folded into bug 2. Gated by momentum-glide contract.

### REMAINING
3. **Grip handles on dividers (low-med):** visible GRIP glyph on the sidebar divider (vertical: nerd grip
   → ⋮/┃/║/▕ → ascii ':'/'|') + git divider (horizontal: ⋯/═/┅ → ascii '-'), theme icon ladder. 3 states
   idle→hover→pressed (brighten to accent on hover, pressed color on drag) — reuse the existing hit-strip
   hover hooks. TUI can't change the OS mouse-cursor shape, so a grip is the discoverability signal.
   Drive-verify: FrameProbe grip glyph present; hover brightens; drag still resizes+persists. (RootView/theme.)
4. **Context-menu adaptive positioning (medium):** mirror tooltip flip (3ec106d/c69ec4a). Default open
   RIGHT+BELOW cursor; flip HORIZONTALLY to LEFT of cursor near right edge (anchor menu's right edge at
   cursor so it extends left — user wants leftward so it coexists with VS Code's own right-click menu),
   flip vertically ABOVE near bottom; clamp fully on-screen. Same for submenus. Generous right-side flip
   threshold. Drive-verify: right-click (SGR button-2) near each edge/corner → FrameProbe menu fully
   visible + flips; mid-screen opens right+below. Extend context-menu smoke. (RootView/ContextMenu.)
   NOTE: the overlap the user saw is VS Code's host terminal menu (terminal.integrated.rightClickBehavior)
   — their setting, not our bug; but adaptive positioning is still correct.

## AUDIT PACKAGE STATUS (3-Sonnet audit, 2026-07-21; packet in scratchpad AUDIT_FINDINGS_PACKET.md)
Disease = build-but-don't-wire. Session frontier HEAD **c7ee4d8**. Progress:
- **HARDENING (highest leverage) — DONE:** `scripts/check-unwired-capabilities.sh` (in conventions-gate
  #7) fails if any namespace+Static/Reactive module is referenced only by its own file+test. Allowlist =
  LSP/Markdown (M5/M6) + DiffView (P1 in-flight, REMOVE when mounted). Surfaced EXACTLY DiffView beyond
  the known list — no other dead capabilities. Definition of Done + merge rule + contract-liveness
  encoded in project.requirements.md (inherited by every worker via the packet). Commit ce869e8.
- **P2 settings single-source — DONE (all 8, each drive-verified):** wordWrap (dbc3886) · gitSplitRatio
  (9007476) · linesPerNotch + horizontalScrollModifier + fastScrollModifier + fastScrollMultiplier — the
  fast-scroll GESTURE was built new (cb85111) · theme + glyphMode via Bootstrap reactive hooks (c7ee4d8).
  Plus scrollbar-thickness unify (ca4a578) + sidebar-divider drag hit-grid fix (fd9db66) + draggable git
  divider (15e5156). Correctly-wired-already: verticalFlingCeiling/scrollAccelGain/scrollFriction/
  sidebarWidth/scrollbarThickness.
- **P3 applied-effect e2e gate — NEXT (the structural lock-in):** build scripts/smoke-settings-applied.sh
  driving EACH of the 13 settings' observable effect (recipes all proven this session — see commit
  messages: wordWrap=MARKER row, theme=bg RGBA, glyphMode=glyph char, linesPerNotch/fastScroll=scrollTop,
  sidebarWidth/scrollbarThickness/gitSplitRatio=frame geometry) + a schema-enumeration META-GATE (every
  SettingsValues key MUST have a covered drive or the gate fails). Wire the meta-gate into conventions-gate.
- **P1 DiffView — NEXT (last unwired capability):** FIRST fix DiffView.ts:262-278 hardcoded momentum ->
  the settings-driven verticalMomentum pattern (Workspace.ts:94-104); THEN mount via
  Workspace.openChangeAtRow/openCommitFileDiff + RootView; then REMOVE DiffView from the unwired allowlist
  (gate then proves it wired). Add a driving test (open a diff -> DiffView tab renders).
- **P4/P5 cleanup — LATER (fan out as DISJOINT worktrees once RootView/core quiescent):** col->column
  (72x, touches RootView — do when not mid-RootView) · system/ manifest backfill (FrameProbe/StatusChannel/
  Logging are MY verification substrate — do carefully/myself) · scroll-momentum->Momentum capability ·
  palette entries git.togglePanel/settings.toggle · LSP coordinate-dup (M5-pending).
- **DELEGATION NOTE:** codex-theme worker DEPRECATED (scope violation — touched forbidden RootView + 10
  other files, pulled in unassigned row-simplification). Redone solo. Lesson logged: don't delegate wiring
  near actively-edited RootView; codex ignores scope fences. See project.delegation-log.md #6.

## RESUME HERE (frontier as of commit 6fc0858 — pre-audit; see AUDIT PACKAGE STATUS above for newer)
- **READ FIRST on resume/cold-start:** `project.requirements.md` (persistent cross-cutting brief) →
  `project.conventions.md` → this file (USER PIPELINE below) → `project.invariants.md` → in-flight contracts.
- **HEAD = 6fc0858** · git status CLEAN · tsc green · conventions-gate PASS · **0 workers in flight.**
- **MERGED CAPABILITIES available to wire:** `src/modules/diff/` (DiffAlignment aligned-row model +
  DiffView, item 14 — NOT yet mounted in a tab), `src/modules/layout/SplitterModel.ts` (reusable
  draggable-divider model — merged; sidebar divider drafted in RootView but the 1-cell childless bar is
  NOT in OpenTUI's mouse hit-grid so drag doesn't register — panel-path resize works), `src/modules/
  settings/` (Settings store + SettingsPanel — live for scroll physics; word-wrap/theme/thickness/glyph TAIL pending).
- **DONE since last anchor:** Cmd+Left/Right disambiguation (raw ^A/^E vs Kitty Ctrl+A — corrected the
  2da0384 false-green, 9694579) · Settings LIVE-APPLY for scroll physics (1afc574) · sidebar-width
  drives layout live (dead-setting #1 fixed, 29c9d29 — user-CONFIRMED ✅) · **FILE-TREE VERTICAL SCROLLBAR landed (6fc0858,
  scrollbar-both-axes pane #1 of the elevated priority)** — drive-verified via TUI_DEBUG_BARS
  (trackLeft=29→left=28, visible, inside the 32-wide sidebar; the earlier "not rendering" was a
  false-negative from a persisted sidebarWidth=76 that put the thumb at col ~73 off the probed range).
- **NEXT (coordinator priority order; RootView integration = mine; delegate isolated builds to codex):**
  1. **SCROLLBARS BOTH-AXES — elevated TOP priority, land pane-by-pane.** Status:
     · tree vertical ✓ DONE (6fc0858).
     · editor v+h ✓ DONE + AUDITED (ca4a578 era) — drove a long-line file: editor-scrollbar-h renders
       at the editor-area bottom (trackLeft=5→left=5 top=35), v-bar at the right edge (laidX=118). Works.
     · UNIFY THICKNESS ✓ DONE (ca4a578) — every bar reads settings.scrollbarThickness LIVE + uniform
       (both axes, every pane); applyBarGeometry sets the cross-axis size each frame. Drove =3→3 cells,
       =1→1 cell. Default 1.
     · git STAGING/CHANGES horizontal + git COMMITS/LOG horizontal — **DEFERRED to fold into the
       git-panel ROW SIMPLIFICATION (item 2/4)**: horizontal windowing must slice each row + shift the
       interactive hit-zones (checkbox col, +/- action buttons pinned right, gitActionButtonAt), and the
       row simplification REWRITES exactly that render+hit-test code. Doing h-scroll first = reworking
       hit-tests that immediately change (bottleneck principle — one rework, not two). The git v-bars
       already exist; the high-value horizontal case (long code lines) is the editor, done.
     · diff v+h — blocked on mounting DiffView in a tab (item 4/old-queue) first.
     Shared ScrollbarGeometry; draggable thumb + click-to-page + inertia.
  2. **GIT-PANEL ROW SIMPLIFICATION (user, LOCKED spec — supersedes single-glyph-checkbox 23616f9,
     now SUPERSEDED):** REMOVE the per-row checkbox column entirely (its stage/unstage duplicates the
     +/- action buttons). Status = an ICON GLYPH via the theme ladder (nerd→unicode→ascii), theme-colored:
       · MODIFIED → pencil: nerd `` (nf-pencil) · unicode ✎ (fallback ●) · ascii `M` — AMBER/yellow.
       · DELETED  → cross/trash: nerd `` (nf-trash) · unicode ✗ · ascii `D` — RED.
       · ADDED (staged new) → PLUS: nerd `` (nf-plus-circle) · unicode ＋ · ascii `+` — GREEN.
       · UNTRACKED (new, unstaged) → QUESTION: nerd `` · unicode ? · ascii `?` — GREEN (matches git ??).
       · RENAMED → arrow: nerd `` · unicode → · ascii `R` — BLUE.
     ascii row = `M / D / + / ? / R` (NOT letters for added/untracked — user wants + and ?). Color does
     half the work (green=added/untracked, amber=modified, red=deleted, blue=renamed). Net row:
     `[status glyph] filename … [+/- open discard]`. PRESERVE BULK STAGING: each SECTION header
     (Staged / Changes / Untracked) gets a stage-all / unstage-all action; row-level +/- for individual
     files. Verify by DRIVING: FrameProbe a changes row shows the glyph (not a letter in nerd/unicode)
     and NO checkbox; +/- stages/unstages; section stage-all works. (RootView/git-panel/theme — mine.)
  2b. **DEAD SETTING #3 — wordWrap (user-found, LIVE dead control, PRIORITY BUG; same pattern as
     sidebarWidth #1, and #2 the settings-tail):** toggling "Word wrap" in the panel wraps NOTHING.
     Root cause (coordinator-verified): TWO sources of truth. EditorWrap.ts has the engine ($wrapLine);
     `settings.wordWrap` (Settings.ts:36/115) is the reactive boolean the PANEL flips; but
     CommandDefaults.ts:68 `view.toggleWordWrap` → getEditor().toggleWordWrap() flips a SEPARATE
     editor-internal flag. The editor renders from ITS OWN flag → the panel toggle changes the setting
     and nothing wraps. FIX (single source of truth): the editor's wrap-enabled state READS
     settings.wordWrap reactively (flip setting ⇒ wrap/unwrap live); `view.toggleWordWrap` flips
     settings.wordWrap (not a private flag) so command + panel stay in sync; editor renders via
     EditorWrap when settings.wordWrap is true at the content width. Drive-verify: long line, panel
     wordWrap ON → FrameProbe the line spans multiple rows within editor width; OFF → one row + h-scroll;
     also verify the command path flips the SAME state. Land the wordWrap applied-effect e2e test (item 11)
     as part of this fix — it's the canonical case for the enforced meta-test.
  2c. **DEAD SETTING #4 — gitSplitRatio (user-found, PRIORITY BUG; same class as #1/#3):** changing
     "Git changes/log split" does NOT move the boundary between the Changes/Staging list and the Commit
     Log. Root cause: the git panel doesn't derive its changes-vs-log split point from
     settings.gitSplitRatio reactively. FIX (mirror sidebarWidth exactly): the vertical division between
     the Changes/Staging region and the Commit Log region is computed from a reactive value =
     settings.gitSplitRatio (clamp 0.1–0.9), so the panel moves the split LIVE and the future draggable
     git divider updates the SAME persisted value. Drive-verify: set gitSplitRatio via the panel →
     FrameProbe the boundary row between changes and log moves; extremes 0.1/0.9 clamp sanely. Add its
     applied-effect e2e test alongside (item 11 suite).
  3. **SPLITTERS DRAG (user-confirmed TOP priority, alongside scrollbars):**
     (a) SIDEBAR divider hit-testable — the 1-cell CHILDLESS bar isn't in OpenTUI's mouse hit-grid, so
     beginDrag/dragTo/endDrag never fire (panel-path resize works, drag doesn't). Give it a REAL hit
     region (a divider renderable with actual width / a child cell spanning the column height) + a
     hover/grab affordance (highlight). Drive-verify: tmux press-drag on the divider COLUMN → FrameProbe
     sidebar width changes + persists to settings.sidebarWidth.
     (b) GIT changes/log divider — horizontal SplitterModel driving settings.gitSplitRatio, SAME
     hit-testable-region approach (this ALSO fixes dead-setting #4 gitSplitRatio, item 2c).
     Both persist via onSizeChange → Settings and stay in sync with the panel (single source of truth).
     Add applied-effect e2e tests (drag → size change → persisted) to the item-11 settings-e2e suite.
  4. DIFF-VIEW integration — mount DiffView as a diff TAB; open-full + jump-next/prev + N-of-M counter.
  5. SEARCH SUITE (4 codex workers, user priority): fuzzy quick-open (reuse CommandScoring.fuzzyScore);
     in-file find/replace; ripgrep find-in-files panel (rg 14.1.1 installed); project-wide replace.
  6. TAB count-badge DROPDOWN CARET (▾) with idle/hover/press states.
  7. FILE-TREE QA: tighter per-level indent (single indentWidth constant, later a setting) + REMOVE the
     leading chevron (folder glyph conveys open/closed); keep the whole row clickable.
  8. SETTINGS GEAR button in the bottom status bar (toggles Ctrl+,).
  9. Cmd+Up/Down → doc start/end — AWAITING user's `cat -v` bytes (do NOT assume — burned twice).
 10. Settings live-apply TAIL — word-wrap / theme / scrollbar-thickness / glyph-mode read the store.
 11. **SETTINGS E2E APPLIED-EFFECT TESTS (user, ENFORCED INVARIANT — pairs with "measured ≠ enforced /
     verify by driving"):** for EACH settings field, a REPEATABLE e2e test that sets the value through
     the real settings path (as the panel does) → asserts the REAL observable effect BY DRIVING
     (status.json / FrameProbe / behavior) → changes it again → asserts it changed. This is the exact
     failure mode just hit: sidebarWidth was a live panel control that did NOTHING (RootView didn't read
     it) — a dead setting a persist-only test can't catch. Per-field coverage:
       · verticalFlingCeiling → a fling caps at the new ceiling (fold into the existing momentum test).
       · scrollAccelGain / scrollFriction / linesPerNotch → scroll distance/decay changes measurably.
       · horizontalScrollModifier → the configured modifier routes a wheel to horizontal (set vs another).
       · fastScrollModifier / fastScrollMultiplier → holding the modifier multiplies the scroll step.
       · scrollbarThickness → the rendered bar occupies the set column/row count (FrameProbe).
       · glyphMode → forcing nerd/unicode/ascii changes rendered glyphs (FrameProbe a known glyph).
       · theme (dark/light) → palette colors in the framebuffer change.
       · wordWrap → a long line wraps vs not (FrameProbe row count).
       · sidebarWidth → sidebar column count changes (the dead one).
       · gitSplitRatio → the staging/log split point moves.
     REPEATABLE = deterministic, reset state each run via the fake-fs/settings seam; part of the
     ALWAYS-RUN gate so a future dead-setting FAILS the gate. **META-ASSERTION:** enumerate the settings
     schema and assert every field has a corresponding applied-effect test — adding a new setting without
     an e2e test FAILS the gate. Turns "every setting must actually apply" into an enforced invariant, not
     a hope. Implement alongside the settings-wiring TAIL (item 10).
 12. Low-pri: symlink node_modules ignore-robustness; fast-scroll modifier [F] (awaiting key); tab-dropdown keyboard nav.
- **BUDGET RULE (coordinator):** codex = DEFAULT worker for almost everything; Fable/opus only for the
  genuinely hard reasoning, and keep the concurrent Fable/opus count MODEST. codex never trusted with deletions.
- **State:** 269 tests pass · tsc green · checker 0 · conventions-gate PASS (now hard-blocks tsc-fail) ·
  smoke-editor + smoke-tabs + smoke-tree-scroll ALL-PASS (incl. idle frame-delta==0). `conventions @ f41a241`.
- **LANDED SINCE THE 4-WORKER MERGES (newest first):** tooltip centered-over-cursor (A, c69ec4a) ·
  Settings MODEL layer merged (G-model, b612f22: reactive settings.json ~/.config/fable + project
  override, live-apply, fake-fs seam, 9 tests) · tab-bar QA — clickable right-pinned arrows (one
  geometry source), positional cycle, hover/press states, close padding (56d2772, smoke-tabs.sh) ·
  higher vertical fling ceiling (E, 85d4343: VERTICAL_MOMENTUM max 220/impulse 34; horizontal
  unchanged) · git action GLYPH icons via theme ladder (#10, bc0ec26) · conventions-gate hard-blocks
  tsc (9c3a2d5) · file-tree independent-scrollTop fix — swim + click-jump (4ce2e1d) · Option+wheel
  horizontal (QA-A, ffbab62) · tooltip above-placement (3ec106d) · buffer TABS (10a, aeeae26).
- **IN FLIGHT (background codex worker):** item 14 side-by-side diff CORE — `codex exec` building
  `src/modules/diff/` (DiffAlignment aligned-row model + DiffView) in worktree `.claude/worktrees/
  codex-diff` (branch codex-diff). NO auto-notification (launched detached); on resume: check
  `.claude/worktrees/codex-diff/src/modules/diff/` + `/tmp/.../scratchpad/codex-diff.log`, review,
  merge (new files, disjoint), then integrate into RootView/tabs (mine). Packet:
  `/tmp/.../scratchpad/codex-diff-prompt.txt`.
- **NEXT (coordinator priority order), all RootView integration = mine; delegate isolated new-file
  capability builds to CODEX (separate budget) via `codex exec --dangerously-bypass-approvals-and-sandbox
  -C <worktree>` — do NOT use Claude Agent worktree isolation (targets the wrong repo) and do NOT add a
  shell `&` (double-background); one `codex exec` per worktree, poll the worktree:**
  1. **Settings PANEL UI** (Ctrl+, pane) over the merged reactive model — seed scroll physics / h-scroll
     modifier(Option) / fast-scroll modifier+multiplier(F, awaiting user's confirmed key) / scrollbar
     thickness(=D avg constant) / glyph mode / theme / word-wrap; live-apply (momentum + renderers read
     the reactive settings); migrate E's ceiling into a settings DEFAULT.
  2. Scrollbars on EVERY overflowing pane BOTH axes (C) + UNIFY thickness to the averaged constant (D)
     + file-tree scrollbar — reuse ScrollbarGeometry, feed each pane's scrollTop/scrollLeft+viewport.
  3. Glyph ladder (B): checkbox CHECKMARK + git status MODIFIED/DELETED/ADDED/UPDATED (extend ThemeIcons).
  4. Draggable Splitters (H): one reusable capability — sidebar width + git changes/log divider; sizes
     persisted to settings.
  5. Integrate the diff worker's output (item 14) into a diff tab; jump-nav + N-of-M + synced aligned-row scroll.
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
