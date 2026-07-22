# Diff — Invariants

Load-bearing rules for `src/modules/diff/`. The module stands on the root bounded-viewport and
appearance-fallback records and the UI scroll-writer and scrollbar-geometry records.

## Reality-based invariants

_None specific to diff rendering. The module consumes terminal viewport, glyph, color, and scroll
geometry constraints recorded by its ancestor contracts._

## Chosen invariants

### Both panes share every aligned row

**Invariant:** If a side-by-side diff renders a row, then both panes resolve that row through the
same `alignedRows` index, with `null` representing the filler side of an addition or deletion.

**Scope:** `DiffAlignment.align`, `DiffView.alignedRowScrollOffset`, and both pane windows rendered
by `DiffView.renderPane`.

**Mechanism:** `DiffAlignment.align` produces one ordered `alignedRows` array. `DiffView` slices
that array once per pane with the same `alignedRowScrollOffset` and viewport size; it never stores
independent vertical offsets for previous and current panes.

**Generates:** synchronized vertical scrolling; one filler row per additive imbalance; stable
line pairing after large insertions and deletions.

**Evidence:** `DiffAlignment.test.ts` pure insert/delete cases and the five-to-five-hundred test;
`DiffView.ts` `renderPane` and `setSharedScrollCoordinate`.

**Impossible if true:** the previous and current panes displaying different aligned-row indices
at the same screen row; a large insertion shifting equal lines onto different screen rows.

**Verification:** `bun test src/modules/diff/` and inspection that both `renderPane` calls read
`alignedRowScrollOffset` without a pane-specific vertical offset.

**Status:** provisional

**Last refined:** 2026-07-21

### Replace hunks pair before adding fillers

**Invariant:** If one contiguous change hunk contains deleted and added lines, then the first
`min(deleted, added)` pairs are `modified` rows and only the remaining imbalance becomes `added`
or `deleted` filler rows.

**Scope:** change hunks produced by `DiffAlignment.align` between consecutive equal-line anchors.

**Mechanism:** `appendChangedHunk` pairs deleted and added line-number arrays up to
`pairedLineCount`, then emits only the unpaired tail as one-sided rows.

**Generates:** deterministic replacement alignment; real line numbers on both sides of every
`modified` row; fillers only on the shorter side.

**Evidence:** `DiffAlignment.test.ts` replacement cases for both previous-longer and current-longer
hunks.

**Impossible if true:** a replacement hunk emitting an `added` or `deleted` filler while an
unpaired real line still exists on the opposite side.

**Verification:** `bun test src/modules/diff/DiffAlignment.test.ts`.

**Status:** provisional

**Last refined:** 2026-07-21

### Diff rendering stays viewport bounded

**Invariant:** If aligned content exceeds the visible diff body, then each pane highlights and
materializes only the aligned rows and display columns inside the shared viewport.

**Scope:** `DiffView.renderPane`, `DiffView.sliceLineWindow`, and horizontal scrollbar sizing.

**Mechanism:** `renderPane` slices `alignment.alignedRows` by `alignedRowScrollOffset` and
`viewportAlignedRowCount`; `sliceLineWindow` crops each real line before `Highlighter` receives it.
Horizontal range measurement walks only the visible aligned-row slice.

**Generates:** render work bounded by terminal rows and columns; viewport-local syntax
highlighting; horizontal scroll sized from visible content.

**Evidence:** `DiffView.ts` `renderPane`, `sliceLineWindow`, and `widestVisibleLineWidth`.

**Impossible if true:** one frame highlighting every line in a large diff or tokenizing the full
length of an off-screen line to display one viewport.

**Verification:** inspection that every `Highlighter.Class.highlightLine` call receives text from
`sliceLineWindow` inside the `visibleAlignedRows` loop.

**Status:** provisional

**Last refined:** 2026-07-21

### The editor gutter reflects HEAD changes

**Invariant:** If a normal editor buffer has a git HEAD comparison, then each logical line's first
visual row shows its added, modified, or nearby-deletion status and the markers converge after
buffer edits, saves, active-document changes, and git reconciliation.

**Scope:** The normal editor in `RootView.renderEditor`, `Workspace.activeHeadText`, and
`GutterDiff.statusByLine`. Excludes the empty editor and `DiffView`, which already renders a diff.

**Mechanism:** `Workspace.refreshActiveHeadText` loads the active path through the existing
`gitFileText('HEAD', path)` seam and rejects stale completions. `GutterDiff.statusByLine` projects
`DiffAlignment.align` rows into a cached buffer-line map. `RootView.renderEditor` paints that map in
the existing one-cell gutter marker slot with the theme's `added`, `modified`, and `deleted` colors.

**Generates:** visible working-tree status beside edited lines; one diff algorithm and one git
watcher path for both the side-by-side diff and gutter decorations.

**Rejected alternatives:** A separate line-diff algorithm or filesystem watcher — either creates a
second authority that can disagree with `DiffAlignment` or `GitWatcher`.

**Evidence:** `src/modules/diff/GutterDiff.test.ts`; `scripts/smoke-gutter-diff.sh`; live caller path
`Workspace.gutterDiffByLine` to `RootView.renderEditor`.

**Impossible if true:** a continuation row carrying a duplicate marker; an edited tracked line with
no modified-colored gutter glyph after settling; a git reconciliation leaving markers based on the
previous HEAD; the normal gutter diff appearing over `DiffView`.

**Verification:** `bun test src/modules/diff/GutterDiff.test.ts && bash scripts/smoke-gutter-diff.sh`.

**Status:** established

**Last refined:** 2026-07-21

