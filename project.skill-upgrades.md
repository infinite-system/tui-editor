# Skill Upgrades — proving-ground log

This build is where the **ivue**, **ibr**, and **invariants** skills get proven on a full,
complex app. Every bump — a naming trap, a missing mode, guidance that assumes existing code,
an upstream doc bug — is logged here as it is hit, with a proposed upgrade and a severity.
These feed back into the skills (in the `ibr` repo) after the run.

Severity: **minor** (nice-to-have) · **moderate** (real gap, work around for now) ·
**blocking** (stops the loop).

## invariants skill

- **Greenfield / contracts-first mode is under-documented.** *(moderate, 2026-07-21)* The skill
  is written for *enforcing* contracts over existing code (Evidence = `file:line`, Verification =
  a runnable command). A greenfield build governed contracts-first inverts this: records are
  necessarily `provisional`, Evidence points at grounding sources (docs, a smoke test, the
  brief), and Verification names the test-to-write, promoted to `established` when the milestone
  lands. **Proposed:** document a "contracts-first / promote-on-build" mode and its Evidence /
  Verification / Status conventions for greenfield.
- **`Evidence` required even before code exists.** *(minor, 2026-07-21)* The checker flags empty
  Evidence; greenfield chosen records legitimately have only grounding-source evidence. **Proposed:**
  authoring-guide note on acceptable greenfield Evidence.
- **Name-charset trap is easy to hit.** *(minor)* Hit the comma rule on
  "Terminals report key repeat, not key up". Documented, but the checker could print the
  corrected slug/name inline as a fix suggestion.
- **Recognize the colocated doc family.** *(minor)* The skill knows `<name>.invariants.md`,
  `<name>.lattice.md`, `<name>.design.md`. This build also uses `<module>.decisions.md` and
  `<module>.architecture.md` (+ `project.*` variants), per the repo's `.filetype.md` convention.
  **Proposed:** treat `.decisions.md` / `.architecture.md` as part of the governed doc family.

## ivue skill

- **Verify the installed SKILL.md carries the load-bearing setup facts.** *(to-verify → moderate,
  2026-07-21)* The docs study found three things a builder must know that would cause bugs if
  missed: (a) **`vue` is a required runtime dep**, not just `@vue/reactivity` (needs
  `watch`/`effectScope`); (b) **`Static()` and the extensible kernel are NOT in the package** —
  vendor from `experiments/` and `examples/`; (c) **`createX()` is not an ivue idiom.** If
  `.claude/skills/ivue/SKILL.md` omits these, upgrade it. To check next.
- **Upstream ivue docs bug.** *(minor, upstream — not the skill)* `guide/principles.md` references
  a removed `stopEffects()` hook; `lib/Reactive.ts` is authoritative ("ivue auto-calls NOTHING").
  Fix the doc line.

## ibr skill

- **Reducing a spec's informal invariant list to generators is a reusable pattern.**
  *(enhancement, 2026-07-21)* The brief shipped 37 "architectural invariants"; IBR reduced them
  to ~6 generators, sorted by kind, with targets (perf budgets) and scope boundaries separated
  out as not-invariants. **Proposed:** capture "reduce a given checklist to its generators" as an
  IBR application note.

## Cross-skill

- **The `.filetype.md` doc convention** (`project.invariants.md`, `project.lattice.md`,
  `project.decisions.md`, `project.architecture.md`; `<module>.<role>.md`) emerged during this
  run and should be reflected wherever the skills recommend file names.

## Lessons from the M1–M3 build + audit (2026-07-21)

Captured while governing the fork's autonomous M1–M3 against the contracts. These are the
strongest signals so far; feed back to the skills.

### invariants skill

- **Verdict distinction: upheld-by-outcome vs mechanism-bypassed.** *(moderate)* `Data flows
  one way` is honored in RESULT (render pulls state, never mutates it) but its prescribed
  MECHANISM (reactive invalidation → requestRender) is bypassed — rendering is imperative from
  input handlers, so async producers can't repaint. A review that only checks the outcome
  passes it; only checking the *mechanism* catches the real gap (which blocks M4/M5). **Proposed:**
  the analyze step should test an invariant's Mechanism clause separately from its outcome; add a
  verdict nuance (e.g. `upheld-outcome / mechanism-drift`).
