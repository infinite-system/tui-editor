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
