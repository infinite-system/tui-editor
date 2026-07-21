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

**Invariant:** If a non-empty selection exists, then exactly the selected grapheme range on each
covered line is drawn with a selection background, while each character keeps its foreground
(syntax) color; splits fall only on grapheme boundaries.

**Scope:** the editor body rendering in `RootView` via `ui.selection.ts`.

**Mechanism:** `lineSelectionRange` maps the normalized selection to each line's `[start, end)`
grapheme columns (first line from `start.col`, last line to `end.col`, middle lines full content);
`buildSelectedSpans` splits each syntax span at those boundaries (`graphemeToU16`) and wraps the
selected slice with `bg(pal.selection)` over its existing `fg` (OpenTUI `applyStyle` merges fg+bg).
Stands on *A cursor position resolves to three distinct coordinates* (editor) and *Selection is an
anchor plus the cursor* (editor).

**Generates:** a visible selection block; multi-line selection shading; correct highlight on lines
with tabs, CJK, and combined (ZWJ) emoji.

**Evidence:** `ui.selection.ts` + `RootView.renderEditorStyled`; deterministically unit-tested in
`ui.selection.test.ts` (12 cases incl. `a中文👨‍👩‍👧b` grapheme-boundary split, multi-span, multi-line
ranges) and exercised end-to-end by `scripts/smoke-editor.sh` (Shift+Right → `hasSelection`, Escape
clears). Chunk-level bg is asserted directly (not via pane-scrape — `tmux capture-pane -e` proved
lossy for truecolor bg).

**Impossible if true:** a selected slice that loses its syntax color; a highlight that starts or
ends inside a surrogate pair or a combined emoji; a shaded range that disagrees with the model's
`selectionRange()` columns.

**Verification:** `bun test src/modules/ui/ui.selection.test.ts` (chunk fg/bg + grapheme boundaries);
smoke selection assertions. Per-cell visual verified with `FrameProbe` (`TUI_FRAME_DUMP=1` dumps the
OpenTUI render buffer to `artifacts/frame.json`) — the authoritative visual channel, since
`tmux capture-pane -e` is lossy for truecolor bg.

**KNOWN RENDER BUG (found by FrameProbe 2026-07-21):** the span-splitting LOGIC is correct
(unit-proven), but embedding `bg` chunks in a multi-line `StyledText` mis-positions the shaded cells
— the frame probe shows the selection bg painted on the wrong buffer row (e.g. selection on doc
line 2 paints near y=13, not the cursor's content row). OpenTUI lays out bg chunks differently from
text chunks. **Fix path:** drive OpenTUI's native text selection instead — `TextBufferRenderable`
(`selectionBg`/`selectionFg` + `onSelectionChanged`, backed by `TextBufferView.setLocalSelection`),
mapping the model selection to LOCAL text-buffer coords (account for the per-line gutter/marker
prefix and the visible window). Self-do (editor-core); see PROGRESS RESUME HERE.

**Status:** provisional (logic proven; render integration to be reworked to native selection)

**Last refined:** 2026-07-21
