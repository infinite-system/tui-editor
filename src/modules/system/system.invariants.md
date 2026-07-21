# System — Invariants

Load-bearing rules for `src/modules/system/` — the stateless capability layer (`Files`, `Clock`,
`Environment`, `Logging`, `Processes`, `StatusChannel`) plus the vendored `Static.ts`. Stands on
`project.invariants.md`.

## Reality-based invariants

_None specific — the system layer wraps the underlying OS/tool realities named at project scope
(language and git tools are separate failable processes) rather than adding its own._

## Chosen invariants

### Capability classes are stateless and Static wrapped

**Invariant:** If a class in this layer is a capability (behavior only, no per-instance state),
then it is wrapped in `Static()` so its methods stay bound to the selected class when retained as
a callback; anything with instance identity or lifetime is NOT a capability and stays a plain
instance class.

**Scope:** `system/*` capability classes vs stateful non-reactive classes elsewhere
(`PieceTable`, `LspProcess`, `UndoStore`, `GitWatcher`, …).

**Mechanism:** `Static()` (vendored `system/Static.ts`, 39 lines from ivue's experiment) lazily
binds each visible static method to a selected subclass; first read binds, later calls are plain
bound functions (~native cost). Realizes `project.decisions.md` #7 (capability vs plain vs
reactive). The discriminator: stateless-behavior-bag → `Static()`; has-instances-and-lifetime →
plain instance class, `let Class = $Class`, never `Static()`.

**Generates:** callback-safe passable capability methods (command actions, key handlers, watcher
callbacks); native static `super` + kernel composition of capabilities; the `system/*` `Static()`
wrapping.

**Evidence:** `system/{Files,Clock,Environment,Logging,Processes,StatusChannel}.ts` →
`let Class = Static($X)`; `system/Static.ts` vendored. No capability class holds instance state
or uses `this.#private` (which `Static()`'s subclass receiver would reject).

**Impossible if true:** a capability method that loses its `this`/binding when passed as a
detached callback; a `system/*` capability class that holds per-instance state; a stateful
class (identity + lifetime) wrapped in `Static()`.

**Verification:** a test that retains a capability method as a detached callback and asserts it
still executes correctly; grep asserts stateful classes are not `Static()`-wrapped.

**Status:** provisional

**Last refined:** 2026-07-21

### File access is confined to a single root

**Invariant:** If a file path is read or listed through `Files`, then it is confined to the active
workspace root — traversal outside it is rejected.

**Scope:** `Files` read/list/path operations.

**Mechanism:** `Files.confineToRoot` normalizes and checks paths against the root before access.
Realizes the security/robustness posture (path-traversal boundary).

**Generates:** the path-traversal guard; safe file-tree listing.

**Evidence:** `Files.ts` `confineToRoot` (`Files.ts:91`); `looksBinary` NUL-sniff for binary files.

**Impossible if true:** a `../../etc/passwd`-style read that escapes the workspace root through
`Files`.

**Verification:** a test asserting a traversal path outside the root is rejected.

**Status:** provisional

**Last refined:** 2026-07-21

### Observability never crashes the app

**Invariant:** If writing the status side-channel or a log fails, then the failure is swallowed —
observability is best-effort and never propagates into the app.

**Scope:** `StatusChannel.flush`/`settle`, `Logging.write`.

**Mechanism:** IO in these paths is wrapped so errors are caught and dropped; the status file is
written atomically (temp + rename).

**Generates:** the crash-proof status channel the tmux harness reads; non-fatal logging.

**Evidence:** `StatusChannel.ts` flush/settle swallow errors + atomic write; `Logging.ts` guarded.

**Impossible if true:** a full disk or unwritable `artifacts/` dir crashing the editor via the
status channel or logger.

**Verification:** a test forcing a write failure and asserting the app path continues.

**Status:** provisional

**Last refined:** 2026-07-21
