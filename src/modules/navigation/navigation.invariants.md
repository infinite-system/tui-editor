# Navigation — Invariants

Load-bearing rules for `src/modules/navigation/` (`NavigationHistory`) and its wiring into
`Workspace` (Go Back / Go Forward). Stands on `project.invariants.md`.

## Reality-based invariants

_None specific to navigation — it consumes the project reality invariants (a referenced resource
stays alive; bounded memory) rather than adding its own._

## Chosen invariants

### Programmatic history navigation does not record new history

**Invariant:** If a location is reached by REPLAYING the history (a back/forward step), then that
restore records no new entry and truncates no forward history; only a fresh user navigation
(go-to-definition, opening a file from the tree / quick-open / a hover or Markdown reference)
records. Without this the current index could never move backward — every "back" would append the
place it just restored, and Forward would be unreachable.

**Scope:** `NavigationHistory.record/back/forward` and the `Workspace` recording hooks
(`openFileInTab`, `jumpToLocation`, `navigateBack`, `navigateForward`).

**Mechanism:** `back()`/`forward()` move only `currentIndex` and return the entry — they never call
`record()`. `Workspace.restoreNavigationLocation` runs the file-open + cursor-placement inside
`withSuppressedLocationRecording`, which raises the `suppressLocationRecording` guard that gates the
auto-record in `openFileInTab`. The go-to-definition jump uses the same guard around its internal
`openFileInTab` and records its source + declaration landing explicitly, so it records exactly two
entries, not four. A fresh `record()` of a NEW location truncates entries after `currentIndex` then
appends (browser back/forward semantics); same-line drift collapses in place.

**Generates:** escapable back/forward walking; a forward trail that survives back-stepping but is
discarded by a new branch; a bounded stack (cap 100, oldest dropped); same-line cursor drift that
never spams the stack.

**Evidence:** `src/modules/navigation/NavigationHistory.ts` (`back`/`forward` touch only
`currentIndex`); `src/modules/workspace/Workspace.ts` (`suppressLocationRecording`,
`withSuppressedLocationRecording`, `restoreNavigationLocation`, `openFileInTab`, `jumpToLocation`);
`src/modules/navigation/__tests__/NavigationHistory.test.ts` (truncation + collapse + cap + at-end
no-ops); `src/modules/workspace/Workspace.navigation.test.ts` (a programmatic back/forward does not
change history size); `scripts/smoke-navigation-history.sh` (Alt+[/Alt+] drive the real app).

**Impossible if true:** a back() that appends the restored location and so pins the current index at
the newest entry; a forward trail that survives navigating to a new location after going back; an
unbounded stack that grows with every cursor nudge.

**Verification:** `bun test src/modules/navigation/ src/modules/workspace/Workspace.navigation.test.ts && bash scripts/smoke-navigation-history.sh`

**Status:** provisional

**Last refined:** 2026-07-23
