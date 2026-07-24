# Git module invariants

This contract stands on `project.invariants.md`, especially *An async result can outlive the
state it described*, *Language and git tools are separate failable processes*, *Cost tracks the
actively observed set*, and their chosen descendants.

## Reality-based invariants

### Git completions can arrive out of order

**Invariant:** If multiple asynchronous Git subprocesses overlap, then they can complete in an
order different from their request order.

**Scope:** Status and log subprocesses started by `GitRepository` for one working directory.

**Mechanism:** `Bun.spawn` processes execute independently while later requests can start before
earlier processes exit.

**Generates:** Monotonic status and history request IDs; a stale-result guard at every async
application point.

**Evidence:** `src/modules/git/GitRepository.ts` (`refreshRequestId`, `historyRequestId`);
`refresh supersedes an older completion` in `src/modules/git/__tests__/GitRepository.test.ts`.

**Impossible if true:** Assuming request order guarantees completion order for two overlapping
`git status` calls.

**Verification:** `bun test src/modules/git -t "refresh supersedes an older completion"`

**Status:** provisional

**Last refined:** 2026-07-21

### Filesystem notifications arrive in bursts

**Invariant:** If a working-tree change is observed through `fs.watch`, then it can produce
multiple notifications in a short interval and notification detail can vary by platform.

**Scope:** Filesystem notifications received by `GitWatcher` for its working directory.

**Mechanism:** Operating-system watcher backends report directory-entry and content changes at
backend-specific granularity, so one logical save can emit several events.

**Generates:** A resettable debounce timer and no correctness dependency on event names.

**Evidence:** `src/modules/git/GitWatcher.ts` (`scheduleRefresh` ignores event payloads and resets
one timer).

**Impossible if true:** Reliably mapping every logical save to exactly one portable `fs.watch`
callback.

**Verification:** Inspect `GitWatcher.scheduleRefresh` and run `bun test src/modules/git`.

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### Only the newest Git request mutates state

**Invariant:** If overlapping status or history requests complete, then only the result carrying
the latest monotonic request ID mutates repository refs.

**Scope:** `GitRepository.refresh`, `GitRepository.loadHistory`, branch-change invalidation, and
repository disposal.

**Mechanism:** Each request captures an incremented ID and checks it after every await and before
mutation; newer requests, branch changes, and disposal supersede older IDs.

**Generates:** Stale status and history rejection; correct `refreshing` state under overlap;
in-flight work made inert on disposal.

**Evidence:** `src/modules/git/GitRepository.ts` (`refresh`, `loadHistory`, `dispose`);
`refresh supersedes an older completion` in `src/modules/git/__tests__/GitRepository.test.ts`.

**Impossible if true:** An older status completion replacing a branch, head, or file group
already supplied by a newer completion.

**Verification:** `bun test src/modules/git -t "refresh supersedes an older completion"`

**Status:** provisional

**Last refined:** 2026-07-21

### History storage remains page bounded

**Invariant:** If branch history is loaded, then `GitRepository` retains only one requested page
of at most 200 compact `CommitRecord` values and no reactive object per commit.

**Scope:** `GitCommands.log`, `parseLog`, and `GitRepository.historyPage`.

**Mechanism:** The command clamps `--max-count`, the parser emits plain records, and
`historyPage` wholesale-replaces one shallow-ref array rather than appending rich models.

**Generates:** Cursor-based page loading; virtualized-ready commit rows; bounded retained history.

**Evidence:** `src/modules/git/GitCommands.ts` (`log`); `src/modules/git/git.parsers.ts`
(`CommitRecord`, `parseLog`); `src/modules/git/GitRepository.ts` (`historyPage`, `loadHistory`).

**Impossible if true:** Loading successive history pages growing one retained array without a
bound, or allocating a reactive class instance for each commit.

**Verification:** `bun test src/modules/git -t "log parser returns compact commit records"`

**Status:** provisional

**Last refined:** 2026-07-21

### Git command failures stay data

**Invariant:** If Git exits nonzero or cannot be spawned, then the capability returns
`{code, stdout, stderr}` and the repository exposes an error without throwing into its caller.

**Scope:** Every public `GitCommands` method and all repository status, history, stage, and
unstage operations.

**Mechanism:** `Processes.run` catches spawn failures and captures nonzero exits; `GitCommands`
preserves the three raw fields and `GitRepository` catches replaceable-capability exceptions.

