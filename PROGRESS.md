# Build Progress — Fable TUI Code Workspace

Live status ledger for the autonomous build. Updated continuously so state survives
context compaction. If you are resuming: read this, then `HANDOFF.md`, then continue at the
first unchecked item.

## Environment (established this session)
- Bun installed at `~/.bun/bin/bun` (v1.3.14). PATH: prefix commands with `export PATH="$HOME/.bun/bin:$PATH"`.
- Deps installed (`bun install` clean): `@opentui/core@0.4.5`, `ivue@2.0.0`, `vue@3.5`, `web-tree-sitter`.
- ivue reactivity proven headless under Bun (`scripts/ivue-smoke.ts` → ok).
- Run a file: `bun run <file.ts>`. Test: `bun test`.
- OpenTUI API learned: `createCliRenderer(config)` → `CliRenderer`; `.root` (RootRenderable, flex),
  `.requestRender()`, `.start()`, `.resize(w,h)`, `.destroy()`, `.keyInput` (EventEmitter: `keypress` → KeyEvent{name,ctrl,shift,meta,option,sequence,repeated}), `.on('resize')`.
  Renderables: `BoxRenderable`, `TextRenderable`, `ScrollBoxRenderable`, etc. from `@opentui/core`.
  Layout via Yoga flex: `flexGrow/flexDirection/width/height/padding` in RenderableOptions.
- ivue pattern: `class $X { get state(){return ref()} get derived(){...} method(){} }` +
  `namespace X { const $Class=$X; let Class=Reactive($Class); type Instance=typeof Class.Instance }`.
  Late deps via getters; no top-level `new ImportedClass()`.

## Milestones
- [x] M0 — Setup & foundations (fork did scaffold; Bun installed; docs read; project.invariants.md exists)
- [ ] M1 — Boot & Frame (app/kernel/system) — IN PROGRESS
- [ ] M2 — Workspace + file browser + read-only editor + syntax + theme
- [ ] M3 — Editing (buffer/cursor/selection/undo/movement/search/palette)
- [ ] M4 — Git + diff
- [ ] M5 — TypeScript LSP + diagnostics
- [ ] M6 — Markdown preview
- [ ] M7 — Plugin demonstration
- [ ] Gauntlet — 5-pass refinement + independent subagent panel

## Decisions
- Building modular per plan §3, but vertical-slice-first within each milestone to keep it runnable.
- Observability side channel: app writes `artifacts/status.json` each render (workspace, buffer,
  revision, dirty, diagnostics count, subprocess PIDs, lifecycle tier) for the tmux harness.
- Priority: a genuinely working editor covering the brief's Definition of Done. Completion-gate
  artifacts (§5.1) produced as far as the night allows; honesty about partial green in final report.
