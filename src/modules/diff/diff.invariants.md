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
