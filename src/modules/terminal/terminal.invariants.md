# Terminal — Invariants

Load-bearing rules for `src/modules/terminal/` (the integrated terminal) and its composable-pane
mount (`src/modules/ui/PaneContent.ts`, `src/modules/ui/PanelHost.ts`). Stands on
`project.invariants.md` (one-way data flow, cost tracks the observed set) and the ui rendering
records. Tier S scope: one interactive terminal in a switchable bottom panel slot.

## Reality-based invariants

### The emulator is the single source of terminal screen state

**Invariant:** If a byte stream defines a terminal screen (ANSI/VT semantics), then the rows×cols
cell grid is a pure function of that stream fed to ONE emulator; the renderer and everything above it
PULL the grid from that emulator and never maintain a parallel screen model. A second parser or a
hand-tracked screen would diverge from the real VT state (wrap, scrollback, alt-screen, SGR).

**Scope:** `TerminalEmulator` (the sole `@xterm/headless` parser), `TerminalInstance` (which owns it),
and `TerminalPaneRenderer` (which reads it). Not the child process, which only produces bytes.

**Mechanism:** `TerminalEmulator` wraps exactly one `@xterm/headless` `Terminal`; child bytes reach it
only through `write()`, and the cell grid is read only through `cell(row, column)` (a flyweight
viewport-pull reusing one xterm cell object). `TerminalPaneRenderer` builds a `StyledText` purely from
those pulled cells each frame. No component keeps its own characters/colors/cursor.

**Generates:** correct VT rendering (wrap, colors, cursor, alt-screen) for free; a renderer that is
stateless and cannot drift from the emulator.

**Evidence:** `src/modules/terminal/TerminalInstance.test.ts` — scripted ANSI (plain text, an SGR
color, and a cursor-position move) feeds the emulator via `MockBackend` and the exact addressed cells
carry the expected character, color, and cursor coordinates; `scripts/smoke-terminal.sh` drives a real
shell and asserts `echo hello` renders `hello` in the panel cells.

**Impossible if true:** a terminal renderer holding its own character/color buffer; a screen cell that
disagrees with what the emulator parsed; two VT parsers for one terminal.

**Verification:** `bun test src/modules/terminal/TerminalInstance.test.ts && bash scripts/smoke-terminal.sh`

**Status:** provisional

**Last refined:** 2026-07-23

## Chosen invariants

### Terminal bytes cross exactly one backend seam

**Invariant:** Every byte to or from the child process passes through the `TerminalBackend` interface
(`write` out, `onData` in, `resize`, `kill`, `onExit`); the emulator and `TerminalInstance` never touch
a file descriptor or spawn a process directly. So `OpenPtyBackend` (a real PTY shell) and `MockBackend`
(scripted bytes) are interchangeable with zero change above the seam — the swap seam, parallel to the
LSP `LanguageProvider`.

**Scope:** `TerminalBackend`, `OpenPtyBackend`, `MockBackend`, `TerminalInstance`, `TerminalFactory`.

**Mechanism:** `TerminalInstance` is constructed with a `TerminalBackend` and a `TerminalEmulator` and
wires them once: `backend.onData → emulator.write`, `emulator.onReply → backend.write`,
`backend.onExit → exit state`. `sendInput`/`resize` call only backend methods. `TerminalFactory.create`
builds the real backend behind an overridable `createBackend` seam; a test passes a `MockBackend`
instead and asserts the exact bytes written / sizes pushed.

**Generates:** deterministic shell-free tests (scripted ANSI in, asserted bytes out); a single place to
add a remote/ssh/container backend later; a terminal core that has no PTY knowledge.

**Evidence:** `src/modules/terminal/TerminalInstance.test.ts` (input reaches `backend.writes`, device
reports round-trip back through it, resize reaches `backend.resizes`, exit stops input);
`src/modules/terminal/OpenPtyBackend.ts` is the only file that opens an fd or spawns a process.

**Impossible if true:** the emulator or instance reading a file descriptor or spawning a child; a test
of terminal behavior that needs a real shell; a second byte path around the backend.

**Verification:** `bun test src/modules/terminal/TerminalInstance.test.ts`; review — only
`OpenPtyBackend` imports `bun:ffi`/`node:fs`/`Bun.spawn`.

