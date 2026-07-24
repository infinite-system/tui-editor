# Independent review verdict

Performance law is breached in several hot paths despite idle rendering itself being quiescent. The largest risks are full-transcript reprojection, wrapped-document rescanning, hidden agent animation, and unbounded blame/transcript storage.

The 2026-07-24 handoff summary is current, but architecture, progress, implementation-plan, requirements, ivue-reference, and the lower half of handoff materially contradict the code.

Severity meaning: **FATAL** violates a governing law or invalidates evidence; **SCOPING** scales with the wrong set; **FLAG** is real but lower priority or not yet quantified.

## Dimension A — performance findings

1. **FATAL — Agent rendering is O(total transcript), not O(viewport).**

   `AgentTranscriptProjection.project()` explicitly creates fresh objects for the entire transcript on every call, wrapping every entry and allocating a complete `ProjectedLine[]`; there is no memoization or incremental index ([AgentTranscriptProjection.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentTranscriptProjection.ts:68)). The pane does this before slicing the visible window and retains the full result for selection ([AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:245), [AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:268)).

   Mechanism: while visible, every streaming delta, composer keystroke/cursor motion, permission change, and 10 Hz spinner tick can rewrap all historical assistant text and recreate all projected objects. Composer activity explicitly bumps the repaint revision ([AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:494)); the spinner increments it every 100 ms ([AgentSpinner.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSpinner.ts:46)); RootView calls the pane render from the coarse frame effect ([RootView.ts](/home/parallels/dev/tui-editor/src/modules/ui/RootView.ts:1094), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:623)).

2. **FATAL — Transcript cost and memory are unbounded.**

   `AgentSession` owns a permanently append-only array with no cap, compaction, persistence rollover, or eviction ([AgentSession.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:17)). Raw tool inputs/results are retained, including arbitrarily large strings and objects ([AgentSession.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:142)). The pane additionally retains the full latest projected transcript ([AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:122)).

   Even when the pane is hidden, every ordinary app paint scans transcript history to find the oldest unresolved permission: the getter walks from entry zero ([AgentSession.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:55)) and `publish()` reads it unconditionally once the agent has been created ([Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:599)).

3. **FATAL — Wrapped editing can rewrap nearly the whole document every frame.**

   Wrapped scrollbar extent walks every document line ([EditorWrap.ts](/home/parallels/dev/tui-editor/src/modules/editor/EditorWrap.ts:267)) and is called during every RootView update ([ScrollbarSync.ts](/home/parallels/dev/tui-editor/src/modules/ui/ScrollbarSync.ts:263)). Locating the visible window also scans from line zero to the visual offset ([EditorWrap.ts](/home/parallels/dev/tui-editor/src/modules/editor/EditorWrap.ts:301)), despite the renderer describing the walk as O(window) ([EditorPaneRenderer.ts](/home/parallels/dev/tui-editor/src/modules/ui/EditorPaneRenderer.ts:216)).

   The claimed memoization does not rescue large files: the global wrap cache holds only 512 line/width entries and discards half on overflow ([EditorWrap.ts](/home/parallels/dev/tui-editor/src/modules/editor/EditorWrap.ts:46), [EditorWrap.ts](/home/parallels/dev/tui-editor/src/modules/editor/EditorWrap.ts:122)). A sequential pass over 50k distinct lines evicts earlier lines, so the next frame largely recomputes them. This directly contradicts the O(viewport) invariant.

4. **FATAL — The agent spinner runs while unobserved.**

   The spinner is controlled solely by `session.busy`, not pane visibility ([AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:128)). A pending permission leaves the session in `awaiting-tool`, hence busy, potentially indefinitely. Hiding the panel only changes visibility and focus ([PanelHost.ts](/home/parallels/dev/tui-editor/src/modules/ui/PanelHost.ts:258)); registered content is retained until application disposal ([PanelHost.ts](/home/parallels/dev/tui-editor/src/modules/ui/PanelHost.ts:304)).

   Thus a hidden agent awaiting approval continues a 10 Hz timer. It normally will not repaint because its revision is no longer observed, but it still violates “a resource lives only while observed.”

