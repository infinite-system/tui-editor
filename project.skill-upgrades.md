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
