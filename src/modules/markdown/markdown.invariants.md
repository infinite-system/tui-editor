# Markdown Preview — Module Invariants

Colocated contract for `src/modules/markdown/` (governed at M6 per the root
`project.invariants.md` governance record "Core modules are contract-governed"). These records
specialize the root invariants for the Markdown preview: they stand on the root reality
invariants (`An async result can outlive the state it described`, `The terminal shows a bounded
viewport`, `A referenced resource stays alive`) and the root chosen invariants (`Cost tracks the
actively observed set`, `Async results are revision-stamped and stale results discarded`) — never
the reverse.

Invariants are unnumbered; the name is the identifier and is matched byte-for-byte by
`// invariant:` annotations in the module's source. `bun test` commands run from the worktree root
with `~/.bun/bin` on PATH.

## Reality-based invariants

### A markdown parse can outlive its source revision

**Invariant:** If a markdown parse is produced asynchronously, then it can complete after the
source text it was computed from has already advanced to a newer revision.

**Scope:** `MarkdownParser.parseAsync` and every consumer that awaits it (`MarkdownDocument`).
Specializes the root `An async result can outlive the state it described` for markdown.

**Renegotiable at:** the root contract — this is the markdown instance of a repo-wide concurrency
reality; it cannot be renegotiated inside this module.

**Mechanism:** `parseAsync` yields the event loop (`await Promise.resolve()`) before parsing, and
edits keep arriving while it is suspended; completion order is not arrival order. A debounced
timer widens the window further.

**Generates:** The revision stamp carried on `MarkdownParseResult` and the current-revision guard
before any result is applied (`Applied blocks match the current revision`).

**Evidence:** `MarkdownParser.ts:119-122` (`parseAsync` awaits then parses, returning
`{ revision, blocks }`); `MarkdownDocument.ts:140` (`await this.parser.parseAsync(...)` suspends
across edits).

**Impossible if true:** A design that assumes the awaited parse result always describes the
current buffer text and applies it without checking the revision.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownDocument.test.ts -t "discards a stale parse whose revision no longer matches the source"`

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### Parsing starts only after opening

**Invariant:** If a `MarkdownDocument` or `MarkdownPreview` has not been opened, then it has
allocated no parser, armed no source watcher, and scheduled no parse — the first parse is caused
by `open()`, never by construction or by a source edit.

**Scope:** `MarkdownDocument` and `MarkdownPreview` lifecycle from construction up to the first
`open()`. Stands on the root `Cost tracks the actively observed set` and `A resource lives only
while observed`.

**Mechanism:** The constructor only stores options; the ref-getters (`blocks`, `revision`,
`opened`, `document`, `active`) are lazy ivue cells that hold their defaults until read. The
source watcher and the first `scheduleParse` are set up inside `open()`, and `scheduleParse`
short-circuits while `opened` is false, so a pre-open source revision change arms nothing.

**Generates:** The lazy preview model (no `MarkdownDocument` until `MarkdownPreview.open`); the
`createParser()` seam called from `open()` only; the `opened`-guarded parse scheduler.

**Rejected alternatives:** Parsing eagerly in the constructor — pays parse + effect cost for a
preview the user may never open, violating observation-priced cost.

**Evidence:** `MarkdownDocument.ts:31-36` (constructor stores only `debounceMs`);
`MarkdownDocument.ts:58-71` (`open()` is where the `$watch` is armed and the first parse
scheduled); `MarkdownDocument.ts:119` (`scheduleParse` returns early while `!opened.value`);
`MarkdownPreview.ts:55-63` (lazy getters default `document` to null) and
`MarkdownPreview.ts:73-89` (`open()` constructs the document and arms `$watchEffect`).

**Impossible if true:** A newly constructed, never-opened preview whose `document` is non-null, or
a source-revision bump before `open()` that produces a parse or a non-negative `revision`.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownDocument.test.ts -t "does not parse or allocate a parser before open"`

**Status:** provisional

**Last refined:** 2026-07-21

### Applied blocks match the current revision

