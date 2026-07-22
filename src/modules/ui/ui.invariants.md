# UI — Invariants

Load-bearing rules for `src/modules/ui/` (`RootView` and the frame it builds). Stands on
`project.invariants.md`. The rendering-mechanism record is `provisional` because the M3 code
drives rendering imperatively; wiring the coarse frame effect promotes it.

## Reality-based invariants

### A scrollable pane height is an input not an output

**Invariant:** If a pane virtualizes its content by rendering only the window that fits its height,
then that height MUST be fixed independently of the pane's own content — viewport-derived, computed,
or pinned. If the layout lets the height derive from the content, the window walk feeds itself
(taller container → wider window → more rendered → taller container) and the fixpoint is the whole
list.

**Scope:** every scrollable/virtualized pane under OpenTUI's Yoga flex layout — the editor code
area, the file tree, the git changes list, and the git commit log.

**Mechanism:** the render window is a function of container height (`renderGitPanel` derives `bodyH`
from `sidebar.height`; the editor from `editorArea.height`). A flex chain whose parent sizes to
content closes the loop. Pinning the height (sidebar `width`+`height:'100%'`, `editorArea`
`flexGrow:1`+`height:'100%'`, code area `flexGrow:1`) breaks it. Cross-substrate transfer from the
browser `VirtualScroller` (`min-height:0` / viewport-pinned there) — the reality is substrate-
independent; only the pinning mechanism rebinds (CSS flex → Yoga flex).

**Generates:** a stable render window; bounded per-frame cost while scrolling.

**Evidence:** all scrollable panes derive their window height from a pinned ancestor, never from
content. Upheld. (In the browser host this ran away to 2,565→5,265 items in 12s behind a
content-sized container — the impossibility this predicts.)

**Impossible if true:** a scrollable pane whose height derives from its own rendered content (the
window diverges toward the full list).

**Verification:** review — every scrollable pane's height traces to a viewport-pinned ancestor;
a FrameProbe check that rendered-row count stays bounded while wheel-scrolling a large log.

**Status:** established

**Last refined:** 2026-07-21

## Chosen invariants

### Input overlays share one modal slot

**Invariant:** If an input-capturing overlay opens, then it is the only input-capturing overlay
left open; Find and Replace remain two modes of the same `FindBar`, and reserved global chords still
run before the active overlay consumes input.

**Scope:** `FindBar` in find or replace mode, `QuickOpen`, the command palette in
`CommandRegistry`, `SettingsPanel`, and `ContextMenu`. The destructive confirmation overlays and
display-only `Tooltip` are outside this slot.

**Mechanism:** `OverlayCoordinator.openExclusiveOverlay` closes every registered overlay except the
requested one before it runs the requested opener. Every live open path in `Bootstrap.ts` and
`RootView.ts` goes through that coordinator. `Bootstrap.keyTick` resolves reserved global bindings
before overlay routing, and `FindBar.openFor` changes `mode` without closing the shared Find bar.

**Generates:** one active input context; one-keystroke switching between overlays; no masked stale
overlay that reappears when a newer overlay closes; the always-available quit escape hatch.

**Evidence:** `src/modules/ui/OverlayCoordinator.ts`; `src/modules/app/Bootstrap.ts` overlay action
handlers; `src/modules/ui/RootView.ts` context-menu and workspace-folder open paths;
`src/modules/ui/OverlayCoordinator.test.ts`; `scripts/smoke-mode-coherence.sh`.

**Impossible if true:** Find and Quick Open both reporting open; closing Settings revealing a stale
command palette beneath it; Ctrl+F then Ctrl+H creating two bars instead of changing one bar to
replace mode; Ctrl+Q being swallowed by Find, Quick Open, or the command palette.

**Verification:** `bun test src/modules/ui/OverlayCoordinator.test.ts
src/modules/keybindings/__tests__/registry.test.ts && bash scripts/smoke-mode-coherence.sh`

**Status:** established

**Last refined:** 2026-07-22

### One writer per scroll regime per frame

