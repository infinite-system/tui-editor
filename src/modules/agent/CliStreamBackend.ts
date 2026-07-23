// The real (subscription-billed) agent backend: it drives `claude -p --output-format stream-json`,
// reads the newline-delimited JSON event stream, and maps each object to an AgentEvent — the SAME seam
// the MockAgentBackend and EchoAgentBackend implement, so AgentSession and the pane are unchanged. This
// is phase 2 of the harness: the pane now talks to real Claude. Conversation continuity is preserved by
// capturing `session_id` from the init event and passing `--resume` on the next turn.
//
// The line→event MAPPING is a pure exported function (mapClaudeStreamEvent) tested against recorded
// fixtures; only the subprocess pumping is shell-bound (verified by driving). No ANSI anywhere.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentBackend } from './AgentBackend';
import type { AgentEvent } from './AgentEvents';
import { ClaudeStreamMapping } from './ClaudeStreamMapping';

export interface CliStreamOptions {
  /** Absolute path to the `claude` binary (resolved by the factory via Bun.which). */
  claudePath: string;
  /** Working directory for the agent (the workspace root), so Claude operates in the user's project. */
  cwd?: string;
}

class $CliStreamBackend implements AgentBackend {
  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private sessionId: string | null = null;
  private sawResult = false;
  private interrupting = false;
  private disposed = false;

  constructor(private readonly options: CliStreamOptions) {}

  send(prompt: string): void {
    if (this.disposed || this.child) return; // one turn at a time (AgentSession also guards this)
    this.sawResult = false;
    this.interrupting = false;
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (this.sessionId) args.push('--resume', this.sessionId); // continue the conversation
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([this.options.claudePath, ...args], {
        cwd: this.options.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
    } catch (error) {
      this.emit({ kind: 'error', message: `Failed to launch claude: ${String(error)}` });
      this.emit({ kind: 'session-end', reason: 'error' });
      return;
    }
    this.child = child;
    void this.pump(child);
  }

  private async pump(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of child.stdout as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          this.consumeLine(buffer.slice(0, newlineIndex));
          buffer = buffer.slice(newlineIndex + 1);
        }
      }
      this.consumeLine(buffer);
    } catch (error) {
      this.emit({ kind: 'error', message: String(error) });
    }
    const exitCode = await child.exited;
    this.child = null;
    // If the stream carried its own `result` event we already ended; otherwise synthesize an end so the
    // session never hangs on a crashed/killed subprocess.
    if (!this.sawResult && !this.disposed) {
      this.emit({ kind: 'session-end', reason: this.interrupting ? 'interrupted' : exitCode === 0 ? 'completed' : 'error' });
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return; // non-JSON diagnostic noise on stdout — ignore
    }
    const sessionId = ClaudeStreamMapping.Class.sessionIdOf(raw);
    if (sessionId) this.sessionId = sessionId; // captured for --resume on the next turn
    for (const event of ClaudeStreamMapping.Class.mapEvent(raw)) {
      if (event.kind === 'session-end') this.sawResult = true; // the stream ended the turn itself
      this.emit(event);
    }
  }

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    if (this.child) {
      this.interrupting = true;
      this.child.kill();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.child = null;
    this.eventCallback = null;
  }

  private emit(event: AgentEvent): void {
    if (!this.disposed) this.eventCallback?.(event);
  }
}

export namespace CliStreamBackend {
  export const $Class = $CliStreamBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
