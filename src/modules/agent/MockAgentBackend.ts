// A deterministic AgentBackend test double: no subprocess, no network. Scripted events are pushed
// through the onEvent sink via emit()/script(); every send() is recorded so a test can assert the exact
// prompts the session submitted. This is what keeps the agent gate hermetic and non-flaky — scripted
// events in, asserted transcript out — while CliStreamBackend proves real liveness against `claude -p`.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentBackend } from './AgentBackend';
import type { AgentEvent } from './AgentEvents';

class $MockAgentBackend implements AgentBackend {
  private eventCallback: ((event: AgentEvent) => void) | null = null;
  /** Every prompt submitted via send(), in order. */
  readonly sent: string[] = [];
  interrupted = false;
  disposed = false;

  send(prompt: string): void {
    this.sent.push(prompt);
  }

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    this.interrupted = true;
    this.emit({ kind: 'session-end', reason: 'interrupted' });
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Push one scripted event into the session (the inverse of send). */
  emit(event: AgentEvent): void {
    this.eventCallback?.(event);
  }

  /** Push a whole scripted sequence in order. */
  script(events: readonly AgentEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

export namespace MockAgentBackend {
  export const $Class = $MockAgentBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
