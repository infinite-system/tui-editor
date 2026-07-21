// Empirical proof: ivue Reactive() + Vue reactivity run headless under Bun.
import { Reactive } from 'ivue';
import { ref } from 'vue';

class $Counter {
  get count() { return ref(0); }
  get double() { return this.count.value * 2; }   // plain getter — reactive via leaf ref
  increment() { this.count.value++; }
}
namespace Counter {
  export const $Class = $Counter;
  export let Class = Reactive($Class);
}

const c = new Counter.Class();
let observed = -1;
(c as any).$watch(() => c.double, (v: number) => { observed = v; }, { flush: 'sync' });
c.increment();
c.increment();
const ok = c.count.value === 2 && c.double === 4 && observed === 4;
console.log(JSON.stringify({ count: c.count.value, double: c.double, observed, ok }));
process.exit(ok ? 0 : 1);
