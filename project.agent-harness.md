# Agent Harness — Invariants & Design

The native AI-agent integration: Claude (and kin) as a **first-class pane** driven through the
Claude Agent SDK's structured event stream — not as a guest TUI behind a PTY. Stands on
`project.invariants.md` (one-way data flow, cost tracks the observed set), the PaneContent/PanelHost
seam, and `terminal.invariants.md` (whose backend-seam and single-source patterns this design
deliberately mirrors). The guest path (Claude Code running inside the PTY terminal) remains valid
and untouched — this is the *second* integration, the one that changes the tool's category:
**Invar stops hosting the agent; Invar and the agent operate each other.**

Everything here is pre-implementation: every record is `provisional`, and each record's
Verification section is the promotion path.

## Reality-based invariants

### An agent is a structured event stream, not a screen

**Invariant:** If an agent integration consumes rendered output (terminal cells, ANSI), it can only
replay what the agent chose to draw; if it consumes the agent's structured events (message deltas,
tool-use requests, tool results, lifecycle), the host can project them into ANY surface and compose
them with its own capabilities. Composition requires the event stream; pixels are a dead end.

**Scope:** The entire native harness. Does not apply to the PTY guest path, which is knowingly the
pixels path and stays a plain terminal citizen.

**Mechanism:** The Claude Agent SDK emits typed events over a session: assistant text deltas,
`tool_use` requests, tool results, errors, session lifecycle. `AgentBackend` yields those events;
`AgentSession` (Reactive) folds them into model state. No ANSI parsing exists anywhere in the
module.

**Generates:** clickable file references; diffs rendered in the git panel's side-by-side view;
transcript folding/search; policy-gated approvals; multi-session dashboards; headless runs —
none of which are possible against a screen.

**Evidence:** design session 2026-07-23 (the TV-vs-texts reduction). The PTY path's limits are
already lived: approval inside the guest is `y/n` typed at a prompt Invar cannot see.

**Impossible if true:** any code path that regex-parses terminal cells to "understand" the agent; a
native feature that only works by injecting keystrokes into the guest TUI.

**Verification:** `MockAgentBackend` scripts an event sequence (text delta, tool_use, result);
unit tests assert `AgentSession` state after each event; a smoke drives the pane and asserts
transcript cells, with zero PTY involvement in the module's dependency graph (conventions check:
`src/modules/agent/` must not import from `src/modules/terminal/`).

**Status:** provisional

**Last refined:** 2026-07-23

### The transcript is the single source of session truth

**Invariant:** If a session produced an event, it lives in ONE append-only transcript owned by
`AgentSession`; every surface (pane renderer, badges, fleet dashboard, persistence) is a pure
projection of that transcript, and none maintains a parallel history. Mirrors the terminal's
"emulator is the single source of screen state" — same disease, same cure: a second history would
diverge from the real one.

**Scope:** `AgentSession` and everything that displays or persists it.

**Mechanism:** `AgentSession.events` is an append-only `shallowRef<AgentEvent[]>` (or chunked
equivalent if length demands it); renderers pull from it each frame; persistence serializes the
event list; reload replays it through the same projection. Derived views (per-message grouping,
fold state, pending approval) are plain getters or separate UI-state refs — never a second event
store.

**Generates:** session persistence and reload for free (serialize/replay); search and QuickOpen
over history; deterministic re-render after theme/layout changes; testability (assert on the one
list).

**Evidence:** `terminal.invariants.md` → "The emulator is the single source of terminal screen
state" — the pattern this instantiates one level up.

**Impossible if true:** a renderer that appends its own "synthetic" rows the transcript doesn't
contain; a saved session that renders differently from the live one it recorded.

**Verification:** unit: feed MockAgentBackend events, serialize, reload, assert projected rows
identical. Smoke: kill and reopen the pane; the framebuffer shows the same transcript.

**Status:** provisional

**Last refined:** 2026-07-23

### Tool consent is a host-owned decision point

