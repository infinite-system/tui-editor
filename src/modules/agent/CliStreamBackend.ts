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
import { type AgentBackend, resolveLivePermission } from './AgentBackend';
import type { AgentEvent } from './AgentEvents';
import { ClaudeStreamMapping } from './ClaudeStreamMapping';

/** Turn an auth-shaped stderr tail into a friendly, actionable hint — or null if it isn't auth-related. */
function authHintFor(stderr: string): string | null {
  const lower = stderr.toLowerCase();
  if (/not logged in|unauthenticated|no api key|authentication|login|oauth|credential|invalid.*key|401|unauthorized/.test(lower)) {
    return 'Claude is not authenticated. Run `claude login` in a terminal (or set ANTHROPIC_API_KEY), then send again.';
  }
  return null;
}

export interface CliStreamOptions {
  /** Absolute path to the `claude` binary (resolved by the factory via Bun.which). */
  claudePath: string;
  /** Working directory for the agent (the workspace root), so Claude operates in the user's project. */
  cwd?: string;
  /** Run without permission prompts (`--dangerously-skip-permissions`) — headless `-p` cannot surface
   *  approval prompts, so tools are denied unless this is on. Provider-neutral `agentSkipPermissions`.
   *  A GETTER (not a snapshot) so a live Shift+Tab toggle takes effect on the NEXT turn — each `send()`
   *  spawns a fresh `claude`, so it re-reads the current setting rather than the value at agent creation. */
  skipPermissions?: boolean | (() => boolean);
  /** Model override (`--model`); empty/undefined uses Claude's default. */
  model?: string;
}

class $CliStreamBackend implements AgentBackend {
  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private sessionId: string | null = null;
  private sawResult = false;
  private interrupting = false;
  private disposed = false;
  /** Tail of the child's stderr, so a non-zero exit can surface a useful reason (e.g. not logged in). */
  private stderrTail = '';

  constructor(private readonly options: CliStreamOptions) {}

  send(prompt: string): void {
    if (this.disposed || this.child) return; // one turn at a time (AgentSession also guards this)
    this.sawResult = false;
    this.interrupting = false;
    this.stderrTail = '';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    // Resolve the permission mode LIVE at send time so a Shift+Tab toggle since creation is honored.
    if (resolveLivePermission(this.options.skipPermissions)) args.push('--dangerously-skip-permissions');
    if (this.options.model) args.push('--model', this.options.model);
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
    const drainStderr = this.drainStderr(child); // concurrent, so a blocked stderr can't stall stdout
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
    await drainStderr;
    this.child = null;
    // If the stream carried its own `result` event we already ended; otherwise synthesize an end so the
    // session never hangs on a crashed/killed subprocess. A non-zero exit with no result surfaces the
    // stderr reason (turned into a friendly hint for the common "not logged in" case).
    if (!this.sawResult && !this.disposed) {
      const interrupted = this.interrupting;
      if (!interrupted && exitCode !== 0) {
        const hint = authHintFor(this.stderrTail);
        this.emit({ kind: 'error', message: hint ?? (this.stderrTail.trim().slice(-400) || 'claude exited with an error') });
      }
      this.emit({ kind: 'session-end', reason: interrupted ? 'interrupted' : exitCode === 0 ? 'completed' : 'error' });
    }
  }

  /** Drain the child's stderr into a bounded tail — never emitted verbatim unless the turn fails. */
  private async drainStderr(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000);
      }
    } catch {
      /* stderr closed — ignore */
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
