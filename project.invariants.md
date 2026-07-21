# TUI Code Workspace — Project Invariants

Root contract: the load-bearing generators the whole architecture descends from, and the
governance record naming the contract-governed modules. Module-level rules live in each
module's colocated `src/modules/<module>/<module>.invariants.md`.

Invariants are unnumbered — the name is the identifier, referenced by name everywhere and
matched byte-for-byte by `// invariant:` code annotations. Chosen invariants stand on reality
invariants, never the reverse.

Grounding: the ivue mechanisms cited below are verified against `../ivue` source/docs and a
headless smoke test (`scripts/ivue-smoke.ts`); see `DECISIONS.md` for the study and page
references.

## Reality-based invariants

### The terminal shows a bounded viewport

**Invariant:** If content is displayed in a terminal, then only a fixed rows×columns window is
visible at once, independent of how much content exists.

**Scope:** All rendering. The window size changes only on resize.

**Mechanism:** A terminal is a fixed cell grid; the emulator exposes a finite dimension and
scrolls, it does not show unbounded content simultaneously.

**Generates:** *Cost tracks the actively observed set*; viewport-only rendering; virtualized
file tree, git history, outline, and editor.

**Evidence:** OpenTUI reports fixed terminal dimensions; `git`/scrollback do not change it.

**Impossible if true:** A render pass that must materialize every line/row/commit of a large
document to show one screen.

**Verification:** Inspection — the render path queries terminal dimensions and renders a
window bounded by them.

**Status:** established

**Last refined:** 2026-07-21

### A referenced resource stays alive

**Invariant:** If an effect, subprocess, watcher, timer, file descriptor, or keyed reactive
overlay remains referenced, then it retains its cost until explicitly released — garbage
collection cannot reclaim what is still reachable.

**Scope:** All owned resources: ivue effect scopes, OpenTUI renderables, LSP/git subprocesses,
file watchers, Tree-sitter trees, keyed revision-ref overlays.

**Mechanism:** JS reachability keeps referenced objects alive; OS resources persist until
closed. ivue keyed overlays (`Map<key, Ref>`) hold strong references and their watchers
subscribe permanently — they never self-GC, so eviction is part of the design, not optional
(`../ivue` flyweight docs; `$stopEffects()` is required for component-outliving instances).

**Generates:** *A resource lives only while observed* (component of *Cost tracks the actively
observed set*); the hot/warm/cold/disposed lifecycle tiers; explicit `dispose()`/eviction
paths; the resource-lifecycle audit.

**Evidence:** `../ivue/lib/Reactive.ts` (`$stopEffects` deletes scope + cached cells);
flyweight `evictOutsideRows` releases fine refs/computeds outside the viewport.

**Impossible if true:** Memory that stabilizes after repeated open/close cycles without any
explicit disposal or eviction path being exercised.

**Verification:** A lifecycle test that opens/closes buffers, workspaces, previews, and LSP
repeatedly and asserts RSS stabilizes and subprocess/watcher/effect counts return to baseline.

**Status:** provisional

**Last refined:** 2026-07-21

### Eager circular runtime reads fail during init

**Invariant:** If a module reads another module's runtime value during evaluation while their
imports form a cycle, then initialization can throw (`Cannot access 'X' before initialization`);
reads deferred to getter/method bodies are always safe.

**Scope:** All cross-module references in the class graph (the app's entity web is cyclic:
panes reference the app root, the app root creates panes).

**Mechanism:** A TS `namespace` compiles to a hoisted `var` filled by an IIFE, safe to hold
from module-eval instant; but a top-level `new B.Class()`, `const C = B.Class`, or
`export default B.Class` re-introduces an eager edge that a cycle can break
(`../ivue` modules docs). Circular *inheritance* remains genuinely impossible.

**Generates:** *Imported dependencies are read late*; the namespace pattern; the ban on
snapshotting `X.Class` at module scope.

**Evidence:** `../ivue/docs_v2/guide/modules.md#circular-references-resolve-by-construction`.

**Impossible if true:** A module-load-order that changes program behavior when every
cross-module read sits in a getter/method body and nothing snapshots `X.Class` at top level.

