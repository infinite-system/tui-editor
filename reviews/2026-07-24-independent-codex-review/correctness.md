# Correctness review

Found **6 FATAL**, **8 SCOPING**, and **1 FLAG** correctness defects.

## FATAL

### 1. Agent repaint signal can cancel itself and leave a finished turn visually “working”

**Location:** [AgentPaneContent.ts:129](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:129), [AgentPaneContent.ts:137](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:137), [AgentSession.ts:162](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:162)

**Scenario:** `renderRevision` is the arithmetic sum of several revisions. If a turn ends after exactly one spinner tick, `session.renderRevision` increases by one while `spinner.stop()` changes the frame from 1 to 0. The sum is unchanged, so Vue does not rerun the coarse paint effect. The last frame can continue showing “working…” until unrelated input arrives. Reproduced with `renderRevision` remaining `2 → 2` while session status became idle.

**Severity:** FATAL — breaks the coarse-frame repaint claim.

**Fix sketch:** Fuse sources through a monotonic revision bump or direct dependencies whose simultaneous changes cannot numerically cancel.

### 2. Superseding a visible Kitty placement can delete the pending ID instead of the visible one

**Location:** [PixelImageMount.ts:81](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:81), [PixelImageMount.ts:99](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:99), [PixelImageMount.ts:106](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:106), [PixelImageMount.ts:114](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:114)

**Scenario:** Image `7001` is visible. A replacement for `7002` is queued until frames settle, but the mount immediately records `7002` as placed. Calling `clear()` before settlement cancels the queued payload—which contained `REMOVE[7001]`—and emits only `REMOVE[7002]`. The visible `7001` survives on screen. The direct reproduction produced `["REMOVE[7002]"]`.

**Severity:** FATAL — violates explicit placement deletion and buffer-switch cleanup.

**Fix sketch:** Track emitted placement separately from pending placement and commit the new ID only when its winning payload is written.

### 3. Current Codex permission requests can be deliberately left unanswered

**Location:** [CodexAppServerMapping.ts:111](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerMapping.ts:111), [CodexAppServerBackend.ts:185](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:185)

**Scenario:** The installed Codex 0.144.6 protocol includes `item/permissions/requestApproval`, used for additional filesystem/network permissions. `approvalOf()` recognizes only command-execution and file-change approval methods, returns `null` for this request, and the backend intentionally sends no JSON-RPC response. The operation therefore waits for a timeout/fail-safe denial and never reaches Invar’s y/n/a prompt.

**Severity:** FATAL — `supportsPermissionPrompts` is claimed true, but a current approval path cannot complete interactively.

**Fix sketch:** Map the granular permissions request and always answer every server request with either a valid result or JSON-RPC error.

### 4. Agent wrapping measures code points as terminal cells

**Location:** [WrapText.ts:10](/home/parallels/dev/tui-editor/src/modules/ui/WrapText.ts:10), [AgentComposer.ts:171](/home/parallels/dev/tui-editor/src/modules/agent/AgentComposer.ts:171), [AgentTranscriptProjection.ts:48](/home/parallels/dev/tui-editor/src/modules/agent/AgentTranscriptProjection.ts:48)

**Scenario:** At width 4, `界界界` is treated as three columns and left on one row, although it occupies six terminal cells. It overflows into an adjacent pane, while the composer reports the caret at column 3 instead of 6. Combining characters can also be split across wrap boundaries.

**Severity:** FATAL — breaks the stated “never overflow horizontally” behavior and terminal-coordinate contract.

**Fix sketch:** Wrap and truncate grapheme clusters using terminal display width, with caret mapping derived from the same cell-prefix table.

### 5. Selection columns are documented as grapheme offsets but applied as UTF-16 offsets

**Location:** [TextSelectionModel.ts:11](/home/parallels/dev/tui-editor/src/modules/ui/TextSelectionModel.ts:11), [TextSelectionModel.ts:93](/home/parallels/dev/tui-editor/src/modules/ui/TextSelectionModel.ts:93), [AgentPaneContent.ts:557](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:557), [AgentPaneRenderer.ts:57](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneRenderer.ts:57)

**Scenario:** Selecting the one-cell grapheme `é` over columns `[0,1)` copies only `"e"` because `String.slice()` interprets the endpoint as a UTF-16 unit. An emoji selection can produce a lone surrogate. Highlight slicing is corrupted through the same path.

**Severity:** FATAL — directly violates the explicit text-encoding/selection invariant.

