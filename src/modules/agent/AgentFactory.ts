// The construction seam for a live agent PaneContent: it wires a default AgentBackend (the local
// EchoAgentBackend for Tier S) into an AgentSession, then wraps that as an AgentPaneContent. Overridable
// (Static, `super`-capable) so a test or an alternate host can swap the backend — a MockAgentBackend for
// a deterministic pane, CliStreamBackend for the real subscription-billed agent — without the caller
// knowing which backend it got. Bootstrap calls this LAZILY on first toggle, so no session spins up
// until the panel is actually opened (idle cost is exactly zero when the agent pane is never used).
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
// invariant: One session is one Reactive instance (src/modules/agent/agent.invariants.md)
import { Static } from 'ivue/extras';
import type { AgentBackend } from './AgentBackend';
import { EchoAgentBackend } from './EchoAgentBackend';
import { CliStreamBackend } from './CliStreamBackend';
import { AgentSession } from './AgentSession';
import { AgentPaneContent } from './AgentPaneContent';

export interface AgentCreateOptions {
  /** Inject a specific backend (tests pass a MockAgentBackend; a host may pass any implementation). */
  backend?: AgentBackend;
  /** The workspace root — the cwd real Claude runs in, so it operates in the user's project. */
  cwd?: string;
}

/** Pick the default backend by auto-detection: real Claude (`claude` on PATH) when available, the local
 *  echo otherwise. `INVAR_AGENT_BACKEND=echo` forces the echo (keeps the driving smoke hermetic —
 *  no subprocess, no billing). Overridable Static seam. */
function $createBackend(options: AgentCreateOptions): AgentBackend {
  if (process.env.INVAR_AGENT_BACKEND === 'echo') return new EchoAgentBackend.Class();
  const claudePath = Bun.which('claude');
  if (claudePath) return new CliStreamBackend.Class({ claudePath, cwd: options.cwd });
  return new EchoAgentBackend.Class();
}

/** Wire backend + session into a ready AgentPaneContent. */
function $create(options: AgentCreateOptions = {}): AgentPaneContent.Model {
  const backend = options.backend ?? AgentFactory.Class.createBackend(options);
  const session = new AgentSession.Class(backend);
  return new AgentPaneContent.Class(session);
}

class $AgentFactory {
  static createBackend = $createBackend;
  static create = $create;
}

export namespace AgentFactory {
  export const $Class = $AgentFactory;
  export const Class = Static($AgentFactory);
}
