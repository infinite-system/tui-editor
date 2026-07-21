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

**Evidence:** `RootView.ts:143,175,240` — all three slice to the visible window. Upheld.

**Impossible if true:** a frame that tokenizes or builds renderables for every line of a large
file, or every row of a large tree.

**Verification:** a test opening a 100k-line document asserting tokenization count per frame is
bounded by viewport height.

**Status:** provisional

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

**Mechanism addendum (mouse, 2026-07-21):** the MODEL is the only selection writer. Mouse events on
the code renderable drive `cursor`+`anchor` (`documentPositionAtCell`: line = scrollTop + rowOffset,
column = `graphemeAtDisplayColumn` — the display→grapheme inverse, unit-tested for wide glyphs and
tabs); `applySelection()` then projects the model into the native highlight each paint. OpenTUI's
OWN mouse-drag selection is DISABLED (`selectable:false`) — it was a second writer the model never
saw, so the next paint wiped its highlight (the human-QA "selection appears then disappears" bug),
and Ctrl+C (which copies the model selection) copied nothing.

**Verification:** FrameProbe frame-diff (before/after a selection; the changed `bg` cells land on the
cursor's content row at the selected display columns — noise-free, proven by a no-action control).
Selection MODEL: `scripts/smoke-editor.sh` (Shift+Right → `hasSelection`, Escape clears; mouse
drag-select → persists across ~1s of frames → Ctrl+C reports copied chars via `lastCopyChars`) +
editor unit tests. Persistence proven: highlight cells identical 1s after the drag.

**Status:** established

**Last refined:** 2026-07-21
