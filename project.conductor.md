# Orchestration Lessons — running multi-agent autonomous work with IBR + skills

What a full night of building the Fable TUI editor taught us about our skills and, more
importantly, about **managing** work like this — one main session conducting a background
fork, which in turn drove three codex workers, all under IBR + the `/invariants` governance
loop. Written 2026-07-21, from real events in this run. The point is to convert the friction
we hit into either practice or tooling.

---

## Part 1 — What the skills got right (validated in the wild)

- **IBR reduction was the highest-value early artifact.** Collapsing the brief's 37
  "architectural invariants" to ~8 named generators was not decoration — it changed the code
  that got written. *"Cost tracks the actively observed set"* is directly why the file tree
  lazy-expands, the editor slices only the visible window, and undo is a bounded stack. The
  compass earned its keep before a line of app code existed.
- **Impossibility-prediction paid off concretely.** The reality invariant *"A text position
  has several encodings"* predicted the exact bug — backspace splitting a surrogate pair into
  a lone half — **before any code was read**. A contract's highest-value output is the
  impossibility it forbids; this is the canonical proof of it.
- **Independent adversarial review caught what the author could not.** The builder (me, in the
  main session) wrote revision-stamping refs and never noticed nothing observed them —
  "decorative reactivity." The fork's independent pass found it. The author of a bug is its
  worst reviewer; the panel is not ceremony.
- **Reviewer disagreement is a signal, not noise.** Two audits disagreeing on whether the code
  typechecked surfaced a real trap (below). When honest reviewers diverge, at least one
  reduction is incomplete — chase it.
