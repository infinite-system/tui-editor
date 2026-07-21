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
  const loweredQuery = query.toLowerCase();
  const loweredText = text.toLowerCase();
  let queryIndex = 0;
  let textIndex = 0;
  let score = 0;
  let lastMatch = -1;
  while (queryIndex < loweredQuery.length && textIndex < loweredText.length) {
    if (loweredQuery[queryIndex] === loweredText[textIndex]) {
      if (lastMatch >= 0) score += textIndex - lastMatch; // reward adjacency
      lastMatch = textIndex;
      queryIndex++;
    }
    textIndex++;
  }
  return queryIndex === loweredQuery.length ? score : -1;
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

  register(command: Command): void {
    this.commands.set(command.id, command);
  }

  registerAll(commands: Command[]): void {
    for (const command of commands) this.register(command);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()].filter((command) => (command.when ? command.when() : true));
  }

  run(id: string): void {
    const command = this.commands.get(id);
    if (command && (!command.when || command.when())) void command.run();
  }

  // --- palette control ---
  get filtered(): Command[] {
    return this.filteredRef.value;
  }

  private recompute(): void {
    const query = this.query.value;
    const scored = this.all()
      .map((command) => ({ command, score: fuzzyScore(query, command.title) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => left.score - right.score || left.command.title.localeCompare(right.command.title));
    this.filteredRef.value = scored.map((entry) => entry.command);
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

  setQuery(query: string): void {
    this.query.value = query;
    this.selectedIndex.value = 0;
    this.recompute();
  }

  appendQuery(character: string): void {
    this.setQuery(this.query.value + character);
  }

  backspaceQuery(): void {
    this.setQuery(this.query.value.slice(0, -1));
  }

  moveSelection(delta: number): void {
    const count = this.filtered.length;
    if (count === 0) return;
    let index = this.selectedIndex.value + delta;
    if (index < 0) index = count - 1;
    if (index >= count) index = 0;
    this.selectedIndex.value = index;
  }

  runSelected(): void {
    const command = this.filtered[this.selectedIndex.value];
    this.closePalette();
    if (command && (!command.when || command.when())) void command.run();
  }
}

export namespace CommandRegistry {
  export const $Class = $CommandRegistry;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
