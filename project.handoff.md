# Handoff — resuming the autonomous TUI build

Full authority to build the whole thing to completion (brief Definition of Done + the §5.1 gate).
Files on disk survive context compaction; this file + `project.progress.md` are the durable memory.

## RESUME ANCHOR — 2026-07-24 (CURRENT) — POST-BIG-RUN REVIEW PHASE

**Ground-truth against git first — anchors lag. `origin/main` was `95f4879` at this writing.**

**State: the 2026-07-23→24 big run is FULLY LANDED.** In one continuous session: bracketed paste +
Hex dictation (app-wide), narration fixes (Escape-only barge-in, prose-not-markdown, inline-code
speakable), voice picker + speech rate + mouse-editable sectioned settings, the whole agent-pane
rebuild (shared ScrollableTextViewport momentum scroll + selectable/copyable transcript+composer via
TextSelectionModel/WrapText seams, multi-line composer with movable cursor + word motion/deletion,
framed chrome, 19-word IBR thinking indicator, human-readable AgentToolSummary), terminal gutter
padding, Tokyo Night (accurate spec) + truecolor auto-detection, JPEG preview via ImageDecoders +
real-pixel tiers (kitty→sixel→half-block via OpenTUI capability report), interactive permission
prompts (Claude Agent SDK canUseTool y/n/a + session auto-allow) with CODEX PARITY (app-server
approvals), live claude⇄codex engine switch with transcript context port, git log tip-SHA freshness +
read-only branch viewer, AppLoader (overridable entry), namespace-pattern enforcement (hardened gate,
zero stragglers), and ALL FOUR experiments adopted (move-line, git-blame, indent-guides + indentGuide
palette role, bracket-match). Every branch parked (NEVER deleted — see AGENTS.md #6) and tagged
finished/ or orphaned/.

**Current phase (goal-hooked): verify → independent review → refine.** Three independent codex
reviewers (correctness / architecture-seams / perf+docs) run against main; their reports are triaged
(severity: fatal/scoping/flag), best advice implemented through the normal gate door. Known follow-up
candidates: full perf-baselines run (the whole run used SKIP_PERF=1 — perf is UNMEASURED), the
perf-baselines "measurement gap" WARN, themed terminal ANSI-16, bracket-rotation + syntax sub-roles
from the Tokyo spec, kitty-tier over-SSH verification.

**Doctrine reminders for any cold resume:** re-read /conductor SKILL.md (doctrine you merely remember
is doctrine you will violate); one gate at a time, conductor's own heavy work included; load-canary
watchlist = smoke-wrap + smoke-selection (re-run solo before believing a red); branches never deleted;
verify by driving; provenance decides main.

---

## RESUME ANCHOR — 2026-07-23 (SUPERSEDED by the 2026-07-24 anchor above) — OVERNIGHT AUTONOMOUS RUN

**Session shape:** conductor (main loop) directing a background FORK (`a0f12abb2a300d596`) + scoped
workers. **USER IS ASLEEP → full autonomy: make ALL calls yourself, do NOT ask/defer. The fork has
STANDING AUTHORITY to merge on a clean ALL-PASS gate** (guardrails: finished/ tag, main-advance via
origin only, never touch the primary checkout, verify by driving) without per-merge approval. Follow
the `/conductor` skill; read its "Instantiating a fresh conductor" section if resuming cold.
**Ground-truth against git — this anchor lags.** `origin/main` was `05108bd` at this writing.

- **DONE + merged:** all 11 UI tasks · pull-diagnostics (tsgo now surfaces red diagnostics) · diff
  batch (tasks 1+6: +/− prefixes, no tabs in diff) · all conductor docs/tooling. Tags:
  `finished/feat-diff-batch`, `finished/feat-pull-diagnostics`, `finished/feat-two-line-tabs-v2`.
- **REMAINING backlog (fork drives autonomously, in order):**
  1. **Tooltip bundle** — MERGING on clean re-gate (was `b2h3ze016`): hover-diagnostic surfacing
     (hover over a TS error shows the message, not `any`) + its smoke. Merge on green + finished/ tag.
  2. **Last-char off-by-one** — own gated batch (shared `SelectionDragBehavior`, drags N copies N−1;
     affects editor+diff). Ratchet a smoke.
  3. **Activity bar** — CHERRY-PICK `feat-activity-bar` @ `2723f28` onto post-tooltip main (NOT a
     branch merge; stale base). Conflicts RootView+Workspace keep-both. +4-col shift needs +4 on
     smoke-scrollbars/find/hover/diff (subagent already did smoke-editor). Then TOGGLE: `showActivityBar`
     setting + `Ctrl+Shift+B` + palette "View: Toggle Activity Bar".
  4. **Two-line-tabs refinement** — FLIP the logic: line1 = PROJECT name (a worktree shows its PARENT
     project, via git-common-dir parent, not its own folder); line2 = current BRANCH, REACTIVE to
     `git checkout` (watch HEAD), detached → short SHA; + char-cap with `…` on both lines. Edits
     Workspace.ts (sequence after activity-bar — Workspace overlap).
  5. **#5 undo-reads-unchanged** — file-changes: undo-to-original reads as UNCHANGED (dirty-tracking).
  6. **Follow-ups:** macOS-Terminal mouse investigation (below) · invariant↔smoke coverage checker ·
     add the smoke-coverage line to the merge-gate ALL-PASS reminder.
- **DRAG-SELECT "regression" — RESOLVED as NOT a HoverCard bug.** The fork drive-proved the card's
  drag-select works in-harness + is smoked (smoke-hover:159–183 green); do NOT fabricate a fix. The
  user saw it break in **macOS Terminal.app** — almost certainly a MOUSE-PROTOCOL path the SGR harness
  can't exercise (Terminal.app may not honor SGR mode 1006 → X10 fallback, coords capped 223). Fix
  DEFENSIVELY in TerminalSession/TerminalCapabilities; CAN'T drive-verify here (needs macOS) — user
  verifies when awake.
- **Doctrine/tooling shipped this session (durable):** `/conductor` skill (agent-priming, never-destroy-
  recovery-points, fresh-conductor bootstrap, smoke-coverage ratchet, verbatim cron prompts, hourly loop
  may refine the skill) · `AGENTS.md` priming · branch END-STATES active/`finished/`/`orphaned/` (never
  delete) · `.claude/settings.json` deny-lists (git-destructive + rm-rf) in BOTH repos · `check_invariants
  --refs-for '<name>'` (retirement-sweep primitive).
- **EPHEMERAL fleet (re-establish on resume — do NOT assume alive):** crons `e4de2d1a` (loop-check 10min)
  + `43217ab5` (hourly; can now refine SKILL.md); fork `a0f12abb2a300d596`. Demo: `/tmp/tui-demo` (user's
  running, detached worktree) + `/tmp/tui-demo-main` (fresh clone on main, for testing). Primary checkout
  is CLEAN + synced to origin.

---

## RESUME ANCHOR — 2026-07-21 (compaction checkpoint, SUPERSEDED — historical) — FULL-POWER build in flight

- **2 INVARIANTS WORKERS IN FLIGHT (mine, spawned post-checkpoint):** general-purpose agents bootstrapping
  `src/modules/theme/theme.invariants.md` (agent a30a1f3d79bafd368) + `src/modules/commands/commands.invariants.md`
  (agent ade4f0f8fa08ff9fb). They write the invariants.md + code annotations + run check_invariants.mjs;
  they do NOT commit or touch scripts/. **ON RESUME:** look for their UNCOMMITTED output (theme.invariants.md
  / commands.invariants.md + `// invariant:` annotations in those modules); REVIEW for LOAD-BEARING quality
  (reject decorative — each needs a real Impossible-if-true); run `node .claude/skills/invariants/scripts/
  check_invariants.mjs --all --refs` (0 problems); then REMOVE that module from ALLOWLIST_NAMES in
  scripts/check-map-coherence.sh + verify `bash scripts/check-map-coherence.sh` PASS; commit crediting the
  agent. If output is missing/sub-par, redo or re-spawn. Continue-an-agent via SendMessage(to: <agentId>).
- **🔴 HIGH-PRIORITY: render-pump FREEZE resilience** — see project.progress.md top ("HIGH-PRIORITY
  ROBUSTNESS BUG"). An unhandled exception in a frame/input handler stalled the demand-driven loop → froze.
  Wrap onFrame + reactive paint + input handlers in try/catch (log to file, NOT TTY, keep loop alive) +
  gated contract. Do EARLY.
- **HEAD (docs commit follows this)** · tsc + conventions-gate PASS · adoption + freeze + invariants-review
  are the resume queue.
- **THE GOVERNING PRINCIPLE:** the PRODUCT NORTH STAR in `project.requirements.md` (learnable in ~15 min,
  zero prior knowledge, kid-to-grandpa) — the acceptance lens on EVERY UI feature + its 3 proxy gates
  (click/tooltip/palette-shortcuts completeness). Read it FIRST for any UI work.
- **THE PLAN:** `project.progress.md` → "FULL-POWER BLOCK" (priority-ordered) + "PANE SUBSTRATE" (the
  deferred editor→pane refactor) are the live queues.
- **RECENTLY LANDED (this session):** unwired-capability gate + Definition of Done · all 8 dead settings ·
  DiffView P1 mount (2cced35) · TIER-0 merge-gate (behavioral-contracts + smokes + settings-applied all
  hard-blocking; `bash scripts/merge-gate.sh` / `bun run gate`) · focus-on-open scroll fix (9f66bbd, root
  cause = over-tracking $watchEffect) + open-then-scroll contract · Ctrl+F/H find/replace (713623f) ·
  Ctrl+P quick-open (b84e700) · scroll-momentum→Momentum Static (6a67412) · map-coherence gate (c9aff34) ·
  builddoc/naming/npm-scripts (e871b7b) · NORTH STAR encoded (3451999).
- **ADOPTION QUEUE (coordinator holds these worktrees; each = merge→wire→driving-smoke in ONE commit under
  the merge-gate; all sanity-passed by the coordinator, NEW isolated files, zero conflict):**
  - `conductor-ripgrep` → src/modules/search/RipgrepSearch.ts — the Search view (find-in-files).
  - `conductor-activitybar` → src/modules/ui/ActivityBar.ts (+test, 5 pass) — icon strip; onSelectView
    callback + activeView input. I copied it once + removed it (unwired would fail the gate) — RE-ADOPT +
    WIRE (mount far-left, switch sidebar view, Ctrl+Shift+E/F/G + click, active highlight, persist last
    view to a new setting + applied-effect test). sidebarView is currently 'files'|'git' (Workspace.ts:171)
    — extend to map explorer→files / sourceControl→git / search→Search view / settings→toggle Ctrl+,.
  - `conductor-shortcuts` → src/modules/ui/ShortcutsView.ts (+test, 5 pass) — consumes the DEAD
    KeybindingRegistry.effectiveBindings(); wire F1/Ctrl+/ open + Esc + a status-bar "?" button.
  - `conductor-quickopen` / `conductor-findbuffer` / `conductor-mapgate` / `conductor-builddoc` — ALREADY
    ADOPTED (committed); coordinator can remove those worktrees.
- **INTEGRATION PATTERNS proven this session (reuse):** overlay modal = command-palette pattern (absolute
  BoxRenderable zIndex 100, root.add, visible-toggle, content projected in update(), a dedicated onKey
  context + isTypedCharacter). See FindBar (find bar) + QuickOpen (Ctrl+P) in RootView/Bootstrap. The
  clickable-buttons pattern = the tab-arrow "single geometry source for render + hit-test".
- **SANDBOX GOTCHAS (env, not code):** `rg` is a shell-function shim here (no real ripgrep) → QuickOpen has
  a git ls-files fallback; fs.watch throws EMFILE (inotify exhausted) → GitWatcher tests skipIf. Both work
  on the user's real machine. Kill stray tmux sessions if EMFILE bites (`tmux kill-server`).

## MUST RE-READ ON RESUME (in order — highest signal first)
0. `project.conventions.md` — THE operative convention set (deterministic self-handoff: load this
   BEFORE anything; every turn status carries `conventions @ <git hash of the file>`).
1. `project.progress.md` — the live checklist (USER PIPELINE) + the EXACT next action (file/function/change).
2. This file (`project.handoff.md`) — role, API facts, protocols, settled decisions.
3. The contract(s) for whatever you're mid-work on. Editor rework frontier →
   `src/modules/editor/editor.invariants.md`, `src/modules/app/app.invariants.md`,
   `src/modules/ui/ui.invariants.md`. A module merge → that module's `*.invariants.md`.
4. `project.invariants.md` + `project.lattice.md` — the generators everything derives from.
5. `project.implementation-plan.md` — §3 conventions, §4 milestones, §5 the verification gate.
6. `project.decisions.md` — the 10 ivue decisions + the 3 study corrections (vue dep, vendored
   Static/kernel, createX-is-ours).
7. `project.ivue-reference.md` — the flyweight + exact ivue patterns (only if writing ivue code).
8. Source at the current frontier (from `project.progress.md` "Next action"): typically
   `src/modules/ui/RootView.ts` (caret/selection render), `src/modules/editor/{Editor,Cursor,TextDocument,editor.coordinates}.ts`, `src/modules/app/Bootstrap.ts`.

## What this is
A terminal code workspace on Bun + ivue + OpenTUI + Tree-sitter + git, built to
`project.brief.md`, governed by the IBR `/invariants` method.

## Your role
Sole builder + governor. You own the critical editor core and ALL review/integration/verification.
Delegate well-scoped implementation to **codex** (worktrees) + **subagents** to keep context lean;
do the subtle/central work yourself. Review every delegated output against its contract + run
checker + `bun test` before merging. Deprecate sub-par output (don't patch around it).

## Environment / runbook
- Bun `~/.bun/bin/bun` (1.3.14): `export PATH="$HOME/.bun/bin:$PATH"`. Run `bun run <f>`; test `bun test`.
- Typecheck `bunx tsc --noEmit; echo TSC=$?` — **NEVER pipe tsc through tail/tee** (masks the exit code; this trap already bit two audits).
- Invariants checker (in the ibr repo — do NOT copy here):
  `node .claude/skills/invariants/scripts/check_invariants.mjs --all|--refs|--score`
- Deps: `ivue@2.0.0`, `vue@3.5.40`, `@opentui/core@0.4.5`, `web-tree-sitter@0.26.11`. Vendored `src/modules/system/Static.ts`.
- codex worktrees: `.claude/worktrees/codex-<mod>` (branch `codex/<mod>`, node_modules symlinked). Prompts `scripts/codex/*.prompt.txt`. Drive: `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C <worktree> "$(cat prompt)"`.

## Key API / pattern facts (easy to forget after compaction)
### ivue
- `import { Reactive } from 'ivue'`; `ref/shallowRef/computed/watch/watchEffect` from `'vue'`.
- Namespace: `class $X {...}` + `export namespace X { export const $Class=$X; export let Class=Reactive($X); export type Model=InstanceType<typeof Class>; export type Instance=typeof Class.Instance }`.
- `$watch/$watchEffect/$stopEffects` are injected on the WRAPPED instance, NOT the raw `$X` type.
  Inside a class method, cast: `(this as { $stopEffects?: () => void }).$stopEffects?.()`.
- Plain getters for cheap derived state (NOT `computed()`); `ref`-getters for state.
- Late dep reads (getter/method bodies, never top-level `new`/`const C = X.Class`).
- Owned deps via overridable `createX()` seams: `field = this.createDep(); protected createDep(){ return new Dep.Class() }` — NOT `field = new Dep.Class()`.
- Stateless capability classes → `Static($X)` (vendored `system/Static.ts`); stateful (identity+lifetime) → plain instance `let Class = $X`.
### OpenTUI (@opentui/core)
- `createCliRenderer({exitOnCtrlC:false, targetFps})` → renderer. `.root`, `.requestRender()`, `.start()`, `.destroy()`, `.keyInput.on('keypress', KeyEvent{name,ctrl,shift,meta,option,sequence,repeated})`, `.on('resize')`, `.on('frame')/.once('frame')`, `.width/.height`.
- `BoxRenderable, TextRenderable, StyledText, fg, type TextChunk` from `@opentui/core`. Yoga flex layout (`flexGrow/flexDirection/width/height/padding`). Renderable `.height/.width` are NON-reactive layout values (read after a frame; synced to viewport on boot/resize only).
- Caret: currently a gutter `▏` bar (`ui/RootView.ts` `renderEditorStyled`, ~line 185). TODO next: a real caret at `displayColumn(line, cursor.col)` — first check @opentui/core for a native cursor API (grep node_modules/@opentui/core for `cursor`); else a block caret (invert the grapheme cell at the display column).
### Coordinate model (`src/modules/editor/editor.coordinates.ts`) — DONE
- Three non-coinciding coords: grapheme index (cursor "col"), UTF-16 offset (slicing + LSP), display column (rendering; tab + wide-char aware). Fns: `graphemeToU16, u16ToGrapheme, graphemeCount, displayColumn, graphemeWidth, lineWidth, clampCol` (via `Intl.Segmenter`).
- `TextDocument` edit ops take `col = grapheme index` (convert to UTF-16 to slice); `Editor` `curLineLen/moveVertical/moveHorizontal` count graphemes. NEVER slice by raw UTF-16 for cursor ops (splits surrogate pairs).
### Reactive frame effect (`src/modules/app/Bootstrap.ts`) — DONE
- ONE `app.$watchEffect` touches load-bearing signals (`document.revision`, `cursor.line/col`, `viewport.scrollTop`, `workspace.focus`, `tree.selectedIndex`, `commands.open/query/selectedIndex`, `theme.paletteName`) → `paint()` = `view.update()` + `publish()` + `requestRender()`. Handlers MUTATE ONLY. `setSize` on boot/resize (OUTSIDE the effect — no feedback loop). `$stopEffects` on dispose. Contract: `app.invariants.md` "Rendering is one coarse frame effect".
### status.json side-channel (`system/StatusChannel`)
- `StatusChannel.Class.update(patch)/flush()/settle(frame)` → atomic write to `artifacts/status.json`. Fields: activeWorkspace/workspaces, activeBuffer, bufferRevision, dirty, cursor{line,col}, openBuffers, focus, treeRows/treeSelected, overlay/paletteQuery/paletteMatches, ready, lifecycleTier, width/height, git* (branch/head/staged/unstaged/untracked counts/refreshing/error), settle frame counter. tmux harness asserts STATE from here; pane-capture for visual only.
### codex review-and-commit protocol
- codex workers write files UNTRACKED in `.claude/worktrees/codex-<mod>/` and do NOT self-commit/self-add. **Integration is the main loop's job**: review code vs the contract, run tsc + `bun test` + checker in the worktree, fix issues (or send a precise follow-up), then copy into main (`cp -r .claude/worktrees/codex-<m>/src/modules/<m>/. src/modules/<m>/ && rm -f src/modules/<m>/.gitkeep`), verify on main, commit crediting codex. **codex often SKIPS tests + the contract** — add them (or delegate to a subagent, then review).

## Settled decisions (do NOT re-litigate)
- Reactive frame effect: WIRE IT (done). Coordinate model: grapheme-based via Intl.Segmenter (done).
- Editor rework order: reactive frame → coordinate → **caret** → selection + copy/cut/paste (`Clipboard` capability: wl-copy/xclip/pbcopy + OSC 52) → multi-workspace → search → piece-table undo.
- `Static()` only for stateless capability classes; stateful stay plain instance.
- Contracts-first governance; module contracts bootstrapped per milestone; docs named `project.<role>.md` / `<module>.<role>.ts`; PascalCase class files.
- Verification: tmux + status.json for state; tsc + tests green at EVERY commit.

## The blackline large-project acceptance test (REQUIRED for the gate — see project.verification-results.md)
- ISOLATED WORKTREE ONLY, never touch live blackline-app:
  `git -C /home/parallels/dev/blackline/blackline-app worktree add /home/parallels/dev/blackline/bl-tui-test HEAD`, point the editor there, edit/revert, then
  `git -C /home/parallels/dev/blackline/blackline-app worktree remove --force /home/parallels/dev/blackline/bl-tui-test` and confirm blackline-app is untouched.
- 5 checks: files-load-at-scale, keyboard editing (write to disk in the worktree then revert), mouse (record unsupported affordances explicitly), shortcut pane/page nav (keyboard-only, no dead-ends), folder expand/collapse (lazy). Drive under tmux, assert from status.json.

## Rules
- Never block on a question — pick the best contract-consistent default, record it in `project.decisions.md`, keep going. Surface only a TRUE hard blocker (missing credential / ambiguous product call with no safe default).
- Commit frequently. Keep `project.progress.md` + this file current every few turns. codex not trusted with deletions; commit before delegating.

## Deferred: buffer-tab de-fieldset (part 4) — decouple find-source identity from the display title
The buffer-tab restyle shipped 3 parts (breadcrumb, powerline separator, first-tab gap/color). Part 4
— removing the redundant filename BORDER LEGEND on the editor pane (blank `editorArea.title`) — is
DEFERRED because it deterministically breaks `scripts/smoke-markdown.sh`: with the title blanked
(`''` or `' '`) the markdown find pane reports `source=''` and a source paste no-op (`revision 1 -> 1`);
restoring the filename title makes it ALL-PASS (bisected — not a flake).
ROOT CAUSE (the bug under the bug): the find/paste pane's SOURCE IDENTITY is derived from
`editorArea.title`, a DISPLAY string — identity must never key off a display value (expression ≠
essence). PROPER FIX (not "put the title back"): DECOUPLE — give the pane a stable source identifier
(the document PATH) independent of the visible title, so the border legend can be blanked/restyled
freely. Likely bundled with the status-bar terminal-toggle button (same RootView/editor-pane region).
See memory reference-editorarea-title-markdown-coupling.
