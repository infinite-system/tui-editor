# Layout — Invariants

Load-bearing rules for `src/modules/layout/` — the reusable draggable-divider model behind both the
sidebar-width divider and the git-split divider. Stands on `project.invariants.md`. `SplitterModel`
is a pure model: pointer positions in, a bounded size out, no renderable. Records are `provisional`
until the coordinator mounts the bar and drives them through a live divider.

## Reality-based invariants

### A split ratio stays within zero and one

**Invariant:** If the splitter reports in ratio mode, then the reported size is always within [0,1] —
a pane cannot own a negative share of the axis nor more than the whole of it.

**Scope:** `SplitterModel` with `mode: 'ratio'` (the git-split divider); the value read from
`size.value` and delivered to `onSizeChange`. Cells mode is unbounded above by design and out of scope.

**Mechanism:** `clamp` intersects the configured [minimumSize, maximumSize] with [0,1] whenever the
mode is ratio, so a mis-configured bound outside [0,1] cannot leak an out-of-range ratio; the seed in
`get size()` is clamped too, so even an out-of-range `initialSize` starts valid.

**Generates:** the host can multiply the ratio by any axis extent to place the divider without
re-validating the range.

**Evidence:** `SplitterModel.ts` `clamp` pins ratio mode into [0,1]; tests "the ratio stays within
zero and one under an extreme drag" and "ratio never escapes [0,1] even with mis-configured bounds"
drive it past both ends.

**Impossible if true:** a ratio-mode `size.value` observed below 0 or above 1.

**Verification:** `bun test src/modules/layout/SplitterModel.test.ts` — the ratio-mode extreme-drag
cases assert 0 and 1 at the limits.

**Status:** provisional

**Last refined:** 2026-07-21

### A pointer delta converts to size through the axis extent

**Invariant:** If the splitter reports in ratio mode, then dragging the pointer by N cells changes the
ratio by N divided by the axis extent — the cell-to-ratio mapping is arithmetic over the total cells,
not a free parameter.

**Scope:** `SplitterModel` ratio-mode drags; `unitsPerCell` and its use in `dragTo`. In cells mode the
factor is exactly 1 (one dragged cell is one cell).

**Mechanism:** `unitsPerCell` returns `1 / totalExtentCells` in ratio mode; `dragTo` multiplies the
pointer delta by it before applying. A zero-or-negative extent yields a factor of 0, so a ratio drag
with no calibrated extent cannot move rather than dividing by zero.

**Generates:** `setExtentCells` — the host recalibrates the same drag math on a window resize by
updating the extent, with no other change.

**Evidence:** `SplitterModel.ts` `unitsPerCell` and `dragTo`; tests "a cell delta converts to a ratio
delta through the extent" (extent 20 → 0.05/cell) and "setExtentCells recalibrates a ratio drag"
(extent 10 → 0.10/cell).

**Impossible if true:** a 4-cell drag over a 20-cell extent moving the ratio by anything other than
0.2.

**Verification:** `bun test src/modules/layout/SplitterModel.test.ts` — the ratio-mode conversion
tests assert the exact ratio.

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### A reported size never leaves its configured bounds

**Invariant:** If any code path sets the splitter size (construction seed or a drag), then the value it
stores and reports is within [minimumSize, maximumSize].

**Scope:** every write to `size` in `SplitterModel` — the `get size()` seed and `dragTo` via
`applySize`. Both the stored `size.value` and the `onSizeChange` payload.

**Mechanism:** the ONLY size writes route through `clamp`; there is no unclamped setter. `dragTo`
applies the pointer delta to the drag-start anchor and clamps the sum, so a drag can never walk the
size past a bound by accumulation.

**Generates:** the host lays panes out directly from `size` with no bounds re-check; persisted values
reloaded as `initialSize` are re-clamped on the next construction.

**Evidence:** `SplitterModel.ts` `clamp` guards every write; tests "clamps at the maximum", "clamps at
the minimum", and "an out-of-range initialSize is clamped at construction".

