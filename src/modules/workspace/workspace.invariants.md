# Workspace — Invariants

Load-bearing rules for `src/modules/workspace/` (`WorkspaceSet`, `Workspace`, `FileTree`) and the
shared project/editor tab boundary. Stands on `project.invariants.md`.

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

**Mechanism:** `WorkspaceSet` owns the outer tab set; each `Workspace` owns its inner
`OpenBufferSet` and editor state. `Bootstrap.ts` resolves every live command and status read through
`WorkspaceSet.active`; `RootView.ts` mounts separate workspace and buffer `TabStrip` instances.

**Generates:** the two-tab-layer UI; separate `workspace.*` vs `editorTab.*` commands;
per-workspace state restoration on switch.

**Evidence:** `WorkspaceSet.ts`; `Bootstrap.ts` active-workspace reads; `RootView.ts`
`workspace-tab-strip` and `editor-tab-bar`; `WorkspaceSet.test.ts` state-restoration test;
`scripts/smoke-workspace-tabs.sh` switches roots and checks tree/git/editor projection.

**Impossible if true:** one shortcut that switches both layers depending on focus; switching a
workspace that loses that workspace's open file and cursor state.

**Verification:** `bun test src/modules/workspace/WorkspaceSet.test.ts && bash scripts/smoke-workspace-tabs.sh`

**Status:** provisional

**Last refined:** 2026-07-21

### N open workspaces do not cost N live GitWatchers

**Invariant:** If N project workspaces are open, then only the active workspace owns a live
`GitWatcher`; inactive workspaces keep resumable model state without filesystem watch handles.

**Scope:** `WorkspaceSet` activation, switching, closing, and disposal; each owned `Workspace` and
its `GitWatcher`. Dirty editor buffers are governed separately by the document flyweight record.

**Mechanism:** `WorkspaceSet.activate` calls `Workspace.suspendOwnedResources` before changing the
active index and `Workspace.resumeOwnedResources` afterward. Suspension disposes and clears the
watcher; resumption constructs one watcher for the newly active root.

**Generates:** one live project watcher; cold inactive workspace roots; watcher disposal on project
switch and close.

**Evidence:** `WorkspaceSet.ts`; `Workspace.ts` `suspendOwnedResources` and
`resumeOwnedResources`; `WorkspaceSet.test.ts` "N open workspaces keep exactly one live GitWatcher";
`scripts/smoke-workspace-tabs.sh` `liveGitWatcherCount` assertions.

**Impossible if true:** two open workspaces both reporting a live `GitWatcher`; an inactive root
retaining filesystem watch handles after a workspace-tab switch.

**Verification:** `bun test src/modules/workspace/WorkspaceSet.test.ts -t "N open workspaces keep exactly one live GitWatcher" && bash scripts/smoke-workspace-tabs.sh`

**Status:** provisional

**Last refined:** 2026-07-21

### Tab strip panning never activates tabs

**Invariant:** If a tab strip viewport pans through overflow, then its active tab stays unchanged
until a separate activation action targets a tab.

**Scope:** Both `TabStrip` instances: project workspace tabs and editor buffer tabs; horizontal and
vertical orientations.

**Mechanism:** `TabStrip.pan` mutates only `scrollOffset`; activation remains in
`WorkspaceSet.activate` or `Workspace.activateTab`. `RootView.ts` routes arrow controls only to pan.

**Generates:** overflow arrows that reveal hidden tabs without changing project or file context.

**Evidence:** `TabStrip.ts`; `TabStrip.test.ts` "panning changes only the viewport offset";
`scripts/smoke-tabs.sh`; `scripts/smoke-workspace-tabs.sh`.

**Impossible if true:** clicking an overflow arrow changes `activeWorkspaceIndex` or
`activeBufferIndex`; panning to a hidden tab opens it.

**Verification:** `bun test src/modules/ui/TabStrip.test.ts && bash scripts/smoke-tabs.sh && bash scripts/smoke-workspace-tabs.sh`

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
