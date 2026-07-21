# Build & run

## Development
```
bun run src/main.ts [directory]
```
`NODE_ENV` defaults to `production` (set in `main.ts` before Vue loads); export
`NODE_ENV=development` to run against Vue's dev build while developing.

## Production profile (interpreted)
```
NODE_ENV=production bun run src/main.ts [directory]
```
Prod Vue build, and `StatusChannel` disk I/O is off unless `TUI_OBSERVE=1` (the harness sets it).
Idle is fully quiescent (demand-driven rendering — no at-rest frame loop).

## Standalone binary
```
bun run build:prod        # -> dist/fable (compiled, minified, ~120 MB incl. the bun runtime)
./dist/fable [directory]
```

### Why `--external web-tree-sitter`
`@opentui/core` contains a LAZY `import("web-tree-sitter/tree-sitter.wasm", { with: { type: "wasm" } })`
behind its tree-sitter code path. `bun build --compile` resolves dynamic-import targets at bundle
time and cannot bundle that wasm asset, so the build fails without `--external web-tree-sitter`.

This is SAFE today because the syntax layer uses the regex `Highlighter` (the immediate,
never-blocks layer); the tree-sitter deferred layer is not wired, so the lazy import never fires and
the external is never needed at runtime. Verified: the compiled binary boots, opens a `.ts` file
(regex highlighting), and edits — the wasm path is never touched.

**When tree-sitter is wired (future M-tier):** ship `node_modules/web-tree-sitter/tree-sitter.wasm`
beside the binary and make it resolvable (or drop `--external` once `bun --compile` supports the
`with: { type: "wasm" }` asset), and gate the grammar load behind the `LanguageRegistry` seam so the
wasm loads only when a real grammar is requested.

## Startup / size / RSS
Comprehensive baselines (startup vs the <150ms budget, RSS vs ~100 MB, idle CPU) are measured by
`scripts/perf-baselines.sh` into `PERFORMANCE_BASELINES.md`. Spot check: the compiled binary boots
through the tmux harness and loads a workspace; interpreted prod RSS ≈ 100 MB.
