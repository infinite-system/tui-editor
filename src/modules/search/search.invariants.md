# Search — Invariants

Load-bearing rules for `src/modules/search/` (QuickOpen, FindBar, FindInBuffer) and the overlay
renderers that project them (`src/modules/ui/QuickOpenRenderer.ts`, `FindBarRenderer.ts`,
`OverlayLayer.ts`). Stands on `project.invariants.md` and the UI contract's
[Selection is item-anchored click-set keyboard-moved and stays](../ui/ui.invariants.md#selection-is-item-anchored-click-set-keyboard-moved-and-stays)
and [Renderables hold no model state](../ui/ui.invariants.md#renderables-hold-no-model-state).

## Reality-based invariants

_None specific to search. The module consumes the terminal viewport, glyph-ladder, colour, and mouse
hit-grid constraints recorded by the UI and theme contracts._

## Chosen invariants

### Search results are click-set and highlight-shown

**Invariant:** In every QuickOpen list (both the file fuzzy-search of Ctrl+P and the open-project
directory navigator), the active result is persistent state set by a click and moved by the keyboard,
shown ONLY by a row-background highlight — never by a leading arrow/`›` marker — and the mouse hover is
a separate transient row-background highlight that never changes the selection. The highlight uses the
same palette tokens as the file tree (`palette.selection` for the active row, `palette.cursorLine` for
hover), so every selectable list looks identical.

**Scope:** `QuickOpen.selectedIndex`/`hoveredIndex` and the `QuickOpenRenderer` projection of both
modes; the `OverlayLayer` quick-open pointer handlers. Excludes the FindBar (it has no result list).

**Mechanism:** `QuickOpenRenderer.render` paints each row's background from `selectedIndex`
(`palette.selection`) then `hoveredIndex` (`palette.cursorLine`) with no marker glyph, padded to the
inner width so the highlight spans the row. `OverlayLayer` maps a pointer row (`event.y` minus the list
renderable's own `y`) to a match: `onMouseMove` sets the hover, `onMouseDown` sets the selection and
then opens (files mode) or drills in (path navigator). It reuses the tree's tokens, so the two agree.

**Generates:** click → select (+ open/drill); hover → transient highlight only; one selection idiom and
one highlight style across the tree, file-search, and open-project lists.

**Evidence:** `QuickOpen.setSelectedIndex`/`setHoveredIndex`; `src/modules/ui/QuickOpenRenderer.ts`;
`src/modules/ui/OverlayLayer.ts` quick-open handlers; `src/modules/search/QuickOpen.test.ts`;
`scripts/smoke-search-mouse.sh` (asserts no `›`, a distinct selection background, hover moving the
highlight onto the pointed row, and a click opening the file).

**Impossible if true:** a `›` (or any arrow) marker on the selected quick-open row; the selection
following the mouse hover; a hover leaving no visible row background; the file-search and open-project
modes rendering the selection differently, or differently from the file tree.

**Verification:** `bun test src/modules/search/QuickOpen.test.ts && bash scripts/smoke-search-mouse.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### Find bar controls are mouse-clickable buttons

**Invariant:** Every FindBar action — previous match, next match, the case toggle, replace, replace-all,
and the find↔replace mode switch — is reachable by a mouse click on a rendered glyph button, and a click
runs the SAME FindBar method its keyboard chord runs. The button hit-zones are the exact columns the
renderer drew that frame (one geometry source), so a drawn button and its clickable rectangle can never
disagree.

**Scope:** `FindBarRenderer.render` (button glyphs + returned `FindBarButtonZone[]`) and the
`OverlayLayer` find-bar `onMouseDown` dispatch. The mode-toggle button appears only when the bound pane
allows replacement.

**Mechanism:** `FindBarRenderer` lays out the button row left-to-right, accumulating each button's
`[startColumn, endColumn)` as it emits the chunk, and returns those zones with the `StyledText`.
`OverlayLayer` stores the zones each frame and, on `onMouseDown`, resolves the local (row, column) to a
zone and calls the matching `FindBar` method (`previous`/`next`/`toggleCaseSensitive`/`replaceCurrent`/
`replaceAll`/`switchMode`) — the same methods the keyboard action-handlers call. Glyphs come from the
theme find-icon ladder (nerd → unicode → ascii), each one cell so the columns stay aligned.

**Generates:** a fully mouse-operable find/replace bar; keyboard and mouse converging on one behaviour;
button rectangles that track the render.

**Evidence:** `src/modules/ui/FindBarRenderer.ts`; `src/modules/ui/OverlayLayer.ts` `runFindButton` +
`findBarText.onMouseDown`; `src/modules/search/FindBar.ts`; `scripts/smoke-search-mouse.sh` (clicks the
next, Aa, and replace-all buttons and asserts the match advances, case flips + re-filters, and the
document mutates).

**Impossible if true:** a FindBar action with no clickable button; a button whose click runs different
logic than its keyboard chord; a click landing in a drawn button's cells doing nothing (hit-zone and
render disagreeing).

**Verification:** `bun test src/modules/search/FindBar.test.ts && bash scripts/smoke-search-mouse.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### Case sensitivity is a live toggle that re-runs the query

**Invariant:** The FindBar carries a case-sensitivity option; flipping it (the Aa button or the Alt+C
chord) immediately re-runs the active query so the match set, the current-match index, and the counter
reflect the new mode in the same frame — the toggle is never a latent flag applied only on the next
keystroke.

**Scope:** `FindBar.toggleCaseSensitive`, `FindInBuffer.caseSensitive` + `createRegularExpression`, the
`find.toggleCaseSensitive` action-handler, and the Aa button state in `FindBarRenderer`.

**Mechanism:** `FindInBuffer.createRegularExpression` selects the `g` vs `gi` flags from
`caseSensitive.value`. `FindBar.toggleCaseSensitive` flips that ref and calls `engine.findAll()` in the
same call, so `matches` and `currentMatchIndex` are recomputed before the next paint. The Aa button
renders with a highlighted background while the option is on, driven by `FindBar.caseSensitive`.

**Generates:** live case-sensitive search; a visible on/off affordance; identical behaviour from the
button and the keyboard.

**Evidence:** `src/modules/search/FindBar.ts` `toggleCaseSensitive`; `src/modules/search/FindInBuffer.ts`
`createRegularExpression`; `src/modules/keybindings/keybindings.defaults.ts` (`find.toggleCaseSensitive`
= Alt+C); `scripts/smoke-search-mouse.sh` (Aa click turns case on and the count drops from 4 to the
single case-exact match).

**Impossible if true:** toggling case-sensitivity without the match count changing for a query that has
case-differing matches; the counter still showing the old mode's matches after a toggle; the Aa button
showing no active state while case-sensitivity is on.

**Verification:** `bun test src/modules/search/FindInBuffer.test.ts src/modules/search/FindBar.test.ts && bash scripts/smoke-search-mouse.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### The open-project path input is a live directory navigator

**Invariant:** In the open-project picker the input is a live path navigator: the text is split at its
last `/` into a directory prefix and a filter segment; the picker lists that directory's subfolders
(re-reading the filesystem only when the directory changes) ranked by the filter segment closest-first,
an empty segment listing all. Typing re-roots the listing live; a click on a folder drills INTO it
(completing the path with its name + `/` and re-listing); Enter opens the current input path.

**Scope:** `QuickOpen` workspacePath mode — `showWorkspacePath`, `refilterWorkspacePath`,
`navigateIntoSelected`, `activate` — and the `OverlayLayer` path-navigator click branch.

**Mechanism:** `refilterWorkspacePath` computes `directoryPrefix`/`filterSegment` from the last `/`,
enumerates the prefix's subfolders (cached by directory so an intra-directory keystroke only
re-filters), scores each folder's basename with `CommandScoring.fuzzyScore`, and sorts closest-first.
`navigateIntoSelected` sets the query to the highlighted folder + `/`, which re-runs the enumeration.
`activate` returns the trailing-slash-stripped current path. `OverlayLayer`'s quick-open `onMouseDown`
calls `navigateIntoSelected` in this mode (versus opening the file in files mode).

**Generates:** VS Code-style path completion; drill-down by clicking or typing; one filesystem read per
visited directory.

**Evidence:** `src/modules/search/QuickOpen.ts` (`refilterWorkspacePath`, `navigateIntoSelected`);
`src/modules/search/QuickOpen.test.ts` (re-roots on directory change, filters by segment, drills in);
`scripts/smoke-search-mouse.sh` (types a partial path and asserts the list re-roots/filters, then clicks
a folder and asserts the path completes and the picker stays open).

**Impossible if true:** the listing not changing when the input's directory part changes; the filter
segment matching against full paths instead of folder names; a folder click opening a workspace instead
of drilling in; re-reading the same directory on every keystroke.

**Verification:** `bun test src/modules/search/QuickOpen.test.ts && bash scripts/smoke-search-mouse.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### An un-openable open-project path is flagged live

**Invariant:** While the open-project navigator is open, the input shows a warning alert glyph (the
⚠ theme ladder, painted in the warning colour) exactly when the current input path is NOT an existing
directory — the same condition that makes Enter refuse to open it — updating live on every keystroke; an
openable path shows no alert.

**Scope:** `QuickOpen.workspacePathOpenable` (set in `refilterWorkspacePath`) and the `OverlayLayer`
quick-open input rendering; the alert glyph is `Theme.alertIcon`.

**Mechanism:** `refilterWorkspacePath` sets `workspacePathOpenable` to
`isDirectory(stripTrailingSlash(query))` — the same predicate `activateQuickOpenSelection` guards Enter
with. `OverlayLayer` appends `Theme.alertIcon` in `palette.warning` to the input when the option is
false in workspacePath mode. The reactive repaint observes the ref so the glyph tracks typing.

**Generates:** an at-a-glance signal that a path will not open, consistent with the Enter guard.

**Evidence:** `src/modules/search/QuickOpen.ts` (`workspacePathOpenable`, `isDirectory`);
`src/modules/ui/OverlayLayer.ts` (alert chunk); `src/modules/theme/ThemeIcons.ts` (`alertIconFor`);
`scripts/smoke-search-mouse.sh` (a partial path raises the `!` glyph in the warning colour; a real
directory shows none).

**Impossible if true:** a valid, openable directory path showing the alert; an un-openable path showing
no alert; the alert glyph painted in the ordinary foreground colour; the flag disagreeing with whether
Enter opens the path.

**Verification:** `bash scripts/smoke-search-mouse.sh`

**Status:** provisional

**Last refined:** 2026-07-23
