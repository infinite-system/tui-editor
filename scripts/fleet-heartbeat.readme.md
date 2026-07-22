# fleet-heartbeat — a pull liveness floor for parallel build workers

`scripts/fleet-heartbeat.sh` watches a fleet of background workers (codex/agents building modules in
parallel, each in its own `/tmp/conductor-<name>` git worktree) and detects a **silently hung** worker
in minutes instead of hours.

## The problem it solves

When you fan work out to background workers, the only signal most orchestrations have is
**completion** — the worker finishes and notifies you. That's an *accelerator*, not a *floor*:

- A worker starved under load (too many concurrent workers + gates saturating the cores) can **hang
  silently** — parent process sleeping, ~0 CPU accumulated, zero files written — and because it never
  completes, it emits **no event at all**.
- On this project two codex workers stalled exactly this way for **~1.5 hours** before a manual check
  caught them.

A silent hang is indistinguishable from "still working" if you only listen for completion. It is, in
effect, a **dropped event** — and the only thing that ever catches a dropped event is a periodic
**pull** that re-reads ground truth. This is the same reduction as the app's own GitWatcher
reconcile-floor (`notify` accelerator over a `pull` correctness floor); here it's applied to the
*worker fleet* instead of the filesystem.

## What it does

Every `BEAT` seconds it polls each worker's liveness and tracks a per-worker "quiet" counter
(consecutive beats with no progress). It prints one pulse line per beat, appends to
`artifacts/heartbeat.pulse`, then **exits the moment something is actionable** so the orchestrator is
notified without having to poll:

### The liveness signal — process-tree CPU (not file-writes)

The signal is the **sum of CPU ticks over the worker's whole process tree**: its `codex` procs (matched
by their worktree `cwd`) **plus all their descendants** (`bun test`, `tsc`, `git`, …). A worker is alive
when that total is advancing — whether the parent codex is orchestrating *or* a child is burning CPU on a
test while the parent sleeps waiting. It's **hung** only when the tree CPU stops advancing for
`STALL_LIMIT` beats — the real hang signature (the earlier 1.5-hour hang sat flat at 4 ticks; a working
worker climbs into the hundreds).

> A naive file-write signal (newest `*.ts`/`*.sh`/`*.md` mtime) **false-positives**: a worker that
> finished writing and is now running its test suite writes nothing yet is very much alive. That flaw
> was caught the first time this tool ran. File-writes are still shown per beat (`…f`) as a secondary,
> informational indicator, but the stall decision is CPU-tree-based.

| Exit | Meaning | Orchestrator action |
|---|---|---|
| `0` (all done) | every watched sub-agent's process has EXITED (finished/died) | verify + merge the branches |
| `2` (STALL) | a worker's sub-agent is still ALIVE but its process-tree CPU has been flat for `STALL_LIMIT` beats | kill + respawn that worker |

**Aliveness is checked before CPU.** Each beat first asks *does this worker's sub-agent process still
exist?* (a `codex` proc whose `cwd` is the worktree). If it's gone, the worker is **done** — not hung —
so a *finished* worker is never mistaken for a stall (an early bug: the tool flagged a merged worker as
"stalled" because its exited codex left flat CPU). Only a **living** sub-agent with flat process-tree CPU
is a real hang.
| `0` (window elapsed) | `MAX_BEATS` passed, all still alive | re-arm for another window |

The orchestrator **re-arms** it while any worker is still running, so the fleet always has a pulse.

## Usage

```bash
scripts/fleet-heartbeat.sh <worker> [<worker> ...]
# worker = a name resolving to a worktree at $WORKTREE_BASE-<worker> (default base /tmp/conductor)

# example: watch /tmp/conductor-scrollbars and /tmp/conductor-markdown
scripts/fleet-heartbeat.sh scrollbars markdown
```

Run it in the background; act on its exit code / final line.

### Config (env)

| Var | Default | Meaning |
|---|---|---|
| `BEAT` | `70` | seconds between beats |
| `STALL_LIMIT` | `3` | consecutive zero-write beats that mean "hung" (≈ `BEAT×STALL_LIMIT` of silence) |
| `MAX_BEATS` | `45` | beats before the window elapses (re-arm) |
| `WORKTREE_BASE` | `/tmp/conductor` | dir prefix containing the `-<worker>` worktrees |
| `PULSE_LOG` | `artifacts/heartbeat.pulse` | where pulse lines are appended |

## The companion rule: cap concurrency

The heartbeat *detects* the silent hang; it does not prevent it. The hang is caused by
**over-parallelizing** — 7 codex workers + gate runs at once starved everything (and also flaked driven
gates via shared-CPU render timing and corrupted shared observability files). Keep the fleet to **~2–3
concurrent workers**. More does not go faster — it stalls the fleet. Detection (this tool) + prevention
(the cap) together keep the fleet honest.

See also: `scripts/delegate-packet.sh` (how a worker's cold-start prompt is built), `project.handoff.md`
(the worker-orchestration workflow), and the GitWatcher reconcile-floor for the same notify-over-pull
shape in the app itself.
