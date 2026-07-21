# UI — Invariants

Load-bearing rules for `src/modules/ui/` (`RootView` and the frame it builds). Stands on
`project.invariants.md`. The rendering-mechanism record is `provisional` because the M3 code
drives rendering imperatively; wiring the coarse frame effect promotes it.

## Reality-based invariants

_None specific to the UI — it consumes the project reality invariants (the terminal shows a
bounded viewport; terminal color and glyph support varies) rather than adding its own._

## Chosen invariants

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

**Mechanism:** the view maps the cursor's grapheme index to a display column (the editor
coordinate model) and renders the caret there. Stands on *A cursor position resolves to three
distinct coordinates* (editor).

**Generates:** a real caret; correct visual position on lines with tabs/wide chars.

**Evidence:** IMPLEMENTED — `RootView.ts` `update()` calls `renderer.setCursorPosition(x, y, true)`
with `x` derived from `displayColumn(line, cursor.col)` (tab/wide aware, via `editor.coordinates`)
and hides the cursor when unfocused/off-screen/palette-open. Uses OpenTUI's native terminal cursor.
Pending a tmux visual confirmation of the x/y offset math.

**Impossible if true:** a caret drawn in a fixed gutter cell regardless of the cursor column; a
caret whose cell disagrees with the character beneath it on a line with tabs or wide glyphs.

**Verification:** a harness capture asserting the caret cell matches the cursor's display column
on lines with a leading tab and a wide (CJK) glyph.

**Status:** provisional

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

**Verification:** FrameProbe frame-diff (before/after a selection; the changed `bg` cells land on the
cursor's content row at the selected display columns — noise-free, proven by a no-action control).
Selection MODEL: `scripts/smoke-editor.sh` (Shift+Right → `hasSelection`, Escape clears) + editor
unit tests.

**Status:** established

**Last refined:** 2026-07-21

**Status:** provisional (logic proven; render integration to be reworked to native selection)

**Last refined:** 2026-07-21
