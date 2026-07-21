# Delegation Log

Live ledger of work delegated to subagents (claude) and codex, so the main loop stays lean
and the human can see who did what. Reported at every milestone check-in.

**Executors:** `claude:general-purpose` (subagent) · `codex` (`--dangerously-bypass-approvals-and-sandbox`, driven directly or via `agent-tmux.sh`). codex is fast — favor it for well-scoped implementation.

**codex deletion guardrail:** codex runs in bypass mode and must NOT be trusted with deletions. Always `git commit` before delegating to it; scope its tasks to specific file writes (never "clean up"/"remove"/"refactor the tree"); keep all deletions in the main loop; `git status`/`git diff` its output before accepting, watching for unexpected removals.

**Status:** running · completed · failed · **deprecated** (work was sub-par — dropped, task
re-done by the main loop or a fresh agent, never patched around).

**Quality gate:** every delegated output is reviewed against its module `*.invariants.md`
contract before it counts. Sub-par = fails contract review, ignores the spec, or introduces
defects the verification layers catch. A deprecated agent's output is discarded, not salvaged.

| # | Executor | Task | Milestone / module | Share of build | Status | Quality | Notes |
|---|----------|------|--------------------|----------------|--------|---------|-------|
| 1 | claude:general-purpose | Study ivue docs → code-level architecture reference | M0 / architecture | ~2% | completed | **pass (high)** | Grounded the contracts; caught 3 real corrections (vue runtime dep; Static/kernel not in package → vendor; `createX()` is ours not ivue's). Reviewed against `../ivue` source + smoke test. |
| — | **`/fork` (Claude Code quirk)** | Autonomously built M1–M3 ungoverned, in background, resurrecting several times until goal cleared | M1–M3 / app,kernel,system,editor,workspace,theme,syntax | ~25% | stopped by user | **pending review** | Committed working code (M2 base: tsc clean, 27/27 tests). NOT contract-governed — must be invariant-reviewed + contracts back-filled before it counts. |
| 2 | codex (worktree `codex/git`) | Build `git` module (M4) + `git.invariants.md` + tests | M4 / git | ~8% | running | — | Isolated worktree; task `bp48klg6r` |
| 3 | codex (worktree `codex/markdown`) | Build `markdown` module (M6) + contract + tests | M6 / markdown | ~6% | running | — | Isolated worktree; task `b17offsd1` |
| 4 | codex (worktree `codex/lsp`) | Build `lsp` module (M5) + contract + tests | M5 / lsp | ~8% | running | — | Isolated worktree; task `b0825yloe` |

## Running tally

- Agents launched: **4** (1 study, 3 codex) + 1 rogue fork · completed: **1** · running: **3** · deprecated: **0**
- Delegated build share so far: fork ~25% (M1–M3, pending review) + codex ~22% in flight (M4/M5/M6)
- Model: fork built the editor core fast but ungoverned; codex now builds forward modules governed (own worktree, own contract, reviewed before merge).

_Percentages are rough estimates of each task's share of total build effort; updated as work lands._

| 5 | codex (worktree `codex/selection`) | Root-cause the selection-render coord bug | selection / ui | ~254k tok | DONE — confirmed root cause (FrameProbe read bg as 1 val/cell; OpenTUI = 4 RGBA lanes/cell; native render was correct). Changes: remove gate + doc comments. REVIEWED: independently reproduced with fixed FrameProbe; applied equivalent minimal fix in main tree (which also carries the FrameProbe stride fix codex only worked around in its verify script). Merged conceptually (not cp'd — main tree had the real tool fix). Worktree removed. | 43cb602 | Good delegation: precise scoped probe + FrameProbe oracle; codex reached correct root cause. Credited co-author. |

**Delegation lesson (selection):** the value here was codex as an INDEPENDENT cross-check on a
diagnosis, not as a builder — it confirmed the real bug was in our verification tool (FrameProbe), not
the code under test. Reinforces: when a visual/oracle-based verdict looks like a deep bug, suspect the
oracle's decode of the substrate first. Also: give codex the exact repro + the source-of-truth files;
it correctly read the OpenTUI Zig + compiled buffer source to find the 4-lane layout.