**Fix sketch:** Convert display/grapheme columns to UTF-16 boundaries before slicing and stop using `.length` as a grapheme count.

### 6. Runtime-created symlinks bypass the watcher’s non-following rule and can throw from the callback

**Location:** [GitWatcher.ts:203](/home/parallels/dev/tui-editor/src/modules/git/GitWatcher.ts:203), [GitWatcher.ts:214](/home/parallels/dev/tui-editor/src/modules/git/GitWatcher.ts:214), [GitWatcher.ts:217](/home/parallels/dev/tui-editor/src/modules/git/GitWatcher.ts:217)

**Scenario:** Initial traversal uses `Dirent.isDirectory()` and does not follow symlinks, but a newly created entry is checked with `statSync()`, which follows them. A dynamic alias to `.git` or an external tree is recursively watched. A self-referential symlink can make `statSync()` throw `ELOOP` from an unguarded `fs.watch` callback, potentially terminating the process.

**Severity:** FATAL — breaks the explicit watcher-boundary/resource claim and exposes an unhandled callback exception.

**Fix sketch:** Use guarded `lstatSync()` and reject symbolic links before ignore checking or recursion.

## SCOPING

### 7. The global agent remains bound to the workspace where it was first opened

**Location:** [Bootstrap.ts:238](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:238), [Bootstrap.ts:301](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:301), [Bootstrap.ts:306](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:306), [WorkspaceSet.ts:88](/home/parallels/dev/tui-editor/src/modules/workspace/WorkspaceSet.ts:88)

**Scenario:** Open the agent in workspace A, switch to workspace B, then ask it to edit the current project. The one global pane/backend still uses A as its cwd and can modify the wrong repository. Cycling engines happens to rebuild against the current root, but ordinary workspace switching does not.

**Severity:** SCOPING — correct only while the initially active workspace never changes.

**Fix sketch:** Make backend ownership workspace-scoped or swap its cwd/backend when the active workspace changes at rest.

### 8. Codex app-server exit leaves an unusable thread ID and unresolved RPCs

**Location:** [CodexAppServerBackend.ts:102](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:102), [CodexAppServerBackend.ts:118](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:118), [CodexAppServerBackend.ts:141](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:141), [CodexAppServerBackend.ts:248](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:248)

**Scenario:** After a successful turn, the app-server crashes while idle. Its exit handler clears `child` but not `threadId`. The next send launches a new server, skips `thread/start`, and submits the old process’s thread ID. If it dies during a request, that RPC promise also remains permanently in `pendingRequests`.

**Severity:** SCOPING — recovery works only if the long-lived app-server never exits.

**Fix sketch:** On exit, identity-check the child, clear the thread, and reject and clear every pending request.

### 9. Claude SDK stream exceptions are reported as successful completion

**Location:** [SdkStreamBackend.ts:117](/home/parallels/dev/tui-editor/src/modules/agent/SdkStreamBackend.ts:117), [SdkStreamBackend.ts:122](/home/parallels/dev/tui-editor/src/modules/agent/SdkStreamBackend.ts:122)

**Scenario:** If SDK iteration throws because of transport, authentication, or CLI failure, the backend emits an error and then emits `session-end: completed`. `AgentSession` consequently returns to idle instead of ended/error. Reproduced event sequence: `error("transport failed")`, then `session-end("completed")`.

**Severity:** SCOPING — status is truthful only when the stream terminates normally.

**Fix sketch:** Record the caught failure and synthesize `reason: "error"`.

### 10. Pressing Enter while busy destroys an unsent follow-up draft

**Location:** [AgentPaneContent.ts:425](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:425), [AgentSession.ts:108](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:108)

**Scenario:** While a turn is streaming, type a follow-up and press Enter. `AgentSession.send()` ignores it because `busy` is true, but the pane unconditionally clears the composer. Reproduced with backend sends remaining `["a"]` while draft `"b"` changed to `""`.

**Severity:** SCOPING — submission is lossless only while the session is idle.

**Fix sketch:** Return whether `send()` accepted the prompt and clear/re-anchor only on acceptance.

### 11. A stale branch-tip probe can override the newly selected branch

**Location:** [Workspace.ts:743](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:743), [Workspace.ts:753](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:753), [Workspace.ts:755](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:755)

**Scenario:** A probe starts for viewed branch A. The user switches the viewer to B while `rev-parse A` is running. If A disappears, its late failure calls `selectLogBranch(null)` and forces the user from B back to HEAD. A successful late A result can instead reset B’s cache and expansions.

