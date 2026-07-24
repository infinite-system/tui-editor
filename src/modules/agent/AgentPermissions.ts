// Permission-mode resolution for agent backends. The mode may arrive as a live GETTER (bound to the
// reactive `agentSkipPermissions` setting) so a Shift+Tab toggle since agent creation is honored on the
// NEXT turn — each send() spawns a fresh CLI, so the flag is resolved at the point of use, never frozen
// at the value from creation (the "mode line lies" bug). Shared by CliStreamBackend + CodexStreamBackend
// so both providers resolve the flag identically — one generator, not a copy per backend.
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';

class $AgentPermissions {
  /** Resolve a permission-mode option to a live boolean: a getter is read NOW, a plain boolean passes
   *  through, undefined → false. */
  static resolveLive(value: boolean | (() => boolean) | undefined): boolean {
    return typeof value === 'function' ? value() : Boolean(value);
  }
}

export namespace AgentPermissions {
  export const $Class = $AgentPermissions;
  export const Class = Static($AgentPermissions);
}
