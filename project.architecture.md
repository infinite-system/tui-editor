# Architecture

The system shape is *generated* by the invariants, not chosen alongside them. Read
`project.invariants.md` and `project.lattice.md` first; this file is the narrative of what those
generators produce. ivue mechanics and page references are in `project.decisions.md`.

**Product thesis (not a falsifiable invariant, per the brief):** developer ergonomics and
runtime performance reinforce each other — coherent ownership → fewer accidental reactive graphs
→ easier lifecycle enforcement → lower memory → better scalability.

## What the invariants generate

- Because *the terminal shows a bounded viewport* + *cost tracks the actively observed set* +
  *data flows one way*, the editor is **flyweight-shaped**: compact columnar ground truth, a
  single OpenTUI frame effect, viewport-pull rendering. No per-line/token/cell object.
- Because *language and git tools are separate failable processes* + *the immediate layer never
  blocks the deferred layer*, highlighting/diagnostics are **two layers**: immediate Tree-sitter
  (synchronous, always present) and deferred LSP/ESLint/git (async, revision-stamped, optional).
- Because *public classes use the namespace pattern*, every class publishes the same raw and
  selected forms whether it is reactive, static, or plain. Separately, because *eager circular
  runtime reads fail during init*, dependencies are read late; with the
  **seal-before-construct kernel**, those rules let the cyclic entity graph (panes ↔ app root ↔
  workspaces) and the plugin system coexist.
- Because *completion is proven not declared*, the build carries an **evidence gate + independent
  review panel** (`project.implementation-plan.md` §5).

## Two owners: ivue and OpenTUI

ivue owns observable state; OpenTUI owns terminal projection and input. One state system, one
projection system. Flow: `OpenTUI input → ivue model method → mutation → reactive invalidation →
requestRender() → frame`. The editor viewport is a custom OpenTUI renderable that *pulls* the
visible window from the model during render; it holds no state.

## The three class kinds (per module)

- **Reactive domain models** — `App`, `Workspace`, `Buffer`, `Cursor`, `Editor`, `Viewport`,
  `GitRepository`, `DiffModel`, `LanguageClient`, `MarkdownPreview`, `Theme`. `Reactive($Class)`,
  ref-returning getters, plain-getter derivation, `$watch`/`$stopEffects` ownership.
- **Plain stateful classes** — `PieceTable`, `LineIndex`, `UndoStore`, `RingBuffer`, `PackedSpans`,
  `ScreenBuffer`, `TreeSitterParser`, `LspProcess`, `LspTransport`, `DiffEngine`. Algorithms and
  resource owners; non-reactive; bridged to models via revision refs.
- **Static capability classes** (vendored `Static()`) — `Files`, `Paths`, `Processes`,
  `Environment`, `Clock`, `Ids`, `GitCommands`, `Logging`, `TerminalCapabilities`. Allocation-free,
  `super`-capable, replaceable, dependencies read late via static getters.

## Modules

`app · kernel · system · storage · workspace · editor · syntax · lsp · diagnostics · git · diff ·
markdown · commands · keybindings · ui · theme` — each a folder under `src/modules/` with
PascalCase class files, `<module>.<role>.ts` role files (no HTTP roles — this is a TUI), and a
colocated `<module>.invariants.md` bootstrapped at its milestone. Module map and milestone
mapping: `project.implementation-plan.md` §3–4 (historical).

**Added since (2026-07 wave):** `agent` (the native AI-agent pane: one `AgentBackend` seam with five
implementations — Claude CLI stream, Claude Agent SDK with `canUseTool` permission pausing, codex
exec stream, codex app-server JSON-RPC with approvals, echo/mock; `AgentSession` owns the transcript
as the single source of truth with pane/audio/probe/context-port as its projections; interactive
y/n/a permission surface; live claude⇄codex engine switch with a bounded transcript context port) ·
`terminal` (VT emulator over a PTY backend seam, panel citizen) · `narration` (TtsBackend seam,
piper/espeak, SpeakableText prose transform) · `image` (ImageDecoders registry — PNG/JPEG → RGBA;
render tiers kitty-graphics → sixel → half-block via OpenTUI's capability report, placement-managed)
· `layout` · `navigation` · `search` · `settings` (sectioned, mouse-editable, applied-effect gated).
The bottom panel is a `PanelHost` of switchable/splittable `PaneContent` cells (terminal + agent).

## Lifecycle tiers

Hot (visible, effects + parser + LSP + watcher active) → Warm (recently used, compact state,
minimal watchers) → Cold (serialized metadata only) → Disposed (resources released). Realized via
the ivue `$stopEffects()` deactivate/reactivate cycle + explicit eviction of keyed overlays;
durable truth lives outside the reactive overlay so it survives teardown. Nothing is merely
hidden — inactive resources are cooled or disposed.

**Documented exception (2026-07-24): persistent panel sessions.** The bottom panel's terminal PTY
and agent session are deliberately SESSION-persistent: hiding the panel hides the projection but
keeps the child process / transcript alive (a shell or an in-flight agent turn must survive a panel
toggle). Their release point is app disposal, not visibility. The honest cost rule for these:
*projection* cost tracks visibility (hidden panes don't repaint, and animation timers must gate on
visibility — enforced by the idle-quiescence contract), while *session* cost is user-owned until
quit. This is the recorded scope-narrowing of "nothing is merely hidden", not a violation of it.

## Boot

`main.ts` → `Bootstrap`: register kernel plugins → `kernel.sealClassGraph()` → construct `App`.
No application instance exists before the seal. Dev is by-restart (no hot-module runtime for the
Bun process).
