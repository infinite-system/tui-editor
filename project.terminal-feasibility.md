# Integrated terminal — feasibility (spike, 2026-07-23)

VS-Code-style bottom terminal panel (PTY manager under the editor). **Verdict: YES, feasible; no
blockers.** Every claim below was proven by code run in a real Bun 1.3.14 install (spike evidence
was in `/tmp/pty-spike`, ephemeral). Capture so we don't re-spike.

## The one real risk — PTY in Bun — is SOLVED
- **node-pty FAILS under Bun.** It installs + compiles + loads, but the child dies with instant EOF
  (proven: `cat` exits +3ms; only synchronously-queued writes land). The native forkpty+socket
  pipeline isn't wired on Bun's runtime. Dead end.
- **`openpty` via `bun:ffi` + `Bun.spawn(slaveFd)` WORKS FULLY.** Recommended path. `dlopen`
  `libutil.so.1` (glibc sometimes stubs `openpty` into libc — try libc first, fall back to libutil)
  for `openpty`, `libc.so.6` for the resize `ioctl`. `openpty` → master+slave fds; `Bun.spawn(["bash",…],
  {stdio:[slave,slave,slave]})` (Bun.spawn accepts a raw fd — the key primitive). Proven: shell sees a
  real tty, real command execution, **delayed writes 300ms+ later land** (the exact thing node-pty
  fails). fork()-based forkpty is unsafe in Bun's multithreaded runtime → openpty + Bun.spawn is the
  correct decomposition.
- **I/O rides node:fs**, no FFI polling: `fs.createReadStream("", {fd: master, autoClose:false})` gives
  async push reads under Bun. FFI is only for `openpty` + the resize `ioctl`.
- **Resize:** `ioctl(master, TIOCSWINSZ=0x5414, &winsize)` → `stty size` reflects it; SIGWINCH reaches
  the foreground program. **Job control / controlling-tty:** bare `Bun.spawn` has no pre-exec hook so
  you get "no job control" — wrap in `setsid --ctty` (Linux, proven). **macOS has no `setsid`** → needs
  a ~30-line `login_tty` native helper or an FFI `posix_spawn` file-action, or accept no-job-control on
  mac. Baseline interactivity + resize work everywhere without it.

## VT emulation — `@xterm/headless@6.0.0` (works under Bun)
Parses raw ANSI into a rows×cols cell buffer exposing exactly what a cell-grid renderer needs:
`getChars()`, `getFgColor()`/`isFgPalette()`/`isFgRGB()`, `isBold()`, `getBgColor()`, cursor X/Y;
events `onWriteParsed`/`onData`/`onResize`/`onBell`. **Maps cleanly to Invar:** feed PTY-master bytes
to `term.write()`; `onWriteParsed` → one `requestRender()` (coalescing); a `TerminalPaneRenderer` pulls
visible rows per frame (`buffer.active.getLine(r).getCell(c)`) → OpenTUI cells — same flyweight
viewport-pull as the editor, no dirty-region bookkeeping. Feed `term.onData` (emulator replies:
device-attribute/cursor/mouse acks) **back** to the master. (A hand-rolled parser would re-implement
scrollback/wrap/alt-screen — not worth it.)

## Difficulty
- **SOLVED / high-reuse:** editor⇄terminal split → `SplitterModel`; terminal instances → `WorkspaceSet`-style
  reactive set (Hot/Warm/Cold lifecycle = keep emulator+PTY hot only when the pane is visible); display →
  a `*PaneRenderer`; keystroke forwarding → existing keybinding/focus routing writes bytes to the master.
  PTY de-risked (this spike).
- **REAL WORK (mid):** emulator integration + the onData→master reply loopback; output throughput
  coalescing (batch master reads → term.write → one frame per onWriteParsed; cap redraw under `yes`/build
  floods); scrollback UI (xterm keeps the buffer; add gestures via existing `ScrollbarGeometry`);
  cross-platform controlling-tty (setsid vs macOS helper).
- **Mouse-passthrough (own hardening pass):** a terminal-in-a-terminal NESTS mouse protocols — when the
  embedded shell runs a mouse-aware TUI it enables reporting; Invar must translate host mouse events in
  the pane rect into the inner coordinate space and re-encode them (X10 vs SGR-1006) onto the master.
  This is the **same SGR/X10 fragility Invar already fights at its outer boundary, doubled at the inner
  one — ties directly to the known macOS Terminal.app mouse issue.**
- **BLOCKERS: none.**

## Effort tiers
- **S — basic non-interactive shell pane** (openpty + Bun.spawn + xterm + forward keys): days.
- **M — full interactive parity** (job control, resize/SIGWINCH, scrollback, throughput coalescing): 1–2 weeks.
- **L — robust nested mouse passthrough** across macOS/Linux terminals + alt-screen apps: additional; where
  the real risk concentrates (and where fixing the outer macOS mouse issue first pays off).

**Status:** build-ready, awaiting the user's go (it's a multi-week subsystem — a scope decision, not part
of the current UI backlog).
