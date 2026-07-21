# App — Invariants

Load-bearing rules for `src/modules/app/` (`App`, `Bootstrap`) — the composition root and the
render loop. Stands on `project.invariants.md`.

## Reality-based invariants

_None specific — the app layer consumes the project reality invariants (the terminal shows a
bounded viewport; a referenced resource stays alive)._

## Chosen invariants

### Rendering is one coarse frame effect

**Invariant:** If model state changes — by input OR by an async producer (syntax, LSP, git) —
then a single owned reactive effect observes it and repaints; a repaint is never conditional on a
keypress, and no per-item render effect exists.

**Scope:** The render loop in `app/Bootstrap.ts` + `App`'s owned effect scope.

**Mechanism:** `app.$watchEffect(...)` touches the load-bearing signals (document revision, cursor
line/col, viewport scrollTop, workspace focus, tree selection, palette open/query/selection, theme
selection) then calls `paint()` = `view.update()` + `publish()` + `requestRender()`. `paint()` is
read-only over model state, so the effect never self-triggers. `viewport.setSize` (a
projection→model write) is kept OUTSIDE the effect, on boot + resize only. Input handlers mutate
model state and nothing else — the effect repaints. Realizes *Data flows one way* (the
reactive-invalidation half).

**Generates:** async repaint for git/LSP/diagnostics without input; the single coarse effect (not
effect-per-line/token/cell); handlers that only mutate; `App.dispose()` calling `$stopEffects()`.

**Evidence:** IMPLEMENTED — `Bootstrap.ts` `app.$watchEffect(...)` + `paint()`; input handlers
carry no render calls; `setSize` on boot/resize only. Tested headless:
`app/__tests__/frame-effect.test.ts` (revision + cursor change re-run the effect; `$stopEffects`
stops it). Confirmed end-to-end by the tmux smoke `scripts/smoke-editor.sh`: booting, opening a
file, and typing bump `bufferRevision` and repaint the real terminal via the side channel (ALL-PASS).

**Impossible if true:** an async result (LSP diagnostic, git refresh) that changes model state but
does not repaint until the next keystroke; a render pass that mutates model state; an
effect-per-item render graph.

**Verification:** the headless test above; plus the tmux smoke `scripts/smoke-editor.sh`
(input → edit → repaint → side-channel, ALL-PASS). Async-producer (no-keypress) repaint is
exercised end-to-end once git/LSP is wired into the editor (M4/M5).

**Status:** established

**Last refined:** 2026-07-21

### Owned resources release in reverse order

**Invariant:** If the app disposes, then it stops its reactive effects first, then runs owned
disposers in LIFO order, then destroys the renderer — so nothing repaints or references a
destroyed resource during teardown.

**Scope:** `App.dispose` + `Bootstrap.shutdown`.

**Mechanism:** `shutdown()` calls `app.$stopEffects()` before `view.dispose()`; `App.dispose()`
also calls `$stopEffects()` (idempotent), then runs `disposers.reverse()` (each guarded), then
`renderer.destroy()`. Realizes *A referenced resource stays alive* (explicit release).

**Generates:** the LIFO disposer stack; `$stopEffects`-before-teardown ordering; guarded disposers.

**Evidence:** `App.ts` `dispose()` (`$stopEffects` + LIFO + guarded); `Bootstrap.ts` `shutdown()`.

**Impossible if true:** the frame effect firing after renderables are destroyed; an owned watcher
or subprocess surviving app disposal.

**Verification:** a lifecycle test asserting effects stop and disposers run reverse on dispose;
tmux: no orphan process/effect after quit, terminal restored.

**Status:** provisional

**Last refined:** 2026-07-21
