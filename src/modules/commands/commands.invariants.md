# Commands module invariants

This contract stands on `project.invariants.md`, especially *No action requires a memorized
motion* and *The core is complete without plugins*, and their chosen descendants.

## Reality-based invariants

### Command scoring is a pure ordering

**Invariant:** If `fuzzyScore(query, text)` is called, then it depends only on those two string
arguments — identical inputs always yield an identical number, it reads and writes no state,
and a tighter (more adjacent) subsequence match scores lower than a more spread-out one.

**Scope:** `CommandScoring.fuzzyScore` and the ordering `CommandRegistry.recompute` derives from
it (sort by score ascending, `title.localeCompare` as the only tiebreak).

**Mechanism:** `$fuzzyScore` is a free function reading only its two parameters — no `this`, no
clock, no randomness, no I/O — and accumulates gap distance between matched characters, so a
smaller total means characters landed closer together. `-1` marks a non-subsequence; `0` marks
the empty query.

**Generates:** A deterministic, reproducible palette ranking; a stable tiebreak so equal scores
never reorder between renders; the freedom to recompute the filtered list on every keystroke.

**Evidence:** `src/modules/commands/CommandScoring.ts` (`$fuzzyScore`);
`src/modules/commands/CommandRegistry.ts` (`recompute` sort); `fuzzyScore matches subsequences
and rejects non-matches` and `tighter (adjacent) matches score lower than spread-out ones` in
`src/modules/commands/__tests__/commands.test.ts`.

**Impossible if true:** `fuzzyScore` returning two different scores for the same query and text,
mutating any observable state, or ranking a spread-out match tighter (lower) than an adjacent one.

**Verification:** `bun test src/modules/commands -t "tighter (adjacent) matches score lower than spread-out ones"`

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### Every action dispatches through the one registry

**Invariant:** If the user can invoke an action, then it is a `Command` registered in the single
`CommandRegistry` map under a stable id, reachable by the palette and by keybindings, and it runs
only by being looked up in that map — no action path bypasses the registry.

**Scope:** `CommandRegistry` (the `commands` map, `register`/`registerAll`, `run`, `all`,
`filtered`, `runSelected`) and the default command set in `CommandDefaults`.

**Mechanism:** Every action is added to one private `Map<string, Command>`; the palette lists it
via `all`/`filtered` and executes the selection via `runSelected`, while a keybinding executes the
same command via `run(id)`. Both dispatch paths resolve the command out of the one map, so there
is no second way to reach an action.

**Generates:** The command-palette-for-everything surface; rebindable keybindings that name a
command id rather than a hard-wired handler; the *No action requires a memorized motion* guarantee
for this module.

**Evidence:** `src/modules/commands/CommandRegistry.ts` (`commands` map, `register`, `run`,
`runSelected`); `src/modules/commands/CommandDefaults.ts` (`registerDefaultCommands`); `registry
filters by query and runs the selected command` in
`src/modules/commands/__tests__/commands.test.ts`.

**Impossible if true:** A user-reachable action absent from the registry map, or a command executed
by any path other than a lookup in that map (a hidden handler the palette cannot list or a keybinding
cannot name).

**Verification:** `bun test src/modules/commands -t "registry filters by query and runs the selected command"`

**Status:** provisional

**Last refined:** 2026-07-21

### A command runs only when its guard holds

**Invariant:** If a command carries a `when` guard, then its `run` fires only while `when()`
returns true, and a guarded-off command is invisible in the palette — enforced identically on the
palette path and the direct-dispatch path.

**Scope:** `CommandRegistry.all` (list filter), `CommandRegistry.run` (id dispatch), and
`CommandRegistry.runSelected` (palette dispatch).

**Mechanism:** `all()` filters out any command whose `when` returns false before it can be listed
or scored, and both `run(id)` and `runSelected()` re-check `!command.when || command.when()`
immediately before calling `run`, so a guard that flips false between listing and invocation still
blocks execution. A command with no `when` is treated as always available.

**Generates:** Context-sensitive commands (save/undo only with a document open) that never fire in
the wrong context; a palette that shows only what is currently runnable.

**Evidence:** `src/modules/commands/CommandRegistry.ts` (`all`, `run`, `runSelected`);
`src/modules/commands/CommandDefaults.ts` (`hasDocument` guards on `file.save`, `edit.undo`,
`view.focusEditor`, etc.); `when() gates command availability` in
`src/modules/commands/__tests__/commands.test.ts`.

**Impossible if true:** A command's `run` executing while its `when()` returns false, reached
through the palette, through `runSelected`, or through `run(id)`.

**Verification:** `bun test src/modules/commands -t "when() gates command availability"`

**Status:** provisional

**Last refined:** 2026-07-21
