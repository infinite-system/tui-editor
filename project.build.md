# project.build.md — Build, Run, Test (the one place)

Invar is a terminal code editor built on **Bun + ivue + OpenTUI + Tree-sitter**. This file is the
single reference for how to run it from source, build the standalone binary, run the tests, and pass
the gate. Commands assume Bun is on PATH (`export PATH="$HOME/.bun/bin:$PATH"`).

## Prerequisites

- **Bun** ≥ 1.3.14 — the only hard requirement. It is the runtime, bundler, test runner, and package
  manager. Node/npm are **not** required.
- `bun install` once to populate `node_modules` (OpenTUI, ivue, vue, web-tree-sitter).
- Optional: `rg` (ripgrep) powers find-in-files; a Nerd-Font-capable terminal improves icons (the app
  auto-degrades to unicode/ascii).

## Run from source (development — always reflects current code)

```bash
bun run start          # opens the CURRENT directory as the workspace
bun run dev <dir>      # opens <dir> as the workspace, e.g. bun run dev ~/my-project
```

`start`/`dev` run `src/main.ts` directly; Bun transpiles the TypeScript on the fly each launch, so
whatever is in `src/` is what runs — no build step. This is the right mode for development and QA.

`NODE_ENV` defaults to **production** (set in `main.ts` before Vue loads). Export
`NODE_ENV=development` to run against Vue's dev build while developing:

```bash
NODE_ENV=development bun run dev <dir>
```

Production profile: prod Vue build; `StatusChannel` disk I/O is off unless `TUI_OBSERVE=1` (the test
harness sets it); idle is fully quiescent — demand-driven rendering, no at-rest frame loop.

Quit: `Ctrl+Q` or `F10` (in a host that intercepts those, `Ctrl+X` then `Ctrl+C`).

## The demo workspace (`/tmp/tui-demo`)

A ready-to-drive checkout lives at `/tmp/tui-demo` — the repo with `node_modules` symlinked and a
`fixtures/` sample tree carrying deliberate git changes (a modified file, a new untracked file, and a
staged deletion) so the git panel is populated on open. It tracks the latest green `main`.

Run it from source (recommended — reflects current code, no build step):

```bash
cd /tmp/tui-demo && PATH="$HOME/.bun/bin:$PATH" bun run src/main.ts .
```

Or build the standalone binary and run that:

```bash
cd /tmp/tui-demo && PATH="$HOME/.bun/bin:$PATH" bun run build && ./dist/invar .
```

The workspace argument is `.` (the demo dir itself). Quit with `Ctrl+Q` or `F10`.

## Build the standalone binary (distribution)

```bash
bun run build          # → dist/invar  (self-contained executable, ~30–60s)
./dist/invar .         # run the compiled binary against the current dir
```

- `build` = `bun build --compile --minify --external web-tree-sitter src/main.ts --outfile dist/invar`.
- The binary is ~120 MB: **most of that is the embedded Bun+JavaScriptCore runtime** (the baseline any
  `bun --compile` binary carries). The app itself is ~14k lines / ~1.2 MB of source; build-time deps
  (typescript, babel, …) are NOT in the binary. Runtime footprint ≈ 100 MB RSS, ~0% idle CPU.

### Why `--external web-tree-sitter` (and is the binary standalone?)

`@opentui/core` contains a **lazy** `import("web-tree-sitter/tree-sitter.wasm", { with: { type: "wasm" } })`
behind its tree-sitter code path. `bun build --compile` resolves dynamic-import targets at bundle time
and cannot bundle that wasm asset, so the build fails without `--external web-tree-sitter`.

**The compiled binary IS standalone today.** The syntax layer uses the regex `Highlighter` (the
immediate, never-blocks layer); the tree-sitter *deferred* layer is not wired, so the lazy wasm import
never fires and the external is never needed at runtime. Verified: the binary boots, opens a `.ts` file
(regex highlighting), and edits without touching the wasm path — you can run `./dist/invar` from
anywhere.