- **Governing already-written, un-governed code is a strong test of the loop**, not a weaker
  one than clean-room. It is exactly the mission ("keep AI-developed code from going
  brittle"), and it converted real M1–M3 code into contracted, annotated, checked code.

## Part 2 — Antipatterns and traps discovered

- **Decorative reactivity** — bumping a `ref` that no effect reads. The substrate (revision
  stamps) existed; the consumer (a frame effect) didn't, so async producers had no repaint
  path. *The `provisional/established` binary doesn't capture this "substrate present, consumer
  pending" state* — a genuine gap in the invariants vocabulary.
- **Outcome-vs-mechanism** — an invariant satisfied in *result* while its prescribed
  *mechanism* is bypassed. "Data flows one way" held in outcome (render never mutated state)
  while its mechanism (reactive invalidation → repaint) was absent. Only checking the mechanism
  catches the real gap. Verdicts must inspect mechanism, not just observable behavior.
- **Exit-code masking** — `tsc | tail` (or `| tee`) reports success while `tsc` actually
  failed, because the pipe's exit code is `tail`'s. This is why two audits disagreed on
  "does it compile." **Rule: never pipe a verification command through tail/tee; use
  `cmd; echo EXIT=$?`.** Now in the tui-editor PROGRESS runbook.
- **Annotation-ahead-of-contract** — sprinkling `// invariant: X (contract.md)` comments that
  name records/files not yet written produces exactly the orphan annotations the checker
  exists to flag. Don't annotate before the contract exists.
- **The observation instrument can be the bug (and manufacture a phantom).** The selection
  highlight looked mis-positioned (~4× scale + offset) and was blamed on OpenTUI's
  `setLocalSelection`; a codex worker was sent deep into the Zig renderer source chasing it.
  Root cause: the **FrameProbe itself** read the render buffer with the wrong stride (cells are
  4 RGBA lanes) — the *observation tool* was lying, the selection had rendered correctly all
  along. The "4× scale" symptom was literally the 4-lane misread. Lesson: when a verifier
  reports a bug, first sanity-check the verifier against a KNOWN-GOOD control (does it report
  the background/a fixed shape correctly?) before trusting its verdict on the thing under test.
  A wrong instrument doesn't just miss bugs — it invents them and sends you debugging the wrong
  layer. This is "a test is only as true as the channel it reads is authoritative for" applied
  to the channel itself.
- **Pane-scraping for state** — the one time state was asserted by scraping the rendered TUI
  pane instead of the deterministic side-channel, it produced a false "the arrow keys are
  broken" scare (half-repainted frames read mid-update). The recorded discipline "verdicts come
  from the side channel, never the pane" was violated by its own author and immediately bit.
  Generalizes: **agent/system verdicts come from artifacts (git, status files, test output),
  never from parsing rendered prose or screens.**

## Part 3 — What we were MISSING to manage this well (the real lesson)

These are the gaps that cost time tonight. Each is a candidate for a practice or a skill.

1. **Commit-ownership was undefined → a real deadlock.** The three codex workers wrote their
   complete modules and went quiet; every file sat *untracked* in the worktrees. The
   orchestrator waited for "codex to commit" as its merge trigger — a signal that would never
   come, because committing delegated output is the *orchestrator's* job, not the worker's.
   Hours of apparent "still building" were actually "done and stranded."
   **Fix / practice:** before delegating, define explicitly — *who commits the work, and what
   is the completion signal?* A worker that finishes without committing is invisible to a
   commit-watching parent. Prefer an explicit done-marker artifact over "watch for a commit."

2. **No liveness/heartbeat on delegated workers.** We could not distinguish "still building"
   from "finished-but-stranded" from "crashed." PIDs rotate every turn, so process-watching
   lies. The only reliable read was file mtimes ("no writes in 56 min → done or hung").
   **Fix:** delegated workers should emit a heartbeat/status artifact (a `worker-status.json`
   with phase + last-progress timestamp + done-flag) that the orchestrator polls — the same
   side-channel discipline the TUI uses for its own tmux harness, turned on the *agents*.

3. **Two writers on one checkout collide.** The fork swept the main session's file renames into
   its own commit; both sessions spent tokens confused about "who is this rogue builder
   committing to master" — when they were the *same* session running a `/goal`.
   **Fix:** worktree-per-writer is mandatory for concurrent agents. One checkout, one writer.
   (Codex workers were correctly isolated in worktrees; the main-session/fork overlap was not.)
   **Fan-out variant (recurred 2026-07-21, whole-repo de-abbreviation pass):** the fork
   parallelized a mechanical rename across 7 module-scoped sub-forks sharing ONE working tree;
   the git-module fork strayed cross-module into `editor/` and raced the dedicated editor fork.
   The orchestrator aborted the whole swarm to stop the race (safe — it verified the tree was
   green and committed rather than resetting), but the abort then propagated as a confusing
   "safe to reset the working tree" signal up the mesh. Two lessons: (a) a whole-repo mechanical
   pass fanned across sub-agents on a shared tree needs **strictly disjoint file sets per agent
   with a hard no-cross-module rule**, or a single serialized owner — sharing the tree without
   partition guarantees is the collision by construction; (b) an internal safety-abort's
   "reset?" signal must not read as an external stop — see limit 9.

4. **Agent-topology blindness.** The fork filed "incident reports" about a rogue committer that
   was itself (its sibling running the user's goal). Agents don't know their own authorship or
   the shape of the fleet they're in, so they burn cycles diagnosing phantoms.
   **Fix:** give each agent a one-paragraph "who you are, who your children are, who commits,
   who else writes here" topology note at spawn. Cheap; prevents whole diagnostic loops.

5. **Compaction resilience is not automatic.** A long autonomous agent *will* compact, and the
   summary cannot be trusted to preserve the work frontier.
   **Fix (now practice):** every long agent maintains a **committed** `HANDOFF.md` with a
   `MUST RE-READ ON RESUME` ordered doc list, updated every few turns — reconstruct from disk,
   not from the dropped summary. A parent can't see a child's context %; detection is
   behavioral (re-reads, re-litigation) or self-reported (ask the child to stamp a COMPACTION
   line each turn). There is no external gauge of the number.
   **Correction learned this run — a parent CAN force-compact a child, with curated focus.**
   Send the subagent a message whose content *begins with* `/compact` (no leading whitespace):
   `/compact <focus instructions>`. The recipient's harness executes it as the slash command,
   compacting with your instructions as the summary focus. (Earlier this run I wrongly believed
   a parent had no compaction control and could only *instruct* the child to compact itself —
   but a background agent CANNOT self-invoke `/compact`; the `/compact`-as-message from the
   parent is the actual lever.) So the proactive-compaction play is: parent watches for the
   child getting long → have it reach a green committed checkpoint + refresh HANDOFF → then
   parent sends `/compact <focus>` to compact it cleanly on a curated boundary, instead of
   waiting for the harness's automatic compaction at the ceiling (`trigger:"auto"`, which fires
   at ~95%+ regardless). Auto-compaction is survivable *if* the handoff is fresh; the manual
   `/compact` lets you choose the boundary and the focus.

6. **Shared decisions ledger.** Re-litigation risk is real across turns and across agents.
   `project.decisions.md` worked for the fork; delegated workers need read access to it so a
   settled call isn't re-opened by someone who never saw it.

7. **The conductor role is itself an un-codified skill.** Shepherding — re-waking parked
   agents, spotting and breaking deadlocks, being the external memory backup, relaying
   decisions with sensible defaults, watching for context-loss — emerged ad hoc tonight and
   did real work (it broke the codex deadlock). It deserves to be a named skill, not improvised
   each time.

## Part 3b — Delegation = cold-start-clone orientation + task delta (the strongest formulation)

The best delegation strategy found this run: **onboarding a delegate is the same operation as
onboarding a resumed/compacted self.** Both bring an agent up to parity with the orchestrator's
load-bearing understanding, then act. Reuse the same packet for both. Concretely, a delegation
prompt is:

  (shared cold-start orientation) + (only the contracts the task touches) + (role-framed task)
  − (the conductor identity)

- **Shared orientation (fixed, reusable):** the exact MUST-RE-READ foundation a resumed self
  reads — ivue reference + namespace pattern, the naming/module conventions, the verify
  discipline (assert from the side channel, never pane-scrape; never pipe the typecheck), the
  coordinate/frame-effect facts, and the delegation/commit protocol. This is why a delegate
  drifts less: it starts where the orchestrator stands, not below it.
- **Scope contracts only (tiered):** the target module's `*.invariants.md` + the relevant
  project records — NOT all contracts. Cloning *everything* multiplies a large context N times
  and defeats the reason you delegate (keeping the loop lean). The MUST-RE-READ list already
  separates "always" from "for what you're working on"; reuse that split.
- **Role-framed task, conductor identity stripped:** clone the *understanding*, not the *role*.
  A delegate must NOT inherit "I am the conductor who spawns codex and re-plans the build" — or
  it will spawn its own sub-agents and re-litigate the plan. Frame it as: "you are a scoped
  worker; read these; do this one thing; return it for review."

The failure this prevents is the bare-bones-prompt drift of Part 3; the failure it *avoids
introducing* is token blowup and role-confusion. The artifact already exists — the HANDOFF's
MUST-RE-READ packet IS the reusable orientation; delegation just points a fresh agent at it.

## Part 4 — Concrete artifacts to build next

- **An `orchestration` / `delegate` skill** codifying: the commit-ownership contract, the
  worker heartbeat artifact, mandatory worktree isolation, the shared decisions ledger, an
  explicit completion-signal definition, the re-wake loop, and the topology note. Most of
  Part 3 becomes a checklist here.
- **Compaction-resilience as standard practice** in every long-running agent prompt: committed
  HANDOFF + MUST-RE-READ + per-turn COMPACTION status line.
- **`/invariants` vocabulary additions** (feed the skill's own upgrade log): the
  outcome-vs-mechanism verdict nuance; a greenfield "consumer-pending" status distinct from
  provisional; the exit-code-masking warning baked into Verification/verify guidance;
  "verdicts from artifacts, never rendered output" as an explicit review rule.
- **`ivue` note:** name "decorative reactivity" (a bumped ref no effect observes) as an
  antipattern; record that the namespace + `Reactive()` conventions held up cleanly in
  autonomous, un-reviewed code.

---

## Part 5 — The deeper reframe: the invariants are the artifact, the app is an expression

Surfaced 2026-07-21, mid-build. The realization that reframes the whole experiment:
**the invariants are the truth/meta layer; the application is only one expression of them —
the implementation, not the truth.** This is IBR's "Expression is Not Essence" axiom, but the
build turned it from a claim into observed evidence:

- **One generator, many expressions.** "Cost tracks the actively observed set" generated the
  file-tree lazy-expand, the editor viewport, AND the git commit-log virtualization — three
  unrelated-looking implementations, one invariant. Building each was *derivation from* the
  invariant, not invention. The generative principle running forward.
- **The truth judged the code, never the reverse.** The surrogate-pair corruption and the
  FrameProbe stride bug were both caught because the *invariant* ("a text position has several
  encodings"; "a test is only as true as its channel is authoritative for") was the fixed point
  that identified the *code* as the thing that had drifted. Expression is corrigible against
  essence; essence is not corrigible against expression.
- **Regenerability asymmetry (the proof).** The fork compacted — lost all conversational memory —
  and continued seamlessly, because the load-bearing truth lived in `project.invariants.md` +
  the module contracts on disk. The implementation is regenerable from the invariants; the
  invariants are NOT regenerable from a lost session. The app is provably downstream.

The rigor caveat (the Wielder Principle): the app is an expression of the invariants **only to
the depth they've been honestly reduced.** Provisional records and "decorative-reactivity"-style
hollow generators still carry hidden truth the contract hasn't extracted — there, the code is
still load-bearing. So the gauntlet and verification passes are not QA; they are *continuing the
reduction* — finding where the expression still holds truth the contract doesn't yet.

Consequence for practice: **the invariants contract is the artifact worth keeping.** The
tui-editor could be discarded or rewritten in another framework; `project.invariants.md` would
regenerate it. That is the point of governing code with invariants — not tidiness, but giving a
codebase a truth layer above its implementation layer, with the implementation provably
downstream. This is *why* the /invariants skill exists; the build is its existence proof.

**The one-line takeaway:** the *reasoning* skills (IBR reduction, invariant impossibility-
prediction, adversarial review) worked and proved their value immediately. What we lacked was
the *operational* layer for running many autonomous agents at once — commit ownership,
liveness, isolation, topology, compaction resilience, and a codified conductor role. Tonight
those gaps cost the most time (the codex deadlock, the "who's the clone" confusion, the
compaction worry). Build the orchestration layer next; the thinking layer is already sound.

---

## Part 6 — Conductor run 2026-07-23 (Invar UI batch + tsgo swap + scroll-viewport module)

Six new operational lessons, every one from real friction this run.

1. **A green gate on an UNCOMMITTED tree is not durable — a commit is the only "safe" signal.**
   The 0/7 scrollbar work was `git add`-ed and passed the FULL merge-gate ALL-PASS *three times*,
   but was never `git commit`-ed. `git worktree remove --force` then silently discarded it; main
   never had it, and hours of validated work vanished. The gate validates the *working tree*, which
   is ephemeral. **Rule: commit before (or immediately after staging for) the first gate; treat the
   COMMIT — never a green gate on a dirty tree — as the "work is safe" checkpoint.** This is the
   commit-ownership lesson (Part-3 #1) turned on the orchestrator's OWN delegated-back work.

2. **Tracked-background vs `nohup` decides both agent visibility AND auto-rewake.** A background
   agent that launches its gate with `nohup … &` (untracked) then ends its turn "with no live
   children" drops out of `/tasks`, goes dormant, and does NOT auto-resume — invisible to the user
   and stalled. The same gate launched with the Bash tool's `run_in_background: true` (a TRACKED
   child) keeps the agent live, visible, and auto-re-invoked the moment the child completes.
   **Rule: delegated agents background long work via tracked children, never nohup** — it is both
   the "why did my fork vanish from /tasks" fix and the auto-rewake mechanism.

3. **Count ROOT gates, not name-matches — transient smoke children cause false self-blocking.**
   `pgrep -f 'merge-gate.sh'` returns the root gate PLUS its transient smoke subprocesses; the fork
   repeatedly read "3 gates running," self-blocked under its own cap-1 rule, and stalled when only
   0–1 real gates existed. **Rule: a "free slot?" check counts only ROOT `bash scripts/merge-gate.sh`
   procs (ppid=1 / the real parent), never any process whose cmdline merely matches the name.**
   Miscounting the fleet's own transients is a recurring self-inflicted deadlock (cf. Part-3 #4).

4. **Stale-base branches: `git merge` is 3-way-safe, but you must gate the COMBINED tree.** A branch
   built on an older main shows an alarming 2-dot diff (looks like it will revert newer merges), but
   `git merge` resolves via the merge-base and preserves both sides for disjoint files — the merge
   is safe. The trap is *gating the stale base*: a green gate on old code validates something that
   isn't what lands. **Rule: bring current main INTO the branch (`git merge main`) BEFORE the final
   gate, then verify `git diff --name-only main..HEAD` shows ONLY the task's own files.** Never gate
   or merge a stale-base branch without first pulling main in.

5. **Swapping a backing service: enumerate PUSH vs PULL capabilities — a complete render can still
   show nothing.** tsgo (native-preview) is pull-model and never sends `publishDiagnostics`; the
   task-4 diagnostics RENDER was complete, gated, and correct, yet produced zero squigglies under the
   default server because the DATA never arrived. **Rule: when swapping a service (tsserver→tsgo),
   enumerate which capabilities are push vs pull and verify the DATA reaches the client — not just
   that the render works given data.** A feature gated against an injected fixture can be invisible in
   production; the fix is a capability (LSP pull-diagnostics), not a render change.

6. **The conductor's OWN discipline degrades over a long session — the same traps it warns about.**
   This run the conductor (main session) hit exactly the Part-3 failures it documents: never-
   committing (real data loss, #1 above), miscounting the fleet (#3), and nearly merging a stale
   base (#4). Judgment erodes precisely when the stakes (irreversible merges) are highest and the
   session is longest. **Lesson: the conductor needs the same mechanical checklist it imposes on
   workers — a per-merge ritual run every single time, not from memory: `committed? · merged current
   main in? · gate ALL-PASS on the combined tree? · diff shows only my files? · pushed? · demo
   bumped?`** The orchestration skill (Part-4) should ship this as a literal checklist, because prose
   discipline is the first thing to slip under length.
- **`update-ref` on a CHECKED-OUT branch desyncs its worktree (2026-07-23).** To fast-forward
  local `main` to a merged commit I ran `git update-ref refs/heads/main <new>` — but `main` was
  checked out in the primary `/home/parallels/dev/tui-editor` worktree. update-ref moves only the
  branch pointer; the working tree + index stayed on the old commit, producing a phantom "staged
  revert of the last merge" in `git status` and serving the user STALE on-disk code (the just-merged
  task 4 was absent from disk). No real work was lost — the unstaged diff was clean — and
  `git reset --hard <new>` repaired it. **Rule: never `update-ref` a branch that `git worktree list`
  shows checked out anywhere (the primary counts). Advance a checked-out branch with
  `git pull --ff-only` / `git merge --ff-only` in that worktree so the files move with the pointer.**
  The conductor owns syncing the primary's local main; workers push merges to ORIGIN and never touch
  the primary checkout.
- **Branch/worktree PRESERVATION guardrail (2026-07-23, user-requested).** Never delete a branch,
  force-remove a worktree, or force-overwrite work without explicit per-branch user authorization —
  destructive git ops are irreversible and already cost a lost task this session (`worktree remove
  --force` on uncommitted work). The user saw branches being deleted before/around commit and asked
  to guard-rail it. **"Done" = MARK finished (`git tag finished/<branch> <merge-hash>` + a
  `project.delegation-log.md` line), never delete.** Deletion happens only in an explicit
  user-authorized sweep. Codified in the /conductor skill's "Never destroy recovery points" section;
  relayed to the fork as a standing rule.
- **Branch END-STATES (2026-07-23, user-requested completion of the preservation rule).** Every branch
  ends ACTIVE (untagged; a live worktree/agent drives it), FINISHED (merged → `finished/<branch>` tag),
  or ORPHANED (abandoned/superseded/dead-end → `git tag -a orphaned/<branch> -m '<reason>'` if it has
  unique commits worth preserving; a delegation-log line alone if empty/DOA). Both terminal states are
  MARKED, never deleted; pruning happens only in an explicit user-authorized sweep. Makes branch status
  legible at a glance and keeps every recovery point.
- **Agents kill their OWN gate's tmux while "cleaning up" (2026-07-23).** The fork, deciding that
  process-counting was "unreliable" (its own smoke processes self-match its `pgrep`), moved to
  "kill ALL smoke tmux sessions" — while its own gate was mid-run driving smokes in tmux. That
  produces spurious failures whose signature is *app did not open / vanished mid-drive* (here:
  smoke-shortcut-help "quit-drive session did not open a document"). **Rule: never kill
  tmux/processes to resolve a liveness or counting confusion.** The gate owns its smoke-tmux
  lifecycle and cleans up itself; the authoritative liveness signal is gate-LOG step activity, not
  process/tmux counts. And never kill unknown/stale sessions (the 2-day-old `diff-manual*` here) —
  they may be adjacent to the user's env. Reinforces "process topology lies; the log is truth."
- **Migration verification must cover EVERY behavior the module provides (2026-07-23).** The
  ScrollableTextViewport migration was drive-verified for scroll/momentum but NOT drag-select; a user
  later reported "drag-select broke." It turned out NOT broken (see next lesson), but no smoke drove the
  hover-card drag — so a real regression WOULD have shipped silently. Rule: migrating to a shared module,
  ratchet a driven smoke for EACH behavior it provides (selection, momentum, alt-scroll, scrollbars), not
  just the one you're focused on. An instance of the smoke-coverage ratchet.
- **The tmux/SGR harness has a BLIND SPOT at terminal-specific paths (2026-07-23).** A user-reported
  "drag-select broke" did NOT reproduce in-harness — it's a macOS Terminal.app MOUSE-PROTOCOL path
  (Terminal.app may not honor SGR mode 1006 → X10 fallback, coords clamped at 223) the SGR-encoding
  harness can't emit. Two rules: (a) do NOT fabricate a code fix for a bug that won't reproduce — that
  ships a no-op (the fork correctly refused, and drive-proved the logic works + smoke-ratcheted it);
  (b) when a real user "break" won't reproduce in-harness, suspect a terminal-CAPABILITY path (mouse mode,
  glyph tier, escape support) the harness's own terminal can't exercise — diagnose defensively from the
  code path, flag that final verification needs the user's real terminal. The harness proves LOGIC, not
  every terminal's protocol quirks.
- **External snapshots LAG an agent's real state — hold "stalled/uncommitted" diagnoses loosely (2026-07-23).**
  A loop-check saw the fork's transcript mtime stale (~22 min), wt-tabs "uncommitted", and an old failed gate,
  and diagnosed "dormant with uncommitted work." Wrong: the fork had committed two-line-tabs (061d583+e098c2c)
  and kicked a FRESH gate in the window between the snapshot and its self-report. Two blind spots: (a) the
  worktree-writes `find` EXCLUDES `.git/`, so it MISSES COMMITS — the single most important progress signal —
  making a just-committed agent look idle; (b) transcript mtime lags an in-flight tool call. Fix: include
  branch-commit detection (`git -C <wt> rev-list --count origin/main..HEAD`) in the liveness read, not just
  non-.git file mtimes; and treat suspected dormancy as a prompt to make the agent SELF-REPORT (a cheap nudge)
  rather than asserting stall from the snapshot — the agent's self-report is authoritative. The nudge does no
  harm when wrong (the agent just clarifies), but the DIAGNOSIS must be held loosely.
- **Mitigation for the tracked-gate re-invoke misfire: arm a MONITOR on the gate log (2026-07-23).** The fork's
  tracked-background-gate completion repeatedly failed to re-invoke it, leaving it dormant on green/red gates
  until a loop-check nudge (merges lagged one cycle). The fork fixed it itself by arming a Monitor on the gate
  log file — completion then reliably wakes the agent. Standing rule: for a long gate whose result must be
  acted on, arm a Monitor on the named gate log rather than trusting the tracked-bg re-invoke; the 10-min
  loop-check remains the floor under it.

- **One fixed-session-name smoke silently serialized the WHOLE fleet.** We'd capped at 2–3 builders and
  strictly "one gate at a time" for the whole run, believing 3+ gates always flake. The real cause was
  narrower and fixable: `smoke-settings-applied.sh` was the ONLY smoke using FIXED tmux session names
  (`sa-sbt-a`…) while every other smoke already PID-namespaced (`smoke-$$`). tmux session names are global
  to the one server, and the frame dump is keyed by session (`artifacts/frame-<session>.json`), so two
  concurrent gates clobbered each other → the frame probe read a half-written frame → `IndexError` → a
  gate RED that looked like a code bug. Proof it wasn't the code: the same check failed on CLEAN main while
  another gate ran, and passed 30 min earlier in isolation. Fix: PID-namespace that smoke's sessions
  (`sa-$$-…`); frame path + cleanup follow the name automatically. After the fix, the namespaced smoke
  passed WHILE another gate ran — gates became genuinely parallel. Lesson: when a whole workflow is
  serialized "because concurrency flakes," find the ONE shared-resource collision and fix IT rather than
  serializing everything; and audit new smokes for PID-namespacing or they silently re-break parallel gating.
  The remaining ceiling is soft: ~4–5 simultaneous gates still CPU-starve timing-sensitive smokes (my first
  part-4 gate RED'd as a load flake at 4–5 concurrent; isolated re-run was ALL-PASS), so keep ~2–3 and
  re-run a load-flaked smoke isolated before believing it.

- **A UI test must locate elements by STRUCTURE, not by cosmetic display text — and a correct bisect can
  still mislead about the mechanism.** The deferred "editorArea.title ↔ markdown find/paste coupling" looked
  like the app keying find-source off the display title (the fork's bisect was correct: title='' → paste
  no-op + find mis-route, deterministically). But the app was never coupled — find-source is the document
  PATH (`source:${path}`, `markdown-preview:${sourcePath}`). The real coupling was in the OBSERVER:
  `smoke-markdown`'s `source-border-column` probe located the source pane by searching the frame for the
  literal `╭─README.md` (the pane's title text), so blanking the title made the probe return -1 → the
  focus-click missed → paste went nowhere. Fix: locate the pane structurally (leftmost box corner on the
  split border row), title-independent. Lesson: a probe that keys off cosmetic text couples the PRODUCT to
  a value the product itself doesn't depend on, manufacturing a phantom "app bug." And a bisect that
  correctly isolates the trigger variable (title) can still point at the wrong SYSTEM — the cause lived in
  the measuring instrument, not the measured system. Verify the mechanism, not just the trigger.

---

## Part 7 — Conductor run 2026-07-23 (backlog drained; wrap fix + agent-harness experiment)

State at this fire: **frontier empty** — ground-truthed against `origin/main`, NOT the handoff anchor
(which lagged, still listing "remaining 0.5 + 6"). All 11 UI tasks + the 7 polish requests +
pull-diagnostics are merged (`893c581` activity-toggle, `061d583` two-line→breadcrumb flip, `9d5b9b4`
undo-unchanged, `c54be3a` open-project navigator, `ce8a261` open-project wrap). The full lesson set is
in `/home/parallels/dev/ibr/Skills/Orchestration Lessons.md`; the doctrine-worthy new ones:

- **Ground-truth the backlog against `git log origin/main`, never the handoff anchor.** The anchor is a
  point-in-time note and lags reality by hours; three fires were spent re-reporting "parked" against a
  backlog that git showed already merged. First action of every fire: `git log --oneline origin/main`
  and match each named task to a commit.
- **The caret/cursor smoke is the CPU-load canary.** `smoke-wrap`'s "caret == tmux cursor on a wrapped
  row" FAILED with unrelated changes purely because `tsc` ran concurrently with the gate; isolated
  re-run = ALL-PASS. Rule: gates run SOLO — one gate at a time across BOTH agents, and never `tsc`/second
  gate alongside. A red caret smoke on unrelated code is almost always load, not regression.
- **New `git worktree add` worktrees have NO node_modules** — symlink it to the main repo immediately
  (`ln -s <mainrepo>/node_modules node_modules`) or `bun test` dies "Cannot find package 'ivue'".
- **Pre-commit hook re-runs the full gate → a foreground `git commit` times out (~2min tool ceiling vs
  ~5min gate).** Commit in the background, or `SKIP_GATE=1` when the identical tree just gated green
  (state which gate log + exit 0 in the message). Never SKIP_GATE an unverified tree.
- **`pkill -f "<pat>"` self-matches and SIGTERMs your own shell** (exit 144) when the pattern appears in
  the killing command's `bash -c` wrapper. Kill by explicit PID from a prior `pgrep`.
- **A stood-down fork is a resource, not a corpse.** Re-engage it with `SendMessage` (full context
  intact) for the next experiment rather than spawning a cold subagent that re-explores.
- **Mirror an existing module 1:1 to build a new one cheaply.** The agent-harness experiment
  (`experiment-agent-harness`) mirrored `terminal/` exactly (backend seam + mock + Reactive
  single-source + PaneContent + Static factory + colocated invariants + smoke) and typechecked
  first-try. When a contract doc names the file layout, follow it verbatim (file-name-follows-class).

**Cron drift (still open):** the live hourly (`4e2da192`) + 10-min (`e4de2d1a`) prompts hardcode "the 11
Invar UI tasks" — all done. They should be re-pointed to "invent + gate ONE experiment-branch feature
per fire; verify frontier against git" on the next reasonably-safe cron edit (deferred here to avoid
restructuring the live loop while the user sleeps).

---

## Part 8 — Conductor run 2026-07-23 (agent harness → main, provider layer, panel-split integration)

Big session: shipped to main the native agent harness + real Claude (phase 2, `claude -p
--output-format stream-json`), HTML/CSS/Vue highlighting, the provider-agnostic layer
(`agentProvider` auto/claude/codex + `agentSkipPermissions` default-ON + auth hardening), and the
bottom-panel split (agent-LEFT / terminal-RIGHT). Fork built indent-guides (experiment) + the
split-capability; I built the agent stack + did the split integration. Hard lessons, most about
**two agents sharing one gate lane**:

- **Gate serialization is a HARD lock across BOTH agents — not a guideline.** Twice, my gate and the
  fork's gate ran concurrently and BOTH flaked `smoke: wrap`'s caret-vs-cursor canary (identical wrong
  coords). Even a *stray isolation smoke* run during the other's gate does it. Rule: exactly ONE
  merge-gate (or smoke, or `bun test`) across both agents at a time. Protocol that worked: the builder
  pings "ready to gate", the conductor replies "clear", and everyone else HOLDS all CPU until the gate
  reports. The systemic fix is still unbuilt: a **gate-lock file** the merge-gate acquires/releases so
  concurrency is impossible, not just discouraged.

- **The waiter self-match footgun (inverse of pkill -f).** A background waiter
  `until ! pgrep -f "bash scripts/merge-gate.sh"; do …` MATCHES ITS OWN shell (the pattern is in its
  command line) → it never exits AND poisons every "is a gate running?" check with false positives.
  Use `ps -eo args | grep -E "^bash scripts/merge-gate\.sh$"` (anchored, exact) to detect a real gate;
  key waiters on the gate LOG's exit line (`grep -q GATE-EXIT`), never on pgrep of the gate command.

- **A mock with a no-op `onResize` cannot test real resize propagation.** The fork's split smoke used a
  `StaticPaneContent` mock whose `onResize` did nothing — it proved RENDER-width sharing but never that
  per-cell `onResize` actually resizes a real child. Wiring the REAL terminal into the split caught a
  latent bug: the panel converge guard keyed on the panel's TOTAL width (unchanged by a split — same
  118 cols, just redistributed), so `setViewportSize` never re-fired and the terminal's pty kept its
  full width. Fix: key on the cell-LAYOUT signature (`rows + each cell id=width`). Lesson: test
  multi-region/resize features by DRIVING a real child (terminal `stty size`), not a mock — the mock
  hides exactly the propagation bug you need to catch. (This is "verify by driving the real user path"
  with teeth.)

- **A fork waiting on a long background gate must arm a Monitor on the gate-LOG file, not trust the
  tracked-bg re-invoke.** Recurred again: the fork's solo split gate went ALL-PASS and the fork sat
  DORMANT ~10 min (branch unpushed) until a loop-check nudge, because it relied on the tracked-bg
  completion to wake it. Standing rule (already in the doctrine, now doubly confirmed): `Monitor` the
  named gate log; the 10-min loop-check is the floor under it, not the primary signal.

- **Concede overclaims under peer pushback — the test is the arbiter, not assertion.** I told the fork
  its wrap failure was "certainly" a load flake; the fork rightly countered with a controlled
  observation (same concurrent load: base PASS, its branch FAIL, deterministic coords) that a pure-flake
  theory had to explain. I was overconfident; the SOLO gate was the real decider (it passed → flake
  confirmed). Truth-over-self-protection in fleet coordination: don't defend a diagnosis, run the clean
  experiment. Good teammate behavior on both sides — nobody pushed on a red gate.

- **Auto-detect + graceful-skip is the reusable shape for external-dependency features.** The provider
  layer (claude/codex on PATH → real backend, else echo), the future TTS (espeak-ng/piper/say installed
  → real audio, else silent no-op), the LSP server table — all the same pattern: neutral intent above
  a seam, per-tool dialect below, availability-detected, never a hard dependency. When the dependency is
  absent at build (codex out of credits; no TTS engine installed), build + unit-test the envelope/mapping
  against known fixtures and FLAG the unverified path in-file — don't fake a drive-verify.

---

## Part 9 — A false invariant from a flawed verification method (2026-07-23)

A builder flagged a possible pre-existing bug (find-match highlighting maybe not rendering) and had
captured a supporting invariant: *"the editor code body ignores `bg()` chunks — OpenTUI mis-positions
background chunks in a multi-line StyledText."* It even reshaped a feature around it (bracket-match
pivoted from a bg highlight to fg accent+bold "because bg doesn't render there").

Independent drive-verification refuted BOTH — but only once driven with the RIGHT method:

- Find-match uses `bg(palette.cursorLine)` per-cell in the code body. Driven WITH `COLORTERM=truecolor`,
  the matched cells render a distinct bg (`69,71,90` vs editor `30,30,46`). Multi-cell AND the decisive
  single-cell case (a 1-char match) both render. bg() works fine in the code body.
- The builder's original "bg doesn't render" observation was a **verification artifact**: it had checked
  colors *without* `COLORTERM=truecolor`, so FrameProbe couldn't distinguish the backgrounds — it LOOKED
  like no bg. It later learned truecolor was required, but the false invariant it had already written
  down persisted (in memory + a branch's `editor.invariants.md`).

Lessons (doctrine):

- **A false invariant can be born from a flawed verification method, then propagate.** The reduce-break
  step only removes what you actually test; if the *test* is broken (wrong env, wrong probe), a false
  candidate survives as if confirmed. When a flagged constraint reshapes a design, **independently
  re-drive it with a correct method before trusting it** — don't inherit a peer's "confirmed" constraint.
- **Provenance-quarantine limited the blast radius.** Because the false invariant lived only in the
  builder's memory + an *unmerged experiment branch* (invented-experiments-stay-on-branches), it never
  reached main's contracts. The provenance rule paid off as a containment boundary for bad invariants,
  not just for features.
- **Color frame-assertions require `COLORTERM=truecolor`** — without it FrameProbe collapses colors and
  bg/fg differences vanish. A gotcha, but the deeper point is the first lesson: a broken probe manufactures
  false structure.

Outcome: the feature was never broken (find highlights fine; bracket-match fg is a valid style); only the
"why" was wrong. Builder tasked to correct its memory + the branch's justification (keep fg, fix the false
reasoning). No main change needed.

---

## Part 10 — The big feature run (2026-07-23→24): agent pane, voice, theme, permissions

The session that took the agent pane from placeholder to approval surface (~15 features landed:
paste/dictation, narration fixes, voice picker, agent scroll/copy/composer/chrome/thinking-indicator,
terminal padding, Tokyo Night, truecolor detection, permission prompts, JPEG preview, AppLoader).
Lessons, most general first:

- **Convention is not a generator.** Asked "should main.ts be a class?", the first reduction defended
  the file with "entry points are done this way" — habit wearing the costume of structure. The user
  wielded the *Construction goes through overridable seams* invariant and was right: everything but the
  4-line load-ordering shim became AppLoader (Static, overridable), and the entry became unit-testable.
  The tell was pre-existing: a real bug had just been found in exactly the untested region ("untested
  because untestable because unseamed"). Run eliminate-assumptions on your OWN defense of surviving code.
- **A live toggle must reach the CONSUMER, not just the label.** Shift+Tab flipped the setting + mode
  line while the backend kept its creation-time boolean — the UI lied. Pass a getter down and resolve at
  the point of use; trace every live control to the thing that ACTS on it. Same class of miss as the
  untested truecolor detection (`COLORTERM` unset + `TERM=xterm-256color` fell to 256-cube → "MS-DOS"
  theme): env-branching capability detection and per-use resolution are load-bearing and need their own
  tests — the consumer's tests cannot catch them.
- **The conductor is a CPU citizen too.** Ran tsc+tests during a builder's merge-gate → flaked the wrap
  canary → cost a full re-gate. When ANY gate runs, the conductor also holds all heavy work. Corollary
  proven twice after: gates run with held CPU passed first try, including wrap.
- **Diff a branch against its merge-base, never a moved main.** A builder read `origin/main..HEAD` after
  main advanced past its base and "saw" a 30-file contamination that didn't exist. `git diff
  $(git merge-base origin/main HEAD)..HEAD` is the branch's actual content. Related sequencing rule:
  land the sibling first, rebase the stale-based branch onto CURRENT main, gate the rebased tree.
- **Smokes that mutate settings need a per-run HOME.** The harness's shared artifacts/home persists
  settings.json across gate smokes; a prior smoke's values leaked into voice-picker's "defaults"
  assertions (failed only in-gate, passed solo). `env HOME=$(mktemp -d)` per run; XDG_DATA_HOME alone
  does not isolate settings.
- **Verify the stack layer by layer before blaming the app.** "No narration audio" reproduced through:
  settings ✓ engine ✓ raw pipeline ✓ real backend ✓ wiring ✓ — leaving only the VM audio route, which it
  was (host device switch broke the guest sink). The app was never broken; an hour of code-spelunking was
  avoided by driving each layer cheaply first.
- **Demo-hold protocol.** While the user demos main to someone: freeze main, hold all gates/merges/heavy
  CPU, builders commit-and-hold. Landing resumes on their word. Provenance of the pause is the user's
  presence, not the work's readiness.
- **Placement leverage for doctrine.** The *Seams are drawn at the shared generator* invariant got its
  reminders where agents actually read (AGENTS.md #2, conventions, the canonical seam annotations) —
  not sprayed across files. Reminder-leverage is always-read placement, not file count; dense where
  load-bearing, absent where it would be noise. (The invariant then held live: a builder refused to
  over-unify composer scroll into the viewport engine and split to the honest wrap+selection seams.)

---

## Live cron prompts (canonical copy now in the /conductor SKILL.md "Live cron prompts" section — edit THERE; the copy below may lag)

These are the exact prompts driving the orchestration loop this session. **Improve them HERE, then
recreate the cron** — crons are session-only, in-memory snapshots (`CronDelete <id>` +
`CronCreate`), so editing this doc does NOT change a running cron, and a running cron does NOT read
this doc. Both auto-expire after 7 days. IDs drift each time we recreate; the text is what matters.

### Hourly orchestration loop — cron `4e2da192` (every hour at :07, `7 * * * *`)

```
Hourly orchestration loop (bounded per fire). Follow the `/conductor` skill (tui-editor/.claude/skills/conductor/SKILL.md). Do in order:

(1) BACKLOG FIRST — before ANY creative experiment, read the active task list and drain real work. Sources of truth, in order: (a) the scratchpad HANDOFF.md task list; (b) any TodoWrite/goal list still open; (c) the fork's (a0f12abb2a300d596) reported remaining tasks. The original 11 Invar UI tasks come first; after them the 7 UI-polish requests, then the pull-diagnostics follow-up. For each UNFINISHED real task: confirm the fork is actively driving it (worktree writes / gate activity / branch commits in the last cycle). If the fork is dormant or stalled, nudge it via SendMessage with a precise fix, OR take it over and drive it yourself. Do NOT start a creative experiment while any original-11 UI task is unmerged.

(2) IF BLOCKED on a task (fork stuck, ambiguous fix, or a hard problem) — do NOT default to deferring to the user. Spin up a codex or fable subagent and have it reach a solution creatively; only escalate to the user if the subagents also can't resolve it or the call is genuinely the user's (naming, scope, publish consent).

(3) ONLY once the real backlog is drained — invent + execute ONE creative IDE-parity experiment: reduce a real user need to its invariant, plan it, build on an experiment-* branch forked off LATEST main, gate it. NEVER merge experiments to main.

(4) Append any orchestrator lessons learned this fire to /home/parallels/dev/tui-editor/project.conductor.md (the running lessons log; the /conductor skill is the stable doctrine).

(5) Keep yourself, the fork, and its builder agents in working order — verify alive by fork-specific evidence, resume attack. Cap builders ~2-3, ONE gate at a time. Verify by DRIVING the real user path. Keep local main synced to origin/main (clean ff). Report concisely.
```

### 10-minute liveness check — cron `e4de2d1a` (every 10 min, `3,13,23,33,43,53 * * * *`)

```
Loop check (every 10 min): VERIFY — do not assume — that the fork orchestrator (agent a0f12abb2a300d596) and its builder agents are actually progressing on the 11 Invar UI tasks. IMPORTANT: the USER runs their OWN interactive Invar instances (from /home/parallels/dev/tui-editor and /tmp/tui-demo) — do NOT treat raw `src/main.ts` process count or instance age as a fork-liveness or hang signal, and NEVER kill a process from those paths. Key ONLY on FORK-SPECIFIC evidence: (1) writes in the fork's worktrees `/tmp/conductor-*` and `.claude/worktrees/agent-*` in the last ~10 min (`find /tmp/conductor-* /home/parallels/dev/tui-editor/.claude/worktrees/agent-* -newermt '10 minutes ago' -not -path '*/.git/*'`); (2) gate-log transitions in /tmp/*gate*.log (ALL-PASS / FAILURES / running); (3) new commits on main (past f64e15e), or on agent-*/conductor-* branches (`git -C /home/parallels/dev/tui-editor log --oneline --all --since='12 minutes ago'`); (4) tmux harness sessions with builder/conductor/agent-ish names (NOT diff-manual*, which are stale). If the fork is DORMANT with a red or finished gate: read the gate log, diagnose the specific failing step, and nudge it via SendMessage with the precise fix. If genuinely STALLED (no worktree writes, no gate activity, no branch commits across a FULL cycle): take over — diagnose, fix, gate, merge. If progressing, note it briefly. Also flag if the fork over-spawned builders (CPU contention flakes smoke-wrap) — tell it to cap at ~2. Report concisely.
```

**Due for refresh (drift noted 2026-07-23):** both prompts hardcode "the 11 Invar UI tasks" and the
hourly one names "the 7 UI-polish requests, then the pull-diagnostics follow-up" — with 11/11 done
and pull-diagnostics landing, the next edit should re-point the backlog to the polish/tooltip/activity-bar
queue and generalize the fork's task framing. The `past f64e15e` and agent-id references are also
session-specific and should be reviewed on reuse.
