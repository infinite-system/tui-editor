# Implementation Plan — Fable TUI Code Workspace

Governing spec: [`project.brief.md`](./project.brief.md).
Governing method: IBR + the `/invariants` skill. This document is the build plan; the
enforceable contracts live in `project.invariants.md`, `project.lattice.md`, and each
module's colocated `<module>.invariants.md`.

---

## 1. Method — the invariant loop drives a greenfield build

This is a greenfield build, which inverts the usual `/invariants` flow (there is no code to
check yet). So the invariant loop and the build loop run at one cadence, per milestone:

```
bootstrap/refine the module's <module>.invariants.md (provisional)
  → build the module to the contract
  → invariant-review the milestone diff (/invariants)
  → run the module's Verification (tests + tmux harness)
  → promote provisional → established where green
  → benchmark, record, commit
```

Consequences held throughout:

- Every record starts `provisional`; its Verification names the test to be written; it is
  promoted to `established` only when that test runs green against real code. No record is
  born `established`.
- Contracts are validated by **execution**, never by assertion — the same discipline the
  brief mandates for performance. A candidate that fails its probe is a bug finding, not a
  record.
- `project.invariants.md` + `project.lattice.md` are written **now** (pre-code) because
  they can be grounded in the brief, the ivue docs, and the reality of terminals/git/LSP.
  Module contracts are bootstrapped **per milestone**, hardest subsystem first — never all
  up front (that produces vacuous records with no evidence).

---

## 2. Project invariants (named, never numbered)

Preview of `project.invariants.md`. The brief's 37 architectural invariants reduce to the
generators below; each generates many of the 37 and predicts specific impossibilities. Names
are the identifiers — referenced by name everywhere, matching code annotations byte-for-byte.

### Reality invariants (discovered; the substrate the architecture stands on)

- **The terminal shows a bounded viewport** — almost all data is never simultaneously visible.
- **A referenced resource stays alive** — unreleased effects, subprocesses, watchers, fds,
  and timers accumulate cost (JS reachability + OS resources).
- **Eager circular runtime reads fail during init** — module evaluation is ordered; a
  cross-module runtime read during circular initialization throws.
- **An async result can outlive the state it described** — parse, LSP, and git results can
  land after the buffer they describe has changed.
- **Terminals report key repeat, not key up** — holding a key yields repeat events, not a
  key-down/key-up pair.
