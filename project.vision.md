# The Instrument — what Invar is actually becoming

*Free-form companion to `project.agent-harness.md`. That file is the contract; this one is the
territory. Written 2026-07-23, the day the terminal landed, Claude ran inside it, and we noticed
what was lying on the table.*

---

## 1. Nobody planned this

Invar exists because VS Code ate 95 GB of RAM and vi wanted a decade of muscle memory. The goal
was an editor: desktop ergonomics, in a terminal, learnable in fifteen minutes.

But it was built a particular way — every module reduced to invariants, every capability behind a
seam, every claim verified by driving the real user path — and reduction has a side effect nobody
prices in: **invariant-shaped machinery outlives its first purpose.** Special-purpose code serves
its purpose; reduced code serves every future purpose that shares the invariants.

So the editor accumulated organs that were never "editor features":

- a **compositor** (panes, splitters, overlays, z-order, focus),
- an **input stack** (mouse protocols, keys, gestures, momentum),
- **system seams** (files, processes, clock, clipboard, status — syscalls behind `Static()`),
- an **IPC layer** (JSON-RPC to language servers),
- a **real terminal** (openpty via FFI, one emulator as the single source of screen truth),
- a **verification culture** (colocated contracts, a merge gate that drives the framebuffer),
- and a **1.1 kB reactive substrate** where the whole domain is one navigable object graph.

Then Claude Code ran inside the terminal pane, and the realization arrived at once: these organs
assemble into a different animal. The editor was the first application. The second is a harness —
and not a harness like the ones that exist.

## 2. The inversion: pixels down, data up

Every AI coding tool today speaks to you in **pixels or prose**: a scrolling terminal, a chat
webview, a wall of markdown. The agent narrates; you trust or you re-derive. Verification is
expensive, so mostly nobody verifies. That expense is where slop lives.

The native harness inverts the medium. Through the SDK, the agent is not a screen — it is a
**stream of structured events**: said-this, wants-to-run-that, produced-this-result. Events are
data, and data can be *projected* into anything the host owns:

- the diff lands in the real side-by-side diff view,
- the file reference is a click that opens the real tab at the real line,
- the invariant the work claims to satisfy is a link to the actual record,
- the tool request is a native overlay with real buttons,
- the whole session is an append-only transcript you can fold, search, replay, and audit.

The agent stops *telling* you what it did. It **takes you there**. "Show me" becomes the default
reading mode, and slop — which survives only where showing is expensive — loses its habitat.

## 3. The membrane: unlock, gate, sieve

Between the agent's intent and any execution sits a policy pipeline that is *code you own*:

```
tool request → rules → (allow | deny | ask) → reviewer agent → human
```

Every arrow is data; every resolution is a transcript event. And because it's data, it's
*programmable culture*:

- **Profiles.** Reads auto-approve; writes ask; `rm -rf` hard-denies. Or full yolo for a
  scratch repo — deliberately chosen, still audited.
- **Conditions.** A commit-shaped tool call can require the merge gate green. The quality bar
  stops being a habit and becomes a physical property of the pipeline.
- **Escalation through agents.** The `ask` residue doesn't have to reach a human first — a
  conservative *reviewer session* can adjudicate the worker's requests, and only what it
  escalates reaches you. The conductor's adversarial-verify doctrine, promoted from workflow to
  runtime. One law keeps it honest: **the approver is never the requester**, and the chain always
  terminates at a human.

Control flows down through the membrane. Evidence flows up through the transcript. Both flows are
data. That is the whole security and sanity model in one sentence.

## 4. The second inversion: the editor is the agent's body

This is the part no other architecture can say. Today's agents are blind organisms with a shell:
they grep at repos, run commands, and *hope* — because they live across a process boundary from
the tools that actually understand the code.

In Invar, the agent and the editor share one process, one reactive graph, one object model. So the
agent's tools can be **the same seams the UI calls**:

- **Eyes:** `queryDiagnostics` — ask the real LSP, not a regex. `readFrame` — look at the actual
  rendered framebuffer and see what the user sees.
- **Hands:** `openFile`, `getSelection`, drive a pane — through the identical public graph the
  mouse drives: `workspaceSet.active.editor…`, one property hop from everything.
- **Conscience:** `runSmoke`, the merge gate — the agent can verify its own UI work by driving
  the real user path, which until now was a lab technique for framework authors.
- **Memory:** the transcript, the invariants contracts, the delegation log — durable, linkable,
  citable by name.

An agent that can *see the frame, drive the smokes, and cite the contract* is not a code
generator. It is an operator of an instrument. And symmetrically, the instrument governs the
operator through the membrane. **They operate each other.** That loop — governed in one
direction, evidenced in the other — is the category that doesn't have a name yet.

## 5. Why this exists here and nowhere else

Not because anyone here is smarter. Because of four accumulated properties that resist retrofit:

1. **Same-process object graph.** Extension-API architectures put the agent in a webview across a
   serialization moat; "read the frame" and "one hop from everything" cannot cross it. Here there
   is no moat — the graph is the API.
2. **One grammar.** 96 files, one class shape, one seam shape. An agent primed with one page of
   conventions ships correct code overnight — measured, 292 commits of it.
3. **Contracts + gate.** Verification is already mechanical and colocated. Agent work inherits the
   same physics as human work: nothing merges on vibes.
4. **The substrate is 1.1 kB and boring.** No framework physics for the agent (or the human) to
   simulate. A ref changes; the effects that read it re-run. The entire runtime model fits in a
   sentence, which is exactly the size an agent can hold perfectly.

Retrofitting any one of these into a 512k-LOC React organism is a rewrite. Here they're the
foundation.

## 6. The trajectory

- **Now (Tier S):** one session, transcript pane, policy'd approvals, clickable evidence. The
  weekend build. Guest mode (Claude Code in the PTY) keeps working forever beside it.
- **Then (Tier M):** persistence and replay; multi-session tabs; the first instrument tools
  (diagnostics, selection, openFile); diffs through the real diff view; context injection.
- **Then (Tier L):** the fleet becomes visible — conductor workers as sessions in a dashboard,
  StatusChannel badges when one finishes or parks a question; frame-probe and smoke tools close
  the agent's own verify loop; gate-conditioned consent; headless sessions from cron sharing the
  same policy.
- **Then the packaging admits what it is:** a container image whose entrypoint is `iv` — kernel,
  git, tsgo, one binary. Boot a machine into the instrument. The working title is a joke that
  stopped being one: **InvarOS**.

The human's role concentrates where it is irreplaceable, and it is the same role that built this
repo: **knowing which rules are load-bearing.** Agents generate; contracts constrain; gates
verify; the membrane governs; evidence flows up. That division of labor is not a compromise with
AI — it is the correct factoring of software work, and it was discovered here by building an
editor and refusing, at every step, to let anything hold together by vigilance.

## 7. The name of the thing

An editor hosts your attention. An IDE hosts your tools. This hosts **a governed collaboration**:
human intent, agent labor, contract law, and mechanical verification, sharing one object graph —
with every exchange between them made of inspectable data.

Call it an instrument. Instruments are what you build when you stop wanting output and start
wanting *evidence*. The alloy holds its shape under heat; now it plays.