- **Greenfield state: "substrate present, consumer pending."** *(moderate)* `Async results are
  revision-stamped` — the stamping substrate exists (`TextDocument.revision` bumped on every
  mutation) but NOTHING observes it yet ("decorative reactivity"). The provisional/established
  binary doesn't capture "mechanism built, not yet exercised because its consumer lands in a
  later milestone." **Proposed:** a Verification convention / status note for deferred-until-Mx.
- **Verification exit-code masking.** *(minor but bit two reviewers + me)* `bunx tsc --noEmit | tail`
  reports the PIPE's exit (0), masking tsc's real exit (2). Two independent audits split on
  "does it typecheck" because of this. **Proposed:** Verification-field guidance must warn that
  piping through tail/tee masks exit codes — capture the real status (`; echo exit=$?` without a
  pipe on the checked command). Same note belongs in the verify skill.
- **Cross-review earns its keep — and even a strong reviewer can be wrong on a fact.** *(evidence)*
  Invar and Opus disagreed on an empirical claim (tsc pass/fail); the disagreement surfaced a real
  bug AND the masking trap. Validates the §5.4 independent-panel design and the rule that the
  executor must verify contested empirical facts firsthand.

### ivue skill

- **Antipattern: decorative reactivity.** *(moderate)* The fork bumped `revision`/`version` refs
  on every mutation but no effect ever reads them — reactive infrastructure with no consumer, so
  it looks reactive and isn't. **Proposed:** the skill should name this explicitly — a ref you
  bump must be observed by some effect, or it's dead weight; wire the coarse frame `watchEffect`
  or don't pretend. (Positive: the fork, guided by the ivue skill, got namespace/late-read/
  plain-getter/no-computed discipline RIGHT with near-zero drift — the skill's core guidance works.)

### ibr skill

- **Impossibility-prediction is the highest-value part of a contract — demonstrated.** *(evidence)*
  The reality invariant `A text position has several encodings` predicted, before any code was
  read, exactly the bug found: UTF-16 math mislabeled "logical", surrogate-splitting backspace,
  no display-column mapping. The Impossibility/Generative principle paid off concretely — worth
  citing as the canonical example of "a good invariant predicts the bug you haven't found yet."

### Cross-skill / delegation

- **Ungoverned autonomous builder = fast but untrusted.** The rogue fork produced disciplined,
  working code quickly, but with no contracts and no review it was un-trustable until governed.
  The governance layer (contracts + independent review + firsthand verification) is what converts
  fast output into trusted output — the delegation model needs the review gate, always.
- **Concurrent-checkout hazard is real.** The fork racing the main loop's commits nearly clobbered
  work. Worktree-per-delegate isolation (now used for codex) is the mitigation — one branch per
  worker, merge after review.

## Governance pass — round 2 (2026-07-21)

### invariants skill

- **"Overridable seams" and "late reads" are DIFFERENT rules — a review must check both.**
  *(moderate)* Field-init `x = new Y.Class()` PASSES *Imported dependencies are read late* (it's a
  construction-time read, not module-scope) but VIOLATES *Construction goes through overridable
  seams* (hard-coded concrete class, no override point; fix = `createX()` factory methods). BOTH
  the Invar and Opus audits missed it — they checked the late-read/circular rule and treated
  field-init construction as clean; the human caught it. **Proposed:** the analyze step must test
  seam-ness separately from late-ness, and flag field-initializer `new X.Class()` explicitly.
  Strong evidence that a human-in-loop catches what parallel AI audits converge on and miss.
- **Annotation path must match where the record actually lives, and rename-ripple must sweep code
  annotations.** *(minor)* A module-level invariant (workspace nav) was annotated
  `(project.invariants.md)` but belongs in `workspace.invariants.md` → orphan until repointed;
  and invariants I renamed (comma removed for the charset rule) orphaned the fork's old-name
  annotations. `--refs` caught all of it — validates the drift check; note the rename-ripple rule
  must include code annotations, not just contracts + lattice links.

### ivue skill

