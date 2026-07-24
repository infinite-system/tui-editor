// The ONE authority for agent provider resolution — inventory, availability, forced overrides,
// fallback, and the RESOLVED record that construction, the mode-line label, and engine cycling all
// read. The review found the dual-authority bug this kills: Bootstrap derived a label from the raw
// setting while AgentFactory silently fell back during construction, so the UI could claim "codex"
// while claude (or the echo) was actually running. Now every consumer asks the SAME resolve(), so the
// label can never disagree with what the factory builds.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';
import type { AgentProvider } from '../settings/Settings';

/** A concrete, runnable engine (the echo is the always-available hermetic fallback). */
export type ResolvedEngine = 'claude' | 'codex' | 'echo';

/** The single resolution record every consumer reads. */
export interface ResolvedProvider {
  /** The engine that WILL actually run (post-availability, post-fallback). */
  readonly engine: ResolvedEngine;
  /** The resolved binary path for claude/codex ('' for the echo). */
  readonly binaryPath: string;
  /** True when the resolved engine differs from what the setting asked for (fallback happened). */
  readonly fellBack: boolean;
}

/** The engines actually switchable on this box, in cycle order. INVAR_AGENT_ENGINES forces the list
 *  (the driving smoke proves switch mechanics with the hermetic echo backend). */
function $availableEngines(): ResolvedEngine[] {
  const forced = process.env.INVAR_AGENT_ENGINES;
  if (forced) {
    return forced
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry): entry is ResolvedEngine => entry === 'claude' || entry === 'codex' || entry === 'echo');
  }
  const list: ResolvedEngine[] = [];
  if (Bun.which('claude')) list.push('claude');
  if (Bun.which('codex')) list.push('codex');
  return list;
}

/** Resolve a REQUESTED provider (the setting, or an env force) to the engine that will actually run.
 *  Order of authority: INVAR_AGENT_PROVIDER force → the requested engine when available → auto
 *  preference (claude, then codex) → echo. This is the whole fallback policy, in one place. */
function $resolve(requested: AgentProvider | undefined): ResolvedProvider {
  const forced = process.env.INVAR_AGENT_PROVIDER;
  const wanted: AgentProvider = forced === 'claude' || forced === 'codex' ? forced : requested ?? 'auto';
  const claudePath = Bun.which('claude');
  const codexPath = Bun.which('codex');
  if (wanted === 'claude' && claudePath) return { engine: 'claude', binaryPath: claudePath, fellBack: false };
  if (wanted === 'codex' && codexPath) return { engine: 'codex', binaryPath: codexPath, fellBack: false };
  const askedConcrete = wanted === 'claude' || wanted === 'codex';
  if (claudePath) return { engine: 'claude', binaryPath: claudePath, fellBack: askedConcrete };
  if (codexPath) return { engine: 'codex', binaryPath: codexPath, fellBack: askedConcrete };
  return { engine: 'echo', binaryPath: '', fellBack: askedConcrete };
}

/** The next engine after `current` in the available cycle, or null when there is nothing to switch to. */
function $nextEngine(current: ResolvedEngine): ResolvedEngine | null {
  const available = $availableEngines();
  if (available.length < 2) return null;
  const index = available.indexOf(current);
  const next = available[(Math.max(0, index) + 1) % available.length];
  return next && next !== current ? next : null;
}

class $AgentProviderRegistry {
  static availableEngines = $availableEngines;
  static resolve = $resolve;
  static nextEngine = $nextEngine;
}

export namespace AgentProviderRegistry {
  export const $Class = $AgentProviderRegistry;
  export const Class = Static($AgentProviderRegistry);
}
