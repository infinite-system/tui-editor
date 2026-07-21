# Decisions

Architecture decisions, grounded in the ivue documentation study (delegated, reviewed against
`../ivue` source + a headless smoke test — see `DELEGATION_LOG.md` #1). The brief mandates
documenting these; each cites the ivue page that informed it. ivue docs live at
`../ivue/docs_v2/{guide,examples}/`.

## Runtime & setup corrections (caught in the study)

- **D0.1 — Install `vue`, not just `@vue/reactivity`.** ivue's public API is one function,
  `Reactive()`, and it imports `watch`/`watchEffect`/`effectScope` from `vue` at runtime
  (peerDep `vue ^3.2.0`). The reactivity core is DOM-free and runs headless under Bun — proven
  by `scripts/ivue-smoke.ts` (`{count:2,double:4,observed:4,ok:true}`). Source: `lib/Reactive.ts`,
  `guide/getting-started.md#install`.
- **D0.2 — Vendor `Static()` and the kernel.** Neither ships in the `ivue` package. `Static()`
  is `experiments/node-namespace/Static.ts`; the extensible kernel is example code
  (`examples/playground/src/examples/extensible-kernel/kernel.ts`). We copy both into the app
  (`system`/`kernel` modules) rather than import from `ivue`. Source: `guide/node-static-runtime.md`.
- **D0.3 — `createX()` is our convention, not an ivue feature.** ivue's real construction seam
  is the mutable `namespace.Class` slot + owner-constructs-child; the brief's `createX()` factory
  idiom is an app convention (an overridable method), documented as such in
  *Construction goes through overridable seams*.

## The ten mandated architecture decisions

1. **Durable state uses ivue Reactive domain classes.** Observable, identity-bearing, disposable
   models (`App`, `Workspace`, `Buffer`, `Editor`, `GitRepository`, …) are `class $X {}` +
   `namespace X { const $Class; let Class = Reactive($Class) }`. `Reactive()` transforms in place
   and rewrites getters to lazy cells. Source: `guide/getting-started.md`, `guide/modules.md`.
2. **High-cardinality data uses compact storage + flyweight views.** Columnar typed arrays / plain
   Maps hold ground truth; disposable per-render facades (three fields: owner+row+col) expose it;
   a two-tier sparse revision overlay (fine per-item + coarse per-block refs) drives reactivity;
   explicit eviction releases cold overlays. Measured 4.7 bytes/cell at 20M cells. Source:
   `guide/flyweight.md`, `examples/flyweight-grid/model/`.
3. **Cheap derived values are plain getters, not `computed()`.** A plain getter lives once on the
   prototype (0 bytes/instance) and is reactive via leaf-ref subscription at any depth; `computed()`
   (~300 bytes/instance observed) is a surgical opt-in for expensive recompute, render-suppression,
   or stable ref identity. Aim nearly-computed-free. Source: `guide/state.md`, `guide/computed-watch.md`.
4. **Effects are owned and disposed explicitly for outliving instances.** `Reactive()` injects
   `$watch`/`$watchEffect`/`$stopEffects`; the effect scope is a lazily-allocated detached
   `effectScope`. Component-lifetime instances use plain `watch`/`onUnmounted`; app-root/store
   instances use `this.$watch` and an owner calls `$stopEffects()`. ivue calls no user hooks ever.
   Source: `guide/lifecycle-teardown.md`, `lib/Reactive.ts`.
5. **Namespace `Class` bindings are the replaceable extension seam.** `const $Class` is the raw
   `extends` root; `let Class` is the mutable selection slot every consumer reads (`new X.Class()`).
   A plugin/kernel swaps the slot at boot. Never snapshot it (`const C = X.Class` loses later
   selection). Source: `guide/namespace-pattern.md`, `guide/modules.md`.
6. **The extensible kernel composes the class graph before construction.** `defineClass` captures
   inheritance; `registerClass` queues `(Base)=>class extends Base{}` factories; `sealClassGraph`
   topologically composes, reparents descendants onto composed parents, applies `Reactive()`/`Static()`,
   replaces `Class` bindings, and seals. Post-seal construction is native `new`. Source:
   `examples/extensible-kernel.md`, `examples/.../extensible-kernel/kernel.ts`.
7. **Plain classes and static capabilities stay distinct from reactive models.** Plain stateful
   classes (`PieceTable`, `LineIndex`, `LspTransport`, `TreeSitterParser`) own algorithms/resources
   with no reactivity; `Static()` capability classes (`Files`, `GitCommands`, `Paths`) are
   allocation-free function bags with `super` + replaceable slot. Reactive models bridge engines via
   small revision refs. Source: `guide/node-static-runtime.md`, `guide/namespace-pattern.md`.
8. **Late dependency reads avoid circular-init failure.** Every cross-module reference sits in a
   getter/method body (`static get Dep() { return Dep.Class }`); the namespace compiles to a hoisted
   `var`, safe to hold from module-eval. No top-level `new`, no snapshot, no `export default X.Class`.
   Source: `guide/modules.md#circular-references-resolve-by-construction`.
9. **Inactive workspaces/panes/buffers/parsers/LSP are cooled or disposed, not hidden.** The
   `$stopEffects()` deactivate/reactivate cycle windows reactivity over a retained model; durable
   truth lives outside the overlay; re-arm watchers in an `activate()` method (not the constructor).
   Keyed overlays never self-GC → explicit eviction (`evictOutsideRows`-style). Source:
   `guide/lifecycle-teardown.md`, `guide/flyweight.md`.
10. **ivue patterns used directly vs adapted for OpenTUI/Bun.** Used directly: Reactive models,
    plain getters, the namespace pattern, `$watch`/`$stopEffects`, flyweight + eviction, late reads.
    Adapted: `Static()` + kernel are vendored (not packaged); HMR is dev-by-restart (no hot runtime
    for a Bun process); the single "render effect" is the OpenTUI frame effect calling
    `requestRender()`, pulling the visible window. Source: `guide/node-static-runtime.md`,
    `guide/node-class-hmr.md`, `guide/hmr.md`.

## Correction noted for contracts

`guide/principles.md` still references an "optional `stopEffects()` hook" — that hook was removed;
`lib/Reactive.ts` (no hooks at all) is authoritative. `LESSONS.md` confirms "ivue auto-calls NOTHING."