**Generates:** Graceful operation outside a repository or without Git; failure messages in the
status side channel; editing independence from Git availability.

**Evidence:** `src/modules/git/GitCommands.ts` (`run`); `src/modules/git/GitRepository.ts`
(`refresh`, `loadHistory`, `runOperation`); failure tests in
`src/modules/git/__tests__/GitRepository.test.ts`; `a FAILED fetch is not end-of-history` in
`src/modules/git/CommitLog.test.ts`.

**Impossible if true:** A missing Git executable or nonzero `git status` rejection escaping
`GitRepository.refresh` as an unhandled exception; a transient nonzero `git log` being cached as
end-of-history (an empty-repository lie — `CommitLog.fetchPage` returns null on failure and
`ensureRange` never advances `knownEnd` from a failed page).

**Verification:** `bun test src/modules/git -t "a failed status refresh degrades to error state"`

**Status:** provisional

**Last refined:** 2026-07-21

### The watcher has one disposable debounce

**Invariant:** If `GitWatcher` is active and filesystem events storm, then it owns at most one
pending debounce timer and disposal clears every owned timer and watcher before another refresh.

**Scope:** One `GitWatcher` instance from construction through `dispose`.

**Mechanism:** Every event clears the previous timer before scheduling one replacement; disposal
marks the watcher inert, clears the debounce and reconcile timers, and closes every `FSWatcher`
handle.

**Generates:** One refresh per settled event storm; no watcher, debounce timer, or reconcile timer
retained after workspace close.

**Evidence:** `src/modules/git/GitWatcher.ts` (`scheduleRefresh`, `flushRefresh`,
`startReconcileFloor`, `dispose`); `reconcile floor refreshes after watcher failure and stops on
disposal` in `src/modules/git/__tests__/GitWatcher.test.ts`.

**Impossible if true:** A disposed watcher firing a delayed or periodic repository refresh, or one
event storm accumulating one debounce timer per event.

**Verification:** `bun test src/modules/git/__tests__/GitWatcher.test.ts -t "reconcile floor refreshes after watcher failure and stops on disposal"`

**Status:** provisional

**Last refined:** 2026-07-22

### The git panel converges without watcher notifications

**Invariant:** If `GitWatcher` remains active while filesystem notifications fail or are lost,
then `GitRepository` refreshes from Git ground truth within one reconcile interval plus the
debounce interval.

**Scope:** The live `GitWatcher` created by `Workspace.createGitWatcher` for one working directory,
including watcher setup failure, runtime watcher errors, and silent notification loss.

**Mechanism:** One slow interval calls the same `GitWatcher.scheduleRefresh` debounce used by
filesystem events. Setup and runtime watcher failures also schedule an immediate refresh, and
`dispose` clears both timers. The watcher requests the existing `GitRepository.refresh` path in
background mode, which replaces panel-observed refs only when Git ground truth changed.

**Generates:** Filesystem notifications as the fast path; periodic `git status` reconciliation as
the eventual-correctness floor; one coalesced repository refresh path; no render wake-up for an
unchanged periodic result.

**Evidence:** `src/modules/git/GitWatcher.ts` (`startReconcileFloor`, `watchDirectory`,
`onWatcherError`, `dispose`); `reconcile floor refreshes after watcher failure and stops on disposal`
in `src/modules/git/__tests__/GitWatcher.test.ts`; `src/modules/git/GitRepository.ts` (`refresh`,
`fileRecordsMatch`); `an unchanged background refresh preserves quiescent Git refs` in
`src/modules/git/__tests__/GitRepository.test.ts`; `src/modules/workspace/Workspace.ts`
(`createGitWatcher`).

**Impossible if true:** A tracked filesystem change remaining absent from `GitRepository` beyond
one reconcile interval plus debounce solely because watcher setup, delivery, or runtime failed; or
a disposed watcher continuing periodic refreshes; or unchanged periodic results replacing
panel-observed refs and waking rendering.

**Verification:** `bun test src/modules/git/__tests__/GitWatcher.test.ts src/modules/git/__tests__/GitRepository.test.ts`

**Status:** provisional

**Last refined:** 2026-07-22

### The watcher never watches inside an ignored directory