**Invariant:** If more than one authority can change a pane's scroll offset (mouse wheel, keyboard
paging, programmatic scroll-to, and later a scroll animation), then exactly one writes that offset
in a given frame; when authority changes, the newest STOPS the other and adopts the current offset.
Two writers in one frame silently eat input.

**Scope:** every scroll offset — editor `viewport.scrollTop`, `gitPanel.logScrollTop`, tree
selection window.

**Mechanism:** wheel routes through `Workspace.scrollGitLog` / `viewport.scrollBy`; keyboard through
`moveLog` / tree `moveSelection`; each input event is the sole writer for that event. When the
pending scroll animation lands, it must adopt-and-stop on any programmatic jump (see the paused-clock
contract). Cross-substrate transfer from `VirtualScroller` ("One Writer Per Regime").

**Generates:** deterministic scrolling; no lost wheel/keys.

**Evidence:** today only one path writes each offset per event; recorded now to bind the scroll
animation increment.

**Impossible if true:** a frame in which two authorities both write the same scroll offset.

**Verification:** review + a test that a programmatic scroll-to during a wheel gesture yields the
scroll-to's offset, not a blend.

**Status:** provisional

**Last refined:** 2026-07-21

### A context menu is modal and single-consumer

**Invariant:** If a context menu is open, then every pointer and keyboard event belongs to the menu
alone: a click either hits a menu row (running that item) or dismisses the menu — it NEVER also
reaches, activates, or edits anything beneath; a keystroke drives the menu, switches the shared
modal slot to another input overlay, or closes the menu and is consumed. Running an item closes the
menu BEFORE the action executes.

**Scope:** `ContextMenu` (the model), the backdrop + menu overlay in `RootView`, and the modal key
block in `Bootstrap.onKey`.

**Mechanism:** the view mounts an invisible FULL-SCREEN backdrop box (zIndex 125) beneath the menu
box (zIndex 130). OpenTUI stamps every rendered renderable into its hit grid in render order
(zIndex ascending, later stamps win), so while the menu is open every pointer cell resolves to the
menu or the backdrop — the panes beneath are unreachable by construction, not by per-handler
guards. The backdrop's only behavior is `close()`. Keys: `Bootstrap.onKey` short-circuits to the
registry's `menu` context, dispatches `menu.*` actions or a global input-overlay opener through
`OverlayCoordinator`, and closes-and-consumes anything else. Reserved global chords run before this
branch. `ContextMenu.runAt` closes first, then invokes the opener-supplied handler.

**Generates:** reusable menus that are safe over any pane; collective git actions without
misclick hazards; keyboard parity for every menu.

**Evidence:** unit tests (`ContextMenu.test.ts` state machine) + live tmux: right-click menu over
the git panel; a click on the editor area closed the menu with buffer revision AND cursor
unchanged; a menu-item click ran only the collective action. `scripts/smoke-mode-coherence.sh`
opens the buffer-tab menu over the command palette, then switches menu to palette with one F1 chord.

**Impossible if true:** a click that both closes the menu and acts on what is beneath it; a
keystroke that types into the editor or moves a pane selection while a menu is open; an item
action that executes while the menu is still open; switching from the menu to another input overlay
requiring the opening chord twice.

**Verification:** `bun test` ContextMenu tests; `bash scripts/smoke-mode-coherence.sh`; tmux — open
the menu, click elsewhere, assert the menu is gone AND `bufferRevision`/`cursor`/`treeSelected`
unchanged in status.json.

**Status:** established

**Last refined:** 2026-07-22

### A tooltip never intercepts input

**Invariant:** If a tooltip is pending or visible, then it is display-only: it never receives,
consumes, or reroutes any pointer or keyboard event, and any disqualifying input (pointer moved
off the target, any click anywhere, any keypress) hides it immediately.

**Scope:** `Tooltip` (the dwell state machine) and the tooltip overlay in `RootView`
(`HitTransparentText`).