**Verification:** A build/lint check that flags top-level `new *.Class` / `const * = *.Class` /
`export default *.Class`; plus the app boots under any module order.

**Status:** provisional

**Last refined:** 2026-07-21

### An async result can outlive the state it described

**Invariant:** If a parse, LSP, or git result is produced asynchronously, then it can arrive
after the buffer/state it described has already changed.

**Scope:** Tree-sitter parses, LSP responses (diagnostics, semantic tokens, definitions), git
refreshes, ESLint runs.

**Mechanism:** Concurrency: the text/state advances while a worker/subprocess/request is in
flight; completion order is not arrival order.

**Generates:** *Async results are revision-stamped and stale results discarded*; *The immediate
layer never blocks the deferred layer*; superseding/cancelling stale refreshes.

**Evidence:** Standard concurrency; the brief's syntax and diagnostics sections.

**Impossible if true:** A highlight or diagnostic set derived from text older than the current
buffer overwriting the current view.

**Verification:** A test that issues rapid edits while a slow parse/LSP result is in flight and
asserts the stale result is dropped (revision mismatch), never applied.

**Status:** provisional

**Last refined:** 2026-07-21

### Terminals report key repeat not key up

**Invariant:** If a key is held, then the terminal emits repeated key events, not a
key-down/key-up pair — hold duration must be inferred from repeat timing.

**Scope:** All keyboard input, especially arrow-key acceleration.

**Mechanism:** Terminal input protocols deliver auto-repeat characters; true key-up is not
generally available.

**Generates:** Arrow-key acceleration inferred from repeat cadence; immediate reset on pause
or direction change.

**Evidence:** The brief's arrow-acceleration section; terminal input reality.

**Impossible if true:** Acceleration logic that depends on a real key-up event to reset.

**Verification:** A harness test sending repeated arrow sequences and asserting the acceleration
curve and its reset on pause.

**Status:** provisional

**Last refined:** 2026-07-21

### Terminal color and glyph support varies

**Invariant:** If the UI uses color or glyphs, then support varies across terminals (color
depth truecolor/256/16; nerd-font glyphs may be absent), so every palette and icon must resolve
through a capability fallback.

**Scope:** Themes, file-type icons, diagnostic underlines, git decorations, all styled output.

**Mechanism:** Terminals differ in declared color and font capability; using an unsupported
color/glyph degrades to garbage or blanks.

**Generates:** *Appearance is data with a capability fallback*; the truecolor→256→16 and
nerd→unicode→ascii ladders; the undercurl→underline→gutter diagnostic ladder.

**Evidence:** The brief's diagnostic-fallback section; terminal capability reality.

**Impossible if true:** Legible output on a 16-color / no-nerd-font terminal that hard-codes
truecolor or nerd glyphs.

**Verification:** A harness test rendering the file tree and diagnostics under forced 16-color /
no-nerd-font capability and asserting legibility.

**Status:** provisional

**Last refined:** 2026-07-21

### Language and git tools are separate failable processes

**Invariant:** If the editor uses LSP, git, or ESLint, then each is a separate OS process that
can be absent, slow, or crash, and the editor must remain fully usable regardless.

**Scope:** LSP servers, git subprocesses, ESLint providers.

**Mechanism:** These run out-of-process; their availability and latency are outside the
editor's control.

**Generates:** *The immediate layer never blocks the deferred layer*; lazy startup; disposal
on cool/close; graceful degradation to no-semantic mode.

**Evidence:** The brief's LSP/git/ESLint sections; subprocess reality.

**Impossible if true:** Editing that blocks or crashes when LSP/git/ESLint is missing, slow, or
dies.

**Verification:** Adversarial tests: LSP absent, LSP killed mid-session, git command failure —
editing continues, no crash, terminal restored.

**Status:** provisional

**Last refined:** 2026-07-21

### A text position has several encodings

**Invariant:** If a position in text is referenced, then its UTF-8 byte offset, UTF-16 unit
offset, logical character index, and terminal display column do not coincide, and each consumer
must use the encoding it requires.

**Scope:** Cursor math, selection, Tree-sitter edit coordinates, LSP positions (UTF-16),
terminal column mapping, tab expansion, wide/combining characters.

