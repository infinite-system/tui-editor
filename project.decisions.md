# Decisions

Architecture decisions, grounded in the ivue documentation study (delegated, reviewed against
`../ivue` source + a headless smoke test — see `project.delegation-log.md` #1). The brief mandates
documenting these; each cites the ivue page that informed it. ivue docs live at
`../ivue/docs_v2/{guide,examples}/`.

## Runtime & setup corrections (caught in the study)

- **D0.1 — Install `vue`, not just `@vue/reactivity`.** ivue's public API is one function,
  `Reactive()`, and it imports `watch`/`watchEffect`/`effectScope` from `vue` at runtime
  (peerDep `vue ^3.2.0`). The reactivity core is DOM-free and runs headless under Bun — proven
  by `scripts/ivue-smoke.ts` (`{count:2,double:4,observed:4,ok:true}`). Source: `lib/Reactive.ts`,
  `guide/getting-started.md#install`.
- **D0.2 — Vendor `Static()` and the kernel.** Neither ships in the `ivue` package. `Static()`
  is `experiments/node-namespace/Static.ts`; the extensible kernel is example code
  (`examples/playground/src/examples/extensible-kernel/kernel.ts`). We copy both into the app
  (`system`/`kernel` modules) rather than import from `ivue`. Source: `guide/node-static-runtime.md`.
- **D0.3 — `createX()` is our convention, not an ivue feature.** ivue's real construction seam
  is the mutable `namespace.Class` slot + owner-constructs-child; the brief's `createX()` factory
  idiom is an app convention (an overridable method), documented as such in
  *Construction goes through overridable seams*.

## The ten mandated architecture decisions

1. **Durable state uses ivue Reactive domain classes.** Observable, identity-bearing, disposable
   models (`App`, `Workspace`, `Buffer`, `Editor`, `GitRepository`, …) are `class $X {}` +
   `namespace X { const $Class; let Class = Reactive($Class) }`. `Reactive()` transforms in place
   and rewrites getters to lazy cells. Source: `guide/getting-started.md`, `guide/modules.md`.
2. **High-cardinality data uses compact storage + flyweight views.** Columnar typed arrays / plain
   Maps hold ground truth; disposable per-render facades (three fields: owner+row+col) expose it;
   a two-tier sparse revision overlay (fine per-item + coarse per-block refs) drives reactivity;
   explicit eviction releases cold overlays. Measured 4.7 bytes/cell at 20M cells. Source:
   `guide/flyweight.md`, `examples/flyweight-grid/model/`.
3. **Cheap derived values are plain getters, not `computed()`.** A plain getter lives once on the
   prototype (0 bytes/instance) and is reactive via leaf-ref subscription at any depth; `computed()`
   (~300 bytes/instance observed) is a surgical opt-in for expensive recompute, render-suppression,
   or stable ref identity. Aim nearly-computed-free. Source: `guide/state.md`, `guide/computed-watch.md`.
4. **Effects are owned and disposed explicitly for outliving instances.** `Reactive()` injects
   `$watch`/`$watchEffect`/`$stopEffects`; the effect scope is a lazily-allocated detached
   `effectScope`. Component-lifetime instances use plain `watch`/`onUnmounted`; app-root/store
   instances use `this.$watch` and an owner calls `$stopEffects()`. ivue calls no user hooks ever.
   Source: `guide/lifecycle-teardown.md`, `lib/Reactive.ts`.
5. **Namespace `Class` bindings are the replaceable extension seam.** `const $Class` is the raw
   `extends` root; `let Class` is the mutable selection slot every consumer reads (`new X.Class()`).
   A plugin/kernel swaps the slot at boot. Never snapshot it (`const C = X.Class` loses later
   selection). Source: `guide/namespace-pattern.md`, `guide/modules.md`.
6. **The extensible kernel composes the class graph before construction.** `defineClass` captures
   inheritance; `registerClass` queues `(Base)=>class extends Base{}` factories; `sealClassGraph`
   topologically composes, reparents descendants onto composed parents, applies `Reactive()`/`Static()`,
   replaces `Class` bindings, and seals. Post-seal construction is native `new`. Source:
   `examples/extensible-kernel.md`, `examples/.../extensible-kernel/kernel.ts`.
7. **Plain classes and static capabilities stay distinct from reactive models.** Plain stateful
   classes (`PieceTable`, `LineIndex`, `LspTransport`, `TreeSitterParser`) own algorithms/resources
   with no reactivity; `Static()` capability classes (`Files`, `GitCommands`, `Paths`) are
   allocation-free function bags with `super` + replaceable slot. Reactive models bridge engines via
   small revision refs. Source: `guide/node-static-runtime.md`, `guide/namespace-pattern.md`.
8. **Late dependency reads avoid circular-init failure.** Every cross-module reference sits in a
   getter/method body (`static get Dep() { return Dep.Class }`); the namespace compiles to a hoisted
   `var`, safe to hold from module-eval. No top-level `new`, no snapshot, no `export default X.Class`.
   Source: `guide/modules.md#circular-references-resolve-by-construction`.
9. **Inactive workspaces/panes/buffers/parsers/LSP are cooled or disposed, not hidden.** The
   `$stopEffects()` deactivate/reactivate cycle windows reactivity over a retained model; durable
   truth lives outside the overlay; re-arm watchers in an `activate()` method (not the constructor).
   Keyed overlays never self-GC → explicit eviction (`evictOutsideRows`-style). Source:
   `guide/lifecycle-teardown.md`, `guide/flyweight.md`.
10. **ivue patterns used directly vs adapted for OpenTUI/Bun.** Used directly: Reactive models,
    plain getters, the namespace pattern, `$watch`/`$stopEffects`, flyweight + eviction, late reads.
    Adapted: `Static()` + kernel are vendored (not packaged); HMR is dev-by-restart (no hot runtime
    for a Bun process); the single "render effect" is the OpenTUI frame effect calling
    `requestRender()`, pulling the visible window. Source: `guide/node-static-runtime.md`,
    `guide/node-class-hmr.md`, `guide/hmr.md`.

## Correction noted for contracts

`guide/principles.md` still references an "optional `stopEffects()` hook" — that hook was removed;
`lib/Reactive.ts` (no hooks at all) is authoritative. `LESSONS.md` confirms "ivue auto-calls NOTHING."

## Pending simplifications (post-gate — do NOT act until the §5.1 gate is green)

### D-S1 — Drop the redundant `Class` suffix from member NAMES (keep `.Class` in bodies)

**Correction (2026-07-21):** an earlier framing (collapse the namespace triad / drop `.Class` from
call sites) was a MISREAD and is withdrawn. **`.Class` stays everywhere** — it is the mutable
composition seam the kernel composes and tests swap (load-bearing for *Construction goes through
overridable seams* and *The app is built only after the kernel is sealed*, and the M7 plugin demo);
`new Namespace()` can't work and ESM forbids reassigning a bare export, so the impl must live on
`.Class`. Dropping it is off the table.

**The actual, purely-cosmetic change:** rename getter/factory MEMBER names that carry a redundant
`Class` suffix, keeping the `.Class` in the body:
`get GitCommandsClass() { return GitCommands.Class; }` → `get gitCommands() { return GitCommands.Class; }`.
No `.Class` reference removed, no seam change, no call-site removal, no invariant impact — a rename
of local member names only. Update the members' callers.

**Watch for name collisions:** renaming a member to exactly its imported namespace name
(`get GitCommands() { return GitCommands.Class }`) shadows the import and reads ambiguously — in
those cases keep a distinct, clear name (lowercase `gitCommands`, or a role name), don't collide.

**Scope:** the `<Thing>Class` late-dependency getters (e.g. GitRepository's `GitCommandsClass` /
`ClockClass` / `StatusChannelClass`). The `createX()` seam methods already carry no `Class` suffix —
untouched.

**Timing / method:** a discrete rename pass AFTER the gate (or trivially inline where small +
local), re-running `bunx tsc --noEmit` + full `bun test` + the checker (`--all --refs`) so no caller
breaks. Do not act mid-build.

**Status:** pending · **Logged:** 2026-07-21 (rescoped 2026-07-21)

---

## D — Delegation standard: full-parity context, task-scoped, boss-identity stripped

**Decision:** Every delegation (codex worker OR review subagent) is briefed as onboarding a resumed
self, not a fresh underling. The prompt =
**(shared cold-start orientation) + (only the contracts the task touches) + (role-framed task) −
(conductor identity).**

- **Shared orientation (fixed, reusable — the `project.handoff.md` MUST-RE-READ foundation):** the ivue reference
  + namespace pattern (`class $X` + `namespace X { const $Class; let Class = Reactive($X)/Static($X);
  type Instance }`, plain getters not `computed()`, late dependency reads, `createX()` seams, the
  `$stopEffects` footgun, `Static()` for stateless capabilities); the naming/module conventions; the
  verify discipline (drive real TUI under tmux, assert STATE from `artifacts/status.json`, NEVER
  pane-scrape; `bunx tsc --noEmit; echo TSC=$?` — never piped through tail/tee); the
  coordinate/frame-effect facts; and the codex-integration protocol (files land UNTRACKED in the
  worktree, the coordinator reviews + commits, codex often skips tests + the contract so demand
  them). Point the delegate at `project.handoff.md` + `project.ivue-reference.md` + the OpenTUI/coordinate
  facts rather than re-inlining — start it where the coordinator stands.
- **Scope contracts only (tiered):** include the target module's `*.invariants.md` + the specific
  `project.invariants.md` records the task touches — NOT all contracts. Cloning everything multiplies
  a large context per agent and defeats the point of delegating (keeping the main loop lean).
- **Role-framed, conductor identity STRIPPED:** clone the understanding, not the role. The delegate
  must NOT receive the coordination context / re-wake loop / "spawn your own agents and re-plan"
  framing, or it will spin up its own sub-agents and re-litigate the plan. Frame it as: "you are a
  scoped worker — read these docs, do exactly this one thing, return it for review."

Applies to BUILDING delegates AND independent adversarial reviewers (a reviewer gets the same
orientation + the contract + the code + a "try to REFUTE this against its contract via IBR /
invariants" framing — cross-model independence, since the author is the worst reviewer of their own
work). Spin up codex worktrees freely for both, worktree-per-writer isolated; parallelize genuinely
independent work.

**Why:** under-briefing is why delegated workers drift, skip tests, or violate the pattern — it
wastes more time than doing it yourself. Full-parity context scoped to the task, minus the
boss-identity, is what stops drift.

**Status:** adopted · **Logged:** 2026-07-21

**Hardening (2026-07-21) — embed the method, gate on compliance:** codex cannot invoke Claude
slash-commands and skips path-pointers, so the shared-orientation packet must INLINE the method, not
just link it: (a) the IBR reduction discipline (reduce to load-bearing generators; if-then form;
sort reality-based vs chosen; predict impossibilities; provisional-until-verified-by-execution), and
(b) the /invariants contract essentials (both required headings verbatim, the record schema with
Evidence + Impossible-if-true required, unnumbered declarative record names, the annotation format
`// invariant: <exact record name> (<path>)`, the name charset = letters/digits/spaces/hyphens only —
no commas). The absolute-path pointers stay, but the inline copy is the guarantee. This is embedded
in `scripts/codex/_preamble.txt` (the "METHOD — IBR + /invariants (EMBEDDED)" section). **Hard review
gate:** reject any delegate output whose `<module>.invariants.md` is not a proper IBR reduction
(vacuous/bare records, missing impossibilities, wrong schema, no Evidence) — send it back or redo it;
run the checker (`--all --refs`) on every delegated module before merge; non-conforming contracts
never merge. Adversarial-review delegates apply the IBR breaking discipline + impossibility test
against the module's contract. Every agent in this build — coordinator, codex, subagents — governs by
IBR + /invariants.

---

## D — Vendor the IBR skills into the project (self-contained, worktree-portable)

**Decision:** Install the `/ibr` + `/invariants` skills into `tui-editor/.claude/skills` via the
published package — `npx @invariantai/ibr install` (validated end-to-end; also `npx @invariantai/ibr
check --all` runs the bundled checker). The project is now self-contained: the slash-commands work
in-project, the checker runs from a project-local path
(`node .claude/skills/invariants/scripts/check_invariants.mjs --all --refs`), and codex git-worktrees
inherit the skills (they were referenced by machine-absolute `/home/parallels/dev/ibr/...` paths that
don't exist in a worktree on another machine — now `.claude/skills/...`, portable).

**Supersedes** the earlier "never copy the checker into the target repo" note: that guarded against
ad-hoc drift between the canonical skill and stray copies. This is different — a PINNED published
version (`@invariantai/ibr` 0.1.0), intentionally vendored, byte-identical to canonical (verified via
`diff`), refreshed by re-running the installer. Version pinning + the release-sync workflow manage
drift. The canonical source remains the npm package.

**Applied:** codex preamble + `project.handoff.md` + `project.progress.md` now point at the project-local checker/skill paths.

**Status:** adopted · **Logged:** 2026-07-21

---

## D — The verification invariant (the "how do we test" formula)

**tmux is NOT the testing invariant — it is only the DRIVER.** The reduced formula:

> A test is only as true as the channel it reads is authoritative for the property under test.
> Drive through the real input path; assert at the layer where the property is authoritative;
> never reconstruct a property from a channel downstream of where it is defined.

This forces a per-property choice of oracle. For this TUI there are exactly three properties, each
with ONE authoritative channel:

1. **Pure logic** (coordinate math, grapheme span-splitting, parsers, `selectionRange()`, porcelain
   parsing) → **unit tests on pure functions**; oracle = the return value. Deterministic, no tmux.
   This is where correctness should live whenever logic can be extracted from I/O.
2. **Semantic state** (what the app BELIEVES: cursor, selection, buffer revision, dirty, focus, tree,
   git status) → the **`status.json` side-channel** the app itself writes (`StatusChannel`); oracle =
   the app's own state export. tmux sends real keys (the honest input path); assertions read
   status.json — NEVER pane-scrape. Settle on the frame counter, never a fixed sleep.
3. **Visual output** (what is actually DRAWN per cell: char/fg/bg/attrs) → the **`FrameProbe`**
   framebuffer dump (`TUI_FRAME_DUMP=1` → `artifacts/frame.json`); oracle = OpenTUI's render buffer,
   read BEFORE the pty. NOT `tmux capture-pane -e` (lossy for truecolor bg — proven). The
   gold-standard visual assertion is a **frame-diff**: snapshot before/after an action; the changed
   cells ARE the effect (no offset or color-decode math). This is what caught the selection
   mis-position bug.

**Role of tmux:** the driver only — a real pty + real keystrokes + process lifecycle + resize. It is
the input path, not the oracle. Reaching for a "Playwright for terminal" (headless xterm) only makes
sense to verify the SGR *encoder* end-to-end; for asserting our app's behavior the framebuffer is
strictly better (source of truth, no round-trip loss).

**Impossible if the formula holds:** a green test that asserts a color by grepping pane escapes; a
state assertion that pane-scrapes rendered text instead of reading status.json; a "settled" wait
that's a fixed sleep rather than a frame-count signal; correctness that lives only in an integration
test when it could be a pure unit test.

**Status:** adopted · **Logged:** 2026-07-21

## D — agent-tmux is the codex/subagent driver; humans attach with `tmux attach -t at_<name>`

**Decision:** delegated interactive agents (codex, claude workers) run under `scripts/agent-tmux.sh`
(brought into tui-editor from the maintained blackline copy). Sessions are namespaced `at_<name>`;
a human watches/steers any worker live with `tmux attach -t at_<name>` (detach `Ctrl-b d`), or
non-intrusively with `scripts/agent-tmux.sh peek <name> [lines]`. Launch:
`scripts/agent-tmux.sh launch <name> --cwd <worktree> --profile codex -- codex --yolo`. A live tmux
session is SINGLE-OWNER — attach to watch freely, but don't drive it from two places at once.
**Caveat:** the `codex` profile's ready/busy regexes are still `[UNVERIFIED]` placeholders — codex's
interactive UI renders fine under tmux (confirmed: YOLO banner + `›` prompt + `model · dir` footer),
but `launch`/`wait` marker detection needs a live tuning pass against codex's real idle/busy footer
before agent-tmux can reliably auto-drive codex (until then, drive codex directly or tune the markers).

**Status:** adopted (markers pending verification) · **Logged:** 2026-07-21

---

## D — Full descriptive names, no abbreviations (global code convention)

**Rule (ALL code, always):** every identifier — variables, parameters, loop counters, locals,
fields — is a full spelled-out descriptive name. **No abbreviations, ever.** `increment` not `inc`,
`index` not `i`, `whiteCenter` not `wc`, `editor` not `ed`, `gitPanel` not `gp`, `commitLog` not
`cl`, `palette` not `pal`, `selection` not `sel`, `current` not `cur`, `options` not `opts`,
`direction` not `dir`, `workspace` not `ws`. Nested loops use distinct real names
(`rowIndex`/`columnIndex`), never `i`/`j`. This is about NAMING (not destructuring).

**Related (same spirit — explicitness):** don't create a local that is merely a short alias of a
property path; reference the full path (`workspace.editor`, not `const editor = workspace.editor`
used once). A reused COMPUTED result (method/function call) may be stored, named for what it is.

**Do NOT rename:** external/library API names, or the ivue namespace tokens (`Class`, `$Class`,
`Model`, `Instance`). A rename must be behavior-preserving — keep tsc + all tests green.

**Enforcement:** de-abbreviate before every commit; hard gate on delegated (codex/subagent) output.
Embedded in `scripts/codex/_preamble.txt`. IBR *explicitness over abstraction* applied to naming.
User directive: "code is getting sloppy… use full names… a global understanding for ALL code always."

**Status:** adopted · **Logged:** 2026-07-21