**When tree-sitter gets wired (future M-tier):** ship `node_modules/web-tree-sitter/tree-sitter.wasm`
beside the binary and make it resolvable (or drop `--external` once `bun --compile` supports the
`with: { type: "wasm" }` asset), gated behind the `LanguageRegistry` seam so the wasm loads only when a
real grammar is requested.

## Test & typecheck

```bash
bun run test           # bun test — the full unit/integration suite
bun run typecheck      # tsc --noEmit — type check only
```

Some tests use `fs.watch`; in sandboxes with exhausted inotify they `skipIf` a probe (they run on real
hardware). Feel/behavior invariants are covered by the driving smokes + contracts below, not by
`bun test` alone.

## The gate (must pass before every commit)

```bash
bun run gate           # scripts/merge-gate.sh — the hard-blocking merge gate
```

`merge-gate.sh` runs, all hard-blocking: `tsc`, `bun test`, the **conventions gate** (naming / namespace
/ manifest / atomic-bind / `$`-raw-form), **check-unwired-capabilities** (every capability has a live
caller), **check-map-coherence** (every governed module has a contract; every lattice reference
resolves), the **settings applied-effect** drives (every settings field actually changes behavior), the
**behavioral contracts** (`behavioral-contracts.sh` — momentum glide, wrap-scroll, idle-quiescence,
open-then-scroll), and the driving **smokes** (`smoke-editor`, `smoke-tabs`, `smoke-tree-scroll`,
`smoke-wrap`, `smoke-git-watch`, `smoke-find`). A regression in any of these blocks the commit — the
project's "MEASURED ≠ ENFORCED" rule made real.

Run pieces individually while iterating:

```bash
bun run contracts      # behavioral-contracts.sh (feel invariants, driven)
bun run smoke          # smoke-editor.sh (open/scroll/select/copy, driven via tmux)
bun run check          # conventions-gate.sh (structure/naming only, fast)
```

Startup / RSS / idle-CPU baselines: `scripts/perf-baselines.sh` → `project.performance-baselines.md`.

## Verification discipline (why the smokes exist)

Feel/behavior is verified by **driving the real path** (tmux input + FrameProbe framebuffer +
`status.json`), never by reading code or trusting an internal value — internal `scrollTop` can read
"565" while the screen shows line 1 (a false green). Every user-reported regression becomes a permanent
driven contract (the ratchet), so it cannot silently recur. When adding a feature: wire it into the
running app **and** add a driving smoke in the same change — an isolated unit test alone does not count
as done.

## Layout

- `src/main.ts` — entry. `src/modules/<domain>/` — one folder per domain (editor, git, diff, ui, …),
  each a namespace/capability with a colocated `*.invariants.md` contract.
- `scripts/` — gates, smokes, harnesses, and `delegate-packet.sh` (builds a worker's cold-start prompt).
- Governance (read-first): `project.brief.md`, `project.requirements.md`, `project.conventions.md`,
  `project.invariants.md`, `project.lattice.md`, `project.progress.md`.

## Troubleshooting

- **Scroll/keys do nothing after opening a file** → make sure you're on current `src/` (this class of
  bug is gated by the open-then-scroll contract).
- **Syntax highlighting missing** → today's binary uses the regex highlighter and needs nothing extra;
  when the tree-sitter layer lands, ship the wasm per the section above.
- **Many stale `bun run src/main.ts` processes** → headless test sessions can leak instances. Reap only
  the leaked `bun` processes by PID — never a bare `pkill -f 'src/main.ts'`, because that pattern also
  matches the shell running it and kills your own session:
  ```bash
  for p in $(pgrep -f 'src/main.ts'); do [ "$(cat /proc/$p/comm 2>/dev/null)" = bun ] && kill "$p"; done
  ```
  (only when no real instance is running; the merge-gate now reaps `/tmp/tui-*` orphans itself before running).