**Mechanism:** Multi-byte UTF-8, surrogate-pair UTF-16, zero-width/combining marks, wide (2-col)
glyphs, and tab expansion each break the 1:1 assumption between these encodings.

**Generates:** Explicit encoding conversions at every boundary; the coordinate-correctness test
matrix; the editor/syntax/lsp coordinate discipline.

**Evidence:** The brief's coordinate-correctness section; Unicode/terminal reality.

**Impossible if true:** A cursor, selection, or LSP jump that lands correctly on ASCII but
drifts on Unicode, tabs, wide, or combining characters.

**Verification:** Unit tests over Unicode, tabs, CRLF/LF, combining, wide chars, asserting each
encoding conversion round-trips.

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### Cost tracks the actively observed set

**Invariant:** If data exists in the system, then its memory, reactivity, and background-activity
cost scale with what is visible and actively observed, not with what exists.

**Scope:** Editor buffers, syntax spans, terminal cells, file tree, git history, diagnostics,
symbol outline, markdown tokens — every high-cardinality dataset.

**Components:**
- *Ground truth is compact and non-reactive at rest* — columnar typed arrays / plain Maps /
  packed spans hold the data; refs are sparse version signals, not value holders.
- *A resource lives only while observed* — reactive overlays and services are materialized for
  the visible window and evicted/disposed when cold.

**Mechanism:** The ivue flyweight pattern (`../ivue` flyweight-grid): columnar ground truth +
disposable per-render facades + a two-tier sparse revision overlay (fine per-item, coarse
per-block refs) with explicit eviction; a single frame effect pulls only the visible window
through tracked accessors, subscribing to exactly the version refs it touches. Measured
4.7 bytes/cell at 20M cells, +0.3 MB after 30 viewports.

**Generates:** The flyweight architecture; viewport rendering; packed highlight spans and
`ScreenBuffer`; hot/warm/cold/disposed tiers; lazy LSP; `evict*` paths.

**Evidence:** `../ivue/docs_v2/guide/flyweight.md` + the flyweight-grid model (4.7 bytes/cell at
20M cells, +0.3 MB after 30 viewports); the flyweight editor/syntax code lands M2.

**Impossible if true:** A reactive object per cell/token/line; an LSP alive for a cold
workspace; idle CPU above ~zero; memory that grows with file/repo size rather than visible size.

**Verification:** A benchmark opening a 100k-line file / 20M-cell grid asserting bytes/visible
scale and observed-effect count O(viewport); idle CPU ~0 after activity.

**Status:** provisional

**Last refined:** 2026-07-21

### Derived state is a plain getter unless caching is proven

**Invariant:** If a value is derived from reactive state, then it is expressed as a named plain
getter unless a specific need (expensive recompute, render-suppression, or a stable ref
identity) justifies `computed()`.

**Scope:** All derived/conditional state in reactive models.

**Mechanism:** ivue rewrites getters to lazy cells; a plain getter lives once on the prototype
(0 bytes/instance) and stays fully reactive by subscribing to the leaf refs it reads, at any
depth. `computed()` costs ~300 bytes/instance when observed and is only worth it when caching
pays (`../ivue` computed-watch docs; 60 computeds × 10k items ≈ hundreds of MB).

**Generates:** The nearly-computed-free architecture; named getters for every `v-if`/ternary;
thin computeds (logic in a method, arrow always).

**Rejected alternatives:** `computed()` by default — costs memory per instance for derivations
that a plain getter delivers free.

**Evidence:** `../ivue/docs_v2/guide/computed-watch.md`; `scripts/ivue-smoke.ts` (the plain
getter `double` tracks reactively). Enforced from M1.

**Impossible if true:** A `computed()` in the codebase with no caching/identity justification.

**Verification:** A review/lint pass counting `computed()` uses, each with a one-line
justification; the architecture-compliance audit.

**Status:** provisional

**Last refined:** 2026-07-21

### Imported dependencies are read late

**Invariant:** If a module depends on another module's class, then that dependency is read
inside a getter or method body at call time, never constructed or snapshotted at module scope.

**Scope:** Every cross-module class reference in the graph.

**Mechanism:** Stands on *Eager circular runtime reads fail during init*. Reading the live
`X.Class` binding late (never `const C = X.Class`, never top-level `new`) lets the cyclic entity
web resolve by construction.

