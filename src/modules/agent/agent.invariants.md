# Agent Harness — Invariants

Load-bearing rules for `src/modules/agent/` (the native AI-agent pane) and its composable-pane mount
(`src/modules/ui/PaneContent.ts`, `src/modules/ui/PanelHost.ts`). Stands on `project.invariants.md`
(one-way data flow, cost tracks the observed set) and deliberately mirrors `terminal.invariants.md`
(backend-seam + single-source-of-truth patterns). This is the *second* agent integration; the PTY
guest path (Claude Code inside the terminal pane) stays valid and untouched. Tier-S scope: one
session, a transcript pane, a composer line, a local echo backend — the deterministic skeleton the
real subscription-billed backend drops into.

Full design + tier plan: `project.agent-harness.md`.

## Reality-based invariants

### An agent session is a structured event stream, not a screen

**Invariant:** If an agent integration consumes rendered output (terminal cells, ANSI), it can only
replay what the agent chose to draw; if it consumes the agent's STRUCTURED events (text deltas,
tool-use requests, tool results, lifecycle), the host can project them into ANY surface and compose
them with its own capabilities. Composition requires the event stream; pixels are a dead end.

**Scope:** the whole `agent/` module. Does not apply to the PTY guest path, which is knowingly the
pixels path and stays a plain terminal citizen.

**Mechanism:** `AgentBackend` yields typed `AgentEvent`s (`AgentEvents.ts`): text-delta, tool-use,
tool-result, error, session lifecycle. `AgentSession` folds those into model state. No ANSI parsing
exists anywhere in the module.

**Generates:** clickable file references; diffs rendered in the git panel's diff view; transcript
folding/search; policy-gated approvals; multi-session dashboards; headless runs — none possible
against a screen.

**Impossible if true:** any code path that regex-parses terminal cells to "understand" the agent; a
native feature that only works by injecting keystrokes into a guest TUI; `agent/` importing
`terminal/`.

**Evidence:** `src/modules/agent/AgentSession.test.ts` scripts an event sequence through
`MockAgentBackend` and asserts `AgentSession` state after each event; `scripts/smoke-agent.sh` drives
the pane and asserts transcript cells, with zero PTY involvement. Conventions check: `src/modules/agent/`
must not import from `src/modules/terminal/`.

**Verification:** `bun test src/modules/agent/AgentSession.test.ts && bash scripts/smoke-agent.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### The transcript is the single source of agent session truth

**Invariant:** If a session produced an event, it lives in ONE append-only transcript owned by
`AgentSession`; every surface (pane renderer, title, future badges/persistence) is a PURE projection
of that transcript, and none maintains a parallel history. Mirrors the terminal's "emulator is the
single source of screen state" — a second history would diverge from the real one.

**Scope:** `AgentSession` and everything that displays or persists it.

**Mechanism:** `AgentSession` owns one `TranscriptEntry[]`, mutated only by its own `fold()`/`send()`;
`transcript` exposes a read-only view. Each fold bumps `renderRevision`, the single reactive paint
pulse the frame effect observes (an idle session bumps nothing → idle quiescence holds).
`AgentPaneRenderer` builds a `StyledText` purely from the pulled transcript each frame; it holds no
history. Assistant text-deltas accumulate into the trailing assistant entry; any other event closes
that turn.

**Generates:** a renderer that is stateless and cannot drift from the session; replay/persistence for
free later (serialize the one transcript); derived status (`idle`/`streaming`/`awaiting-tool`) as a
pure function of the folded stream.

**Impossible if true:** a renderer holding its own copy of the messages; a badge counting events from
a separate tally; two histories for one session.

**Evidence:** `src/modules/agent/AgentSession.test.ts` — after a scripted stream, `session.transcript`
holds exactly the expected entries (deltas coalesced, tool-use/result paired) and `status` matches;
the renderer reads only `session.transcript`.

**Verification:** `bun test src/modules/agent/AgentSession.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23

## Chosen invariants

### Agent events cross exactly one backend seam

**Invariant:** Every agent event enters the module through the single `AgentBackend` interface, and
nothing above the seam knows which implementation produced it. The scripted `MockAgentBackend`, the
local `EchoAgentBackend`, and the future `CliStreamBackend`/`ClaudeSdkBackend` are interchangeable
with zero change to `AgentSession` or the pane. Parallel to the terminal's `TerminalBackend`.

**Scope:** `AgentBackend` and its implementations; `AgentSession` (the sole consumer).

**Mechanism:** `AgentBackend` is `send`/`onEvent`/`interrupt`/`dispose`. `AgentSession` wires
`backend.onEvent → fold` once in its constructor and calls `backend.send` on a turn. `AgentFactory`
(Static, overridable) picks the default backend; tests/hosts swap it via `create({ backend })`.

**Generates:** hermetic tests (Mock), a live app today (Echo), and a real subscription-billed agent
later (CliStream) — all behind one seam.

**Impossible if true:** `AgentSession` branching on backend type; a second entry path for events that
bypasses `onEvent`.

**Evidence:** `AgentSession.test.ts` drives the session entirely through a `MockAgentBackend`;
`AgentFactory` defaults to `EchoAgentBackend` with no session change.

**Verification:** `bun test src/modules/agent/AgentSession.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23

### The agent pane is a PaneContent citizen, not a special case

**Invariant:** The agent session mounts as a generic `PaneContent` in the same switchable `PanelHost`
slot the terminal uses — same `render`/`handleKey`/`caret`/`renderRevision`/`dispose` shape, zero
host rewiring. The host treats it identically to any other pane.

**Scope:** `AgentPaneContent`, its mount in `PanelHost`, and the Bootstrap toggle that registers it.

**Mechanism:** `AgentPaneContent implements PaneContent`: `render()` delegates to `AgentPaneRenderer`;
`handleKey()` edits the composer (printable → append, Backspace → delete, Enter → send); `caret()`
pins to the composer; `renderRevision` fuses the session pulse with composer edits so both repaint
through the one frame effect. Bootstrap lazily creates it on first toggle (idle cost zero).

**Generates:** the agent pane composes with splits, focus, z-order, and the switcher for free; the
same seam hosts multi-session tabs later.

**Impossible if true:** a bespoke agent-only render/input path outside `PaneContent`; the host
special-casing the agent pane.

**Evidence:** `scripts/smoke-agent.sh` toggles the pane through the normal panel path, types a prompt,
and asserts the echoed reply renders in the panel cells.

**Verification:** `bash scripts/smoke-agent.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### One session is one Reactive instance

**Invariant:** A session's state (`transcript`, `status`, `renderRevision`) is exactly one `Reactive`
`AgentSession`; UI is optional and additive. The session runs and folds events whether or not a pane
is mounted, so headless/fleet use is the same object with no renderer attached.

**Scope:** `AgentSession` lifecycle and ownership.

**Mechanism:** `AgentSession` is `Reactive($AgentSession)`; the pane holds a reference but the session
owns the backend and the transcript. `dispose()` tears down the backend.

**Generates:** headless sessions (cron/fleet) reuse the same class with no pane; multi-session tabs
are N instances in the host.

**Impossible if true:** session state living in the renderer; a session that cannot exist without a
mounted pane.

**Evidence:** `AgentSession.test.ts` constructs and drives a session with NO pane and asserts full
transcript/status behavior.

**Verification:** `bun test src/modules/agent/AgentSession.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23
