# Workspace — Invariants

Load-bearing rules for `src/modules/workspace/` (`Workspace`, `FileTree`). Stands on
`project.invariants.md`. Multi-workspace records are `provisional` — the M2 code is
single-workspace only; they are the M2 completion backlog.

## Reality-based invariants

_None specific to the workspace — it consumes the project reality invariants (bounded viewport;
a referenced resource stays alive) rather than adding its own._

## Chosen invariants

### Workspace and file navigation are separate layers

**Invariant:** If the user navigates, then project/worktree navigation (the outer layer) and
file/buffer navigation (the inner layer) use distinct commands and never share one control;
switching the outer layer restores the inner layer's own state.

**Scope:** Workspace/worktree tabs vs file/editor tabs; the focus toggle between files pane and
editor.

**Mechanism:** A `WorkspaceManager` owns the outer tab set; each `Workspace` owns its inner
file-tab/editor state; distinct key/command families drive each. Realizes the project product
model at the workspace boundary.

**Generates:** the two-tab-layer UI; separate `workspace.*` vs `editorTab.*` commands;
per-workspace state restoration on switch.

**Evidence:** partially built — `Workspace.ts` has a files/editor focus toggle (`focus`,
`toggleFocus`), but there is no `WorkspaceManager`, no outer tab set, and only a single workspace
is constructed (`Bootstrap.ts:45`). The outer layer is the M2 gap.

**Impossible if true:** one shortcut that switches both layers depending on focus; switching a
workspace that loses that workspace's open file and cursor state.

**Open question:** land `WorkspaceManager` + outer tabs + per-workspace snapshot restoration
(M2 completion).

**Verification:** a test opening two workspaces, switching between them, and asserting each
restores its own file tab, cursor, viewport, and sidebar mode.

**Status:** provisional

**Last refined:** 2026-07-21

### The file tree costs only what is expanded and visible

**Invariant:** If the project tree is large, then only expanded directories are listed and only
the visible window is rendered — cost is O(expanded + viewport), never O(total files).

**Scope:** `FileTree` listing, expansion, and row materialization.

**Mechanism:** lazy directory reads cached in a `Map`, expansion tracked in a `Set`, flattened
rows as a plain getter, viewport-sliced at render. Realizes *Cost tracks the actively observed
set*.

**Generates:** lazy expansion; windowed tree rendering; flat cost as the repo grows.

**Evidence:** `FileTree.ts` — lazy `Set`/`Map`, viewport slice in `RootView.ts:143`; tested
("cost only on expand"). Upheld. Nit: collapsed-directory listings are not evicted from the
cache (minor unbounded growth).

**Impossible if true:** listing or materializing a row for every file in the project to show one
screen of the tree.

**Verification:** a test asserting listing calls happen only on expand and rendered rows are
bounded by sidebar height.

**Status:** provisional

**Last refined:** 2026-07-21

### N open tabs do not cost N live documents

**Invariant:** If N editor tabs are open, then the number of LIVE documents (with an in-memory text
buffer + undo history) is bounded by the active buffer plus any DIRTY background buffers — clean
background tabs are dehydrated to a light handle (path + cursor/scroll) and rehydrated on
activation. Memory cost tracks the actively-edited set, not the tab count.

**Scope:** `OpenBufferSet` — the editor-layer buffer set behind the tab bar; its open/focus,
dehydrate, and rehydrate discipline. Excludes workspace/project tabs (a separate layer).

**Mechanism:** Opening a file ADDS or FOCUSES a buffer (never replaces). On deactivation a clean
buffer is disposed to a handle; a dirty buffer stays live so unsaved edits survive. Activation
rehydrates the handle from disk + restores the saved cursor/scroll. Realizes *Cost tracks the
actively observed set*.

**Generates:** memory-safe many-tab sessions; the flyweight tab model; dirty-edit preservation
across tab switches.

**Evidence:** `src/modules/workspace/OpenBufferSet.ts` (flyweight + dispose discipline; the active
+ dirty-background live set); `Workspace.tabs.test.ts` (flyweight keeps live docs < tab count).

**Impossible if true:** every open tab holding a live document + undo stack regardless of activity;
a clean background tab consuming a full buffer; a dirty background tab losing its unsaved edits on
deactivation.

**Verification:** a test opening more tabs than the live-document budget and asserting the live-set
size stays bounded by active + dirty.

**Status:** provisional

**Last refined:** 2026-07-21
