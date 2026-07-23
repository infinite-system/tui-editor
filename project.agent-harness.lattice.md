# Agent Harness — Invariant Lattice

How the agent-harness records (`project.agent-harness.md`) hold **together** — with each other
and with the project + terminal invariants they stand on. Derived, never legislative: where this
disagrees with the records, the records win and the finding is against this file. Free-form
territory in `project.vision.md`.

## Dependency map — chosen stands on reality

```
An agent is an event stream, not a screen ──┬─► The transcript is single session truth
                                             ├─► Tool consent is a host-owned decision point
                                             └─► The editor is the agent's instrument

Eager circular runtime reads fail during init ─► Agent events cross exactly one backend seam
                                                 (the Static-slotted mock/SDK swap)

The panel renders exactly the active pane content   ─► The agent pane is a PaneContent citizen
(terminal.invariants — PanelHost interchangeability)

Cost tracks the actively observed set ─► One session, one Reactive instance — UI optional
(project.invariants)                     (a session costs nothing to observe headlessly)

The emulator is the single source of terminal screen state ─≡─ The transcript is single
(terminal.invariants — SAME pattern, one level up:              session truth
 one authoritative fold of a stream; every surface a pure projection)
```

Import-style references:

- [Transcript as single truth][transcript], [consent host-owned][consent], and
  [editor as instrument][instrument] all stand on [event stream, not screen][stream] — pixels
  can be none of: audited, gated, or composed.
- [One backend seam][seam] stands on the project's [imported dependencies are read late] /
  [construction through overridable seams] — the same law that made `MockBackend` carry the
  terminal's gate weight.
- [PaneContent citizenship][citizen] stands on the terminal's panel-interchangeability record —
  the terminal proved the socket; the agent is citizen two.
- [One session, one instance][session] stands on [cost tracks the observed set] — N sessions are
  N plain instances, priced by observation, disposable by `dispose()`.

## Compositions — emergent guarantees

### Evidence replaces narration (the anti-slop loop)

**Members:** [event stream, not screen][stream] · [transcript as single truth][transcript] ·
[PaneContent citizenship][citizen] · (tier M) [editor as instrument][instrument].
**Guarantee:** every claim the agent makes is one click from its artifact — the diff in the real
diff view, the file at the real line, the invariant record by name, the smoke that proves it.
Reading agent work IS verifying agent work.
**Mechanism of conjunction:** events carry structure → the transcript preserves it losslessly →
native projection renders it with the editor's own affordances (tabs, diff view, hover, links).
Remove the stream and you have pixels to trust; remove the single transcript and evidence can
diverge from history; remove citizenship and the projection lives in a lesser surface.
**Breaks if:** any surface renders agent output that is not a projection of the transcript; a
tool result is summarized into prose with its artifact discarded.

### The membrane (consent compiles culture into physics)

**Members:** [consent host-owned][consent] · [one backend seam][seam] · [transcript as single
truth][transcript].
**Guarantee:** nothing executes without a recorded resolution — and the resolution rules are
data, so the project's culture (reads free, writes ask, `rm -rf` never, commits require the
merge gate green) becomes a physical property of the pipeline, identical for UI, headless, and
fleet sessions.
**Mechanism of conjunction:** every tool_use is data at the seam → policy resolves
allow/deny/ask before any UI → the outcome is itself a transcript event. Remove host-owned
consent and approval regresses to typing at a prompt; remove the seam and policy can be
bypassed by a second path; remove the transcript record and audit dies.
**Breaks if:** any tool path reaches execution without passing `AgentPolicy`; a consent outcome
exists that the transcript does not contain.

### Agents governing agents (escalation stays honest)

**Members:** [consent host-owned][consent] · [one session, one instance][session] ·
[transcript as single truth][transcript].
**Guarantee:** the `ask` residue can escalate rules → reviewer session → human, so fleets run
overnight with only genuine judgment reaching a person — while every hop remains auditable and
the chain always terminates at a human.
**Mechanism of conjunction:** a resolver is just code returning a promise, and a reviewer is
just another session instance — so escalation is composition, not new machinery. The
one-instance law keeps requester and approver as SEPARATE sessions with separate transcripts.
**Breaks if:** a session resolves its own requests; a reviewer's approval is not recorded in
BOTH transcripts; the escalation chain can terminate at an agent.

### The bidirectional instrument (the category shift)

**Members:** [editor as instrument][instrument] · [event stream, not screen][stream] ·
[consent host-owned][consent] — on the project's [one-way data flow] and the gate doctrine
(verify by driving).
**Guarantee:** the agent sees what the user sees (frame probe), asks what the IDE knows (LSP),
proves what it changed (smokes, gate) — through the same public seams the UI uses — while the
membrane governs every step. Control flows down, evidence flows up, both flows are data:
**they operate each other.**
**Mechanism of conjunction:** same-process object graph means tool = seam = one property hop;
event stream means every instrument reading returns as data; consent means every instrument
action was resolved. Remove the shared graph (the webview/extension moat every other
architecture has) and the instrument reduces to a shell; remove consent and the instrument is
ungoverned; remove the stream and its findings are pixels again.
**Breaks if:** an agent tool mutates state through a path the UI could not take; an instrument
invocation is missing from the transcript; agent verification asserts internal values instead
of driving the real path.

### Headless equivalence (one physics, any frontend)

**Members:** [one session, one instance][session] · [consent host-owned][consent] ·
[one backend seam][seam].
**Guarantee:** a cron job, a gate hook, and the visible pane run the SAME session class under
the SAME policy — headless is not a second implementation, it is the same instance with no
subscriber.
**Mechanism of conjunction:** the class never reads render state; policy's `ask` residue in
headless mode denies-and-logs instead of raising an overlay; the mock/SDK seam swap is
orthogonal to all of it.
**Breaks if:** any session behavior branches on whether a pane is mounted; headless runs get a
relaxed policy path "because nobody is watching."

[stream]: project.agent-harness.md
[transcript]: project.agent-harness.md
[consent]: project.agent-harness.md
[instrument]: project.agent-harness.md
[seam]: project.agent-harness.md
[citizen]: project.agent-harness.md
[session]: project.agent-harness.md