**Mechanism:** the tooltip renderable overrides `render()` to mask OpenTUI's hit-grid stamp for
itself (`HitTransparentText`), so the pointer can NEVER resolve to the tooltip — a click at its
cells hits whatever is beneath, exactly as if the tooltip did not exist. The model only ever
writes its own display refs (`visible/text/anchor`); the dwell advances on the frame tick
(`tick(dtSeconds)` — the momentum/auto-scroll contract) and `Bootstrap` clears on every keypress
and every mouse-down.

**Generates:** hover affordance labels (git action buttons now; scrollbars/tree/diagnostics
later) with zero input risk.

**Evidence:** unit tests (`Tooltip.test.ts` dwell machine: no show before the dwell, cumulative
dwell, jitter keeps the timer, clear disarms) + live tmux: tooltip visible in the pane capture
after a dwell; a click at the same cells acted on the row beneath.

**Impossible if true:** a tooltip that eats a click (a click that would have hit the control
beneath but does not); a tooltip whose state machine writes cursor/selection/scroll state; a
tooltip still visible after a keypress or click.

**Verification:** `bun test` Tooltip tests; grep — `HitTransparentText` masks `addToHitGrid`;
tmux — with the tooltip visible, click through it and assert the underlying action fired.

**Status:** established

**Last refined:** 2026-07-21

### Renderables hold no model state

**Invariant:** If a renderable exists, then it holds only presentation state; it pulls all
domain data from models each `update()` and never mutates a model during render.

**Scope:** `RootView` and every OpenTUI renderable it builds.

**Mechanism:** `update()` reads workspace/editor/theme/commands state and writes renderable
content; renderables store no cursor/buffer/selection truth. Realizes *ivue owns state, OpenTUI
owns projection*.

**Generates:** the stateless view; the ability to rebuild the frame purely from model state.

**Evidence:** `RootView.ts:211-249` — renderables hold no model fields; pulls each update. Upheld.

**Impossible if true:** a renderable that is the source of scroll/selection/cursor truth; a
render pass that writes model state.

**Verification:** review/grep — renderables hold no model fields; `update()` performs no model
mutation.

**Status:** provisional

**Last refined:** 2026-07-21

### Only the visible window is rendered

**Invariant:** If the document, tree, or list is larger than the viewport, then only the visible
window is materialized into renderables each frame — render cost is O(viewport), not O(content).

**Scope:** editor body, file tree, palette list rendering in `RootView`.

**Mechanism:** `renderEditorStyled` slices `document.slice(top, height)` and tokenizes only those
lines; `renderTree` slices the visible tree window; the palette caps at 12. Realizes *Cost tracks
the actively observed set*.

**Generates:** viewport-bounded tokenization; windowed tree/list rendering; flat render cost as
files/repos grow.

**Evidence:** editor body, tree, and palette list all slice to the visible window; since 2026-07-21
the editor ALSO virtualizes COLUMNS — each visible line is sliced to the visible display-column
window (grapheme-safe, memoized boundaries) BEFORE tokenizing, so a 50k-char line drags/renders at
normal speed (verified: 3 drag-selects ≈ 0.1s processing; open+settle 538ms). Trade-off recorded:
tokens start at the slice, so left-context-sensitive highlighting can differ at the window edge.

**Impossible if true:** a frame that tokenizes or builds renderables for every line of a large
file, or every row of a large tree; a frame whose cost depends on total LINE LENGTH rather than
visible columns (the horizontal twin).

**Verification:** a test opening a 100k-line document asserting tokenization count per frame is
bounded by viewport height.

**Status:** provisional

**Last refined:** 2026-07-21

### One file line is one visual row when word wrap is off

**Invariant:** If word wrap is OFF (the default), then one file line renders as exactly one visual
row — long lines clip at the right edge and horizontal scroll covers the rest — so the gutter
(which numbers file lines), the caret Y, selection rows, and click hit-testing all share the same
trivial row mapping. When word wrap is ON, this record does not apply: the row mapping is the
editor's pure logical↔visual layer instead (*Word wrap is a pure view mapping*,
src/modules/editor/editor.invariants.md), and the gutter numbers only a line's FIRST visual row
(continuation rows blank).