**Invariant:** If `GitWatcher` establishes its watches, then the WORKING-TREE WALK never opens a
watch handle inside a directory git ignores or inside `.git`; a change to a tracked file at any depth
still refreshes, and a change inside an ignored working-tree directory never does. Exactly ONE
deliberate watch stands apart from the walk: a single handle on the worktree's git dir, filtered to
HEAD, so a branch switch refreshes promptly — it is bounded (one handle), never recurses, and is not
part of the walk's watch set.

**Scope:** One `GitWatcher` instance's watch set, from construction through `dispose`, including
directories that appear after start. The dedicated HEAD watch is the single named exception.

**Mechanism:** The watcher WALKS the working tree from the root and opens one non-recursive
`fs.watch` per directory, pruning any child git reports through `git check-ignore` (and always
`.git`) before its watch is created; a new subdirectory event re-runs the same ignore test before
gaining a watch. A recursive root watch is not used — it would open a handle per directory inside
ignored subtrees like `node_modules`. Runtime-created entries are classified with a guarded
`lstatSync` — never `stat` — so a symlink (to `.git`, to an external tree, or to itself) is
rejected before ignore-checking or recursion, exactly like the initial walk's `Dirent` check; and
the whole `fs.watch` event callback is exception-guarded, so a filesystem race (ELOOP, vanished
path) can never throw out of the callback and kill the process. When git cannot answer (no repository or git unavailable) a
fixed fallback skip set stands in. Separately, `watchHead` opens ONE `fs.watch` on the worktree's git
dir (`rev-parse --absolute-git-dir`) and refreshes only when the changed entry is `HEAD` — a
directory watch, not a file watch, because git replaces HEAD by rename (HEAD.lock → HEAD), which
would break a file watch after the first switch. This handle lives outside `directoryWatchers`, so
`watchedDirectories()` — the bounded-walk contract's observable — never reports it.

**Generates:** Bounded watch-handle count on large projects; no filesystem-handle or memory growth
from ignored subtrees; refreshes driven by relevant working-tree changes plus prompt branch
reactivity on checkout/switch.

**Evidence:** `src/modules/git/GitWatcher.ts` (`walkAndWatch`, `filterIgnoredChildren`,
`queryIgnoredNames`, `onDirectoryEvent`, `watchHead`); `no watch handle is ever opened inside an
ignored directory`, `a nested tracked change refreshes but a change inside an ignored directory does
not`, and `a newly created nested directory is watched but a new ignored directory is not` in
`src/modules/git/__tests__/GitWatcher.test.ts`; `a runtime-created symlink is never watched and
never throws from the event callback` in the same file (all asserting `watchedDirectories()`, which excludes
the HEAD handle).

**Impossible if true:** A watch handle open on any path under `node_modules`, or the WALK opening a
handle inside `.git`, or a write inside an ignored working-tree directory scheduling a refresh; a
runtime-created symlink gaining a watch (or recursively watching its target); an `fs.watch`
callback exception escaping and terminating the process. (A
write to HEAD scheduling a refresh is the intended branch-reactivity path, not a violation.)

**Verification:** `bun test src/modules/git/__tests__/GitWatcher.test.ts`

**Status:** provisional

**Last refined:** 2026-07-21

### Commit expansion is lazy and windowed

**Invariant:** If a commit in the log is expanded inline, then its changed-file list was fetched on
demand for THAT sha alone (`git show --name-status --format=`), is retained in a hard-bounded
expanded set (expanding past the capacity collapses the oldest expansion, and collapse evicts the
files), and only the flat rows inside the visible window are ever rendered or consulted.

**Scope:** `CommitExpansion` (expanded set + lazy fetch + eviction), the flat row model in
`git.log-rows.ts`, and every consumer of it: `RootView.renderGitPanel`'s log region,
`Workspace.logRowAt`/`ensureLogWindow`/`activateLogRow`, and the log hit-tester/keyboard indices.

**Mechanism:** `CommitExpansion.expand` fetches one sha only after the user expands it, shows a
loading row until the fetch lands, and discards a result superseded by collapse/reset (per-sha
tickets); `expansionOrder` bounds the expanded set at `capacity` (default 32) by collapsing the
oldest; `commitLogRows(flatStart, rowCount, …)` walks only the commits intersecting the window
plus the bounded expanded set, with unfetched commit records degrading to placeholder headers.

**Generates:** VS Code-style inline drill-down over a 10k-commit log at O(window) cost; a single
flat row space shared by renderer, mouse hit-test, and keyboard selection; instant collapse with
no orphaned async writes.

