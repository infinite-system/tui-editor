# ivue 2.0.0 — implementation reference (for a TypeScript TUI on Bun)

Code-level reference distilled from the ivue docs/source study (`../ivue`), reviewed against
the published package + a headless smoke test. This is the authority for how to write ivue code
in this repo. Companion: `project.decisions.md` (the 10 decisions), and `.claude/skills/ivue/SKILL.md`.

## Framing facts (get these right or you write bugs)

- **ivue's entire public runtime API is `Reactive()`** (plus type helpers). The engine is tiny
  and has zero deps of its own.
- **ivue depends on Vue's reactivity at runtime.** `ref`, `shallowRef`, `computed`, `watch`,
  `watchEffect`, `effectScope`, `pauseTracking`/`resetTracking` all come from **`vue`** (installed),
  NOT from ivue. From `ivue` you import ONLY `Reactive`. The core is DOM-free and runs headless
  under Bun (proven: `scripts/ivue-smoke.ts`).
- **`Static()` and the extensible kernel are NOT in the ivue package.** `Static()` is an
  experiment; the kernel is example code. In this repo, a static-capability class is just a normal
  class in a namespace with `let Class = $Class` (no wrapper) — see `src/modules/system/*`.

## 1. The three class kinds + the namespace pattern

Project invariant: **every public class has a canonical raw class and one honest `Class`
selection slot**. This shape was discovered through ivue, but Invar applies it independently to
reactive models, static capabilities, and plain stateful classes. Late dependency reads are a
separate invariant that composes with this shape; they are not the reason every class uses it.

**(a) Reactive domain model** — the default for observable, identity-bearing, disposable state:
```ts
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

class $Buffer {
  get revision() { return ref(0); }                 // ref-getter → cached Ref, r/w via .value
  get lines() { return shallowRef<string[]>([]); }  // large, wholesale-replaced collection
  get lineCount() { return this.lines.value.length; } // PLAIN getter → 0 bytes/instance, still reactive
  applyEdit(e: Edit) { /* mutate */ this.revision.value++; }
  dispose() { /* close resources first */ this.$stopEffects(); }
}
export namespace Buffer {
  export const $Class = $Buffer;              // raw; children `extends` this; native super root
  export let   Class  = Reactive($Class);     // mutable slot; consumers do `new Buffer.Class()`
  export type  Model    = InstanceType<typeof Class>;   // raw-instance type (Refs stay Refs) — use for params/collections
  export type  Instance = typeof Class.Instance;        // unwrapping surface (defineExpose/reactive) only
}
```
`Reactive(C)` transforms C **in place** and returns the same constructor. `Class.Instance` is a
**type carrier only** (no runtime property). Consumers ALWAYS read the live `Class` binding
(`new X.Class()`) — **never** snapshot `const C = X.Class`.

**(b) Plain stateful class** — algorithms/resources with identity but no reactivity (parsers,
transports, engines, process handles). Same namespace, but `let Class = $Class` (no wrapper).

**(c) Static capability class** — stateless backend ops (file/process/git wrappers). Class with
`static` methods; namespace with `let Class = $Class`. Cross-module deps via **static getters**
read late: `static get Db() { return Db.Class; }`.

## 2. State primitives + the "nearly computed-free" rule

`Reactive()` rewrites each getter to a lazy cell: first access runs the getter; if the result
`isRef()` it caches that ref forever; if it's a plain value it **de-optimizes to a native
getter** (0 overhead thereafter).

- **ref-returning getter** = mutable reactive state (`get x(){ return ref(0) }`, r/w `this.x.value`).
- **`shallowRef`** for large/wholesale-replaced structures (arrays/maps you swap, not mutate deeply).
- **Plain getter** = the DEFAULT for cheap derived/conditional state. Lives once on the prototype
  (0 bytes/instance) and is fully reactive because the reading effect subscribes to the leaf refs
  underneath, at any depth. Make every `v-if`/ternary/comparison a **named plain getter**.
- **`computed()`** = surgical opt-in ONLY when: derivation is expensive, you need equal-value
  render suppression, or a stable ref identity for `watch`. Keep it thin — logic in a named
  method, arrow always: `get total(){ return computed(() => this.recalc()) }`. (60 observed
  computeds × 10k items ≈ hundreds of MB — do not default to it.)
- **`$`-prefixed getter** caches WHOLE forever on first access — the slot for a per-instance
  service/composable: `private get $mouse(){ return useMouse() }`.

**Keyed reactivity (version signals)** — the third shape, for high-cardinality data. Ground truth
lives in plain storage; refs are per-key *version signals*, not value holders:
```ts
private readonly versions = new Map<number, Ref<number>>();
private track(k: number) {                 // READ: get-or-create, then subscribe
  let v = this.versions.get(k);
  if (!v) this.versions.set(k, (v = ref(0)));
  void v.value;                            // subscribes the current effect
}
private bump(k: number) {                  // WRITE: peek-only — unobserved keys notify no one
  const v = this.versions.get(k); if (v) v.value++;
}
```

## 3. Effects, ownership, disposal

`Reactive()` injects onto every instance: `this.$watch(src, cb, opts?)`, `this.$watchEffect(fn)`,
`this.$stopEffects()`. The effect scope is a detached `effectScope`, allocated lazily on first
`$watch` (a pure-data instance allocates none). **ivue calls NO user hooks — no auto-init, no
auto-dispose.**

