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

**Mechanism (architecture — DONE):** the editor is split into a **gutter** renderable (line numbers
+ current-line marker) and a **code** renderable (`SelectableText`, syntax only) so the code buffer
holds no gutter — OpenTUI's native selection then never shades a gutter on a multi-line span, and
code-local selection coords are pure display columns. `applySelection` maps the model
`selectionRange()` into code-local coords (`x = displayColumn`, `y = docLine − scrollTop`, clamped to
the visible window) and drives `SelectableText.setSelectionRange` →
`TextBufferView.setLocalSelection`. Stands on *A cursor position resolves to three distinct
coordinates* (editor) and *Selection is an anchor plus the cursor* (editor).

**Generates:** a visible selection block that tracks the model; multi-line shading without touching
the gutter.

**BLOCKED — OpenTUI coordinate mismatch (found by FrameProbe 2026-07-21):** `setLocalSelection`
does NOT interpret coords as the local cell grid. A fixed `(0,0,5,0)` probe (select first 5 cols of
row 0) shaded `y=5, x=28..46` in period-4 groups (a ~4× scale + offset); a real selection on doc
line N lands ~`5 + 4N` rows too low. The visual shading is therefore **gated OFF by default**
(`TUI_SEL_RENDER=1` to experiment) so we ship no highlight rather than a mis-placed one. The
selection MODEL is unaffected and fully working (copy/cut/paste/select-all, `hasSelection`,
`selectionRange`). **Next:** pin down the coordinate space `setLocalSelection` expects (likely a
viewport/`setViewport`/`setFirstLineOffset` or a logical-vs-visual-line issue) using the FrameProbe
frame-diff; the gutter/code split + `SelectableText` are the right substrate and stay.

**Impossible if true (once unblocked):** a shaded range that disagrees with `selectionRange()`; a
multi-line selection that shades the gutter; a highlight offset from the cursor's content row.

**Verification:** FrameProbe frame-diff (before/after a selection; the changed `bg` cells must land
on the cursor's content row at the selected display columns — the frame-diff is noise-free, proven
by a no-action control). Selection MODEL: `scripts/smoke-editor.sh` (Shift+Right → `hasSelection`,
Escape clears) + editor unit tests.

**Status:** provisional (blocked on the OpenTUI coordinate mismatch; model works, visual gated off)

**Last refined:** 2026-07-21

**Status:** provisional (logic proven; render integration to be reworked to native selection)

**Last refined:** 2026-07-21