5. **SCOPING — Every five-second git reconciliation causes an unnecessary `git show`.**

   The required convergence floor schedules a background status refresh every five seconds ([GitWatcher.ts](/home/parallels/dev/tui-editor/src/modules/git/GitWatcher.ts:160)). `GitRepository` correctly avoids replacing unchanged status arrays, but always updates `lastRefreshAt` ([GitRepository.ts](/home/parallels/dev/tui-editor/src/modules/git/GitRepository.ts:101)). Bootstrap watches that timestamp and refreshes active HEAD text on every completion ([Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:376)), which fetches `HEAD:<file>` through git even when HEAD and the path are unchanged ([Workspace.ts](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:410)).

   Result: approximately 12 `git status` plus 12 redundant `git show` subprocesses per idle minute with an active file. The status floor is required; the unchanged blob fetch is not.

6. **SCOPING — Git blame avoids per-cursor spawns but has an unbounded process-lifetime cache.**

   The per-move spawn guard is sound: cache lookup plus an in-flight set ensures only one full-file blame per path/mtime ([GitBlame.ts](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:109)). However, the module-level cache retains a per-line `Map` for every file ever visited ([GitBlame.ts](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:42)). `clearCache()` exists but has no production caller ([GitBlame.ts](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:127)).

   Memory therefore grows with total lines across all historically opened files. The hot path also stats the file on every query, and both the status bar and status publisher query blame during a paint ([StatusBar.ts](/home/parallels/dev/tui-editor/src/modules/ui/StatusBar.ts:247), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:548)).

7. **SCOPING — Hidden sidebar datasets are rebuilt/scanned during unrelated animations.**

   Every live animation frame calls `syncPaneViewportGeometry()` ([Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:766), [RootView.ts](/home/parallels/dev/tui-editor/src/modules/ui/RootView.ts:1223)). That method rebuilds the entire git change-row array and scans it for width whenever a repository exists, without checking whether the git sidebar is visible ([ScrollbarSync.ts](/home/parallels/dev/tui-editor/src/modules/ui/ScrollbarSync.ts:216), [GitRows.ts](/home/parallels/dev/tui-editor/src/modules/git/GitRows.ts:39)). It also clamps tree horizontal scroll, whose extent scans all expanded rows ([FileTree.ts](/home/parallels/dev/tui-editor/src/modules/workspace/FileTree.ts:109)).

   An editor fling can therefore allocate and scan the complete hidden change set and expanded tree at frame rate.

8. **FLAG — Find highlighting is O(viewport × total matches).**

   For each visible line, the renderer filters the entire match array by line ([EditorPaneRenderer.ts](/home/parallels/dev/tui-editor/src/modules/ui/EditorPaneRenderer.ts:108)). A common query with thousands of matches multiplies full-match scans by viewport rows. Matches should be indexed by line or windowed after `findAll()`.

9. **FLAG — Narration playback has no queue bound or replacement policy.**

   Narration observation itself is incremental and timer-free ([NarrationProjection.ts](/home/parallels/dev/tui-editor/src/modules/narration/NarrationProjection.ts:61)), but completed turns append to an uncapped speech queue ([SystemTtsBackend.ts](/home/parallels/dev/tui-editor/src/modules/narration/SystemTtsBackend.ts:118), [SystemTtsBackend.ts](/home/parallels/dev/tui-editor/src/modules/narration/SystemTtsBackend.ts:143)). Users can produce turns faster than slow speech playback; only barge-in clears accumulated work.

### Perf-baselines harness

**FATAL — the harness cannot currently support several claims it prints.**

I ran `scripts/perf-baselines.sh` on `main@56fe6df`. Results:

- Idle final-window frames: **0**, CPU **0.80%** — idle renderer quiescence passed.
- RSS with fixture and one file: **156.0 MB**.
- RSS after 60 seconds with the 5 MB file: **167.1 MB**, versus the documented 121.4 MB.
- Reported cycle growth: **+20.4 MB**.
- Latency proxy: p50 **27 ms**, p95 **29 ms**.
- Lifecycle: 5/5 clean exits, no orphan process from the run.
- Script exit: **0**.

Mechanisms behind the evidence gap:

