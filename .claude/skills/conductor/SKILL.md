---
name: conductor
description: >-
  Orchestration protocol for running multi-agent builds reliably — the conductor role.
  Use when coordinating a fork + builder agents (codex/claude/fable) across a backlog of
  tasks: delegating scoped work, keeping agents alive/visible, protecting merges, verifying
  by driving, and staying resilient across compaction. Covers when to delegate vs self-do,
  what to do when BLOCKED (bring in codex/fable before deferring to the user), and the
  merge-safety + liveness invariants that cost real time when missed. The running,
  append-only detail lives in the repo root at `project.conductor.md`; this file is the doctrine.
---

# Conductor — multi-agent build orchestration

The conductor is the architect / reviewer / integrator that stays out of the implementation
weeds so its context survives a long build. It delegates scoped chunks, reviews output against
contracts, protects the merge line, keeps the fleet alive and visible, and reconstructs state
from disk (never from a dropped summary). The role is real work worth naming — this skill
codifies it so it is not re-improvised each run.

**Evolving detail:** the empirical, run-by-run lessons accrete in
`project.conductor.md` (repo root). Read it before a run; append to it during one.
This SKILL.md is the stable doctrine; that file is the changelog.

## When to use
Any build with a fork/conductor coordinating one or more builder agents over a task backlog —
e.g. the Invar (tui-editor) UI-task runs. Not needed for a single-shot task you do yourself.

## Delegation doctrine
- **Delegate scoped chunks, self-do the critical/hard/failed work.** Hand well-specified
  modules to subagents (claude general-purpose) and to **codex** (fast, runs auto/yolo). Keep
  the conductor's own reasoning for architecture, integration, and anything an agent stalls on.
- **Spec each chunk crisply.** For governed code, the spec IS the module's `*.invariants.md`
  contract + design. Review every agent's output against that contract before it counts as
  done — validate by RUNNING it (drive the real path), not by reading it.
- **Ledger + prune.** Track delegated tasks (who launched, who finished, rough effort share);
  report the tally at each milestone. **Deprecate any sub-par agent** — discard its work, don't
  patch around it; redo with the conductor or a fresh agent. Sub-par = fails contract review,
  ignores spec, or introduces defects.
- **codex guardrails.** codex must NOT be trusted with deletions (it can delete by mistake):
  commit to git BEFORE handing it work; scope it to specific files/writes, never
  "clean up"/"refactor the tree"; keep all `rm`/deletions to the conductor; `git status`/`diff`
  its output before accepting.

## Priming delegated agents (anti-telephone)
IBR and the repo's ivue / invariants conventions **decay when relayed turn-over-turn in task
prose** — the "bad telephone" failure. Do NOT re-explain them per task. **Prime every agent that
touches governed code with the repo's own skill files at spawn**, from a single source of truth
(never a copy — copies drift):
- **IBR framework:** `.claude/skills/ibr/IBR.md` (repo-local, reusable by anyone).
- **Conventions:** the `.claude/skills/ivue/` and `.claude/skills/invariants/` skills, plus
  `project.conventions.md` / `project.ivue-reference.md`.
- `AGENTS.md` at the repo root points at all of the above (and codex auto-reads it).

Prime by agent type:
- **claude-lineage via CLI** (`claude …`): `--append-system-prompt-file=.claude/skills/ibr/IBR.md`
  so IBR is in the *system prompt*, not the task body. It auto-reads `CLAUDE.md`; open the task
  prompt by telling it to load the `/ivue` + `/invariants` skills (or read
  `project.conventions.md`) for conventions.
- **claude-lineage via the in-harness Agent tool** (no system-prompt-file flag): open the task
  prompt with an explicit *"Read `.claude/skills/ibr/IBR.md` and the `/ivue` + `/invariants`
  skill docs in full before any governed work; reason with IBR."* — the Read-first line is the
  in-harness stand-in for the flag.
- **codex:** auto-reads `AGENTS.md` at the repo root (keep it present + pointing at the skills).
  For governed-code tasks, ALSO prepend the IBR file as codex's opening context
  (`cat .claude/skills/ibr/IBR.md` into the first prompt) — codex has no system-prompt-file flag.
- **fable:** same as claude-lineage.

**Exception:** a purely mechanical, non-governed chunk (e.g. a shell smoke-script coordinate fix
touching no `src/`) does not need the full prime — but when in doubt, prime. State in the spec
which case it is, so the agent isn't needlessly loaded or dangerously under-briefed.