- **Component-lifetime** instance (created in a render root's setup): use plain
  `watch`/`watchEffect`/`onUnmounted` — the surrounding scope reaps them. No `$stopEffects` needed.
- **Component-outliving** instance (app root, stores, anything created in a callback/async): use
  `this.$watch`/`this.$watchEffect`; an explicit owner MUST call `this.$stopEffects()` on disposal.
  Do resource cleanup first, then `$stopEffects()`:
  `dispose(){ this.proc?.kill(); this.$stopEffects(); }`
- **Teardown is a full reset** to pre-first-touch: ref state is lost (durable truth must live
  OUTSIDE the overlay); the constructor does not re-run (put re-armable watchers in an
  `activate()` method). This gives a repeatable deactivate/reactivate cycle for windowing
  reactivity over a large retained model.
- **One coarse invalidation effect, not one-per-item:** a single frame/render effect reads only
  the visible window through tracked accessors and subscribes to exactly the version refs it
  touched. NEVER a watcher per row/line/token/cell.

## 4. The flyweight / active-set pattern (copy this for high-cardinality data)

Measured 20M cells at 4.7 bytes/cell, +0.3 MB after 30 viewports. Use for git history, markdown
tokens, diagnostics, editor lines/spans — anything with cardinality.

Three moves:
1. **Columnar ground truth (plain, non-reactive):** typed arrays (`Uint8Array`/`Float64Array`) +
   sparse `Map`s for the data. Writes to unobserved cells update arrays and notify no one.
2. **Flyweight facades (disposable, per-render):** a facade holds only `(source, index)` — 2-3
   fields — and every member is a plain getter delegating to the source's tracked accessors.
   Reactive state lives on the SOURCE overlay, not the facade, so facades are created per render
   pass and dropped on scroll with zero loss.
3. **Two-tier sparse revision overlay + eviction:**
   ```ts
   private readonly cellVersions  = new Map<number, Ref<number>>();  // fine: per observed item
   private readonly blockVersions = new Map<number, Ref<number>>();  // coarse: per BLOCK (e.g. 4096)
   ```
   - Read: rendered items take fine refs; large ranges subscribe BLOCK refs and read ground truth
     inside `pauseTracking()`/`resetTracking()` (so a 1M-range read costs a few hundred edges, not 1M).
   - Write: O(1) storage update + peek-only bumps of the touched fine + block refs.
   - **Eviction is mandatory** (keyed Maps never self-GC): release fine refs/computeds for items
     outside the viewport+margin (`evictOutsideRange(keepStart, keepEnd)`); correctness after
     release is by re-materialization (next observation rebuilds a fresh ref over unchanged ground
     truth). Memory is O(viewport), not O(ever-visited).

## 5. The extensible kernel (composition before construction)

A single module singleton (no DI container). API: `defineClass(name, ns)` (captures inheritance
now), `registerClass(name, (Base)=>class extends Base{}, plugin?)` (queues a factory),
`sealClassGraph()` (BOOT: topological compose → reparent descendants onto composed parents →
apply `Reactive()`/`Static()` → replace each namespace `Class` binding → seal), `reset()`.
After seal, `new X.Class()` does zero registry lookup (native prototype dispatch). Sealing changes
**future construction only** — it never mutates existing instances. A plugin toggle = capture
state → reset → re-register → seal → reconstruct. (This repo vendors/adapts the kernel in
`src/modules/kernel`.)

## 6. Inheritance across the namespace

Children `extends` the raw `$Class`, then export their own `Reactive` `Class`:
```ts
class $SaleProduct extends Product.$Class {
  get total(): number { return super.total * (1 - this.discount.value); }
}
export namespace SaleProduct {
  export const $Class = $SaleProduct;
  export let   Class  = Reactive($Class);
  export type  Instance = typeof Class.Instance;
}
```
`Reactive()` is idempotent/diamond-safe and gives each `(prototype, key)` its own cache symbol, so
a child computed and the `super` it calls never collide. Every file safely calls `Reactive()` on
its own class; any load order yields the same result. (Native caveat: don't split get/set of one
accessor across inheritance levels — use one getter returning a writable `computed({get,set})`.)

## 7. Late dependency binding (circular-init immunity)

A `namespace` compiles to a hoisted `var` filled by an IIFE — safe to hold from module-eval. Move
every cross-module read into a getter/method body (`static get Users(){ return Users.Class }`).
NEVER top-level `new B.Class()`, `const C = B.Class`, or `export default B.Class` — those
re-introduce the eager edge a cycle breaks. For stores/composables use the `$`-getter
(`private get $store(){ return useStore() }`). Circular *inheritance* stays impossible.

## 8. Construction seams

ivue's real seam is the **mutable `Class` slot** (swap it at boot to redirect construction) +
**owner-constructs-child passing itself**: `new Task.Class(this, data)`. There is NO framework
`createX()` factory API — in THIS repo `createX()` is our own convention (an overridable method).
Constructor virtual dispatch is native JS: calling `this.method()` in a base constructor reaches
the override; just don't rely on a subclass field initialized after `super()`.

## 9. TUI/Bun specifics

- Install `vue` (done). Reactivity is headless; the "render effect" is the OpenTUI frame effect
  calling `requestRender()`, pulling the visible window.
- Everything is **observation-priced**: cost ∝ what's observed, never ∝ what exists. Structure so a
  single frame effect pulls only the visible window; ground truth in plain columnar storage;
  reactivity a disposable, EVICTABLE overlay.
- Dev is by-restart (no hot-module runtime for a Bun process). An outliving instance's owner calls
  `$stopEffects()` before replacing it.
- Static capability classes for the non-reactive service layer (file/process/git/format);
  reactive instances only for view-models/entities with identity.

Source index: engine `../ivue/lib/Reactive.ts`; flyweight
`../ivue/examples/playground/src/examples/flyweight-grid/model/`; kernel
`../ivue/examples/playground/src/examples/extensible-kernel/kernel.ts`; guide
`../ivue/docs_v2/guide/*`.