**Scope:** the editor gutter + code renderables in `RootView`, wrap-OFF mode only. (Historically
this was recorded as unconditional — "an editor pane NEVER soft-wraps"; word wrap becoming a MODE
on 2026-07-21 scoped it honestly.)

**Mechanism:** the code renderable is `wrapMode: 'none'` in BOTH modes — the renderable itself
never wraps; wrap-ON feeds pre-wrapped SEGMENT rows from the mapping layer, so row identity is
always decided ABOVE the renderable, never by widget wrapping heuristics.

**Generates:** the consecutive-gutter smoke check (wrap-off); the trivial `docLine − scrollTop`
row math every wrap-off consumer uses; the guarantee that toggling wrap OFF restores today's
pixel-identical behavior.

**Evidence:** human-QA regression (a wrapped tail once desynced every gutter number below it);
`smoke-editor.sh` "no soft-wrap" check — consecutive rows carry consecutive gutter numbers;
`RootView` codeBody options keep `wrapMode: 'none'`.

**Impossible if true:** with wrap off, a file line occupying two visual rows, or a gutter number
that disagrees with the file line beside it; in either mode, the OpenTUI renderable (rather than
the row source) deciding where a line breaks.

**Verification:** `smoke-editor.sh` consecutive-gutter check (wrap-off); the wrap-mode inversion
lives with the wrap record (continuation rows have BLANK gutters).

**Status:** established

**Last refined:** 2026-07-21

### The caret renders at the cursor display column

**Invariant:** If the editor is focused, then a caret is drawn at the cursor's **display column**
on its line — not merely a marker in the gutter — accounting for tabs and wide glyphs.

**Scope:** the editor body caret in `RootView`.

**Mechanism:** the view anchors the caret to the code renderable's ACTUAL laid-out screen cell
(`codeBody.x/y` from yoga — never hand-derived layout constants) plus
`displayColumn(line, cursor.col)`, then adds **+1 on both axes** because the native terminal cursor
is 1-based (ANSI CUP; OpenTUI's own `renderCursor` does `screenX + visualCol + 1`). Stands on
*A cursor position resolves to three distinct coordinates* (editor).

In wrap MODE (word wrap, 2026-07-21) the caret cell comes from the SAME logical↔visual mapping the
render used (`wrapVisualPosition`): x = `codeBody.x` + the display column WITHIN the cursor's wrapped
segment (no scrollLeft term — horizontal scroll is inert), y = `codeBody.y` + the cursor's visual-row
index in the window. The 1-based ANSI +1 and the tmux `#{cursor_x},#{cursor_y}` oracle are unchanged —
the caret must agree with tmux's own cursor in EITHER mode.

**Generates:** a real caret; correct visual position on lines with tabs/wide chars; a caret that
stays correct when the layout changes (the anchor moves with the renderable).

**Evidence:** HUMAN-QA BUG FIXED (2026-07-21): the caret rendered one row HIGH — two stacked causes:
(1) 0-based cells passed to the 1-based `setCursorPosition`, and (2) hand-derived x constants that
had drifted from the real layout. Both fixed by anchoring to `codeBody.x/y` + the ANSI +1. Verified
against tmux's OWN cursor position (`#{cursor_x},#{cursor_y}` — the authoritative channel for a
native caret): after typing, the caret cell is exactly one right of the typed glyph's frame cell on
the SAME row. Permanent smoke regression (`smoke-editor.sh` caret-cell check).

**Impossible if true:** a caret drawn in a fixed gutter cell regardless of the cursor column; a
caret whose cell disagrees with the character beneath it on a line with tabs or wide glyphs; a caret
one row/column off from the typed glyph.

**Verification:** the smoke's caret regression — tmux `#{cursor_x},#{cursor_y}` == typed glyph's
FrameProbe cell + (1,0). LESSON: the earlier "established"-by-frame-diff proofs never asserted the
NATIVE cursor cell (FrameProbe cannot see it) — a channel gap human QA caught; tmux's cursor
position is the right oracle for the caret.

