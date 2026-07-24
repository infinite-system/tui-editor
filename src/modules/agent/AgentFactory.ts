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
import { CodexStreamBackend } from './CodexStreamBackend';
import { SdkStreamBackend } from './SdkStreamBackend';
import { AgentSession } from './AgentSession';
import { AgentPaneContent } from './AgentPaneContent';
import type { AgentProvider } from '../settings/Settings';

export interface AgentCreateOptions {
  /** Inject a specific backend (tests pass a MockAgentBackend; a host may pass any implementation). */
  backend?: AgentBackend;
  /** The workspace root — the cwd the real agent CLI runs in, so it operates in the user's project. */
  cwd?: string;
  /** Which engine to use ('auto' picks the first CLI on PATH, Claude preferred). */
  provider?: AgentProvider;
  /** Run the agent without permission prompts (provider-neutral; each backend maps it to its flag).
   *  Pass a GETTER (`() => setting.value`) so a live Shift+Tab toggle is honored on the next turn. */
  skipPermissions?: boolean | (() => boolean);
  /** Model override; empty uses the provider default. */
  model?: string;
}

/** Pick the backend by provider setting + CLI availability. Claude now rides the SDK backend
 *  (SdkStreamBackend — interactive permission prompts in ask-mode, bypass resolved live per turn); the
 *  legacy CLI pipe stays as an escape hatch via `INVAR_AGENT_BACKEND=cli`. `auto` (or a requested CLI
 *  that's missing) prefers Claude, then Codex, then the local echo. `INVAR_AGENT_BACKEND=echo` forces
 *  the echo (keeps the driving smoke hermetic — no subprocess, no billing). Overridable Static seam. */
function $createBackend(options: AgentCreateOptions): AgentBackend {
  if (process.env.INVAR_AGENT_BACKEND === 'echo') return new EchoAgentBackend.Class();
  const provider: AgentProvider = options.provider ?? 'auto';
  const skipPermissions = options.skipPermissions ?? true;
  const model = options.model || undefined;
  const claudePath = Bun.which('claude');
  const codexPath = Bun.which('codex');
  const buildClaude = (path: string): AgentBackend =>
    process.env.INVAR_AGENT_BACKEND === 'cli'
      ? new CliStreamBackend.Class({ claudePath: path, cwd: options.cwd, skipPermissions, model })
      : new SdkStreamBackend.Class({ cwd: options.cwd, skipPermissions, model });
  const buildCodex = (path: string): AgentBackend =>
    new CodexStreamBackend.Class({ codexPath: path, cwd: options.cwd, skipPermissions, model });
  if (provider === 'claude' && claudePath) return buildClaude(claudePath);
  if (provider === 'codex' && codexPath) return buildCodex(codexPath);
  // auto, or the requested CLI is missing: prefer Claude, then Codex, then echo.
  if (claudePath) return buildClaude(claudePath);
  if (codexPath) return buildCodex(codexPath);
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
