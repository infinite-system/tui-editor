# Verification Results

Traceability + evidence for the §5.1 completion gate. Each entry: procedure · expected · actual ·
evidence · pass/fail. Populated as milestones complete; artifacts under `artifacts/`.

## Gate status (see project.implementation-plan.md §5.1 + additions)
1. Traceability matrix — PENDING
2. Invariant checker `--all --refs` clean — GREEN (0 problems, 5 contracts) as of 080ed91
3. Resource-lifecycle audit — PENDING
4. Benchmarks recorded — PENDING
5. Independent subagent panel (no unresolved critical/high) — PENDING
6. Completeness critic dry ×2 — PENDING
7. **Large-project acceptance test (blackline) — PENDING** (see below; gate NOT green without it)

---

## Large-project acceptance test — blackline (REQUIRED for done)

**Isolation protocol (mandatory — never mutate the live checkout):**
- Do NOT open `/home/parallels/dev/blackline/blackline-app` directly.
- Create a throwaway worktree:
  `git -C /home/parallels/dev/blackline/blackline-app worktree add /home/parallels/dev/blackline/bl-tui-test HEAD`
- Point tui-editor at `/home/parallels/dev/blackline/bl-tui-test` only. All edits/saves land ONLY
  there. Revert/discard edits; `git -C .../blackline-app worktree remove --force .../bl-tui-test` when done.
- Verify before finishing that the real `blackline-app` working tree is unchanged
  (`git -C .../blackline-app status` clean / untouched by us).

**Drive under tmux; assert STATE from `artifacts/status.json`, pane capture for visual. Checks:**
1. **Files load at scale** — open a large `.ts`, a `.json`, and a `.md` from deep in the tree;
   content renders, highlighting applies, big files don't hang (flyweight viewport holds; assert
   render cost bounded, status.json bufferRevision/path update).
2. **Keyboard editing** — type, backspace/delete, newline, undo/redo, Ctrl+S; confirm the change
   hits disk IN THE WORKTREE (read the file back), then revert/discard so the worktree stays clean.
3. **Mouse interaction** — if OpenTUI reports pointer events, click to place cursor / select a file
   / focus a pane. Explicitly record any mouse affordance NOT supported by the terminal path — no
   silent gaps.
4. **Shortcut pane/page navigation** — editor → git page → files pane and back via keyboard only;
   every pane reachable by keyboard, focus visibly moves (status.json `focus`), no dead-ends.
5. **Folder expand/collapse** — expand + collapse nested directories in the tree on the big repo;
   lazy expansion works without loading the whole tree (assert listing calls only on expand).

**Result:** PENDING. Each failure → repair-loop item + standing regression scenario.