**Status:** established

**Last refined:** 2026-07-21

### The selected range renders with a background

**Invariant:** If a non-empty selection exists, then exactly the selected range is drawn with a
selection background, aligned to the model's `selectionRange()`, on the cursor's content row(s).

**Scope:** the editor code renderable in `RootView` (`SelectableText` + `applySelection`).

**Mechanism:** the editor is split into a **gutter** renderable (line numbers + current-line marker)
and a **code** renderable (`SelectableText`, syntax only) so the code buffer holds no gutter —
OpenTUI's native selection then never shades a gutter on a multi-line span, and code-local selection
coords are pure display columns. `applySelection` maps the model `selectionRange()` into
viewport-local cells (`x = displayColumn`, `y = docLine − scrollTop`, clamped to the visible window)
and drives `SelectableText.setSelectionRange` → `TextBufferView.setLocalSelection`
(TextBufferRenderable syncs its view's viewport in `onResize`, so those coords resolve directly).
Stands on *A cursor position resolves to three distinct coordinates* (editor) and *Selection is an
anchor plus the cursor* (editor).
Mouse addendum (2026-07-21): the MODEL is the only selection writer. Mouse events on
the code renderable drive `cursor`+`anchor` (`documentPositionAtCell`: line = scrollTop + rowOffset,
column = `graphemeAtDisplayColumn` — the display→grapheme inverse, unit-tested for wide glyphs and
tabs); `applySelection()` then projects the model into the native highlight each paint. OpenTUI's
OWN mouse-drag selection is DISABLED (`selectable:false`) — it was a second writer the model never
saw, so the next paint wiped its highlight (the human-QA "selection appears then disappears" bug),
and Ctrl+C (which copies the model selection) copied nothing.

The MODEL is the only selection writer (mouse, 2026-07-21). Mouse events on the code renderable drive
`cursor`+`anchor` (`documentPositionAtCell`: line = scrollTop + rowOffset, column =
`graphemeAtDisplayColumn` — the display→grapheme inverse, unit-tested for wide glyphs and tabs);
`applySelection()` then projects the model into the native highlight each paint. OpenTUI's OWN
mouse-drag selection is DISABLED (`selectable:false`) — it was a second writer the model never saw,
so the next paint wiped its highlight (the human-QA "selection appears then disappears" bug), and
Ctrl+C (which copies the model selection) copied nothing.

**Generates:** a visible selection block that tracks the model; multi-line shading without touching
the gutter.

**Evidence:** VERIFIED by FrameProbe frame-diff (`TUI_FRAME_DUMP=1`). Selection on doc line 3, cols
[1,4) → exactly 3 contiguous bg-changed cells on buffer row **y=4** (line 3's content row), x=38..40
in the code area, bg `95,95,95,255`, no gutter cells; multi-line selection spans rows 4–5. The
earlier "~4× scale/offset" was NOT a render bug — it was a FrameProbe defect (it read `bg` as one
value per cell; OpenTUI stores fg/bg as FOUR Uint16 RGBA lanes per cell, so stride-1 reads aliased
one cell's change across four). FrameProbe now decodes 4 lanes (`FrameProbe.read`, regression-tested
in `FrameProbe.test.ts`); the native selection was correctly positioned all along. Confirmed
independently by a scoped codex worker (cross-check).

**Impossible if true:** a shaded range that disagrees with `selectionRange()`; a multi-line selection
that shades the gutter; a highlight offset from the cursor's content row.

**Verification:** FrameProbe frame-diff (before/after a selection; the changed `bg` cells land on the
cursor's content row at the selected display columns — noise-free, proven by a no-action control).
Selection MODEL: `scripts/smoke-editor.sh` (Shift+Right → `hasSelection`, Escape clears; mouse
drag-select → persists across ~1s of frames → Ctrl+C reports copied chars via `lastCopyChars`) +
editor unit tests. Persistence proven: highlight cells identical 1s after the drag.

**Status:** established

**Last refined:** 2026-07-21

### A scrollbar track is derived per frame from its region rect

**Invariant:** If a pane overflows on an axis, then that axis has a scrollbar whose track occupies
the trailing inner edge of the pane's CONTENT rect, derived each frame through the ONE geometry
source; every non-overflowing axis has no bar, and scrollbar visual thickness is axis-independent.

**Scope:** every scrollbar (editor vertical + horizontal, file tree vertical + horizontal, git
changes vertical + horizontal, git commit log vertical + horizontal, and any future pane).

**Mechanism:** `ScrollbarGeometry.Class.scrollbarGeometry(orientation, region, scroll)` is the only
authority for placement, track length, min-thumb inflation, exact-extremes scale, and hidden-when-
fits. `RootView.applyBarGeometry` applies the configured cross-axis cell count; horizontal bars keep
OpenTUI's native drag geometry and repaint with half-height `▂`/`▄` glyphs so N rows carry the same
visual ink as N vertical columns on a roughly 2:1 terminal cell.

**Generates:** a bar on every overflowing axis; aligned tracks across split positions; reachable
clipped content; grabbable thumbs; no phantom bars; equal visual thickness across axes.

**Evidence:** `src/modules/ui/ScrollbarGeometry.test.ts` (17 region/property cases);
`scripts/smoke-scrollbars.sh` (narrow tree/changes/log overflow, real SGR 75 reveal, half-height
horizontal paint vs vertical columns, and fitting-pane absence), wired in `scripts/merge-gate.sh`.

**Impossible if true:** an overflowing tree, changes, or log row whose clipped tail cannot be
reached; a bar visible with nothing to scroll; a horizontal thumb that reads twice as thick as the
same configured vertical thumb; two bars deriving placement from different math.

**Verification:** `bun test src/modules/ui/ScrollbarGeometry.test.ts && bash scripts/smoke-scrollbars.sh`

**Status:** established

**Last refined:** 2026-07-21

### Selection is item-anchored, click-set, keyboard-moved, and stays

**Invariant:** In every selectable list — the file tree, git changes/staging, the commit log, stashes,
and any future list — the SELECTION is persistent state anchored to an ITEM, mutated ONLY by a click
(sets it) and the keyboard (moves it while the list is focused). It is independent of the mouse HOVER (a
separate transient highlight, never selection truth) and of the SCROLL position (scrolling the list never
changes what is selected). The selected item stays HIGHLIGHTED even when its pane is not focused (dimmed
when unfocused, full when focused), so the selection is always visible and the keyboard resumes from it
when the pane regains focus. Opening a FILE additionally moves keyboard focus to the editor (the settled
focus decision) — but that neither moves nor clears the list's selection.

**Scope:** file tree, git changes/staging, git commit log, git stashes, and any future selectable list.

**Mechanism:** selection = an item index/identity in the list model; hover = a separate pointer-row
index; scroll = a viewport offset. Three orthogonal states, each written only by its own input (click,
pointer-move, wheel/scrollbar) — never one by another.

**Generates:** click → set selection (+ open/focus-editor for a file); ↑/↓ while focused → move
selection + reveal; wheel/scrollbar → move viewport only; hover → transient highlight only; blur →
selection stays, highlight dims.

**Evidence:** `FileTree.selectedIndex` vs `hoveredIndex` ("hover highlight only, never selection truth")
vs `scrollTop`; `GitPanel.changesIndex`/`logIndex` vs `changesHovered`.

**Impossible if true:** selection following the mouse hover or the scroll position; a clicked selection
vanishing on scroll or on losing focus; a list where click selects but the keyboard cannot move from
there; different list panes disagreeing on the selection model.

**Verification:** click a row → highlights; wheel-scroll → the SAME item stays selected (highlight rides
the item, not the viewport); focus away → still highlighted (dimmed); Tab back → arrows move it from
there; identical in tree, changes, commits, stashes.

**Status:** provisional

**Last refined:** 2026-07-22
