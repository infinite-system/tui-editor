# Editor — Invariants

Load-bearing rules for `src/modules/editor/` (`Editor`, `TextDocument`, `Cursor`, `Viewport`)
and the `storage` undo store it drives. Stands on `project.invariants.md`; references are by
name. Several records are `provisional` because the fast-built M3 code partially violates them —
those violations are the coordinate/selection rework backlog, and each record's Verification is
what promotes it to `established` as the rework lands.

## Reality-based invariants

### A cursor position resolves to three distinct coordinates

**Invariant:** If a position in a document is referenced, then its grapheme index, its UTF-16
offset, and its display column are distinct values, and each consumer uses the coordinate its
domain requires — editing on graphemes, LSP on UTF-16, rendering on display columns.

**Scope:** Cursor, selection, all edit operations, LSP position mapping, the view's caret and
column readout. Per line (positions are line-relative).

**Mechanism:** An explicit coordinate model over each line's string converts grapheme ↔ UTF-16 ↔
display column, accounting for surrogate pairs, combining marks, wide (2-column) glyphs, and tab
expansion. Realizes the project invariant *A text position has several encodings* inside the
editor.

**Generates:** grapheme-safe movement and backspace; a UTF-16 mapping layer for the LSP client;
a display-column caret and wide/tab-aware rendering; the coordinate test matrix.

**Evidence:** `project.invariants.md` → *A text position has several encodings*. Current code
conflates all three as UTF-16 (`TextDocument.ts:120,143`, `Cursor.ts:3` labels col "logical" but
uses `String.length`/`.slice`) — the gap this record governs.

**Impossible if true:** a backspace that deletes half a surrogate pair; a caret drawn at a column
that disagrees with the character beneath it on a line containing tabs or wide glyphs.

**Open question:** current M3 code is UTF-16-only; the coordinate rework establishes the
three-coordinate model before LSP and selection build on it.

**Verification:** a coordinate test matrix over ASCII, astral (emoji), combining marks, wide
(CJK) chars, tabs, and CRLF — asserting movement/backspace land on grapheme boundaries and the
display column matches the rendered caret.

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### Every document mutation bumps the revision exactly once

**Invariant:** If the document's line content changes, then `revision` is incremented exactly
once for that change, so async consumers (syntax, LSP, git) can stamp and discard stale results.

**Scope:** All `TextDocument` mutation methods.

**Mechanism:** Each mutator (`insertInline`, `splitLine`, `deleteBackward`/`Forward`, `setLine`,
`insert`/`removeLine`, `replaceAll`, `restore`) does `this.revision.value++` after the edit.

**Generates:** the revision-stamping substrate that *Async results are revision-stamped* consumes;
the syntax/LSP stale-drop.

**Evidence:** `TextDocument.ts:44,87,94,100,110,125,138,148,170,188` — every mutator bumps once.

**Impossible if true:** a mutation that changes lines without bumping `revision`; a single edit
that bumps twice (double-invalidation).

**Verification:** a test asserting `revision` increments by exactly 1 per edit op and is unchanged
by pure reads (`line`, `slice`, `text`).

**Status:** provisional

**Last refined:** 2026-07-21

### Undo records deltas not whole-document snapshots

**Invariant:** If an edit is recorded for undo, then the stored cost is proportional to the edit
size, not the document size.

**Scope:** `storage/UndoStore` + `Editor.captureBefore`.

**Mechanism:** Undo stores the inverse edit (range + removed/inserted text) against the piece
table, not a full `_lines.slice()`. Realizes *Cost tracks the actively observed set* for edit
history.

**Generates:** O(edit) undo memory; the piece-table delta store; bounded history that scales to
large files.

**Evidence:** currently VIOLATED — `Editor.ts:41` snapshots `document.snapshot()` (`_lines.slice()`)
per keystroke, O(document) each; `storage/UndoStore.ts` is the snapshot fallback. The piece table
named in `project.decisions.md` #7 is unbuilt.

**Impossible if true:** undo memory that grows with file size rather than with the number/size of
edits.

**Open question:** rework replaces snapshot-undo with a piece-table delta store; until then this
is the known cost stress on large files.

**Verification:** a test editing a large document and asserting per-step undo memory is bounded by
edit size, not line count.

**Status:** provisional

**Last refined:** 2026-07-21

### Selection is an anchor plus the cursor and edits replace it

**Invariant:** If a selection is active, then it is the range between a fixed anchor and the live
cursor, and any insert/delete/paste replaces exactly that range and collapses the selection;
copy/cut read exactly that range as grapheme-correct text.

**Scope:** `Cursor` (anchor), `Editor` selection + edit/clipboard ops, the view's selection
highlight.

**Mechanism:** Cursor gains an optional anchor; shift+movement and mouse-drag set/extend it;
edits with an active selection delete the range first; copy/cut/paste go through the `Clipboard`
system capability. Spans use the grapheme coordinate model (first reality invariant above).

**Generates:** shift+arrow / mouse-drag selection; selection-aware editing; copy/cut/paste; the
selection highlight in `RootView`.

**Evidence:** IMPLEMENTED — `Cursor.ts` `anchor` + `selectionRange()` (normalized); `Editor`
selection-aware `insertText`/`insertNewline`/`backspace`/`deleteChar` (replace-selection),
`copySelection`/`cutSelection`/`pasteClipboard` via `system/Clipboard.ts` (Static, OS tools + OSC 52),
`selectAll`, extend-on-shift movement; `Bootstrap` wires shift+arrow extend + Ctrl+C/X/V/A. Tested:
`editor/__tests__/selection.test.ts` (7 tests, grapheme-correct multi-line ranges). The visual
selection HIGHLIGHT in RootView is pending the tmux visual pass.

**Impossible if true:** typing over a selection that leaves the selected text in place; a copy
that returns text split mid-grapheme; a paste that inserts without removing the selection.

**Verification:** tests for shift-extend, replace-on-insert, and copy/cut/paste round-trip
(including a multi-line and an astral-char selection).

**Status:** provisional

**Last refined:** 2026-07-21

### The editor owns no view state

**Invariant:** If the editor holds state, then it is document/cursor/selection/viewport model
state only — never terminal geometry or rendering artifacts; the view pulls from the editor and
writes nothing back into it.

**Scope:** `Editor`, `Cursor`, `Viewport` vs `ui/RootView`.

**Mechanism:** The editor exposes model state; `RootView.update()` reads it to build renderables
and holds no model state. Realizes *ivue owns state, OpenTUI owns projection* and *Data flows one
way* at the editor boundary.

**Generates:** the stateless renderable in `RootView`; the viewport as model state the view reads.

**Evidence:** `RootView.ts:211` holds no model state and pulls each `update()` — upheld. One edge
to watch: `Bootstrap.ts:78` writes `viewport.setSize(view.…())` from frame geometry into model
state — controlled (outside any render pass) but it is projection→model flow; keep it the only
such edge and out of the reactive frame effect.

**Impossible if true:** a renderable that is the source of scroll/selection truth; the editor
storing terminal width/height as anything but a viewport input.

**Verification:** grep/review — renderables hold no model fields; the only projection→model write
is the single `setSize` edge, asserted not to run inside the frame effect.

**Status:** provisional

**Last refined:** 2026-07-21