**Evidence:** `src/modules/git/CommitExpansion.ts` (`expand`, `collapse`, capacity eviction);
`src/modules/git/git.log-rows.ts` (`commitLogRows`, `commitIndexAtFlatRow`, `totalFlatRows`);
`src/modules/git/CommitExpansion.test.ts` (lazy single-sha fetch, stale-collapse discard, bounded
eviction); `src/modules/git/git.log-rows.test.ts` (windowing across an expanded commit, loading
placeholder).

**Impossible if true:** Expanding one commit pre-fetching any other commit's files; an expanded
10k-commit log materializing rows beyond the visible window plus the bounded expanded set; a
collapse racing its own fetch and re-expanding from a stale result.

**Verification:** `bun test src/modules/git/CommitExpansion.test.ts src/modules/git/git.log-rows.test.ts`

**Status:** provisional

**Last refined:** 2026-07-21

### The commit log follows repository reality

**Invariant:** If the git panel is visible and the VIEWED ref's tip commit changes by any means
(an external commit from another terminal, a pull, a fast-forward, a rebase, an amend), then the
history list drops its cached pages and refetches the visible window within one reconcile cycle —
and while the panel is hidden the tip check spawns no subprocess at all.

**Scope:** `Workspace.reconcileLogTip` and its call sites: the `GitWatcher.onReconciled` hook
(every completed background reconcile — debounced event flush or the 5s floor) and the panel-open
catch-up in `Workspace.showSidebarView` / Bootstrap's `git.togglePanel`.

**Mechanism:** Poll the cheap invariant, never the expensive projection: the check compares the
viewed ref's real tip SHA against `CommitLog.loadedTipSha` (cache index 0 — what the pane
displays). Following HEAD reads `git.head`, which the status reconcile already carries (zero extra
subprocesses); viewing another local branch costs one `git rev-parse refs/heads/<branch>` — LOCAL
refs only, never a network fetch on a timer. Only a mismatch resets the log cache + the
index-keyed expansions and refetches the current window. `sidebarView !== 'git'` returns before
any probe (cost tracks the actively observed set); a stale cache left behind is caught by the
panel-open catch-up.

**Generates:** External commits/pulls/rebases appearing in the history pane without reopening it;
no per-interval `git log` when nothing moved; no polling cost while the panel is hidden; the same
freshness for a viewed non-checked-out branch.

**Evidence:** `src/modules/workspace/Workspace.ts` (`reconcileLogTip`, `createGitWatcher`,
`showSidebarView`); `src/modules/git/GitWatcher.ts` (`flushRefresh`, `onReconciled` option);
`src/modules/git/CommitLog.ts` (`loadedTipSha`, `reset`); `onReconciled fires after a completed
background refresh and never after disposal` in `src/modules/git/__tests__/GitWatcher.test.ts`;
driven end-to-end by `scripts/smoke-git-log.sh` (external commit on HEAD and on the viewed
branch, no in-app action).

**Impossible if true:** The history pane still showing yesterday's tip after an external commit
while the panel sits open; a hidden git panel spawning tip probes on the reconcile interval; the
reconcile timer triggering a network fetch; an unchanged tip refetching the log window.

**Verification:** `bash scripts/smoke-git-log.sh`; `bun test src/modules/git`

**Status:** provisional

**Last refined:** 2026-07-24

### The log branch viewer is read-only

**Invariant:** If the commit pane shows another local branch's history, then every byte of that
view was produced by read commands parameterized on the ref (`log`, `show`, `rev-parse`,
`for-each-ref`) through the SAME virtualized log pipeline — the working tree, index, and HEAD are
never modified, and the non-HEAD view is always visibly labeled with a return path to HEAD.

**Scope:** `CommitLog.branch`/`setBranch`, `Workspace.selectLogBranch`/`cycleLogBranch`/
`localLogBranches`, the `history: <branch>` header in `GitPaneRenderer`, and the branch menu +
header hit-target in `Sidebar`.

**Mechanism:** The viewer re-sources `CommitLog` by ONE parameter (the ref) through the existing
offset-windowed fetch — no second log pipeline. `git switch`/`checkout` is OUT OF SCOPE for this
control by design: switching the working tree from a history dropdown would mutate the user's
files as a side effect of *looking*, so changing what HEAD points at is an impossibility for this
control, not a missing feature. Selecting the checked-out branch normalizes to HEAD-following;
Esc returns to HEAD before it leaves the panel; commit drill-down routes by SHA (`show <sha>`),
which resolves identically whatever is checked out.

