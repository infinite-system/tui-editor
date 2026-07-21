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
- Because *eager circular runtime reads fail during init*, modules use the **namespace pattern**
  with late reads and a **seal-before-construct kernel** — the only shape in which the cyclic
  entity graph (panes ↔ app root ↔ workspaces) and the plugin system coexist.
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
mapping: `project.implementation-plan.md` §3–4.

## Lifecycle tiers

Hot (visible, effects + parser + LSP + watcher active) → Warm (recently used, compact state,
minimal watchers) → Cold (serialized metadata only) → Disposed (resources released). Realized via
the ivue `$stopEffects()` deactivate/reactivate cycle + explicit eviction of keyed overlays;
durable truth lives outside the reactive overlay so it survives teardown. Nothing is merely
hidden — inactive resources are cooled or disposed.

## Boot

`main.ts` → `Bootstrap`: register kernel plugins → `kernel.sealClassGraph()` → construct `App`.
No application instance exists before the seal. Dev is by-restart (no hot-module runtime for the
Bun process).