**Generates:** The `static get Dep() { return Dep.Class }` late-getter pattern; the ban on
default-exporting a `Class`; boot under any module order.

**Evidence:** `../ivue/docs_v2/guide/modules.md#circular-references-resolve-by-construction`.
Lint gate + enforced from M1.

**Impossible if true:** A top-level `new *.Class()`, `const * = *.Class`, or `export default
*.Class` in module source.

**Verification:** A lint/grep gate flagging those forms; the app boots under shuffled import
order.

**Status:** provisional

**Last refined:** 2026-07-21

### Construction goes through overridable seams

**Invariant:** If an object assembles a dependency, then it does so through an overridable seam
— the mutable `Class` slot or an overridable factory method — never a hidden hard-coded
decision in a constructor.

**Scope:** All domain-model and capability construction.

**Mechanism:** ivue's real seam is the mutable `namespace.Class` binding (`new X.Class()` reads
the live slot; a plugin/kernel swaps it) plus owner-constructs-child (`new Task.Class(this,
data)`). Our chosen convention adds `createX()` factory methods for constructor-time assembly,
overridable via subclass/`super` — `createX()` is our idiom, not an ivue feature.

**Generates:** The `Class`-slot swap for plugins; `createX()` factory methods; owner-injects-self
child construction; testable replacement of ids/clocks/engines.

**Rejected alternatives:** Hard-coding `new ConcreteDep()` in a constructor — unreplaceable in
tests and plugins.

**Evidence:** `../ivue` namespace-pattern docs + `examples/.../workspace-platform/Workspace.ts`
(owner-constructs-child, `new Task.Class(this, data)`). Code from M1.

**Impossible if true:** A dependency choice baked into a constructor with no override point.

**Verification:** A test replacing a model's id/clock/storage seam via subclass or `Class` swap
and observing the substitution take effect.

**Status:** provisional

**Last refined:** 2026-07-21

### The app is built only after the kernel is sealed

**Invariant:** If the application is constructed, then plugin class-graph composition has already
completed and sealed — no application instance is created during plugin registration.

**Scope:** Boot sequence; kernel plugins; the `App` root and all module models.

**Mechanism:** The kernel (vendored/adapted from `../ivue` extensible-kernel) registers
extension classes, captures inheritance, topologically composes plugin factories, reparents
descendants onto composed parents, applies `Reactive()`/`Static()`, replaces namespace `Class`
bindings, then seals; construction after seal is native `new` + prototype dispatch with zero
registry lookup. Sealing changes future construction only; it never hot-mutates existing
instances.

**Generates:** The `Bootstrap` boot phase; `kernel.sealClassGraph()` before `new App.Class()`;
plugin toggle = capture → reset → re-register → seal → reconstruct.

**Evidence:** `../ivue/examples/playground/src/examples/extensible-kernel/kernel.ts`
(`sealClassGraph` composes then seals). Kernel module M1, plugins M7.

**Impossible if true:** An application singleton constructed during module evaluation or during
plugin registration; a live instance mutated into a new class by a plugin toggle.

**Verification:** A test that registers a kernel plugin, seals, constructs, and asserts the
composed behavior is present and no instance predates the seal.

**Status:** provisional

**Last refined:** 2026-07-21

### ivue owns state and OpenTUI owns projection

**Invariant:** If application state is observed, then ivue owns it; if the terminal is drawn or
input is read, then OpenTUI owns that — there is exactly one state system and one projection
system.

**Scope:** All application state and all terminal rendering/input.

**Mechanism:** A single reactive source of truth (ivue models) feeds custom OpenTUI renderables;
the editor viewport is a custom renderable, never a template renderer holding parallel state.

**Generates:** Custom `*Renderable` classes; no second state store; the one-way flow below.

**Rejected alternatives:** A second state system inside the renderer — two sources of truth that
drift.

**Evidence:** The brief's Terminal-Rendering and Rendering-and-Reactivity rules (one state
system; custom renderables). Enforced from M1.

**Impossible if true:** Two systems both holding editor/workspace state; a render path that is
the source of scroll/selection truth.

**Verification:** Architecture audit — grep for state held in renderables; assert renderables
pull from models and hold none.