**Invariant:** If the agent requests a tool execution, the request arrives as DATA (name, input,
context) and is resolved by the HOST's policy pipeline — automatic rules first, human overlay only
as the fallback — and the resolution returns as data. Consent never takes the form of text typed
at a prompt the host cannot introspect.

**Scope:** every tool_use event in every native session, headless included (headless = policy
rules only; no overlay fallback — unresolvable requests deny and log).

**Mechanism:** the SDK's permission callback parks the request in
`AgentSession.pendingApproval` after `AgentPolicy.Class.resolve(request)` returns `ask`;
`allow`/`deny` outcomes resolve the SDK promise directly without UI. The overlay (via
OverlayCoordinator, same machinery as the context menu) renders only the `ask` residue and calls
`session.approve()`/`session.deny()`.

**Generates:** auto-approve-reads policy; hard deny-lists; per-project rules in settings;
gate-conditioned approvals (a commit-shaped tool call may require merge-gate green); an audit
trail — every consent is an event in the transcript.

**Evidence:** design session 2026-07-23; the settings applied-effect harness proves policy-as-data
is drive-verifiable in this codebase.

**Impossible if true:** a tool that executes with no transcript record of who allowed it and under
which rule; an approval UI that writes bytes to a process's stdin; a headless run that silently
blocks waiting for a human.

**Verification:** unit: policy table resolves allow/deny/ask cases; pending `ask` blocks the tool
until resolved; deny returns a refusal event. Smoke: scripted tool_use raises the overlay in the
frame, clicking Approve unblocks the scripted backend, and the transcript records the consent.

**Status:** provisional

**Last refined:** 2026-07-23

## Chosen invariants

### The agent pane is a PaneContent citizen, not a special case

**Invariant:** If the harness renders, it renders as a registered `PaneContent` inside `PanelHost`
— identical citizenship to the terminal. RootView and PanelHost gain ZERO agent-specific branches.

**Scope:** `AgentPaneContent`, `AgentPaneRenderer`; RootView/Bootstrap wiring.

