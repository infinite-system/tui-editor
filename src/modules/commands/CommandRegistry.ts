// Command registry + palette state. Every action the app can take is a registered command
// with a stable id, a human title, and a run function — the palette lists them, filters them
// with a subsequence match, and runs the selection. Keybindings dispatch the same commands.
//
// invariant: No action requires a memorized motion (project.invariants.md)
//   — everything is in the palette, discoverable and rebindable.
// invariant: The core is complete without plugins (project.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

export interface Command {
  id: string;
  title: string;
  category?: string;
  run: () => void | Promise<void>;
  when?: () => boolean;
}

/** Case-insensitive subsequence match; returns a score (lower = tighter) or -1. */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let ti = 0;
  let score = 0;
  let lastMatch = -1;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      if (lastMatch >= 0) score += ti - lastMatch; // reward adjacency
      lastMatch = ti;
      qi++;
    }
    ti++;
  }
  return qi === q.length ? score : -1;
}

class $CommandRegistry {
  private commands = new Map<string, Command>();

  // Palette reactive state.
  get open() {
    return ref(false);
  }
  get query() {
    return ref('');
  }
  get selectedIndex() {
    return ref(0);
  }
  private get filteredRef() {
    return shallowRef<Command[]>([]);
  }

  register(cmd: Command): void {
    this.commands.set(cmd.id, cmd);
  }

  registerAll(cmds: Command[]): void {
    for (const c of cmds) this.register(c);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()].filter((c) => (c.when ? c.when() : true));
  }

  run(id: string): void {
    const cmd = this.commands.get(id);
    if (cmd && (!cmd.when || cmd.when())) void cmd.run();
  }

  // --- palette control ---
  get filtered(): Command[] {
    return this.filteredRef.value;
  }

  private recompute(): void {
    const q = this.query.value;
    const scored = this.all()
      .map((c) => ({ c, s: fuzzyScore(q, c.title) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s || a.c.title.localeCompare(b.c.title));
    this.filteredRef.value = scored.map((x) => x.c);
    if (this.selectedIndex.value >= this.filteredRef.value.length) {
      this.selectedIndex.value = Math.max(0, this.filteredRef.value.length - 1);
    }
  }

  openPalette(): void {
    this.open.value = true;
    this.query.value = '';
    this.selectedIndex.value = 0;
    this.recompute();
  }

  closePalette(): void {
    this.open.value = false;
    this.query.value = '';
  }

  setQuery(q: string): void {
    this.query.value = q;
    this.selectedIndex.value = 0;
    this.recompute();
  }

  appendQuery(ch: string): void {
    this.setQuery(this.query.value + ch);
  }

  backspaceQuery(): void {
    this.setQuery(this.query.value.slice(0, -1));
  }

  moveSelection(delta: number): void {
    const n = this.filtered.length;
    if (n === 0) return;
    let i = this.selectedIndex.value + delta;
    if (i < 0) i = n - 1;
    if (i >= n) i = 0;
    this.selectedIndex.value = i;
  }

  runSelected(): void {
    const cmd = this.filtered[this.selectedIndex.value];
    this.closePalette();
    if (cmd && (!cmd.when || cmd.when())) void cmd.run();
  }
}

export namespace CommandRegistry {
  export const $Class = $CommandRegistry;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
