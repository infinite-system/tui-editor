// The Tier-S default backend: a local, no-network echo. It implements the SAME AgentBackend seam as the
// real backends will, so it exercises the whole projection pipeline (send → structured events →
// transcript → pane) end-to-end without any subprocess. It is deliberately honest about being a
// placeholder — every reply says so — and is swapped for CliStreamBackend (`claude -p
// --output-format stream-json`, subscription-billed) in phase 2 with ZERO change above the seam. This
// is the whole point of the one-seam invariant: the live app runs today, the real agent drops in later.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentBackend } from './AgentBackend';
import type { AgentEvent } from './AgentEvents';

class $EchoAgentBackend implements AgentBackend {
  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private disposed = false;

  send(prompt: string): void {
    if (this.disposed) return;
    const reply = `You said: “${prompt}”. This is the local echo backend — real Claude arrives when CliStreamBackend is wired (phase 2).`;
    // Stream the reply as word-sized deltas so the pane shows real incremental accumulation.
    for (const word of reply.split(' ')) this.emit({ kind: 'text-delta', text: `${word} ` });
    this.emit({ kind: 'session-end', reason: 'completed' });
  }

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    this.emit({ kind: 'session-end', reason: 'interrupted' });
  }

  dispose(): void {
    this.disposed = true;
    this.eventCallback = null;
  }

  private emit(event: AgentEvent): void {
    if (!this.disposed) this.eventCallback?.(event);
  }
}

export namespace EchoAgentBackend {
  export const $Class = $EchoAgentBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