- Memory target failures deliberately do not affect exit status; only measurement failures and exact-zero idle violations do ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:16), [perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:352)). Consequently the soft gate cannot emit a warning for a 67 MB budget miss.
- The “re-open cycles” still assume opening replaces one document ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:231)). In the shipped tab model, later cycles mostly switch existing tabs; they do not exercise close/dispose/recreate.
- The script prints any cycle delta as “flat = no leak signal,” with no threshold or trend check ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:241)).
- Failure to open a buffer is merely a warning in idle and latency phases ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:159), [perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:307)).
- A three-second latency timeout is appended as though it were a valid sample; cursor movement is never asserted after the polling loop ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:311)).
- The idle assertion requires exactly zero frames, but the status clock intentionally requests one frame at a minute boundary ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:184), [StatusBar.ts](/home/parallels/dev/tui-editor/src/modules/ui/StatusBar.ts:227)). This can generate a false WARN depending on wall-clock alignment.
- Bare-process cold start is explicitly not measured ([perf-baselines.sh](/home/parallels/dev/tui-editor/scripts/perf-baselines.sh:292)); the baseline document acknowledges the gap ([project.performance-baselines.md](/home/parallels/dev/tui-editor/project.performance-baselines.md:34)).
- “Target miss or measurement gap” is generic merge-gate wording, not a diagnosis ([merge-gate.sh](/home/parallels/dev/tui-editor/scripts/merge-gate.sh:60)). The prior warning’s exact cause is not recoverable, and it did not reproduce today.

Minimal repair: make open/cursor-change preconditions hard measurement failures; drive actual close→dispose→reopen cycles and assert `bufferTabCount`/`bufferLiveCount`; allow only the expected minute-clock wake; return distinct exit codes for measurement failure versus target miss; and timestamp boot inside the app/status channel so bare startup excludes tmux/login-shell overhead.

Pixel preview did not produce a finding: decoding/rendering is single-slot memoized, and pixel emission is keyed so unchanged frames do not re-encode ([ImagePreview.ts](/home/parallels/dev/tui-editor/src/modules/image/ImagePreview.ts:19), [PixelImageMount.ts](/home/parallels/dev/tui-editor/src/modules/image/PixelImageMount.ts:63)). Commit history and commit expansions are also properly bounded and evicted.

## Dimension B — top 10 documentation fixes

1. **FATAL — Replace `project.progress.md`’s false “live” frontier.** It directs cold resumes to a 2026-07-21 queue ([project.progress.md](/home/parallels/dev/tui-editor/project.progress.md:3)), then later says tabs, diff, LSP, Markdown, and conversions are still pending after they shipped ([project.progress.md](/home/parallels/dev/tui-editor/project.progress.md:690), [project.progress.md](/home/parallels/dev/tui-editor/project.progress.md:794)). Keep one current snapshot and move historical session logs to an archive.

2. **FATAL — Recast the implementation plan as historical or rewrite its current state.** It still says Bun is not installed and the directory is not a git repository ([project.implementation-plan.md](/home/parallels/dev/tui-editor/project.implementation-plan.md:397)), and declares “No integrated terminal” as release scope ([project.implementation-plan.md](/home/parallels/dev/tui-editor/project.implementation-plan.md:122)). Both are plainly obsolete.

3. **FATAL — Remove contradictory runbook material from the lower handoff.** The current top anchor accurately lists the big feature run ([project.handoff.md](/home/parallels/dev/tui-editor/project.handoff.md:10)), but later claims ivue 2.0 plus a vendored `Static.ts`, `renderer.start()`, a gutter-only caret, the old lowercase coordinate filename, and an unfinished editor-title decoupling ([project.handoff.md](/home/parallels/dev/tui-editor/project.handoff.md:159), [project.handoff.md](/home/parallels/dev/tui-editor/project.handoff.md:176), [project.handoff.md](/home/parallels/dev/tui-editor/project.handoff.md:180), [project.handoff.md](/home/parallels/dev/tui-editor/project.handoff.md:208)). Actual dependencies are ivue 2.1 and Vue 3.6 RC ([package.json](/home/parallels/dev/tui-editor/package.json:14)); renderer uses `auto()` ([Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1649)); the title decoupling is complete ([RootView.ts](/home/parallels/dev/tui-editor/src/modules/ui/RootView.ts:942)).