**Status:** provisional

**Last refined:** 2026-07-21

### Data flows one way

**Invariant:** If state changes, then it flows input event → model method → mutation → reactive
invalidation → `requestRender()` → frame; a render pass never mutates model state.

**Scope:** The whole input-to-frame loop.

**Mechanism:** OpenTUI input events call ivue model methods; a single coarse frame effect reads
the visible window and calls `requestRender()`; the renderable pulls compact data during render.

**Generates:** The one coarse invalidation effect (not effect-per-line/token/cell); render-pulls
-visible-data.

**Evidence:** The brief's data-flow diagram (OpenTUI input → ivue method → mutation →
invalidation → `requestRender`). Enforced from M1.

**Impossible if true:** A renderable that writes model state during its render pass; an
effect-per-item render graph.

**Verification:** A test asserting the editor uses one frame effect and renderables perform no
state mutation.

**Status:** provisional

**Last refined:** 2026-07-21

### The immediate layer never blocks the deferred layer

**Invariant:** If the deferred layer (LSP, ESLint, git) is slow or absent, then the immediate
layer (Tree-sitter highlighting, typing, cursor) proceeds without waiting.

**Scope:** Syntax vs semantic tokens; typing vs diagnostics; editing vs git refresh.

**Mechanism:** Stands on *Language and git tools are separate failable processes* and *An async
result can outlive the state it described*. Tree-sitter provides immediate syntax; LSP/ESLint/git
enrich asynchronously and never gate input.

**Generates:** Tree-sitter-first highlighting; async debounced git refresh; non-blocking
diagnostics; the UI never freezing on a backend.

**Evidence:** The brief's Real-Time-Syntax and Diagnostics sections (Tree-sitter first,
semantic later). Verified M2 (syntax) / M5 (LSP).

**Impossible if true:** Typing that stalls on an LSP/ESLint/git response; highlighting that
waits for semantic tokens.

**Verification:** A test with a stalled LSP/git asserting typing and highlighting latency are
unaffected.

**Status:** provisional

**Last refined:** 2026-07-21

### Async results are revision-stamped and stale results discarded

**Invariant:** If an async result (parse, LSP, git, ESLint) is applied, then it carries the
buffer/document revision it was computed against, and a result older than current state is
discarded, never applied.

**Scope:** Highlight spans, semantic tokens, diagnostics, definition results, git refreshes.

**Mechanism:** Stands on *An async result can outlive the state it described*. Every result
carries a revision/version; on completion it is applied only if it matches the latest revision.

**Generates:** Buffer-revision stamping; stale-drop on parse/LSP/diagnostics; superseding stale
git refreshes.

**Evidence:** The brief's rule "apply only results matching the latest buffer revision" +
diagnostics staleness handling. Verified M2 / M5.

**Impossible if true:** An older parse/diagnostic overwriting highlighting/diagnostics for newer
text.

**Verification:** A test issuing rapid edits during in-flight async work, asserting only
latest-revision results are applied.

**Status:** provisional

**Last refined:** 2026-07-21

### The core is complete without plugins

**Invariant:** If a feature is essential (per the brief's scope), then it works with all plugins
disabled; plugins extend a complete product, they never supply a basic.

**Scope:** All core surfaces: workspaces, files, editing, git, LSP, markdown, palette.

**Mechanism:** Core features live in core modules; the plugin system adds contributions and
kernel compositions on top.

**Generates:** The two-tier plugin architecture; "no essential feature requires a plugin"; the
demonstration plugins are additive.

**Evidence:** The brief's Plugin-Architecture ("plugins extend a complete product"). Verified by
the M7 all-plugins-disabled run.

**Impossible if true:** An essential feature that only works with a plugin enabled.

**Verification:** A run with all plugins disabled exercising every Definition-of-Done capability.

**Status:** provisional

**Last refined:** 2026-07-21

### No action requires a memorized motion

**Invariant:** If an action exists, then it is reachable without memorized motions — a familiar
default binding, a command-palette entry, and a rebindable shortcut; no modal editing.

**Scope:** Every user action.

**Mechanism:** Every core action is registered as a command; the palette lists all; bindings are
configurable; defaults follow familiar (VS Code / nano) conventions.

**Generates:** Command-palette-for-everything; visible shortcut hints; rebindable keys; the
not-a-Vim-clone stance.

**Evidence:** The brief's Keyboard-and-Command-System ("every core action is a command";
not-a-Vim-clone). Verified M3.