**Severity:** SCOPING — tip reconciliation is correct only if the viewed branch remains unchanged during the await.

**Fix sketch:** Capture a request token and branch identity, then recheck branch, log instance, and visibility after the await.

### 12. Concurrent diff opens apply in completion order rather than click order

**Location:** [Workspace.ts:844](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:844), [Workspace.ts:848](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:848), [Workspace.ts:1025](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:1025), [Workspace.ts:1043](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:1043)

**Scenario:** Click slow diff X and then fast diff Y. Y opens first; X finishes later and overwrites the editor with the older selection. Both commit-file and working-change entry points lack a request token before their awaits.

**Severity:** SCOPING — newest-user-intent behavior holds only when diff requests do not overlap.

**Fix sketch:** Allocate a diff-open token at request start and verify it before calling `openDiffView()`.

### 13. Sixel placement cache ignores changes in terminal cell pixel dimensions

**Location:** [PixelImageMount.ts:65](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:65), [PixelImageMount.ts:75](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:75), [PixelImageMount.ts:89](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:89), [RootView.ts:1313](/home/parallels/dev/tui-editor/src/modules/ui/RootView.ts:1313)

**Scenario:** A square image in a 10×10-cell region produces the same fitted cell rectangle when cell size changes from 10×20 to 20×40, but the required Sixel raster changes from 100×100 to 200×200 pixels. Because pixel dimensions are absent from `placementKey`, no second payload is emitted. Reproduced with only the original 100×100 placement written.

**Severity:** SCOPING — cache correctness assumes cell pixel dimensions never change independently.

**Fix sketch:** Include fitted pixel width and height, or raw cell pixel dimensions, in the placement key for pixel-sized tiers.

### 14. A failed `git log` is cached as end-of-history

**Location:** [CommitLog.ts:84](/home/parallels/dev/tui-editor/src/modules/git/CommitLog.ts:84), [CommitLog.ts:88](/home/parallels/dev/tui-editor/src/modules/git/CommitLog.ts:88), [CommitLog.ts:106](/home/parallels/dev/tui-editor/src/modules/git/CommitLog.ts:106)

**Scenario:** A transient nonzero `git log` result becomes `[]`; `ensureRange()` interprets that short page as genuine EOF and sets `knownEnd` to the requested offset, often zero. The panel displays an empty repository and stops rendering placeholders instead of exposing an error/retry state.

**Severity:** SCOPING — EOF inference is valid only when the command succeeded.

**Fix sketch:** Distinguish command failure from an empty successful page and never advance `knownEnd` on failure.

## FLAG

### 15. Git blame retains every visited file’s complete line map for process lifetime

**Location:** [GitBlame.ts:42](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:42), [GitBlame.ts:90](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:90), [GitBlame.ts:96](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:96), [GitBlame.ts:127](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:127)

**Scenario:** Visiting many large tracked files accumulates a full per-line blame map for each absolute path. Closing tabs and workspaces does not evict them. `clearCache()` exists but has no production caller, so retained memory grows with all files ever visited rather than the active set.

**Severity:** FLAG — long-session memory growth worth recording; not an immediate functional blocker.

**Fix sketch:** Add bounded/LRU ownership and evict entries when documents or workspaces become cold.

## Verification

- `bunx tsc --noEmit`: passed.
- Invariant checker: **0 problems**, 390 annotations and 38 lattice links resolved.
- Unit tests: **303 passed, 0 failed** across agent, image, git, workspace, WrapText, and TextSelectionModel.
- Direct Bun reproductions confirmed findings 1, 2, 4, 5, 9, 10, and 13.
- No repository files were modified. The pre-existing untracked `scratch-permission-test.txt` remains untouched.
- No merge gate or smoke script was run.

## Completeness note

Read completely: all production TypeScript under `src/modules/agent/`, `src/modules/image/`, and `src/modules/git/`; their invariant contracts; root/app/workspace/UI/editor contracts; and the relevant `Bootstrap`, `Workspace`, `WorkspaceSet`, `RootView`, `WrapText`, `TextSelectionModel`, and `EditorCoordinates` paths.

Read selectively rather than exhaustively: the remainder of large `Workspace.ts`, `RootView.ts`, and `Bootstrap.ts`.

Skipped: full audits of LSP, syntax, terminal emulation, narration, settings, theme, and unrelated UI/editor modules; prohibited tmux smoke and merge-gate paths.
