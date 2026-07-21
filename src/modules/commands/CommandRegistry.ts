// Command registry + palette state. Every action the app can take is a registered command
// with a stable id, a human title, and a run function — the palette lists them, filters them
// with a subsequence match, and runs the selection. Keybindings dispatch the same commands.
//
// invariant: No action requires a memorized motion (project.invariants.md)
//   — everything is in the palette, discoverable and rebindable.
// invariant: The core is complete without plugins (project.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { CommandScoring } from './CommandScoring';

export interface Command {
  id: string;
  title: string;
  category?: string;
  run: () => void | Promise<void>;
  when?: () => boolean;
}

class $CommandRegistry {
  // invariant: Every action dispatches through the one registry (src/modules/commands/commands.invariants.md)
  //   — the single source of truth; both the palette and keybindings resolve actions out of this map.
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
    // invariant: A command runs only when its guard holds (src/modules/commands/commands.invariants.md)
    //   — a guarded-off command is never listed, so it cannot be scored or selected.
    return [...this.commands.values()].filter((command) => (command.when ? command.when() : true));
  }

  run(id: string): void {
    // invariant: Every action dispatches through the one registry (src/modules/commands/commands.invariants.md)
    //   — the keybinding dispatch path: resolve the command by id out of the one map.
    const command = this.commands.get(id);
    // invariant: A command runs only when its guard holds (src/modules/commands/commands.invariants.md)
    if (command && (!command.when || command.when())) void command.run();
  }

  // --- palette control ---
  get filtered(): Command[] {
    return this.filteredRef.value;
  }

  private recompute(): void {
    const query = this.query.value;
    // invariant: Command scoring is a pure ordering (src/modules/commands/commands.invariants.md)
    //   — the palette ranking derives entirely from fuzzyScore, with title localeCompare as the only tiebreak.
    const scored = this.all()
      .map((command) => ({ command, score: CommandScoring.Class.fuzzyScore(query, command.title) }))
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
    // invariant: A command runs only when its guard holds (src/modules/commands/commands.invariants.md)
    //   — re-checked here so a guard that flipped false since listing still blocks the palette dispatch.
    if (command && (!command.when || command.when())) void command.run();
  }
}

export namespace CommandRegistry {
  export const $Class = $CommandRegistry;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