### The overview ruler locates every change block

**Invariant:** If a diff has change blocks beyond or inside the visible window, then the diff view
marks every block's proportional position on the vertical scroll axis without requiring scrolling.

**Scope:** `DiffView.overviewKinds` and `DiffView.synchronizeOverviewRuler` for side-by-side diffs
mounted by `RootView.syncDiffView`.

**Mechanism:** `DiffView.overviewKinds` projects the existing `DiffAlignmentResult.changeBlocks`
intervals onto the vertical scrollbar's track rows. It reads the first aligned row kind in each
overlapping block and uses the same `Palette.added`, `modified`, and `deleted` colors as the gutters.

**Generates:** a one-cell overview ruler beside the scrollbar; visible top-to-bottom change
distribution; no second diff or scroll authority.

**Rejected alternatives:** Recomputing line differences for the ruler — `DiffAlignment.changeBlocks`
already is the single change-region authority.

**Evidence:** `src/modules/diff/DiffView.test.ts`; `scripts/smoke-diff-overview.sh`; live mount
`RootView.syncDiffView` to `DiffView.synchronizeOverviewRuler`.

**Impossible if true:** a separated top, middle, or bottom change block existing with no matching
colored ruler cell; an unchanged ruler band painted as a change when it overlaps no change block.

**Verification:** `bun test src/modules/diff/DiffView.test.ts && bash scripts/smoke-diff-overview.sh`.

**Status:** established

**Last refined:** 2026-07-21

### The diff pane split stays draggable and persistent

**Invariant:** If a user drags the divider between the previous and current diff panes, then both pane
widths change live from one bounded ratio and that ratio is reused by the next diff open.

**Scope:** `DiffView.paneSplitter`, `Settings.diffSplitRatio`, and side-by-side diffs mounted by
`RootView.syncDiffView`.

**Mechanism:** A ratio-mode `SplitterModel` converts captured pointer movement through the live pane
extent. `DiffView` writes every drag tick to `Settings.diffSplitRatio`, derives both widths from that
single value, and saves once when the drag ends.

**Generates:** a one-cell visible grab strip; complementary previous/current widths; live resize;
persisted split geometry across diff instances.

**Evidence:** `src/modules/layout/SplitterModel.test.ts`; `scripts/smoke-diff-overview.sh`; live caller
`RootView.syncDiffView` attaches the shared `Settings` instance to each `DiffView`.

**Impossible if true:** dragging the divider while the pane widths remain fixed; reopening a diff in
the same session resets a completed split drag to one half; both pane widths growing independently.

**Verification:** `bash scripts/smoke-diff-overview.sh`.

**Status:** established

**Last refined:** 2026-07-21

### Diff selection reuses editor drag behavior

**Invariant:** If text is selected in either read-only diff pane, then the editor's cursor selection
model and shared drag-edge behavior extend the underlying pane text while the aligned diff scrolls.

**Scope:** `SelectionDragBehavior`, `DiffView.createSelectionDragBehavior`, the active read-only
`Editor` selection model, and Ctrl+C routing in `Bootstrap` while `Workspace.showingDiff` is true.

**Mechanism:** Both `RootView`'s normal editor and `DiffView` construct `SelectionDragBehavior` with
their own coordinate/scroll callbacks. Diff hit-testing maps an aligned row to its real side line,
stores the range in an `Editor.cursor`, paints it through `SelectableText`, and copies through
`Editor.copySelection`; filler rows never enter the copied document range.

**Generates:** per-pane click-drag selection; vertical and horizontal drag-edge autoscroll; exact
underlying-text copy; one pointer-rate and lifecycle rule shared with the editor.

**Rejected alternatives:** A native-only diff selection or a second diff-specific selection model —
either can disagree with the cursor range that Ctrl+C copies after repaint or scrolling.

**Evidence:** `src/modules/ui/SelectionDragBehavior.test.ts`; `scripts/smoke-diff-overview.sh`; live
callers `RootView` and `DiffView` both construct `SelectionDragBehavior`.

**Impossible if true:** a diff drag highlight disappearing on repaint; a held bottom-edge drag leaving
the aligned scroll offset unchanged; Ctrl+C copying alignment filler or text outside the model range.

**Verification:** `bun test src/modules/ui/SelectionDragBehavior.test.ts && bash scripts/smoke-diff-overview.sh`.

**Status:** established

**Last refined:** 2026-07-21

### Base and current stay unambiguous

**Invariant:** If a side-by-side diff is visible, then the left pane is named as the HEAD base, the
right pane is named as the working current file, and Open current is positioned with the right pane
and opens that current path.

**Scope:** `DiffView.update`, `DiffView.renderHeader`, header-segment hit-testing, and the
`RootView.syncDiffView` `onOpenFull` callback.

**Mechanism:** Pane title rows carry explicit `Base (HEAD)` and `Current (working)` prefixes.
`renderHeader` places the existing `openFull` segment at or beyond the current pane start, and the
existing header hit map dispatches it to `Workspace.openFileInTab(currentVersionPath)`.

**Generates:** distinct base/current labels; a spatially associated Open current affordance; existing
Previous/Next navigation and change count kept together.

**Evidence:** `scripts/smoke-diff-overview.sh`; live caller path `RootView.syncDiffView` to
`DiffView.renderHeader` and `Workspace.openFileInTab`.

**Impossible if true:** Open current appearing over the base pane; clicking Open current leaving the
diff open or opening the base revision; both panes carrying labels that do not distinguish their roles.

**Verification:** `bash scripts/smoke-diff-overview.sh`.

**Status:** established

**Last refined:** 2026-07-21