## When BLOCKED — delegate before deferring
If a task is stuck (an agent can't crack it, the fix is ambiguous, or it's a genuinely hard
problem), **do NOT default to escalating to the user.** Spin up a **codex or fable** subagent
and have it reach a solution creatively. Only escalate to the user when the subagents also fail
OR the decision is genuinely theirs (naming, scope, publish consent, irreversible/outward
actions). `fable` = a subagent on the `claude-fable-5` model (the ivue-rooter model).

**Fork caveat:** a background FORK cannot spawn subagents (its boilerplate forbids the Agent
tool). So a blocked fork reports UP to the conductor, and the conductor brings in codex/fable.
This delegate-when-blocked rule is wired into the hourly orchestration loop.

## Merge safety (each of these cost real time when missed)
- **Commit before gating.** A green gate on an uncommitted/staged tree is NOT durable —
  `git worktree remove --force` discards it (this lost a whole task's work once). The commit is
  the safe signal.
- **Gate the COMBINED tree.** A branch cut from an OLD main must `git merge main` FIRST, then
  gate — otherwise you validate the wrong (stale-base) code. Confirm `git diff --name-only
  main..HEAD` shows only that task's files.
- **Count ROOT gates** (a real `merge-gate.sh` process), never `pgrep -c` name-match — transient
  smoke children inflate the count and cause false cap-1 self-blocks. When gates run as tracked
  background children they don't reparent to ppid=1 either, so **gate-LOG step activity is the
  authoritative liveness signal**, not process topology.
- **One checkout, one writer.** Worktree-per-writer is mandatory for concurrent agents. The main
  session and its own fork writing the same checkout collide (renames swept into the wrong
  commit). Give each agent a topology note at spawn (who you are, who your children are, who
  commits, who else writes here).
- **Advance main safely** when it isn't checked out in a worktree: `git update-ref
  refs/heads/main <new> <expected-old>` (CAS fast-forward), so the fork's working tree stays put.
- **Untracked files don't travel with `git merge`.** Before merging an agent branch,
  `git status` its worktree + `git add -A` — a SKIP is not a PASS.

## Liveness & visibility
- **Verify, don't assume.** Key on fork-specific evidence only: worktree writes in the last
  cycle, gate-log transitions, new branch/main commits, builder tmux sessions. NEVER treat the
  user's own interactive instances as fork liveness, and never kill them.
- **Tracked background, never nohup.** Run every gate/long command as a TRACKED background child
  (the harness re-invokes you on completion and keeps you visible in /tasks). `nohup … &` leaves
  you with no live children and the harness drops you from view.
- **Cap concurrency ~2–3 builders, ONE gate at a time.** 3+ concurrent gates starve CPU and
  flake load-sensitive smokes (e.g. word-wrap caret timing). Over-spawn → tell the fleet to cap.
- **Heartbeat over PID-watching.** PIDs rotate every turn; give long workers a heartbeat artifact
  (phase + last-progress timestamp + done-flag) so "still building" ≠ "done-and-stranded" ≠
  "crashed". File mtimes are the fallback read.

## Compaction resilience
Long autonomous runs must survive context compaction. Keep a `HANDOFF.md` with a
`MUST RE-READ ON RESUME` ordered doc list, refreshed every few turns by **reconstructing from
disk** (git log, gate logs, worktree state), not from the dropped summary. A parent can't see a
child's context %; detection is behavioral (re-reads, re-litigation) or self-reported. A parent
CAN force-compact a child on a chosen boundary by sending a message whose content *begins with*
`/compact <focus>` (a background agent can't self-invoke it).

## Verify by driving
Verify EVERYTHING by driving the real user path (tmux harness + frame probe), never internal
values. Reproduce before diagnosing. Ratchet a verified behavior into a gated smoke so it can't
silently regress.

## Loop shape (the hourly orchestration cron)
1. **Drain the real backlog first** — the task list (HANDOFF → the numbered UI tasks → polish
   requests → follow-ups). Ensure the fork is driving each unfinished task; nudge or take over.
   No creative experiment while any core task is unmerged.
2. **If blocked** → codex/fable before deferring (see above).
3. **Only once drained** → invent + run ONE creative parity experiment on an `experiment-*`
   branch cut from latest main, gated. **NEVER merge experiments to main.**
4. Append lessons to `project.conductor.md` (repo root).
5. Keep the fleet alive; sync local main to origin/main (clean ff). Report concisely.
