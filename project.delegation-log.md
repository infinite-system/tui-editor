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

## In-flight status @ compaction checkpoint (HEAD 6fc0858)

- **0 workers in flight.** All prior codex/subagent delegations merged or closed. The 4 merged
  capability workers (perf-baselines, word-wrap, context-menu, wheel-momentum-parity) + the diff-core
  codex worker are all landed/merged. No detached `codex exec` running.
- **NEXT to delegate (post-resume, per the budget rule — codex = default worker, Invar/opus only for
  hard reasoning, keep concurrent Invar count MODEST):** SEARCH SUITE = 4 codex workers (fuzzy
  quick-open reusing CommandScoring.fuzzyScore; in-file find/replace; ripgrep find-in-files panel;
  project-wide replace) — isolated new-file capability builds, ideal for codex. The dead-setting wiring
  fixes (wordWrap/gitSplitRatio), the scrollbar panes, the splitter drag, and the git-panel row
  simplification are RootView/cross-module integration = MAIN LOOP (mine), not delegated.
- Before delegating: `git commit` first (codex not trusted with deletions); one `codex exec` per
  worktree, no shell `&`; review against contract + tsc + tests before merging.

| 6 | codex (worktree `codex-theme`) | Wire theme + glyphMode settings (Theme.ts + Bootstrap hook ONLY) | P2 / theme | ~2% | **DEPRECATED** | **fail (scope)** | Went far out of scope: touched 11 files incl. RootView.ts (explicitly forbidden), keybindings, GitRows, OpenBufferSet — AND conflated in item-4 git-panel row simplification (checkboxIcons→gitStatusIcons) which was never assigned. Also worked from the STALE worktree base (dbc3886), so its RootView/Workspace would clobber my 7 newer commits. Killed (exit 144), worktree discarded, redone by the main loop. |

**Delegation lesson (theme, DEPRECATED):** two failures compounded. (1) A tightly-scoped spec ("touch
ONLY Theme.ts + a Bootstrap hook, DO NOT touch RootView") did NOT hold codex — it sprawled into 11
files and pulled in an UNASSIGNED adjacent task (row simplification). codex treats scope fences as
suggestions. (2) Delegating ANY task whose natural solution touches a file the main loop is ACTIVELY
editing (RootView) is a mistake even when the spec forbids it — the worktree base goes stale under my
commits, so a merge would clobber. RULE: while the main loop owns + actively edits RootView, do not
delegate settings/wiring work that lives near it; delegate only genuinely DISJOINT leaf modules, and
prefer Invar subagents (which honor scope better) over codex for anything requiring judgment about what
NOT to touch. This reinforces the pre-existing "SERIALIZE RootView, PARALLELIZE disjoint" rule.

## Full-power checkpoint @ HEAD 3451999 (2026-07-21)

- **0 workers of mine in flight.** This session I did NOT spawn codex/Invar workers — the capabilities
  came from the COORDINATOR's conductor-* worktrees (built cold-start, sanity-passed, handed to me to
  adopt). Nothing of mine to reconcile/orphan.
- **Coordinator's conductor-* branches** (adopt = merge→wire→driving-smoke in ONE commit under merge-gate):
  ADOPTED (committed, worktree removable): conductor-quickopen (b84e700), conductor-findbuffer (713623f),
  conductor-mapgate (c9aff34), conductor-builddoc (e871b7b). READY, NOT yet adopted: conductor-ripgrep
  (Search view), conductor-activitybar (ActivityBar, 5 tests), conductor-shortcuts (ShortcutsView, 5 tests).
- **On resume:** adopt the ready branches per project.handoff.md ADOPTION QUEUE; delegation rules unchanged
  (delegates never commit; main reviews+merges; codex never trusted with deletions; a worker's task whose
  natural solution touches actively-edited RootView must NOT be delegated — SERIALIZE RootView, mine).
- **When to fan out (per the coordinator's full-power directive):** the DISJOINT judgment-heavy work — the
  5 invariants.md bootstraps (kernel/storage/syntax/theme/commands, Invar workers, gate via
  check_invariants.mjs) — is the prime fan-out candidate; RootView wiring stays serial/mine.

- feat-two-line-tabs-v2 · tip d15b454 · merged-into main (d15b454) · 2026-07-23 · task 0.5 two-line workspace tabs (project name / worktree-or-branch); smoke height-robustness applied

- feat-pull-diagnostics · tip a750a85 · merged-into main (a750a85) · 2026-07-23 · tsgo pull-diagnostics (textDocument/diagnostic) so red-squiggly errors show under the tsgo default; drive-verified tsgo pull + tsserver push; new invariant; finished/ tag pushed
- codex workers · DEPRECATED 2026-07-23 · "You've hit your usage limit ... try again Jul 28th 2026" — codex exec unusable until 2026-07-28; use fable/claude subagents (conductor-spawned) instead
- feat-diff-prefix · DEAD-ON-ARRIVAL · empty branch off origin/main (d2a186e); codex worker quota-failed before any commit; branch PRESERVED per guardrail, no work on it

- feat-diff-batch · tip af9573f · merged-into main (af9573f) · 2026-07-23 · diff +/- line prefixes (task 1) + blank buffer tabs in diff view (task 6); finished/ tag pushed
- feat-tooltip-bundle · tip 002d50a · merged-into main (002d50a) · 2026-07-23 · hover card surfaces the DIAGNOSTIC message (not just `any`): Workspace.diagnosticsAt(position) + HoverCard renders severity-coloured diag lines above the type sig; new hover-diag smoke (tsgo pull + tsserver push, ALL-PASS); drag-select "regression" DISPROVEN in-harness (smoke-hover:159–183 green — the ScrollableTextViewport migration did NOT orphan the content hit-test); finished/ tag pushed. Follow-ups queued: last-char off-by-one (own batch), macOS Terminal.app mouse-protocol (SGR/1006 vs X10) chase.
