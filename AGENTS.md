# AGENTS.md — Invar

Any agent (codex, claude, fable, or a human tool) working in this repo: **load the repo's IBR
framework and conventions before writing code.** They live as skills in this repo — read them,
don't work from a second-hand summary:

>  **`.claude/skills/ibr/IBR.md`** — the Invariant-Based Reasoning framework that governs this
>  codebase (this is the file to inject via `--append-system-prompt-file` for claude agents).
>  **`.claude/skills/ivue/`** and **`.claude/skills/invariants/`** — the ivue reactive/namespace
>  conventions and the invariant-contract discipline.

Non-negotiable conventions (summarized from the `ivue` + `invariants` skills and
`project.conventions.md`; these are the ones that must not be lost in relay):

1. **ivue namespace pattern — three forms.** `class $X` + `namespace X` exposing one of
   `Class = Static($X)` (stateless capability / swap seam), `Reactive($X)` (stateful + reactive
   controller), or `= $X` (raw plain service: stateful, not reactive-tracked). Pick the honest
   form — don't default everything to Reactive.
2. **Distill to the shared generator — reuse the seam, don't duplicate or over-unify.** A behavior
   belongs in ONE seam only where its *generator* is the same across consumers (e.g. `TextEditing`
   word-edits, the `*Backend` provider seams, `ScrollableTextViewport`); a new consumer is then one
   wire-up, not a reimplementation. SPLIT where features only *look* alike — the tell that a boundary
   is wrong is a consumer forced to *suppress a seam's core* to use it (peripheral config is fine).
   Duplication AND over-unification are both failures. Invariant: *Seams are drawn at the shared
   generator* (`project.invariants.md`).
3. **Full descriptive identifier names, always.** `increment` not `inc`, `index` not `i`,
   `editor` not `ed`. Full property paths over short aliases. All code.
4. **Invariants govern change.** Check against the relevant `*.invariants.md`; require zero
   problems from `node .claude/skills/invariants/scripts/check_invariants.mjs --all --refs`.
   Never put a literal `// invariant: …` string in example/comment text (the checker scans it).
5. **Verify by DRIVING the real user path** (tmux harness + FrameProbe), never internal values.
   Reproduce before diagnosing; ratchet verified behavior into a gated smoke.
6. **Branches are NEVER deleted — parked and tagged.** Every branch ends in exactly one of two
   marked terminal states: `git tag -a finished/<branch>` (content fully merged into main) or
   `git tag -a orphaned/<branch> -m '<why>'` (content never landed: superseded, unadopted, or
   replaced by a rebase — tag the pre-rebase twin too). No `git branch -D`, ever; cleanup removes
   WORKTREES only (`git worktree remove`). In-flight branches get neither tag — pending ≠ orphaned.
   Greppable: `git tag -l 'finished/*'` / `'orphaned/*'`.
7. The editor is named **Invar** (formerly "Fable").

Also read on entry: `CLAUDE.md`, `project.conventions.md`, `project.ivue-reference.md`,
`project.invariants.md`, `project.architecture.md`.
