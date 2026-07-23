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
- **Advance main — NEVER `update-ref` a branch checked out in ANY worktree.** Here `main` IS
  checked out in the primary `/home/parallels/dev/tui-editor` (the user runs Invar from there).
  `git update-ref refs/heads/main <new>` moves only the pointer and leaves that worktree's index +
  files on the OLD commit — a phantom "staged revert of the last merge" that also serves the user
  stale code (this bit us; `git reset --hard <new>` repaired it). Advance a checked-out branch by a
  merge that moves the files too: `git pull --ff-only` / `git merge --ff-only` IN that worktree, or
  merge in a separate worktree and push to origin. Reserve bare `update-ref` for a ref that
  `git worktree list` confirms is checked out NOWHERE.
- **Untracked files don't travel with `git merge`.** Before merging an agent branch,
  `git status` its worktree + `git add -A` — a SKIP is not a PASS.

## Never destroy recovery points (branches, worktrees, files)
Destructive git ops are irreversible and have already caused real data loss here (a
`git worktree remove --force` on an uncommitted tree discarded a whole task). **Preservation is
the DEFAULT; destruction requires explicit, per-instance user authorization.**
- **Never delete a branch** (`git branch -d/-D`) without the user explicitly OK'ing that specific
  branch. Not as cleanup, not because "it's merged", never as a side effect of finishing.
- **Never `git worktree remove --force`.** Plain `git worktree remove` (which refuses on a dirty
  tree) is allowed ONLY after verifying the branch's work is committed AND merged (tip reachable
  from `origin/main`) — and even then the BRANCH stays; you only reclaim the worktree's disk.
- **Never force-overwrite work:** no `git push --force[-with-lease]`; no `git reset --hard` /
  `git checkout -f` / `git clean` that discards uncommitted or unmerged changes; no `update-ref`
  that rewinds a branch. (A `reset --hard` to SYNC onto a commit that already contains all the
  work — zero loss — is fine; verify with `git status` first. When in doubt, `git stash`, don't
  discard.)
- **"Done" is a MARK, not a delete.** When a worktree/branch's task merges, record it finished and
  LEAVE it in place: `git tag finished/<branch> <merge-hash>` (an immutable recovery point,
  greppable via `git tag -l 'finished/*'`) and add a line to `project.delegation-log.md`
  (branch · tip · merged-into · date). Cleanup of accumulated finished branches happens ONLY in an
  explicit, user-authorized sweep — never inline, never automatic.

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

## Instantiating a fresh conductor (resume after context loss)
This skill (doctrine) + `project.conductor.md` (lessons) transfer the METHOD — but NOT the live
build state or the fleet. A clone needs all three. Read in this order:
1. `CLAUDE.md` → `AGENTS.md` → this skill → `project.conductor.md` (conventions, doctrine, lessons).
2. `project.handoff.md` (its TOP resume anchor = current status) → `project.progress.md` (task ledger).
3. Project frame: `project.brief.md`, `project.requirements.md` (the north star), `project.architecture.md`, and the `/ibr`, `/ivue`, `/invariants` skills.
4. **Ground-truth the docs against reality** — docs lag, git is authoritative: `git log --oneline -15 --all`, `git tag -l 'finished/*'`, `git worktree list`, `git status`.

**DURABLE vs EPHEMERAL — the load-bearing distinction for resume:**
- DURABLE (survives context loss, lives in the repo): commits, branches, `finished/*` tags, the
  `project.*.md` docs, the skills, `.claude/settings.json` guardrails.
- EPHEMERAL (dies with the session — must be RE-ESTABLISHED, never assumed alive): background
  agents (the fork + workers — their agent-IDs are gone; you cannot reattach, only respawn an
  equivalent for genuinely unfinished work), crons (loop-check + hourly — recreate via CronCreate),
  tmux harness sessions, and the session-local scratchpad HANDOFF.

On resume: read the anchor for what was in flight → verify each in-flight branch/worktree by git →
respawn missing crons → respawn a worker ONLY for unfinished work (never duplicate a live one) →
refresh `project.handoff.md`'s top anchor from disk every few turns so the NEXT clone starts from
truth. The scratchpad HANDOFF is a convenience mirror; the committed `project.handoff.md` is the
one a clone will actually find.

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
4. Append lessons to `project.conductor.md` (repo root); AND when a lesson generalizes into durable
   doctrine, **refine THIS skill** (`.claude/skills/conductor/SKILL.md`) and commit it — the loop is
   explicitly allowed to improve its own method (IBR self-application), including the verbatim cron
   prompts recorded below, which it keeps in sync.
