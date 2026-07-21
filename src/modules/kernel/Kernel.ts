// The kernel composes module implementations (via the namespace Class slots) and SEALS
// before any application instance is constructed. In M1 there are no plugins yet, so the
// kernel simply enforces the ordering guarantee; M7 fills in contribution composition.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: Construction goes through overridable seams (project.invariants.md)
import { Logging } from '../system/Logging';

export type SealHook = () => void;

class $Kernel {
  private hooks: SealHook[] = [];
  private sealed = false;

  /** Register a composition hook to run at seal time (plugins, class replacement). */
  register(hook: SealHook): void {
    if (this.sealed) {
      throw new Error('Kernel.register: cannot register after seal');
    }
    this.hooks.push(hook);
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  /** Run every composition hook once, then freeze. Constructing App before this throws. */
  seal(): void {
    if (this.sealed) return;
    for (const hook of this.hooks) hook();
    this.sealed = true;
    Logging.Class.info(`Kernel sealed (${this.hooks.length} hooks)`);
  }

  /** Guard called by App construction to prove the kernel was sealed first. */
  assertSealed(): void {
    if (!this.sealed) {
      throw new Error('The app is built only after the kernel is sealed');
    }
  }
}

export namespace Kernel {
  export const $Class = $Kernel;
  export let Class = $Kernel;
  // One process-wide kernel instance.
  export const instance = new $Kernel();
}
