# Image preview — Invariants

Load-bearing rules for `src/modules/image/` (the dependency-free PNG decoder, the half-block cell
renderer, and the memoised `ImagePreview` seam) and its editor mount (the image branch in
`src/modules/ui/RootView.ts`). Stands on `project.invariants.md` (one-way data flow, cost tracks the
observed set) and the ui rendering records. Prototype scope: non-interlaced 8-bit PNG shown in the
active editor buffer as truecolor half-block cells.

## Reality-based invariants

### A raster image renders as half-block cells sized to the pane

**Invariant:** If a truecolor cell can carry an independent foreground and background colour, then two
vertically-stacked pixels map to ONE cell — the glyph `▀` (U+2580 upper half block) whose foreground is
the TOP pixel and whose background is the BOTTOM pixel. A pane of `columns × rows` cells therefore shows
exactly `columns × (2·rows)` pixels; the image is box-downsampled to that subpixel grid with aspect
preserved (a subpixel is square when sampled `columns` wide × `2·rows` tall), alpha-composited over the
panel background, and centred with panel-background letterbox cells. This is a property of the terminal
cell, not of any one image format: the decoder produces straight-alpha RGBA and the renderer knows
nothing of PNG.

**Scope:** `PngDecoder` (bytes → `{width, height, rgba}`), `HalfBlockRenderer` (RGBA + `columns`/`rows`
+ panel background → `StyledText` of `▀` cells), and `ImagePreview` (decode + render memo). Not the
editor document model, which only supplies the active file path.

**Mechanism:** `PngDecoder.decode` un-filters scanlines (all five filters, Paeth included) and expands
colour types 0/2/3/6 at bit depth 8 to RGBA. `HalfBlockRenderer.render` fits the source into a
`columns × (2·rows)` subpixel box by the tighter of the two scale ratios, box-averages source pixels per
subpixel, composites over the panel background, and emits one `fg(top)(bg(bottom)('▀'))` chunk per cell,
coalescing same-styled runs like the other pane renderers. `RootView.update` swaps the code body to this
`StyledText` when `workspace.activeFileIsImage`, leaving the gutter blank.

**Generates:** a recognizable image in the cell grid at twice the vertical resolution of a full-block;
aspect-correct letterboxing; a renderer that is a pure function of the decoded pixels and the pane size.

**Evidence:** `src/modules/image/HalfBlockRenderer.test.ts` (a 1×2 image maps top→fg, bottom→bg of one
`▀` cell; a wide image in a tall pane is letterboxed with panel-background cells; the fit never exceeds
the pane); `src/modules/image/PngDecoder.test.ts` (every filter + colour type round-trips);
`scripts/smoke-image-preview.sh` drives the real app: opening `/tmp/ivue-cart-dark.png` renders non-blank
`▀` cells with many distinct foreground/background colours.

**Impossible if true:** an image cell whose glyph is not `▀`; a decoded image whose `rgba.length` is not
`width*height*4`; a preview that upscales past `columns × (2·rows)` or distorts aspect; a renderer that
inspects PNG structure instead of the decoded RGBA.

**Verification:** `bun test src/modules/image/ && bash scripts/smoke-image-preview.sh`

**Status:** provisional

**Last refined:** 2026-07-23

## Chosen invariants

### An image buffer replaces the code text and leaves other files untouched

**Invariant:** The active buffer is treated as an image purely by file extension (`.png` for now), and
ONLY then does the code body show the half-block preview instead of syntax-highlighted text; every
non-image file renders exactly as before, and a decode failure shows a friendly one-line message rather
than crashing. The image branch is additive — it reads the same viewport geometry and palette the editor
render uses and writes only the code body and gutter.

**Scope:** `Workspace.activeFileIsImage` (the extension policy), the image branch in `RootView.update`,
and `ImagePreview.render` (the decode-error fallback). Not `PngDecoder`/`HalfBlockRenderer`, which are
format and policy agnostic.

**Mechanism:** `Workspace.activeFileIsImage` mirrors `activeFileIsMarkdown` — false during a diff or with
no document, true when `extname(path).toLowerCase() === '.png'`. `RootView.update` computes it once and,
when true, sets the code body to `ImagePreview.render(path, columns, rows, palette.panel)` and blanks the
gutter; otherwise the unchanged editor render path runs. `ImagePreview` catches any decode error and
returns a `Cannot preview this image` `StyledText`. Decode and render are single-slot memoised so the
per-frame cost is a map lookup, not a re-decode.

**Generates:** image preview with zero regression to text/markdown/diff rendering; a crash-proof preview;
a one-line extension change to support more raster formats later.

**Evidence:** `scripts/smoke-image-preview.sh` — after opening the PNG, `activeFileIsImage` is true and
the pane is half-block cells; opening a `.ts` file next renders its source text (no `▀`), and the app
stays alive; a bad-image path yields the friendly message, not a crash.

**Impossible if true:** a `.ts`/`.md` buffer rendered as half-block cells; an image decode error that
crashes the app; the image branch mutating anything but the code body and gutter; a per-frame re-decode
of the active image.

**Verification:** `bash scripts/smoke-image-preview.sh`

**Status:** provisional

**Last refined:** 2026-07-23