**Status:** provisional

**Last refined:** 2026-07-23

### The panel renders exactly the active pane content cells each frame

**Invariant:** The bottom panel slot (`PanelHost`) projects ONLY `activeContent.render(region)` each
frame; pane contents are switchable behind the `PaneContent` seam with no per-content wiring in the
host or in RootView. Adding another content (Output, Problems, a plugin) needs zero host change — the
host never names the terminal.

**Scope:** `PaneContent` (the composable-view seam), `PanelHost` (the generic slot), the panel mount +
render in `RootView`, and `TerminalPaneContent` (the terminal's implementation of the seam).

**Mechanism:** `PanelHost` holds a registry keyed by `PaneContent.id` and an `activeId`; `register` and
`activate` switch which content is active. `RootView.update` mounts the panel box when `visible`, sets
its title from `activeContent.title`, and fills its body from `activeContent.render({width, height,
palette, focused})` — the same flyweight viewport-pull as the tree/git panes. RootView contains no
`Terminal*` reference in the render path.

**Generates:** a composable bottom panel where the terminal is the first citizen and any future
PaneContent slots in unchanged; a stateless panel projection.

**Evidence:** `src/modules/ui/PanelHost.test.ts` (registration, generic switching between two fake
contents, focused-key routing, size convergence); `scripts/smoke-terminal.sh` (the terminal renders in
the panel body).

**Impossible if true:** RootView or PanelHost branching on a specific content type to render; a second
content requiring host edits to appear; a panel that renders something other than its active content.

**Verification:** `bun test src/modules/ui/PanelHost.test.ts && bash scripts/smoke-terminal.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### A focused panel routes keystrokes to its active pane content

**Invariant:** When the panel is focused, every non-reserved keystroke is encoded to terminal bytes and
delivered to `activeContent.handleKey`; reserved global chords (quit, panel toggle) still fire first so
the user is never trapped, and an unencodable key is swallowed rather than driving the hidden editor
beneath. When the panel is NOT focused, it consumes no keys.

**Scope:** `TerminalKeys` (key→bytes), `TerminalPaneContent.handleKey`, `PanelHost.handleKey`, and the
panel-input branch in `Bootstrap.keyTick`.

**Mechanism:** `Bootstrap.keyTick` resolves reserved global chords first (`app.quit`,
`panel.toggleTerminal`), then — before any editor/overlay routing — if `panelHost.visible && focused`
it calls `panelHost.handleKey(key)` and returns. `TerminalPaneContent.handleKey` runs `TerminalKeys.encode`
(canonical VT bytes from the PARSED key fields, not the Kitty-encoded `sequence`) and writes them via
`sendInput` → the backend seam. Focus follows the toggle and clicks (`panelContainsPoint`).

**Generates:** a terminal that receives Ctrl+C/Ctrl+D/arrows/typing as a real terminal would, while
Ctrl+Q and the toggle always work; no keystroke both drives the shell and the editor.

**Evidence:** `src/modules/terminal/TerminalKeys.test.ts` (control-byte, arrow, named-key, printable
encoding); `src/modules/ui/PanelHost.test.ts` (focused host routes to the active content);
`scripts/smoke-terminal.sh` (typed `echo hello`+Enter reaches the shell and renders; Ctrl+Q from the
focused terminal still quits).

**Impossible if true:** a focused terminal where typing drives the editor; a key that both types into
the shell and moves the editor cursor; Ctrl+Q swallowed by the focused terminal; keys consumed while
the panel is unfocused.

**Verification:** `bun test src/modules/terminal/TerminalKeys.test.ts src/modules/ui/PanelHost.test.ts && bash scripts/smoke-terminal.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### A split panel renders every visible cell into its own sub-region

**Invariant:** When the panel holds two or more visible cells, the slot is partitioned left-to-right by
each cell's ratio (one column per interior divider), and each cell's `PaneContent.render` AND its
`onResize` see ONLY that cell's sub-region — never the full slot. The single-cell case is the same code
with one full-width partition, so nothing regresses when nothing is split. One width algorithm
(`PanelHost.cellSpans`) feeds BOTH the laid-out cell width and the content's `onResize`, so a cell can
never be sized for a region different from the one it is painted into.

**Scope:** `PanelHost` (`layout`, `resolvedCells`, `cellSpans`, `setViewportSize`, `moveDivider`), the
panel cell-pool render in `RootView` (`syncPanelCellMount`, the per-span body loop), and any
`PaneContent` (e.g. `StaticPaneContent`, `TerminalPaneContent`) that occupies a cell.

**Mechanism:** `PanelHost.cellSpans(totalColumns)` distributes the slot's inner columns across the
resolved cells by normalized ratio, reserving one column per divider and giving the remainder to the
last cell. `RootView.update` mounts one body per span (a divider before each body from the second on),
sets each body's width to its span, and fills it from `span.content.render({width: span.columns, …})`.
`Bootstrap`'s converge step calls `panelHost.setViewportSize`, which walks the SAME `cellSpans` and
calls each `content.onResize(span.columns, rows)`. `moveDivider` re-flows only the two cells adjacent
to the dragged divider, each clamped to a minimum share.

**Generates:** an agent | terminal (or N-way) bottom panel where each pane is a first-class occupant of
its own region; a resizable divider that reflows both neighbours; a single-pane panel as the degenerate
1-cell case with byte-identical behaviour.

**Evidence:** `src/modules/ui/PanelHost.test.ts` (`split` layout + normalized shares, `cellSpans`
per-cell widths reserving the divider column, `setViewportSize` resizes each cell independently,
`moveDivider` re-flow + minimum clamp); `scripts/smoke-panel-split.sh` drives F9 to split live and
asserts two cells render into distinct sub-widths (the left cell prints its own converged width), the
divider drag reflows both, and un-split restores the full-width pane.

**Impossible if true:** a split cell rendered at the full slot width while another cell overlaps it; a
cell whose content is `onResize`d to a region different from the one it is painted into; a divider drag
that resizes one neighbour but not the other; a split that changes the single-pane render path.

**Verification:** `bun test src/modules/ui/PanelHost.test.ts && bash scripts/smoke-panel-split.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### A focused split panel routes keystrokes to the focused cell

**Invariant:** When the panel is focused and split, every non-reserved keystroke goes to exactly ONE
cell — the focused cell — and clicking a cell makes it the focused cell (focus-follows-click at the
cell grain). The block caret is drawn in the focused cell's sub-region. An unfocused cell receives no
keys and shows no caret. With a single cell this is identical to the old "focused panel routes to its
active content".

**Scope:** `PanelHost` (`focusedIndex`, `focusedContent`, `focusCell`, `handleKey`, `retargetFocus`),
the panel cell-body `onMouseDown` handlers + caret anchoring in `RootView`, and the panel-input branch
in `Bootstrap.keyTick`.

**Mechanism:** `PanelHost.handleKey` delegates to `focusedContent` (the resolved cell at `focusedIndex`,
or the single active content). `RootView` gives each cell body an `onMouseDown` that calls
`panelHost.focus()` + `panelHost.focusCell(index)`, and anchors the caret to the focused cell body's
laid-out screen cell. `focusCell`/`split`/`unsplit` run through `retargetFocus`, which fires
`onBlur`/`onFocus` only when the focused content actually changes, so exactly one cell is ever focused.

**Generates:** two live panes (agent | terminal) where typing drives only the one you clicked, the
caret sits in the active pane, and switching panes is a single click; no keystroke drives two panes.

**Evidence:** `src/modules/ui/PanelHost.test.ts` (a focused split routes to the focused cell; `focusCell`
moves the routing target; splitting while focused blurs the old content and focuses the new cell);
`scripts/smoke-panel-split.sh` types into the focused left cell (`key:z` renders), clicks the right cell
(focus index → 1), and asserts a later key never reaches the now-blurred left cell.

**Impossible if true:** a keystroke delivered to an unfocused cell; two cells focused at once; a click
on a cell that does not focus it; a caret drawn in a blurred cell.

**Verification:** `bun test src/modules/ui/PanelHost.test.ts && bash scripts/smoke-panel-split.sh`

**Status:** provisional

**Last refined:** 2026-07-23