**Generates:** Browsing any branch's history (and its commits' diffs) with zero risk to
uncommitted work; the header `history: <branch> (view only)` distinction; the tip-SHA freshness
check applying to the viewed ref.

**Evidence:** `src/modules/git/CommitLog.ts` (`branch`, `setBranch`, `fetchPage`);
`src/modules/git/GitCommands.ts` (`localBranches`, `revParse` — read-only argv, no mutation
verbs); `src/modules/workspace/Workspace.ts` (`selectLogBranch`, `cycleLogBranch`);
`src/modules/ui/GitPaneRenderer.ts` (the log header row); `src/modules/ui/Sidebar.ts`
(`openLogBranchMenu`); `setBranch re-sources the SAME pipeline` in
`src/modules/git/CommitLog.test.ts`; `scripts/smoke-git-log.sh` asserts `branch --show-current`,
`status --porcelain`, and `rev-parse HEAD` are byte-identical after a full view/return cycle.

**Impossible if true:** Selecting a branch in the viewer emitting `switch`, `checkout`, `reset`,
or any worktree mutation; the pane showing another branch's history without the header saying so;
a second, forked log implementation for non-HEAD refs.

**Verification:** `bash scripts/smoke-git-log.sh`; `bun test src/modules/git/CommitLog.test.ts`

**Status:** provisional

**Last refined:** 2026-07-24

### Destructive working-tree operations require confirmation

**Invariant:** If an operation destroys uncommitted work (discard a file's changes, clean an
untracked file), then it executes only after an EXPLICIT user confirmation distinct from the
triggering gesture — never on a single click or keypress.

**Scope:** every working-tree-destructive git action the UI offers (discard; future: branch
force-ops). Staging/unstaging are NOT destructive (fully reversible) and stay one-gesture.

**Mechanism:** the trigger (button/key) only ARMS `gitPanel.confirmDiscard`; a modal y/N overlay
renders; only 'y' runs `GitCommands.discard` (untracked → clean -f; staged → restore
--staged --worktree --source=HEAD; unstaged → restore); any other key cancels. Kin of the
delegation rule that deletions never ride in an automated pass.

**Generates:** safe exploration of the git panel; a reusable confirm pattern for later destructive
actions.

**Evidence:** `Workspace.requestDiscardAtRow` (arms) vs `Workspace.confirmDiscard` (executes);
Bootstrap's modal intercept; live-verified n-cancels / y-discards on a scratch repository.

**Impossible if true:** a single gesture that irreversibly destroys uncommitted work; a discard
path that bypasses the overlay.

**Verification:** tmux — 'd' → overlay visible, 'n' → file unchanged; 'y' → file restored (scratch
repo only).

**Status:** provisional

**Last refined:** 2026-07-21

### Current-line blame is a cached lookup, not a per-move git spawn

**Invariant:** Blaming a file is a git subprocess, but moving the cursor is a pure map lookup. The
WORKSPACE-OWNED `GitBlameCache` blames a tracked file ONCE and caches the per-line authorship map
keyed on the file's on-disk mtime; a cursor move on an already-blamed file spawns nothing. A save
(mtime change) invalidates the entry and re-blames; a repeated non-tracked result is cached (empty
map) so it never re-spawns every frame. The cache is BOUNDED (LRU over at most `MAX_BLAMED_FILES`
files — blame memory tracks the actively observed set, never every file ever visited) and is
DISPOSED with its workspace (suspend/close), making any in-flight load inert. The on-disk stat is
memoized within one paint tick, so the status bar and the status side-channel querying in the same
frame cost one stat.

**Scope:** `GitBlameCache` (the instance `Workspace` creates in `open()` and disposes in
`suspendOwnedResources`/`dispose`), `Workspace.activeLineBlame` (the single query surface),
`GitBlame.parsePorcelain` (pure parsing), `GitCommands.blamePorcelain`, `Files.mtimeMs`.