5. Keep the fleet alive; sync local main to origin/main (clean ff). Report concisely.

## Live cron prompts (verbatim — the running loop's exact words)
These are the exact prompts driving this session's loops, recorded here so we can improve them
deliberately. **This skill may refine them** (step 4 above) — but a cron is a session-only,
in-memory snapshot: editing the text here does NOT change a running cron. Apply a change with
`CronDelete <id>` + `CronCreate`, then update the copy here to match. IDs drift on each recreate;
the words are the durable artifact.

### Hourly orchestration loop — `7 * * * *` (every hour at :07)

```
Hourly orchestration loop (bounded per fire). Follow the `/conductor` skill (tui-editor/.claude/skills/conductor/SKILL.md). Do in order:

(1) BACKLOG FIRST — before ANY creative experiment, read the active task list and drain real work. Sources of truth, in order: (a) project.handoff.md's top resume anchor + the scratchpad HANDOFF; (b) any open goal/TodoWrite list; (c) the fork's (a0f12abb2a300d596) reported remaining tasks. Requested UI/feature tasks and user requests come first. For each UNFINISHED task: confirm the fork/workers are actively driving it (worktree writes / gate activity / branch commits in the last cycle). If dormant or stalled, nudge via SendMessage with a precise fix, OR take it over and drive it yourself. Do NOT start a creative experiment while any requested task is unmerged.

(2) IF BLOCKED (fork stuck, ambiguous fix, or a hard problem) — do NOT default to deferring to the user. Spin up a codex or fable subagent (if the fork can't spawn, the conductor spawns one) and reach a solution creatively; only escalate to the user if the subagents also can't resolve it or the call is genuinely the user's (naming, scope, publish consent).

(3) ONLY once the real backlog is drained — invent + execute ONE creative IDE-parity experiment: reduce a real user need to its invariant, plan it, build on an experiment-* branch forked off LATEST main, gate it. NEVER merge experiments to main.

(4) Append orchestrator lessons learned this fire to /home/parallels/dev/tui-editor/project.conductor.md (the running lessons log). AND when a lesson generalizes into durable doctrine, REFINE the /conductor SKILL.md itself (tui-editor/.claude/skills/conductor/SKILL.md) and commit it — the stable doctrine is NOT frozen; the loop improving its own method is IBR self-application. If you edit the cron prompts, keep their verbatim copy in the skill in sync.

(5) Keep yourself, the fork, and its workers in working order — verify alive by fork-specific evidence (gate-log step activity is authoritative, NOT process/tmux counts; never kill tmux mid-gate). Cap builders ~2-3, ONE gate at a time. Verify by DRIVING the real user path. Keep local main synced to origin/main (clean ff; never update-ref a checked-out branch). Report concisely.
```

### 10-minute liveness check — `3,13,23,33,43,53 * * * *` (every 10 min)

```
Loop check (every 10 min): VERIFY — do not assume — that the fork orchestrator (agent a0f12abb2a300d596) and its builder agents are actually progressing on the 11 Invar UI tasks. IMPORTANT: the USER runs their OWN interactive Invar instances (from /home/parallels/dev/tui-editor and /tmp/tui-demo) — do NOT treat raw `src/main.ts` process count or instance age as a fork-liveness or hang signal, and NEVER kill a process from those paths. Key ONLY on FORK-SPECIFIC evidence: (1) writes in the fork's worktrees `/tmp/conductor-*` and `.claude/worktrees/agent-*` in the last ~10 min (`find /tmp/conductor-* /home/parallels/dev/tui-editor/.claude/worktrees/agent-* -newermt '10 minutes ago' -not -path '*/.git/*'`); (2) gate-log transitions in /tmp/*gate*.log (ALL-PASS / FAILURES / running); (3) new commits on main (past f64e15e), or on agent-*/conductor-* branches (`git -C /home/parallels/dev/tui-editor log --oneline --all --since='12 minutes ago'`); (4) tmux harness sessions with builder/conductor/agent-ish names (NOT diff-manual*, which are stale). If the fork is DORMANT with a red or finished gate: read the gate log, diagnose the specific failing step, and nudge it via SendMessage with the precise fix. If genuinely STALLED (no worktree writes, no gate activity, no branch commits across a FULL cycle): take over — diagnose, fix, gate, merge. If progressing, note it briefly. Also flag if the fork over-spawned builders (CPU contention flakes smoke-wrap) — tell it to cap at ~2. Report concisely.
```

**Due for refresh:** both prompts still name "the 11 Invar UI tasks" / `f64e15e` / the specific agent-id
— session-specific and now largely complete. The hourly loop is allowed (step 4) to generalize these
on a future fire.