**Invariant:** If a parse result is applied to the document, then its stamped revision equals the
current source revision (and the request that produced it is still the latest); a result stamped
with a superseded revision is discarded, never applied.

**Scope:** `MarkdownDocument.startParse` / `applyResult` — every path from an awaited parse to a
mutation of `blocks`/`revision`. Stands on `A markdown parse can outlive its source revision` and
the root `Async results are revision-stamped and stale results discarded`.

**Mechanism:** Each schedule captures a monotonic `requestId`, a `lifecycleGeneration`, and the
revision. `isCurrent` re-checks all three plus `revision === source.revision.value` both before
the await and again in `applyResult` after it, so a late or out-of-order result whose revision has
moved on fails the guard and is dropped.

**Generates:** The revision stamp on `MarkdownParseResult`; the double `isCurrent` guard around the
await; the discard-on-mismatch path.

**Evidence:** `MarkdownDocument.ts:166-173` (`isCurrent` conjoins generation, requestId, and
`revision === this.source.revision.value`); `MarkdownDocument.ts:150-151` (`applyResult` guards on
`isCurrent(result.revision, ...)` before mutating); `MarkdownDocument.ts:135-143`
(`startParse` guards before and after the await).

**Impossible if true:** `blocks` or `revision` holding the output of a parse computed against text
older than `source.revision.value`.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownDocument.test.ts -t "discards a stale parse whose revision no longer matches the source"`

**Status:** provisional

**Last refined:** 2026-07-21

### Closing releases all preview work

**Invariant:** If a `MarkdownDocument` or `MarkdownPreview` is closed or disposed, then its parser
is disposed, its pending parse timer is cleared, its owned effects are stopped, and its reactive
state is reset — no watcher, timer, or effect outlives the close.

**Scope:** `MarkdownDocument.close`/`dispose` and `MarkdownPreview.close`/`dispose`. Stands on the
root `A referenced resource stays alive` (keyed overlays and effects never self-GC) and the
brief's M6 acceptance "closed preview leaves no active render effect".

**Mechanism:** These instances outlive any component scope, so they own their effects via
`$watch`/`$watchEffect` and must release them explicitly. `close()` clears the debounce timer,
invalidates the in-flight request (`latestRequest = ++requestSequence`), disposes the parser,
resets `blocks`/`revision`/`parsing`/`opened`, and calls `$stopEffects()`; the preview cascades
`document.close()` then drops the document ref and stops its own effect.

**Generates:** The `dispose()` → `close()` delegation; `$stopEffects()` after resource cleanup;
the post-close inertness of source edits.

**Evidence:** `MarkdownDocument.ts:79-100` (`close` clears the timer, disposes the parser, resets
state, calls `$stopEffects`) and `MarkdownDocument.ts:102-104` (`dispose` → `close`);
`MarkdownPreview.ts:92-107` (`close` cascades `document.close()`, nulls the ref, calls
`$stopEffects`).

**Impossible if true:** A source-revision change after `close()` that schedules a parse or fires
the render effect; RSS/effect/timer counts that fail to return to baseline across repeated
open/close cycles.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownPreview.test.ts -t "close releases the document and leaves no active render effect"`

**Status:** provisional

**Last refined:** 2026-07-21

### Markdown blocks stay compact

**Invariant:** If the parser emits a block or an inline run, then it is a plain non-reactive
record — inline spans are packed as flat `[start, end, style, linkIndexPlusOne]` integers and the
whole block list is swapped wholesale into one `shallowRef`; there is no reactive object per token,
span, or block.

**Scope:** `MarkdownParser` output (`BlockRecord`, `spans`) and its storage in
`MarkdownDocument.blocks`. Stands on the root `Cost tracks the actively observed set` /
`Ground truth is compact and non-reactive at rest`.

**Mechanism:** `BlockRecord` is a plain object literal; inline styling is encoded as a flat number
array (4 ints per run) plus a parallel `links` string array, never token objects or refs. The
document holds the block list in a single `shallowRef` replaced wholesale on each parse, so
reactivity is one signal for the array, not one per element.

**Generates:** The packed-span encoding consumed by `MarkdownRenderable`; the wholesale
`shallowRef` swap; O(1) reactive edges per parse regardless of block count.