**Mechanism:** `lineBlame` reads the memoized mtime; a cache hit (same mtime) returns
`lines.get(cursorLine + 1)` with no spawn and refreshes the entry's LRU recency. A miss kicks a
one-shot async load (guarded by an in-flight set), which runs `git blame --porcelain` through the
`Processes` seam, parses via the stateless `GitBlame` capability, stores the map under that mtime
(evicting the coldest file beyond the bound), and bumps a reactive `revision` the status bar reads
— so blame appears without a keystroke, and an idle session (no cursor move, no save) spawns
nothing and stays quiescent. Disposal clears the maps and discards any load that lands after it.

**Generates:** GitLens-style current-line authorship with zero per-move cost; one git spawn per
file version, amortized across every line; bounded long-session memory; no blame state outliving
its workspace.

**Evidence:** `src/modules/git/GitBlameCache.ts` (`lineBlame`, `storeBounded`, `dispose`,
`statMemoizedMtime`); `src/modules/git/GitBlameCache.test.ts` (cache hit spawns nothing, mtime
invalidation, negative caching, LRU bound, stat memo, disposal inertness);
`src/modules/git/GitBlame.test.ts` (the porcelain parser: metadata reused across a commit's hunks,
1-based line map); `src/modules/workspace/Workspace.ts` (`createGitBlameCache`, `activeLineBlame`,
the suspend/dispose wiring); `scripts/smoke-git-blame.sh` (cursor on a committed line shows its
author in the status bar; the git spawn happens once and later moves are instant).

**Impossible if true:** a git subprocess per cursor move; a stale blame surviving a save; a
non-git file re-spawning `git blame` every frame; blame maps for every file ever visited retained
for the process lifetime; a suspended workspace holding live blame memory; module-level mutable
blame state hiding behind a Static facade.

**Verification:** `bun test src/modules/git/GitBlameCache.test.ts src/modules/git/GitBlame.test.ts && bash scripts/smoke-git-blame.sh`

**Status:** provisional

**Last refined:** 2026-07-24

### An unblamable file degrades to no blame, never an error

**Invariant:** A document that cannot be blamed — no git repository, an untracked file, or an unsaved
buffer with no path on disk — shows NO blame part and never raises an error. `git blame` exiting nonzero
is data (an empty cached map), not an exception.

**Scope:** `GitBlameCache.lineBlame`/`loadBlame`, and the `StatusBar` blame part that omits itself on a null
result.

**Mechanism:** `lineBlame` returns null when the cache is disposed, the path is empty, or the file is not on
disk (`mtimeMs === 0`). `loadBlame` caches an empty map on a nonzero git exit or any thrown error, so
the negative result is remembered. `StatusBar.currentLineBlamePart` returns `''` for a null blame and
pushes no part.

**Generates:** a status bar identical to today's for non-git and scratch files; a feature that is purely
additive where git applies and invisible where it does not.

**Evidence:** `src/modules/git/GitBlame.test.ts` (empty/non-blame output → empty map, no throw);
`src/modules/git/GitBlameCache.test.ts` (a failed blame is negatively cached — no per-frame respawn);
`scripts/smoke-git-blame.sh` (a file outside any repo shows no blame part).

**Impossible if true:** a blame part on a non-git document; an unsaved buffer triggering a blame error;
a thrown exception from a failed `git blame`.

**Verification:** `bun test src/modules/git/GitBlame.test.ts && bash scripts/smoke-git-blame.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### A relative time reads in the largest fitting unit

**Invariant:** `RelativeTime.format` renders an age in exactly one coarse unit — the largest that fits
(just now → minutes → hours → days → weeks → months → years) — with correct singular/plural, and a
future/equal instant reads "just now" (clock skew never yields a negative age). It is pure: the caller
supplies `nowMs`, so there is no ambient clock and the output is deterministic.

**Scope:** `RelativeTime.format` (pure), its one caller `StatusBar.currentLineBlamePart`.

**Mechanism:** `format(fromMs, nowMs)` computes `nowMs - fromMs` and returns the first bucket it fits,
rounding to a whole count of that unit (minimum 1) and pluralizing on `!== 1`. A negative elapsed falls
into the sub-45s bucket → "just now".

**Generates:** a compact, human relative date for the blame part; deterministic, unit-testable output.

**Evidence:** `src/modules/git/RelativeTime.test.ts` (every bucket boundary, singular vs plural, and the
clock-skew "just now" case).

**Impossible if true:** a relative time in mixed units ("1 day 3 hours"); a negative age; "1 minutes".

**Verification:** `bun test src/modules/git/RelativeTime.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23