**Mechanism:** the same registration path the terminal used ("terminal is its first citizen,
register more contents with zero host rewiring" — this is citizen two, proving that sentence).
Renderer is a Static flyweight pulling transcript rows into cells, exactly as
`TerminalPaneRenderer` pulls emulator cells.

**Generates:** panel switching, splitter resize, focus routing, and toggle keybinding for free;
the fleet dashboard later is "more contents," not new hosting.

**Evidence:** `src/modules/ui/PaneContent.ts:2` (the interchangeability contract);
`terminal.invariants.md` → "The panel renders exactly the active pane content cells each frame".

**Impossible if true:** `RootView.ts` containing the string `agent` in a render branch; a second
bottom-panel implementation.

**Verification:** conventions grep (no agent-typed branches in RootView/PanelHost); the existing
panel smokes pass unchanged with the agent content registered.

**Status:** provisional

**Last refined:** 2026-07-23

### Agent events cross exactly one backend seam

**Invariant:** If session logic or UI needs the agent, it speaks to `AgentBackend` (Static-slotted,
replaceable); only `ClaudeSdkBackend` touches the SDK/network, and `MockAgentBackend` is a scripted
double honoring the same contract. Mirrors "Terminal bytes cross exactly one backend seam".

**Scope:** `AgentBackend` (seam), `ClaudeSdkBackend`, `MockAgentBackend`, `AgentFactory` (lazy
spawn on first toggle, like `TerminalFactory`).

**Mechanism:** the namespace pattern's mutable Class slot: tests and smokes install the mock;
production installs the SDK backend; `AgentSession` cannot tell the difference. Provider variety
later (another vendor, a local model) is another backend, zero session changes.

**Generates:** gate-runnable verification with no API key and no network; deterministic smokes;
provider portability.

**Evidence:** `terminal.invariants.md` → backend-seam record; `MockBackend.ts` precedent proved
the pattern carries a whole module's test weight.

**Impossible if true:** `AgentSession` or any renderer importing the SDK directly; a test that
needs network to assert transcript behavior.

**Verification:** conventions check on imports; the full unit + smoke suite runs green with ONLY
the mock installed. Real-backend runs are manual/dev (API key), never gate-blocking — same class
of exception as the macOS mouse-protocol work: what the harness cannot drive here is verified by
a human and recorded.

**Status:** provisional

**Last refined:** 2026-07-23

### One session, one Reactive instance — UI optional

**Invariant:** If a session exists, it is exactly one `AgentSession.Class` instance whose entire
behavior is UI-independent: the same class drives the pane, a headless cron run, or a gate hook.
The UI is a subscriber, never a dependency.

**Scope:** `AgentSession`; anything that constructs sessions.

**Mechanism:** ivue discipline as-is: state in ref-getters, actions as methods, watchers via
`$watch` in the instance's own scope, disposal via an ordinary `dispose()` that closes the backend
and calls `$stopEffects()`. Nothing in the class reads render state.

**Generates:** the fleet view (N instances in tabs); scripted/overnight sessions with the same
policy pipeline; tests that drive sessions with no renderer mounted.

**Evidence:** the engine's teardown/ownership model (ivue lifecycle docs); every existing Invar
model class already lives this way.

**Impossible if true:** a session method that requires a mounted pane to function; agent state
stored in renderer-owned variables.

**Verification:** unit tests construct and drive sessions with no PaneContent registered;
`dispose()` verifiably stops watchers and closes the mock backend (assert via backend close count).

**Status:** provisional

**Last refined:** 2026-07-23

### The editor is the agent's instrument

**Invariant:** If the agent is granted a custom tool into Invar (open file, query diagnostics,
read the rendered frame, run a smoke, get selection), that tool calls the SAME public seams the UI
calls — `workspaceSet.active...`, `LanguageClient`, the frame probe, the smoke scripts — with no
privileged side-channel and every invocation recorded in the transcript.

**Scope:** `AgentTools` (Static registry of tool definitions handed to the backend). Tier M+.

**Mechanism:** each tool is a thin adapter over an existing capability seam; tool granting is
policy-scoped (a session's toolset is data, chosen at construction). The object graph is the API:
what the UI navigates, the agent navigates.

**Generates:** the category shift — an agent that verifies its own UI work by reading the real
frame and driving the real smokes, inside the same process and reactive graph; drive-verified
agent development as a product feature, not a lab setup.

**Evidence:** `FrameProbe`, the smoke harness, and `diagnosticsAt` already exist as callable
seams; the conductor's verify-by-driving doctrine is this invariant practiced manually.

**Impossible if true:** a tool that mutates editor state through a path the UI could not take; an
agent capability that bypasses the policy pipeline because it is "internal".

**Verification:** unit: each tool adapter is exercised against the real module with the mock
backend scripting the tool_use. Smoke: scripted session calls `openFile` and the target tab is
present in the frame.

**Status:** provisional

**Last refined:** 2026-07-23

## Design — module layout

```
src/modules/agent/
  AgentEvents.ts         — event/type vocabulary (deltas, tool_use, results, consent records)
  AgentBackend.ts        — the seam (interface + namespace slot)
  CliStreamBackend.ts    — drives `claude -p --output-format stream-json` (subscription-billed
                           structured events — the default native backend; verified 2026-07-23)
  ClaudeSdkBackend.ts    — Claude Agent SDK adapter (API-key billing; only file importing the SDK)
  GuestHookBackend.ts    — tier G: projects a PTY-guest session from hook events (stable contract)
  MockAgentBackend.ts    — scripted double (the gate's backend)
  AgentPolicy.ts         — Static; resolve(request) → allow | deny | ask (rules from settings)
  AgentSession.ts        — Reactive; transcript, pendingApproval, send/approve/deny/dispose
  AgentTools.ts          — Static registry of Invar-instrument tools (tier M)
  AgentPaneContent.ts    — PaneContent citizen (focus/keys → composer input)
  AgentPaneRenderer.ts   — Static flyweight; transcript rows → cells
  agent.invariants.md    — the six records above, colocated on implementation
```

Dependency rule (conventions-gate): `agent/` imports ui seams and system seams; NEVER
`terminal/`; only `ClaudeSdkBackend.ts` imports the SDK package.

## Tier plan

- **Tier G (the guest hybrid — plan-billed users get the instrument too):** the stock Claude
  Code TUI keeps running in the PTY pane (subscription billing, untouched interaction), and the
  harness attaches through the guest's STRUCTURED side doors — never the ANSI stream. Facts
  pinned against official docs 2026-07-23 (hooks.md, sessions.md, headless.md,
  agent-sdk/overview.md):
  - **Hooks carry both flows, and they are the STABLE contract.** `PreToolUse` receives the tool
    call as JSON and returns `permissionDecision: allow | deny | ask | defer` — the membrane,
    officially supported; the `http` hook handler POSTs straight to the running Invar (no
    FIFO/socket improvisation). `PostToolUse` delivers every tool call + result as JSON — the
    evidence feed for the highest-slop surface (what actually executed), also stable.
    `GuestHookBackend` folds these into `AgentEvent`s.
  - **The JSONL transcript tail is an optional enhancement, not a foundation** — the on-disk
    format (`~/.claude/projects/<slug>/<session>.jsonl`) is officially internal and may break on
    any release. If used (for assistant-text mirroring between hook events), it is version-pinned
    and degrades gracefully to the hook-only feed.
  Tier G exercises the SAME `AgentSession`/`AgentPolicy`/`AgentPaneContent` classes — only the
  backend differs, which is exactly what the one-seam invariant is for.
- **Auth matrix (verified 2026-07-23):** the Agent SDK requires API-key billing —
  subscription/claude.ai login for SDK products is explicitly disallowed by policy. BUT
  `claude -p --output-format stream-json` runs under normal subscription OAuth and streams the
  full structured event vocabulary (assistant / tool_use / tool_result / stream_event deltas /
  result with usage+cost). Therefore **`CliStreamBackend` is the default native backend** —
  plan-billed, officially documented events — and `ClaudeSdkBackend` is the API-key/enterprise
  option (Bedrock/Vertex/Foundry), not a prerequisite.
- **Tier S (the weekend):** one session; transcript pane (PaneContent + renderer);
  composer line; approval overlay wired through AgentPolicy with default rules
  (reads auto-approved, writes ask, deny-list); clickable `file:line` references opening tabs;
  MockAgentBackend + unit tests + one driving smoke; `agent.invariants.md` colocated.
- **Tier M:** session persistence (serialize/replay the transcript); multi-session tabs in
  PanelHost; AgentTools v1 (openFile, getSelection, queryDiagnostics); diffs from edit-shaped
  tools rendered via the git panel's side-by-side machinery; context injection (selection/open
  file front matter).
- **Tier L:** fleet dashboard (conductor's workers as visible sessions, StatusChannel badges on
  finish/ask); frame-probe and run-smoke tools (the agent verifies its own UI work);
  gate-conditioned approvals; headless sessions from cron/hooks sharing AgentPolicy.

## Boundary (what this is NOT)

- Not a replacement for the PTY guest path — running stock Claude Code in the terminal pane stays
  supported and untouched; the two compose (native pane orchestrates, PTY executes shells), and
  tier G makes the guest itself a first-class evidence source through its sidecars.
- Not ANSI interception, ever — tier G reads the guest's structured transcript and hook events;
  the rendered byte stream stays what the reality invariant says it is: a dead end.
- Not an autonomy change — the policy pipeline only ever *narrows* what executes without a human;
  the default posture matches today's guest behavior (asks).
- Not gate-coupled to the network — the merge gate never requires an API key; the SDK backend is
  exercised manually and the mock carries the gate.
