# Handoff — resuming the autonomous TUI build

Full authority to build the whole thing to completion (brief Definition of Done + the §5.1 gate).
Files on disk survive context compaction; this file + PROGRESS.md are the durable memory.

## MUST RE-READ ON RESUME (in order — highest signal first)
1. `PROGRESS.md` — the live checklist + the EXACT next action (file/function/change).
2. This file (`HANDOFF.md`) — role, API facts, protocols, settled decisions.
3. The contract(s) for whatever you're mid-work on. Editor rework frontier →
   `src/modules/editor/editor.invariants.md`, `src/modules/app/app.invariants.md`,
   `src/modules/ui/ui.invariants.md`. A module merge → that module's `*.invariants.md`.
4. `project.invariants.md` + `project.lattice.md` — the generators everything derives from.
5. `project.implementation-plan.md` — §3 conventions, §4 milestones, §5 the verification gate.
6. `project.decisions.md` — the 10 ivue decisions + the 3 study corrections (vue dep, vendored
   Static/kernel, createX-is-ours).
7. `project.ivue-reference.md` — the flyweight + exact ivue patterns (only if writing ivue code).
8. Source at the current frontier (from PROGRESS "Next action"): typically
   `src/modules/ui/RootView.ts` (caret/selection render), `src/modules/editor/{Editor,Cursor,TextDocument,editor.coordinates}.ts`, `src/modules/app/Bootstrap.ts`.

## What this is
A terminal code workspace on Bun + ivue + OpenTUI + Tree-sitter + git, built to
`FABLE_TUI_EDITOR_BUILD_BRIEF_FINAL.md`, governed by the IBR `/invariants` method.

## Your role
Sole builder + governor. You own the critical editor core and ALL review/integration/verification.
Delegate well-scoped implementation to **codex** (worktrees) + **subagents** to keep context lean;
do the subtle/central work yourself. Review every delegated output against its contract + run
checker + `bun test` before merging. Deprecate sub-par output (don't patch around it).

## Environment / runbook
- Bun `~/.bun/bin/bun` (1.3.14): `export PATH="$HOME/.bun/bin:$PATH"`. Run `bun run <f>`; test `bun test`.
- Typecheck `bunx tsc --noEmit; echo TSC=$?` — **NEVER pipe tsc through tail/tee** (masks the exit code; this trap already bit two audits).
- Invariants checker (in the ibr repo — do NOT copy here):
  `node /home/parallels/dev/ibr/.claude/skills/invariants/scripts/check_invariants.mjs --all|--refs|--score`
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
- codex workers write files UNTRACKED in `.claude/worktrees/codex-<mod>/` and do NOT self-commit/self-add. **Integration is the main loop's job**: review code vs the contract, run tsc + `bun test` + checker in the worktree, fix issues (or send a precise follow-up), then copy into master (`cp -r .claude/worktrees/codex-<m>/src/modules/<m>/. src/modules/<m>/ && rm -f src/modules/<m>/.gitkeep`), verify on master, commit crediting codex. **codex often SKIPS tests + the contract** — add them (or delegate to a subagent, then review).

## Settled decisions (do NOT re-litigate)
- Reactive frame effect: WIRE IT (done). Coordinate model: grapheme-based via Intl.Segmenter (done).
- Editor rework order: reactive frame → coordinate → **caret** → selection + copy/cut/paste (`Clipboard` capability: wl-copy/xclip/pbcopy + OSC 52) → multi-workspace → search → piece-table undo.
- `Static()` only for stateless capability classes; stateful stay plain instance.
- Contracts-first governance; module contracts bootstrapped per milestone; docs named `project.<role>.md` / `<module>.<role>.ts`; PascalCase class files.
- Verification: tmux + status.json for state; tsc + tests green at EVERY commit.

## The blackline large-project acceptance test (REQUIRED for the gate — see VERIFICATION_RESULTS.md)
- ISOLATED WORKTREE ONLY, never touch live blackline-app:
  `git -C /home/parallels/dev/blackline/blackline-app worktree add /home/parallels/dev/blackline/bl-tui-test HEAD`, point the editor there, edit/revert, then
  `git -C /home/parallels/dev/blackline/blackline-app worktree remove --force /home/parallels/dev/blackline/bl-tui-test` and confirm blackline-app is untouched.
- 5 checks: files-load-at-scale, keyboard editing (write to disk in the worktree then revert), mouse (record unsupported affordances explicitly), shortcut pane/page nav (keyboard-only, no dead-ends), folder expand/collapse (lazy). Drive under tmux, assert from status.json.

## Rules
- Never block on a question — pick the best contract-consistent default, record it in `project.decisions.md`, keep going. Surface only a TRUE hard blocker (missing credential / ambiguous product call with no safe default).
- Commit frequently. Keep PROGRESS.md + this file current every few turns. codex not trusted with deletions; commit before delegating.