**Impossible if true:** A core action reachable only by an unlisted, unrebindable keystroke, or
a mode the user must enter to type.

**Verification:** A test asserting every registered command has a palette entry and a rebindable
binding; no modal state gates insertion.

**Status:** provisional

**Last refined:** 2026-07-21

### Appearance is data with a capability fallback

**Invariant:** If the UI shows color or icons, then they come from swappable data (palettes,
icon sets), never hard-coded, and each resolves through a capability fallback ladder.

**Scope:** Themes, file-type icons, syntax colors, git/diagnostic decorations, gutter.

**Mechanism:** Stands on *Terminal color and glyph support varies*. `theme.palettes.ts` /
`theme.icons.ts` are semantic-token data; `TerminalCapabilities` drives truecolor→256→16 and
nerd→unicode→ascii resolution; the active theme is a reactive selection; themes/icons are
contribution-plugin extension points.

**Generates:** The `theme` module; semantic color tokens pulled by ui/editor/syntax/diagnostics;
theme/icon plugin contributions.

**Evidence:** The brief's diagnostic undercurl→underline→gutter fallback; the `theme` module
lands M2.

**Impossible if true:** A hard-coded truecolor/nerd-glyph that breaks legibility on a limited
terminal; a component that colors itself without going through the theme.

**Verification:** A harness test forcing 16-color / no-nerd-font and asserting legible output;
grep for hard-coded colors/glyphs outside `theme`.

**Status:** provisional

**Last refined:** 2026-07-21

### Completion is proven not declared

**Invariant:** If a milestone or the project is called done, then a set of green evidence
artifacts says so — never the builder's self-assessment; the final sign-off comes from
independent reviewers told to refute.

**Scope:** Every milestone gate and the final Definition of Done.

**Mechanism:** The completion gate (implementation-plan §5.1): traceability matrix, invariant
checker, resource-lifecycle audit, recorded benchmarks, an independent subagent panel, and a
completeness critic dry twice — each a checkable artifact.

**Generates:** The layered verification model; the subagent cross-check; the completion gate;
`VERIFICATION_RESULTS.md` and the traceability matrix.

**Evidence:** `IMPLEMENTATION_PLAN.md` §5 (the completion gate + layered verification + subagent
panel). Enforced at every gate.

**Impossible if true:** A milestone declared done because "it works"; the author certifying
their own work at the gate; a requirement with no verification procedure counting as covered.

**Verification:** The gate itself — the six artifacts are green, and the panel carries no
unresolved critical/high finding.

**Status:** provisional

**Last refined:** 2026-07-21

### Core modules are contract-governed

**Invariant:** If a module is on the governed list below, then it carries a colocated
`<module>.invariants.md` contract and changes to it are reviewed against that contract.

**Scope:** The modules under `src/modules/`. Governed set (contract bootstrapped at its
milestone, hardest-first):

- M1: `app`, `kernel`, `system`
- M2: `workspace`, `storage`, `editor`, `syntax`, `theme`
- M3: `editor` (editing), `storage` (piece table / undo)
- M4: `git`, `diff`
- M5: `lsp`, `diagnostics`
- M6: `markdown`
- M7: `kernel` (composition), `commands`, `keybindings`

**Mechanism:** The `/invariants` skill derives review scope from colocated contracts; a contract
next to the module makes changes to it implicate its rules. Module contracts are bootstrapped
per milestone (grounded, not vacuous), never all up front.

**Generates:** The per-module bootstrap queue; the milestone invariant-loop cadence; the review
gate on every governed diff.

**Evidence:** This governance record + the module tree under `src/modules/`; both project
contracts pass `check_invariants.mjs`.

**Impossible if true:** A governed module with no contract file; a module silently dropped from
this list without a recorded decision.

**Verification:** For each governed entry at/after its milestone, the contract file exists and
the checker passes; `--refs` resolves its annotations.

**Status:** provisional

**Last refined:** 2026-07-21