- **Terminal color and glyph support varies** — color depth ranges truecolor/256/16 and
  nerd-font glyphs may be absent; every palette and icon needs a capability-aware fallback.
  (The same reality behind the brief's undercurl → underline → gutter-marker ladder.)
- **Language and git tools are separate failable processes** — LSP, git, and ESLint can be
  absent, slow, or crash.
- **A text position has several encodings** — UTF-8 bytes, UTF-16 units, logical characters,
  and display columns do not coincide. (Lives primarily in the `editor`/`syntax` modules.)

### Chosen invariants (disciplines held consistently; each stands on the reality above)

- **Cost tracks the actively observed set** *(master)* — memory, reactivity, and background
  activity scale with what is visible and observed, not with what exists. Two components:
  *ground truth is compact and non-reactive at rest*; *a resource lives only while observed*.
  Generates the flyweight architecture, viewport rendering, hot/warm/cold/disposed tiers,
  lazy LSP, packed spans. Forbids: a reactive object per cell/token/line; an LSP alive for a
  cold workspace; idle CPU above ~zero; memory that grows with file/repo size.
- **Imported dependencies are read late** — no top-level construction, no eager read of
  another module's `Class` binding during evaluation. Forbids a `new ImportedClass()` at
  module scope.
- **Construction goes through overridable seams** — constructors assemble via `createX()`
  methods; no dependency decision is hidden in a constructor.
- **The app is built only after the kernel is sealed** — plugin composition completes before
  any application instance is constructed.
- **ivue owns state, OpenTUI owns projection** — one state system; the editor viewport is a
  custom OpenTUI renderable, never a template renderer.
- **Data flows one way** — input event → model method → mutation → reactive invalidation →
  `requestRender()` → frame. Forbids a render path that mutates model state.
- **The immediate layer never blocks the deferred layer** — Tree-sitter highlighting never
  waits for LSP/ESLint; git refresh and LSP never freeze input.
- **Async results are revision-stamped and stale results discarded** — every parse/LSP/git
  result carries a buffer revision; an older result never overwrites newer state.
- **The core is complete without plugins** — no essential feature requires a plugin; plugins
  extend a working product.
- **No action requires a memorized motion** — familiar defaults, every command in the
  palette, all shortcuts rebindable; no modal editing.
- **Appearance is data with a capability fallback** — color palettes and file-type icon sets
  are swappable data, never hard-coded; each resolves through a fallback ladder
  (truecolor → 256 → 16; nerd glyph → unicode → ascii) so the UI stays legible on any
  terminal. Themes and icon sets are contribution-plugin extension points.
- **Diff mode decorates the live buffer** — a side-by-side diff pairs a read-only cold
  projection of the previous version (a git blob, disposed on close) with the **same live
  editable `Buffer`** the normal editor uses; the right pane is never a separate "current"
  copy. Editing recomputes the diff live (debounced, revision-stamped, stale discarded).
  Stands on *ivue owns state, OpenTUI owns projection* and *Cost tracks the actively observed
  set*. Forbids: a second buffer/state for the current side; a read-only "current" pane; a
  diff that goes stale against the edited text.
- **Completion is proven, not declared** — a milestone or the project is "done" only when a
  set of green evidence artifacts says so (traceability matrix, invariant checker,
  resource-lifecycle audit, recorded benchmarks, an independent subagent panel, a
  completeness critic that finds nothing new twice) — never on the author's self-assessment.
  The final sign-off comes from independent reviewers told to refute, not from the builder.
  Generates the completion gate, the layered verification model, and the subagent cross-check
  (§5). Forbids: declaring a milestone done because "it works"; the author certifying their
  own work at the gate; a requirement with no verification procedure counting as covered.
- **Workspace and file navigation are separate layers** — project/worktree tabs and
  file/buffer tabs never share a command; switching a workspace restores its full inner
  state. (Primarily a `workspace`-module record, surfaced at project level.)

### Governing principle (presides, not a subsystem record)

- **Smallest coherent architecture** — IBR's reduction discipline: no abstraction that only
  renames another; every abstraction justifies its runtime and maintenance cost.

### Explicitly not invariants (relocated so they don't pollute the contract)

- Performance budgets (startup < 150 ms, idle < 100 MB, …) → `project.performance-baselines.md` /
  `BENCHMARKS.md`. The invariant is *every subsystem carries a reproducible benchmark*, not
  the number.
- "No integrated terminal in the first release" → scope / `KNOWN_LIMITATIONS.md`.
- "DX and performance improve together" → the product thesis in `project.architecture.md`, not a
  falsifiable record.
- Workspace label content, user-controlled order, source-order outlines → feature records in
  the `workspace` / `syntax` module contracts, written when those modules are built.

---

## 3. Module and file architecture

Module-based, one self-contained folder per domain (the blackline `modules/` model, e.g.
`project_contact/` with `project_contact.<role>.ts`), fused with the brief's namespace-class
layout and PascalCase class files.

### File naming

- **Single-class file → `PascalCase.ts`** matching its namespace: `Buffer.ts` exports
  `class $Buffer` + `export namespace Buffer { $Class; Class; Model; Instance }`.
- **Role-collection file → `<module>.<role>.ts`** for functions/config/registrations that
  are not one class: `keybindings.defaults.ts`, `git.parsers.ts`, `editor.commands.ts`,
  `commands.defaults.ts`, `theme.palettes.ts`, `theme.icons.ts`.
- **No HTTP-era roles.** This is a TUI, not an API — there are no `.controllers.ts`,
  `.routes.ts`, or HTTP `.service.ts` files. The entry points are commands and input
  handlers. Role suffixes in use: `.commands`, `.defaults`, `.parsers`, `.sources`,
  `.palettes`, `.icons`, and `.renderable` (a custom OpenTUI renderable that is not a domain
  class, e.g. `EditorRenderable.ts` stays PascalCase; collection-style renderables use the
  suffix).
- **Colocated contracts/docs** → `<module>.invariants.md`, `<module>.lattice.md`,
  `<module>.design.md` (design/lattice only where they carry real content).
- **Tests** → `__tests__/<name>.test.ts` inside the module.
- **Invariant annotations** in code point back to the contract:
  `// invariant: <exact record name> (modules/<module>/<module>.invariants.md)`.

### Module map (each a folder under `src/modules/`, each with a colocated contract)

| module | primary files | kind |
| --- | --- | --- |
| `app` | `App.ts`, `Bootstrap.ts`, `Lifecycle.ts` | reactive + boot |
| `kernel` | `Kernel.ts`, `Plugin.ts`, `ExtensionPoints.ts`, `ContributionRegistry.ts` | boot/composition |
| `system` | `Files.ts`, `Paths.ts`, `Processes.ts`, `Environment.ts`, `Clock.ts`, `Ids.ts`, `Watchers.ts`, `Logging.ts` | static capabilities |
| `storage` | `PieceTable.ts`, `LineIndex.ts`, `UndoStore.ts`, `RingBuffer.ts`, `PackedSpans.ts`, `ScreenBuffer.ts` | plain classes |
| `workspace` | `Workspace.ts`, `WorkspaceManager.ts`, `WorkspaceTabs.ts`, `WorkspaceSnapshot.ts`, `Project.ts`, `Worktree.ts`, `ProjectFiles.ts`, `FileEntry.ts`, `FileTree.ts` | reactive |
| `editor` | `Editor.ts`, `Buffer.ts`, `Cursor.ts`, `Selection.ts`, `Viewport.ts`, `MovementController.ts`, `NavigationHistory.ts`, `Search.ts`, `EditorRenderable.ts` | reactive + renderable |
| `syntax` | `SyntaxModel.ts`, `TreeSitterParser.ts`, `HighlightStore.ts`, `SymbolOutline.ts`, `SymbolStore.ts`, `SymbolView.ts`, `LanguageRegistry.ts` | plain + reactive |
| `lsp` | `LanguageClient.ts`, `LanguageProvider.ts`, `LspProcess.ts`, `LspTransport.ts`, `JsonRpc.ts`, `TypeScriptProvider.ts` | plain resources + reactive |
| `diagnostics` | `DiagnosticStore.ts`, `DiagnosticView.ts`, `diagnostics.sources.ts` | plain + reactive |
| `git` | `GitRepository.ts`, `GitStatus.ts`, `GitHistory.ts`, `GitWatcher.ts`, `GitCommands.ts`, `git.parsers.ts` | reactive + static |
| `diff` | `DiffEngine.ts`, `DiffModel.ts`, `DiffView.ts`, `DiffRenderable.ts` | plain + reactive + renderable |
| `markdown` | `MarkdownDocument.ts`, `MarkdownParser.ts`, `MarkdownPreview.ts`, `MarkdownRenderable.ts` | plain + reactive |
| `commands` | `Command.ts`, `CommandRegistry.ts`, `CommandPalette.ts`, `commands.defaults.ts` | reactive + config |
| `keybindings` | `Keybinding.ts`, `KeybindingRegistry.ts`, `KeyboardInput.ts`, `keybindings.defaults.ts` | reactive + config |
| `ui` | `RootView.ts`, `Sidebar.ts`, `FilesView.ts`, `GitView.ts`, `StatusBar.ts`, `Tabs.ts`, `Overlay.ts` | reactive + renderable |
| `theme` | `Theme.ts`, `ThemeRegistry.ts`, `TerminalCapabilities.ts`, `theme.palettes.ts`, `theme.icons.ts` | reactive + static capability |

`src/main.ts` is the entry point; the kernel boot phase composes modules and seals before
`App` is constructed.

### Theming (icons + palettes)

The `theme` module owns appearance as swappable data, governed by *Appearance is data with a
capability fallback*:

- **File-type icons** — the file explorer (`ui/FilesView.ts`) renders a per-file glyph from
  `theme.icons.ts`, keyed by extension/filename (ts, js, json, md, lock, git, image, folder
  open/closed, …). `TerminalCapabilities.ts` detects glyph support; the ladder is
  nerd-font glyph → unicode symbol → ascii marker, so the tree stays legible everywhere.
- **Color palettes** — `theme.palettes.ts` ships a small set of curated palettes (a default
  dark and light at minimum) as semantic tokens (background, foreground, accent, added,
  modified, deleted, selection, syntax roles, diagnostic severities). Colors resolve through
  truecolor → 256 → 16 down-quantization so a palette degrades gracefully.
- **Selection & extension** — the active theme (palette + icon set) is a reactive selection
  in `Theme.ts`; `ThemeRegistry.ts` holds registered themes. Themes and icon sets are
  contribution-plugin extension points (the brief already lists themes and file decorators as
  contributions). Syntax highlighting, git decorations, diagnostics, and the gutter all pull
  their colors from the active theme rather than hard-coding.

Theme is consumed by `ui`, `editor`, `syntax`, and `diagnostics`; it is built in M2 (so the
file browser and highlighting land themed) and extended by the demonstration plugin in M7.

---

## 4. Milestones (each gates on the invariant loop)

Each milestone: bootstrap the listed module contracts (provisional) → build → invariant-review
→ verify via tests + tmux harness → promote → benchmark → commit. A milestone is done only
when it works, has tests, disposes resources, has a recorded benchmark, its largest waste is
removed, and its architecture reads cleanly.

- **M0 — Setup & foundations.** Install Bun + toolchain; `bun init`; pin versions; read the
  ivue guide + examples (record conclusions in `project.architecture.md`/`project.decisions.md`); write
  `project.invariants.md` + `project.lattice.md`; scaffold the module tree; stand up the
  tmux harness skeleton and the benchmark runner. Contracts: project-level.
- **M1 — Boot & Frame.** `app`, `kernel`, `system`. OpenTUI root renderer, clean start/stop,
  two-pane layout, status bar, command + keybinding registries, kernel boot phase,
  event-driven render (no idle loop). Verifies: starts, resizes, restores terminal, no idle
  render.
- **M2 — Multi-workspace + file browser + read-only editor.** `workspace`, `storage`,
  `editor` (viewport/flyweight), `syntax` (highlight), `theme`. Project/worktree tabs,
  per-workspace state restoration, file tree **with file-type icons**, flyweight viewport,
  Tree-sitter highlighting, line numbers, **themed color palettes** with the truecolor→256→16
  and glyph→unicode→ascii fallback ladders. Verifies: workspace isolation, only-visible-lines
  render, no per-line reactive models, highlight updates while typing, icons + palette degrade
  correctly on a 16-color / no-nerd-font terminal.
- **M3 — Editing.** `editor` (buffer/cursor/selection/undo/movement), `storage` (piece
  table/undo), `system` (Clipboard). Insert/delete/save, dirty state, undo/redo, accelerated
  arrows, mouse cursor, file search, command palette. **Text selection** (anchor on Cursor;
  shift+arrow extend; mouse drag; selection-aware insert/delete = replace-selection) and
  **copy / cut / paste** via a `Clipboard` system capability (wl-copy/xclip/pbcopy with an
  OSC 52 fallback), both built on the settled coordinate model so spans and clipboard text
  respect grapheme boundaries. A real caret renders at the cursor column (not just a gutter
  marker). Verifies: non-modal editing, predictable acceleration, responsive under repeat,
  selection + copy/cut/paste round-trip, caret at correct display column across
  Unicode/wide/tab.
- **M4 — Git + diff.** `git`, `diff`. Branch, staged/unstaged/untracked, stage/unstage, async
  debounced refresh, branch history, commit detail. **Selecting a changed file splits into a
  side-by-side diff: read-only previous version on the left, the live editable buffer with
  diff decorations on the right, recomputing as you type.** Verifies: external edits appear,
  refresh never freezes, branch always visible, the right diff pane edits and saves like a
  normal buffer, the diff never goes stale against the edited text, the old-version pane
  disposes on close.
- **M5 — TypeScript LSP + diagnostics.** `lsp`, `diagnostics`. Lazy start, diagnostics,
  definition jump, Cmd+click, navigation back, references if practical; revision-stamped,
  stale-safe, disposable. **TS errors render as inline squiggles/underlines with a
  capability fallback (undercurl → underline → gutter marker), and the full error message is
  reachable on demand — a floating detail overlay anchored to the range, triggered by the
  cursor resting on it or `diagnostic.show`, with mouse-hover as enhancement only where
  OpenTUI reports pointer-move — plus the optional inline message and the Problems list.**
  Verifies: works without LSP, survives LSP crash, shuts down on disposal, error detail is
  reachable by keyboard alone (no dependence on hover).
- **M6 — Markdown preview.** `markdown`. Split layout, live refresh, dispose leaves no active
  effect. Verifies: open/close cleanly, no leaked effect, editing stays responsive.
- **M7 — Plugin demonstration.** `kernel` (composition), `commands`, `keybindings`. Class-graph
  kernel, contribution registry, one kernel plugin + one contribution plugin, deterministic
  order. Verifies: plugin changes behavior without core edits; disabling restores defaults.

---

## 5. Verification — layered, adversarial, and gated

Verification is a primary deliverable, not a phase. Its job is to make "done" a fact backed
by evidence rather than a judgment I make about my own work. Three properties hold throughout:
**layered** (each bug class is caught by a lens aimed at it, so a miss in one layer is caught
by another), **adversarial** (verifiers try to break, not confirm — the author never certifies
their own work at the gate), and **empirical** (the real app is driven and observed; nothing is
"verified" by reading it).

### 5.1 The completion gate — what makes "done" binary

I may not declare any milestone or the project complete on my own assessment. Done is a set of
checkable artifacts, all of which must be green:

1. **Traceability matrix** (`project.verification-results.md`) — every requirement in the brief maps to:
   implementation location · verification procedure · expected · actual · evidence artifact ·
   pass/fail · follow-up. **Any unmapped or red row means not done.** A requirement with no
   verification procedure is itself a red row.
2. **Invariant checker green** — `check_invariants.mjs --all --refs` exits 0; every
   `established` record has a Verification that runs green; no orphan annotations.
3. **Resource-lifecycle audit green** (`RESOURCE_LIFECYCLE_AUDIT.md`) — repeated create/dispose
   cycles show stabilized memory and zero orphan subprocess/watcher/fd/effect/timer.
4. **Benchmarks recorded** — every module has a reproducible benchmark with a baseline; no
   unexplained regression.
5. **Independent subagent panel** (5.4) finds no unresolved critical/high issue.
6. **Completeness critic** (5.5) finds nothing new for two consecutive sweeps.

Until all six are green the honest status is "not done," and that status is reported as such.

### 5.2 The verification layers (each catches a different bug class)

Orthogonal by design — they are aimed at different failure modes, not stacked for redundancy:

| layer | lens | bug class it catches |
| --- | --- | --- |
| **L1 Static** | typecheck + lint + format | type errors, dead code, obvious smells |
| **L2 Unit** | pure logic in isolation | piece-table/line-index/cursor/arrow-accel/git-parse/JSON-RPC/coordinate-encoding algorithm bugs, flyweight eviction |
| **L3 Integration** | cross-module flows | seam/wiring bugs: open→edit→save, git refresh after edit, stage/unstage, definition jump, markdown split, plugin composition |
| **L4 Invariant** | `/invariants` on the diff, `--depth adversarial` at gates | architectural drift, contract violations, `stressed`/`refines` cases; downgrades independently re-derived |
| **L5 Real-terminal harness** | tmux driving the actual TUI | rendering, input, layout, focus, scroll, terminal-restore bugs invisible to L1–L3 |
| **L6 Resource lifecycle** | create/dispose cycles + process/fd inspection | leaks, undisposed effects/watchers/subprocesses, orphan LSP — the class unit tests structurally cannot see |
| **L7 Performance** | benchmark before/after | perf regressions, hidden O(n) on hot paths, retained-memory growth |
| **L8 Adversarial scenarios** | the failure matrix, run against the live app | edge/failure bugs: external delete/modify (clean & dirty), git failure, detached HEAD, no commits, huge repo/file, binary, unusual Unicode, LSP absent/crash, parser failure, resize mid-edit, key-repeat storms, watcher storms, plugin-init failure, malformed settings, conflicting keybindings |
| **L9 Security/robustness** | input & subprocess boundaries | path traversal in file ops, argument injection into git/LSP subprocesses, unbounded input, crash-to-broken-terminal |

Every L5/L8 failure follows the **autonomous repair loop**: capture pane + input + logs +
process state → localize (model/input/layout/render/timing) → patch the smallest responsible
unit → rerun the *exact* interaction → diff before/after → add the scenario permanently to the
regression suite. A bug is not fixed until its scenario is a standing test.

**tmux harness discipline (learned from `blackline-app/.claude/skills/agent-tmux`).** Driving a
TUI through tmux is fragile in four ways — send races, startup dialogs, "is the frame done?"
busy-detection, and bounded reads — so the harness never hand-rolls `sleep`-then-`send-keys`:

- **State verdicts come from artifacts, not from scraping the pane.** The editor exposes a
  deterministic **observability side channel** (a status artifact / debug channel reporting
  active workspace, buffer revision, dirty state, diagnostics count, live subprocess PIDs,
  lifecycle tier). The harness asserts model/process/git state from that + `git` + process
  snapshots; **pane capture is reserved for genuinely visual assertions** (layout, tab
  hierarchy, squiggles, theme). This side channel is stood up in M1 as part of the harness
  skeleton so every later milestone asserts against it.
- **Wait for a settled-frame signal before capturing** (a render-quiescence marker on the side
  channel), never a fixed delay — otherwise a half-rendered frame is captured.
- A small `scripts/tui-harness.sh` encapsulates ready-detection, settle-detection, and bounded
  capture once, so individual tests never re-hand-roll the fragile recipe.

### 5.3 Cadence — when each layer runs

- **Per change:** L1, the affected L2/L3, and L4 on the diff.
- **Per milestone (gate):** all of L1–L8 for the milestone's surface, L4 at `--depth
  adversarial`, benchmarks recorded, lifecycle cycles run, matrix rows for that milestone
  turned green with evidence. A milestone is complete only when it works, has tests, disposes
  cleanly, has a recorded benchmark, its largest waste is removed, and it reads cleanly.
- **End of build (M7 → gauntlet):** five whole-repo refinement passes (architecture & ivue
  compliance · correctness & failure modes · performance & scalability · UX & discoverability ·
  independent adversarial), then the subagent panel below.

### 5.4 End-of-build independent subagent cross-check

The final sign-off does not come from me. It comes from a panel of independent subagents,
because the author of a bug is the worst reviewer of it. Protocol:

- **Diverse orthogonal lenses**, one subagent each: architecture/ivue-compliance ·
  correctness/failure-modes · performance/scalability · UX/discoverability ·
  resource-lifecycle/leak · security/robustness · one pure adversarial reviewer told to
  assume the other six missed something. Where possible these run as **independent
  cross-model reviewers** (claude, and codex once its `agent-tmux` markers are verified)
  driven via `blackline-app/.claude/skills/agent-tmux` (`agent-tmux.sh launch/send-wait`),
  for genuine cross-model independence rather than one model reviewing itself. Their verdicts
  also come from artifacts (each reviewer's `STATUS` + `git`), not pane scraping.
- **Independence enforced:** each is given the same package (brief · repo · test results ·
  benchmarks · known limitations), asked *neutral, non-leading* questions, and told to **find
  what is broken, not confirm what works.** Each produces its findings **before** seeing any
  other's — spawned in parallel, blind to each other.
- **Findings are themselves verified:** each reported issue is adversarially reproduced against
  the live app before it is accepted (kill plausible-but-wrong findings), then fixed via the
  repair loop, then regression-tested.
- **Cross-compare** the independent reports for agreements, contradictions, missing coverage,
  and false assumptions. Resolve every critical/high; document any deferred medium explicitly.
  "Looks good" from a reviewer is not evidence — a reproduced green scenario is.

### 5.5 Loop-until-dry and no silent caps

- A **completeness critic** sweeps for what is missing — a requirement not traced, a claim
  unverified, a module without a benchmark, a disposal path untested, an adversarial scenario
  not run. Its findings become the next round of work. The build is not done until it finds
  nothing new for two consecutive sweeps.
- **No silent truncation:** wherever verification is bounded (a scenario skipped, a benchmark
  not run on a platform, a sampled rather than exhaustive check), it is logged in
  `project.verification-results.md` — an unstated cap reads as "covered" when it was not.

### 5.6 Artifacts

Under `artifacts/{terminal-captures,screenshots,recordings,benchmark-results,process-snapshots}/`,
referenced by the matrix rows they prove. Normalize unstable values (timestamps, PIDs, temp
paths, usernames) before visual-regression comparison; compare semantic screen regions rather
than byte-identical ANSI.

---

## 6. Documents maintained

Contracts: `project.invariants.md`, `project.lattice.md`, per-module `*.invariants.md`
(+ `*.lattice.md` where composition is real). Build docs (per the brief): `project.architecture.md`,
`project.decisions.md`, `BENCHMARKS.md`, `KNOWN_LIMITATIONS.md`, `TODO.md`, `VERIFICATION_PLAN.md`,
`project.verification-results.md`, `project.performance-baselines.md`, `RESOURCE_LIFECYCLE_AUDIT.md`,
`ARCHITECTURE_COMPLIANCE.md`, `UX_REVIEW.md`, and `project.delegation-log.md` (the ledger of work
delegated to subagents/codex — tally and per-agent build share reported at each check-in,
sub-par agents deprecated). `project.architecture.md`/`project.decisions.md` link the ivue guide/example pages
that informed each choice.

---

## 7. Toolchain & environment

- **Runtime:** Bun (primary). **Not yet installed — the one hard prerequisite before M0/M1.**
- **Verified installable:** `@opentui/core@0.4.5`, `ivue@2.0.0` (local source at `../ivue`),
  `web-tree-sitter@0.26.11` / `tree-sitter@0.25.0`, `@vtsls/language-server@0.3.0`,
  `typescript-language-server@5.3.0`.
- **Harness:** tmux 3.4 present. `asciinema`/`agg` absent → text capture for most assertions;
  visual screens captured via raw-ANSI rendering rather than a recorder.
- **ivue reading (mandated before architecting):** `../ivue/docs_v2/guide/*` +
  `../ivue/docs_v2/examples/*`, cross-checked against ivue.dev and the published package.
- **Repo:** `../tui-editor` is greenfield and not yet a git repository.

---

## 8. Definition of done

The brief's Definition of Done (a user can run, navigate workspaces/tabs, browse/open/edit/save,
move with accelerated arrows, stage/inspect git, highlight + outline TypeScript, jump to
definitions and back, preview Markdown, use the palette, exit cleanly) **plus** the completion
gate of §5.1, all six green: traceability matrix fully mapped and passing with evidence;
`check_invariants.mjs --all --refs` clean with every established record's Verification green;
resource-lifecycle audit stable; benchmarks recorded per module; the independent subagent panel
carrying no unresolved critical/high finding; and the completeness critic dry for two
consecutive sweeps. Per *Completion is proven, not declared*, none of this is satisfied by my
own assessment — each is a checkable artifact.
