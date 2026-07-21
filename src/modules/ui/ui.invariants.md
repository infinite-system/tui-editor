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

**Open question:** the selection highlight (shift/mouse) lands with the selection rework.

**Verification:** a harness capture asserting the caret cell matches the cursor's display column
on lines with a leading tab and a wide (CJK) glyph.

**Status:** provisional

**Last refined:** 2026-07-21