4. **FATAL — Update `project.ivue-reference.md`.** It calls itself the authority while saying `Static()` is absent from ivue and static classes use raw `$Class` ([project.ivue-reference.md](/home/parallels/dev/tui-editor/project.ivue-reference.md:7)). The enforced convention and code now use `Static` from `ivue/extras`.

5. **SCOPING — Replace the architecture module map.** It lists only the original 16 domains ([project.architecture.md](/home/parallels/dev/tui-editor/project.architecture.md:46)). Missing major shipped modules: `agent`, `terminal`, `narration`, `image`, `layout`, `navigation`, `search`, and `settings`.

6. **FATAL — Correct the architecture lifecycle claim.** It says hidden resources are cooled or disposed and “nothing is merely hidden” ([project.architecture.md](/home/parallels/dev/tui-editor/project.architecture.md:54)). PanelHost retains terminal/agent contents until global disposal, and the hidden busy-agent spinner continues ticking. Document the actual persistent-session exception or make the implementation honor the stated tiers.

7. **SCOPING — Add the native agent architecture, not just a changelog entry.** Architecture lacks the backend seam, SDK/app-server choices, transcript ownership, permission state machine, live Claude/Codex switching, context port, composer/projection, and narration. The implementation spans provider selection and five backend forms ([AgentFactory.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentFactory.ts:35)) plus backend swapping in one session ([AgentSession.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSession.ts:87)).

8. **SCOPING — Document PanelHost, terminal, image/pixel tiers, and their lifecycle.** The architecture has no account of lazy PTY creation, split bottom-panel cells, terminal emulation, PNG/JPEG decoding, kitty/sixel placement, or half-block fallback. These are now first-class infrastructure, not UI details.

9. **SCOPING — Bring requirements’ gate and milestone claims current.** It says the settings applied-effect meta-gate is “being built” and LSP/Markdown remain allowlisted forward milestones ([project.requirements.md](/home/parallels/dev/tui-editor/project.requirements.md:77), [project.requirements.md](/home/parallels/dev/tui-editor/project.requirements.md:120)). The schema gate now enumerates all current settings ([smoke-settings-applied.sh](/home/parallels/dev/tui-editor/scripts/smoke-settings-applied.sh:24)), and live LSP/Markdown paths exist.

10. **SCOPING — Separate vision’s shipped Tier S from generated/future capability.** Vision says “Now” includes clickable evidence ([project.vision.md](/home/parallels/dev/tui-editor/project.vision.md:117)) and describes transcript folding, search, replay, audit, file-reference navigation, and real diff projection as present-tense behavior ([project.vision.md](/home/parallels/dev/tui-editor/project.vision.md:39)). Current pointer handling only cycles engines and folds tool rows ([AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:501)); transcript search/replay and clickable file evidence are not shipped. Mark these Tier M outputs explicitly. The same update should add Tokyo Night, branch-history viewing, move/duplicate line, blame, indent guides, and bracket matching to the progress/capability inventory.

## Read, validation, and exclusions

Read in full: `CLAUDE.md`, `project.conventions.md`, `project.ivue-reference.md`, `project.invariants.md`, `project.performance-baselines.md`, `project.architecture.md`, `project.vision.md`, `project.requirements.md`, `project.handoff.md`, `project.implementation-plan.md`, `project.progress.md`, and the required IBR/ivue/invariants skill instructions. I also inspected the relevant agent, app, UI, editor-wrap, git, narration, image, terminal, settings, and harness sources.

Read selectively: `project.agent-harness.md`, recent git history, package/build metadata, and affected module contracts/tests.

Skipped as outside the requested comparison: the full 3,245-line `project.brief.md`, `project.decisions.md`, lattice/delegation/conductor histories, terminal-feasibility narrative, and unrelated source modules.

Validation run:

- TypeScript: pass.
- Invariant checker: 390 annotations resolved, zero problems.
- Unit tests: 726 pass, zero fail.
- Full perf baseline: completed as reported above.
- Per instruction, I did not run `merge-gate.sh` or any `smoke-*.sh`.
- No files were edited. Pre-existing untracked `scratch-permission-test.txt` was left untouched.
