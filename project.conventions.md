# project.conventions.md — THE operative convention set (load-bearing infrastructure)

This file is the single canonical WHAT. `project.decisions.md` keeps the WHY/history. Every resume
loads this FIRST (HANDOFF MUST-RE-READ position 1); every delegate packet embeds it mechanically
(`scripts/delegate-packet.sh`); the greppable rules run at every merge (`scripts/conventions-gate.sh`).
Change a convention → change it HERE (and note the why in decisions.md).

## Naming
- Every identifier is a FULL, spelled-out descriptive name. No abbreviations, ever, in all code:
  `editor` not `ed`, `workspace` not `ws`, `index` not `i`, `increment` not `inc`, `palette` not
  `pal`, `options` not `opts`, `direction` not `dir`. Nested loops use distinct real names
  (`rowIndex`/`columnIndex`). CHECK: conventions-gate grep.
- Prefer the full property path over a single-use alias local (`workspace.editor.save()`, not
  `const editor = workspace.editor` used once). A reused COMPUTED result may be stored, named for
  what it is.
- Do NOT rename ivue namespace tokens (`Class`, `$Class`, `Model`, `Instance`) or library APIs.
- Late-dependency getter members carry NO `Class` suffix: `get GitCommands() { return
  GitCommands.Class; }`.

## Class kinds & file shape (NEW-FILE RULE)
- NEW FILE RULE: exported STATELESS behavior is born as `class $X { static … }` + `export namespace
  X { export const $Class = $X; export const Class = Static($X); }` — never a bare
  `export function` bag. State: Reactive domain models via `Reactive($X)` (mutable `let Class`);
  plain classes for algorithms/resources. Legacy bare bags are converted by the scheduled item-9
  pass; new code NEVER adds more. CHECK: conventions-gate grep for `^export function` in
  `src/modules/**`.
- One class per `PascalCase.ts` file (ivue namespace pattern); role collections are
  `<module>.<role>.ts`. Docs are `project.<role>.md`. "ivue" is always lowercase.
- Reactive state = ref-returning getters; cheap derived state = PLAIN getters (never `computed()`
  unless memoization is proven). Cross-module deps are read LATE (getters/method bodies) — never
  top-level `new`/snapshot. Owned constructions go through overridable `createX()` seams.
- `$stopEffects()` only on classes that OWN effects (it clears ref-getter state cells too).

## Interaction & state discipline
- One writer per scroll/animation regime per frame; a new authority (keyboard, thumb drag, jump)
  HALTS the previous one (adopt-and-stop). Wheel input feeds IMPULSES to momentum, never direct
  offset steps on a momentum-managed pane.
- A mouse event is consumed by exactly ONE handler path; renderer and hit-testers share the SAME
  row/geometry model (never parallel math).
- Scrollbar placement/visibility comes ONLY from `scrollbar-geometry` (one source; explicit
  `visible` predicate; thickness from the explicit map — never layout read-back).
- Destructive operations (discard, delete, force) execute ONLY behind an explicit confirmation
  distinct from the triggering gesture.
- ALL key handling goes through the keybinding registry as DATA (intent-addressed bindings;
  chords as step lists; canonical floor + overlays + user layers). No inline chord conditionals.
  Advertised binding hints come from `effectiveBindings()` — never hand-written strings.

## Verification (authoritative channels)
- Semantic state → the session's `status-<session>.json` (harness `field <session> <name>`);
  NEVER pane-scrape state. Visual → FrameProbe (`TUI_FRAME_DUMP=1`, 4 RGBA lanes/cell,
  frame-diff with a no-action control). Native caret → tmux `#{cursor_x},#{cursor_y}`.
- Never pipe tsc through anything that masks the exit code: `bunx tsc --noEmit; echo TSC=$?`.
- Every feature lands with: unit tests for extractable logic + a live tmux verification + (where
  visual) a FrameProbe assertion; regressions get a permanent smoke assertion.
- Destructive git verification runs in a SCRATCH repo under /tmp — never this repo's tree.
- Merge gate = tsc + `bun test` + smoke ALL-PASS + invariants checker `--all --refs` 0 problems +
  `scripts/conventions-gate.sh`.

## Contracts (invariants)
- Contract-first for new modules; records follow the /invariants schema (both section headings;
  Evidence + Impossible-if-true required; unnumbered declarative names; charset letters/digits/
  spaces/hyphens). Code that upholds a record carries `// invariant: <exact name> (<path>)`.
- Status is `provisional` until verified BY EXECUTION through an authoritative channel.

## Delegation
- Every delegate packet is assembled MECHANICALLY by `scripts/delegate-packet.sh` — conventions +
  method essentials + target contracts + task spec. Never hand-assembled from memory.
- Full-parity context, task-scoped: worktree-per-writer isolation; disjoint file sets where
  possible; NO conductor identity (delegates do the one task and stop); delegates never commit —
  the coordinator reviews (naming gate, contracts, verification evidence) and commits with credit.
- codex: never trusted with deletions; commit before delegating; review `git status` for
  unexpected removals.

## Self-handoff
- On ANY resume: read THIS file first, then PROGRESS.md (USER PIPELINE + RESUME HERE), then
  HANDOFF.md, then the contracts of whatever is in flight.
- Every turn-ending status carries: the COMPACTION line + `conventions @ <git hash of this file>`
  (drift made visible).
