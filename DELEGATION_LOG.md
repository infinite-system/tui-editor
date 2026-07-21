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

## Running tally

- Agents launched: **1** · completed: **1** · deprecated: **0**
- Estimated build share delegated so far: **~2%** (M0 architecture study)

_Percentages are rough estimates of each task's share of total build effort; updated as work lands._