**Impossible if true:** a `size.value` outside [minimumSize, maximumSize] after any begin/drag/end
sequence.

**Verification:** `bun test src/modules/layout/SplitterModel.test.ts` — the clamp cases drag far past
each bound and assert the bound value.

**Status:** provisional

**Last refined:** 2026-07-21

### Only a drag in progress moves the size

**Invariant:** If `dragTo` is called while no drag is in progress (before `beginDrag` or after
`endDrag`), then the size does not change and no `onSizeChange` fires.

**Scope:** `SplitterModel.dragTo` and the `dragging` flag; the whole begin/drag/end lifecycle.

**Mechanism:** `dragTo` returns immediately unless `dragging.value` is true; `beginDrag` sets the flag
and re-anchors the pointer and size, `endDrag` clears it. Stray pointer moves outside a drag (the host
routes ALL moves, dragging or not) are therefore inert.

**Generates:** the host can forward every pointer-move to `dragTo` without gating on drag state — the
model gates itself.

**Evidence:** `SplitterModel.ts` `dragTo` guard on `dragging.value`; tests "dragTo before beginDrag is
a no-op" and "endDrag stops tracking — later dragTo calls are ignored".

**Impossible if true:** `size.value` changing from a `dragTo` call issued while `dragging.value` is
false.

**Verification:** `bun test src/modules/layout/SplitterModel.test.ts` — the lifecycle cases assert the
size is untouched outside a drag.

**Status:** provisional

**Last refined:** 2026-07-21

### Size changes flow through the onSizeChange seam

**Invariant:** If a drag changes the reported size to a new value, then `onSizeChange` fires exactly
once with that value; a clamped no-change move fires nothing.

**Scope:** `SplitterModel.applySize` and the `onSizeChange` seam; the host wires it to the Settings
store to persist the divider.

**Mechanism:** `applySize` compares the next size to the current one and returns without notifying when
they are equal, otherwise it stores the value and calls `onSizeChange`. The seam defaults to the
constructor callback and is overridable by a subclass.

**Generates:** the host persists the divider by supplying `onSizeChange`, with no polling of `size`.

**Evidence:** `SplitterModel.ts` `applySize` and `onSizeChange`; tests "fires with the new size on
every change" and "does not fire when the clamped size is unchanged".

**Impossible if true:** the size settling on a new value with no `onSizeChange` call, or a run of
`onSizeChange` calls all carrying the same value.

**Verification:** `bun test src/modules/layout/SplitterModel.test.ts` — the persist-seam cases assert
the exact sequence of notified values.

**Status:** provisional

**Last refined:** 2026-07-21

### The splitter model carries no renderable dependency

**Invariant:** If a module imports `SplitterModel`, then it pulls in no OpenTUI, renderable, or
terminal dependency — the model is plain numbers in and out, so its logic is unit-testable with no TUI.

**Scope:** `src/modules/layout/SplitterModel.ts` imports; the boundary where a future editor would be
tempted to reach for a renderable or hit-testing. The bar, hit-testing, and cursor live in the host
(RootView), not here.

**Mechanism:** the model takes scalar pointer positions and reports a scalar size; it imports only
`ivue` and `vue` (reactivity). Rendering and pointer projection are the host's job, kept out of this
file by construction.

**Generates:** the same model backs BOTH dividers (sidebar width and git split) and runs headless in
the test suite.

**Evidence:** `SplitterModel.ts` imports are `ivue` and `vue` only; `SplitterModel.test.ts` drives the
full API with plain numbers and no renderer.

**Impossible if true:** an `import` of OpenTUI or any renderable/terminal module in `SplitterModel.ts`.

**Verification:** `grep -nE "opentui|Renderable|render" src/modules/layout/SplitterModel.ts` returns
nothing; `bun test src/modules/layout/` runs with no TUI.

**Status:** provisional

**Last refined:** 2026-07-21
