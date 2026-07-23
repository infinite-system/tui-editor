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
  /** Pending delayed-completion timer (only armed in the demo/driving path). */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  send(prompt: string): void {
    if (this.disposed) return;
    const reply = `You said: “${prompt}”. This is the local echo backend — real Claude arrives when CliStreamBackend is wired (phase 2).`;
    // Stream the reply as word-sized deltas so the pane shows real incremental accumulation.
    for (const word of reply.split(' ')) this.emit({ kind: 'text-delta', text: `${word} ` });

    // Driving-smoke path (env-gated, off by default so the hermetic smoke-agent stays synchronous): emit
    // a scripted tool-use so the pane holds a busy state (spinner animates) and a COLLAPSIBLE tool row,
    // then finish the turn after the delay with a multi-line tool-result to expand.
    const delayMilliseconds = Number(process.env.INVAR_AGENT_ECHO_DELAY_MS ?? 0);
    if (delayMilliseconds > 0) {
      this.emit({
        kind: 'tool-use',
        id: 'echo-demo-tool',
        name: 'Bash',
        input: { command: 'echo hello from the demo tool', note: 'scripted tool call for the agent-pane-ux smoke' },
      });
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.emit({
          kind: 'tool-result',
          id: 'echo-demo-tool',
          result: 'hello from the demo tool\nline two of the tool output\nline three of the tool output',
          isError: false,
        });
        this.emit({ kind: 'session-end', reason: 'completed' });
      }, delayMilliseconds);
      return;
    }
    this.emit({ kind: 'session-end', reason: 'completed' });
  }

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    this.clearPendingTimer();
    this.emit({ kind: 'session-end', reason: 'interrupted' });
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingTimer();
    this.eventCallback = null;
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
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