- **Non-reactive splits into TWO kinds; only one uses `Static()`.** *(moderate)* Stateless
  capability classes — "function bags" (file/process/git-command/clock/ids/env/logging) → wrap in
  `Static()` (vendored, experimental) for callback-safe passable methods + native static `super` +
  deterministic plugin composition. Stateful non-reactive classes with identity + lifetime
  (PieceTable, LspProcess/Transport, UndoStore, GitWatcher, DiffEngine, Tree-sitter handles) →
  plain instance classes, `let Class = $Class`, **never** `Static()` ("a static capability
  transform is not an instance container"). The fork built the capability layer (`system/*`) as
  plain static-method classes with no `Static()` — a gap vs the intended pattern. **Proposed:**
  the skill should state the discriminator (stateless-behavior-bag vs has-instances-and-lifetime)
  and that `Static()` must be vendored.
- **`Static()` `#private` caveat.** *(minor)* Native static `#private` rejects the selected-subclass
  receiver (a `Static()` class is a subclass of `$Class`); use TS `private`/`protected` or
  module-scope state for capability-class private data, not `this.#member`.

### Process

- **WebFetch upgrades HTTP→HTTPS and won't reach a local dev server** *(minor)* — the ivue docs at
  `10.211.55.7:5174` are served from `../ivue/docs_v2/`; read the local source file instead.

## codex integration round (2026-07-21)

### ivue skill

- **`$stopEffects()` clears ALL cached getter cells, not just effects — a real footgun.**
  *(moderate)* `Reactive()` stores ref-getter STATE (`get status(){ return ref('idle') }`) in the
  same per-instance cached cells that `$stopEffects()` deletes. So calling `$stopEffects()`
  "defensively" on a class that owns NO `$watch`/`$watchEffect` effects but HAS ref-getter state
  corrupts that state: after dispose the getter re-materializes its DEFAULT (`'idle'`, `''`, `[]`),
  not the last value, and any `publish()`/read after the call sees the reset. Bit two integrated
  modules (LanguageClient, GitRepository) — both had a speculative `$stopEffects()` in `dispose()`.
  **Rule:** call `$stopEffects()` ONLY on classes that actually own effects (e.g. the App frame
  effect). For pure ref-getter-state classes, disposal = invalidate in-flight work + close
  resources; do NOT call `$stopEffects()`. **Proposed:** the skill's lifecycle/disposal section
  must state this explicitly (it currently implies `$stopEffects()` is a harmless teardown call).

### Delegation

- **codex delivers code but routinely skips the required tests AND the module contract.** *(pattern)*
  All 3 workers wrote working code; git included a contract + tests, but markdown and lsp shipped
  code only. Completion (contract + tests + minor fixes) was delegated to review subagents that also
  caught real bugs (lsp dispose). **Takeaway:** budget a review+completion pass per codex module by
  default; a codex "done" is code-done, not milestone-done.

## Cross-substrate invariant transfer (scroll, from the realized VirtualScroller) — 2026-07-21
Transferred scroll invariants from `../realized/.../VirtualScroller.invariants.md` (browser GPU
substrate) to this terminal cell-grid substrate. The split is the lesson:
- **The implementation transfers ~nothing** — Lenis/creep-integrator/CSS-transition machinery is the
  *expression*, bound to sub-pixel compositing. Discarded wholesale (expression-is-not-essence).
- **~half the invariants transfer verbatim** because they are about STATE OWNERSHIP + COST, which are
  substrate-independent: "Nothing Costs O(Total)" (== our *Cost tracks the actively observed set*,
  reached INDEPENDENTLY on another substrate → a Domain-Crossing confirmation of our own core
  invariant), "Computed Geometry Is The Truth" (pull the total through a callback; rendered rows are
  never the source of scroll truth), "One Writer Per Regime", "The Container Is An Input Never An
  Output" (Yoga-flex runaway fixpoint — a real reality invariant we lacked; now recorded).
- **Some transfer only with a re-parameterized variable, not rejected:** "Smoothness Is Crossing
  Regularity" — the KERNEL (regularity of *crossings*) is substrate-independent; only the crossing
  UNIT rebinds (device-pixel → cell-row). It PREDICTS sub-cell smoothness is impossible (don't chase
  it). Filed as the contract for the pending smooth-scroll increment.
- **Some are category errors on the new substrate and must be RECORDED as non-transferable** so
  nobody re-imports them: GPU-f32 precision, composited-layer weight, transform-scaled rects,
  fractional/sub-pixel motion — all N/A on a discrete cell grid.
**Takeaway:** when transferring a contract across substrates, sort each invariant into
{transfers verbatim | transfers with a re-parameterized variable | category error here}; the
verbatim-transfers that you also derived independently are the strongest (Domain-Crossing), and the
re-parameterized ones are easy to wrongly reject — check whether only the *unit* changed.