**Rejected alternatives:** A reactive object (or ref) per token/block — hundreds of bytes each
times block count, exactly the cost the flyweight architecture forbids.

**Evidence:** `MarkdownParser.ts:29-42` (compact `BlockRecord`, `spans: readonly number[]`);
`MarkdownParser.ts:313-335` (`createBlock` returns a plain object literal, no ref);
`MarkdownParser.ts:337-392` (`parseInline` packs 4 ints per run);
`MarkdownDocument.ts:38-40` (`blocks` is one `shallowRef` over the array).

**Impossible if true:** A `ref`/`computed`/reactive proxy stored on a per-block or per-span basis;
a `.value` accessor on any `BlockRecord` field.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownParser.test.ts -t "packs inline emphasis strong code and link into flat spans"`

**Status:** provisional

**Last refined:** 2026-07-21

### Preview rendering follows visible rows

**Invariant:** If the preview is rendered, then only the rows inside the requested
viewport (`scrollTop … scrollTop+height`) are instantiated as `PreviewRow` objects; the number of
materialized rows never exceeds the viewport height regardless of document size.

**Scope:** `MarkdownPreview.visibleRows` / `collectRows` and its consumer
`MarkdownRenderable.pullVisibleRows`. Stands on the root `The terminal shows a bounded viewport`
and `Cost tracks the actively observed set`.

**Mechanism:** `collectRows` walks blocks through an `emit` callback that pushes a `PreviewRow`
only when the running row index falls inside `[firstVisible, firstVisible+visibleCount)` and
returns `true` to short-circuit the walk once the window is filled, so at most `height`
`PreviewRow` flyweights exist per frame and blocks past the window are never emitted.

**Generates:** The ephemeral per-frame `PreviewRow` flyweight; the short-circuiting block walk;
viewport-bounded render cost.

**Evidence:** `MarkdownPreview.ts:21-31` (`PreviewRow` documented as an ephemeral flyweight row);
`MarkdownPreview.ts:196-201` (`collectRows` pushes only rows within the window and returns
`rowIndex >= endVisible` to stop early); `MarkdownPreview.ts:135-147` (`visibleRows` bounds output
by `Math.floor(height)`); `MarkdownRenderable.ts:67-81` (`pullVisibleRows` pulls only the visible
window each frame).

**Impossible if true:** A `visibleRows(width, height)` call returning more than `height` rows, or a
render pass that materializes a `PreviewRow` for every block of a large document to show one
screen.

**Verification:** `bun test src/modules/markdown/__tests__/MarkdownPreview.test.ts -t "renders only the visible window of rows"`

**Status:** provisional

**Last refined:** 2026-07-21

### A Markdown file offers a live source preview split

**Invariant:** If the active editor tab is a Markdown file and preview mode is enabled, then the
editable source and the rendered current document appear together in two resizable panes.

**Scope:** `Workspace.showingMarkdownPreview`, `RootView.syncDiffView`, `MarkdownSplitView`,
`MarkdownPreview`, and the `previewToggle` tab-bar segment.

**Mechanism:** The tab button and `markdown.togglePreview` action change one per-path Workspace mode.
`RootView` mounts `MarkdownSplitView` in the live editor slot, moves the existing source renderable
into its left pane, and opens the existing `MarkdownPreview` on the active `TextDocument` revision.
One `SplitterModel` writes `Settings.markdownSplitRatio` live and persists it once on release.

**Generates:** source-only default mode; source and preview together; live edit reparsing; one
clickable and keyboard-bound toggle; persistent pane geometry.

**Evidence:** `src/modules/markdown/MarkdownSplitView.ts`; live mount in
`src/modules/ui/RootView.ts`; `scripts/smoke-markdown.sh` toggle and splitter drives.

**Impossible if true:** enabling preview on an active Markdown tab while only raw source remains;
editing source while the visible preview remains on an older revision; dragging the divider while
both pane widths stay fixed; reopening the split at the default ratio after a completed drag.

**Verification:** `bash scripts/smoke-markdown.sh`.

**Status:** established

**Last refined:** 2026-07-22

### A file reference opens from rendered Markdown

**Invariant:** If a rendered Markdown link or inline-code path resolves to a real file inside the
workspace root, then Ctrl or Cmd click and the hovered Ctrl Enter chord open or focus that file tab.

**Scope:** reference spans from `MarkdownParser`, `MarkdownRenderable.referenceAtCell`,
`MarkdownSplitView` hover and activation, and `Workspace.resolveFileReference`.

**Mechanism:** Rendering and hit-testing share the same visible `PreviewRow` and packed inline-span
coordinates. Workspace resolution strips fragments, rejects external schemes and escapes, and
confirms the target exists before routing through `Workspace.openFileInTab`.

**Generates:** clickable standard Markdown links; clickable backtick file paths; hover emphasis and
an explanatory tooltip; a keyboard activation chord; no-op external or missing targets.

**Evidence:** `src/modules/markdown/MarkdownRenderable.ts` (`referenceAtCell`);
`src/modules/markdown/MarkdownSplitView.ts` (`resolvedReferenceAt`, `openHoveredReference`);
`src/modules/workspace/Workspace.ts` (`resolveFileReference`); `scripts/smoke-markdown.sh`.

**Impossible if true:** a valid in-root backtick path being hovered but unable to open by either
activation; an HTTP URL or path escaping the workspace being opened as an editor file; the drawn
reference text and its clickable cells disagreeing.

**Verification:** `bash scripts/smoke-markdown.sh`.

**Status:** established

**Last refined:** 2026-07-22

### Markdown preview selection reuses editor drag behavior

**Invariant:** If a user drags a selection in the rendered preview, then the shared editor drag-edge
behavior extends one preview text range, autoscrolls that pane, and Ctrl C copies exactly that range.

**Scope:** `MarkdownSplitView.createSelectionDragBehavior`, its read-only preview `Editor`,
`MarkdownRenderable` cell mapping, and Bootstrap copy routing.

**Mechanism:** `SelectionDragBehavior` receives preview-specific cell mapping and scroll callbacks,
while the range itself lives in the existing `Editor.cursor` model and paints through
`SelectableText`. The source editor keeps its own selection and remains the only paste target.

**Generates:** preview drag selection; edge autoscroll; exact rendered-text copy; editable-source
paste without a third selection model.

**Evidence:** `src/modules/markdown/MarkdownSplitView.ts`; shared behavior tests in
`src/modules/ui/SelectionDragBehavior.test.ts`; `scripts/smoke-markdown.sh`.

**Impossible if true:** a preview drag highlight disappearing on repaint; a held edge drag leaving
preview scroll and selection unchanged; Ctrl C copying raw Markdown punctuation absent from the
rendered selection; Ctrl V mutating the read-only preview.

**Verification:** `bun test src/modules/ui/SelectionDragBehavior.test.ts && bash scripts/smoke-markdown.sh`.

**Status:** established

**Last refined:** 2026-07-22

### Markdown panes keep independent find state

**Invariant:** If source and preview are searched in turn, then each pane retains its own query,
match list, current match, and visible highlights when focus moves to the other pane.

**Scope:** `FindBar.openForTarget`, source and preview target identifiers, RootView source
highlighting, and `MarkdownRenderable` preview highlighting.

**Mechanism:** `FindBar` stores one `FindInBuffer` engine per stable pane identifier instead of one
global engine. Each renderer reads only its own retained engine, and each target owns match reveal.

**Generates:** Ctrl F bound to the focused pane; simultaneous source and preview highlights; separate
queries and match counters; find-only behavior in the read-only preview.

**Evidence:** `src/modules/search/FindBar.ts`; `src/modules/ui/RootView.ts` (`findTarget`);
`src/modules/markdown/MarkdownSplitView.ts` (`findTarget`); `scripts/smoke-markdown.sh`.

**Impossible if true:** searching the preview replacing the source query or match list; a preview
match moving the source cursor; a source match being painted in the preview pane.

**Verification:** `bash scripts/smoke-markdown.sh`.

**Status:** established

**Last refined:** 2026-07-22
