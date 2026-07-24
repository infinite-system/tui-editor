// The agent I/O seam — the honest minimal shape of "a source of agent events". A backend takes a
// prompt in (send), yields structured events out (onEvent), can be interrupted (interrupt), and has a
// lifetime (dispose); nothing about HOW those events are produced belongs here. This is the swap seam
// (parallel to the terminal's TerminalBackend): MockAgentBackend scripts events for deterministic
// tests; CliStreamBackend will drive `claude -p --output-format stream-json` under subscription
// billing; ClaudeSdkBackend the API-key path. AgentSession depends ONLY on this interface, so every
// implementation is interchangeable with zero change above the seam.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentEvent } from './AgentEvents';

/** A source of agent events. The single boundary between AgentSession and whatever produces the
 *  structured event stream (a real `claude` subprocess, the SDK, or a scripted test double). */
export interface AgentBackend {
  /** Submit a user turn. The backend responds by emitting events through the onEvent sink. */
  send(prompt: string): void;
  /** Register the sink for events coming FROM the agent. Called once by the owning AgentSession. */
  onEvent(callback: (event: AgentEvent) => void): void;
  /** Request the current turn stop. The backend should emit a `session-end` with reason 'interrupted'. */
  interrupt(): void;
  /** Terminate the backend and release every owned resource (subprocess, streams). Idempotent. */
  dispose(): void;
}

