// The Codex (subscription/API-billed) agent backend: drives `codex exec --json`, reads the
// newline-delimited JSON event stream, and maps each object to an AgentEvent behind the SAME one
// backend seam as CliStreamBackend (Claude) — so AgentSession and the pane are unchanged. The neutral
// `agentSkipPermissions` maps to codex's `--dangerously-bypass-approvals-and-sandbox`; `agentModel` to
// `-m`. The line→event mapping is the pure, tested CodexStreamMapping.
//
// STATUS: envelope drive-verified; item-level mapping + turn continuity are best-effort pending a live
// run (codex was out of usage credits at build, resets 2026-07-28). v1 is stateless per turn (no
// resume) to avoid guessing the resume CLI shape before it can be verified.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentBackend } from './AgentBackend';
import type { AgentEvent } from './AgentEvents';
import { CodexStreamMapping } from './CodexStreamMapping';

export interface CodexStreamOptions {
  /** Absolute path to the `codex` binary (resolved by the factory via Bun.which). */
  codexPath: string;
  /** Working directory for the agent (the workspace root). */
  cwd?: string;
  /** Run without approval prompts / sandbox (`--dangerously-bypass-approvals-and-sandbox`). */
  skipPermissions?: boolean;
  /** Model override (`-m`); empty/undefined uses codex's default. */
  model?: string;
}

class $CodexStreamBackend implements AgentBackend {
  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private threadId: string | null = null;
  private sawEnd = false;
  private interrupting = false;
  private disposed = false;
  private stderrTail = '';

  constructor(private readonly options: CodexStreamOptions) {}

  send(prompt: string): void {
    if (this.disposed || this.child) return;
    this.sawEnd = false;
    this.interrupting = false;
    this.stderrTail = '';
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (this.options.skipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
    if (this.options.model) args.push('-m', this.options.model);
    args.push(prompt); // prompt as the final positional argument
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([this.options.codexPath, ...args], {
        cwd: this.options.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
    } catch (error) {
      this.emit({ kind: 'error', message: `Failed to launch codex: ${String(error)}` });
      this.emit({ kind: 'session-end', reason: 'error' });
      return;
    }
    this.child = child;
    void this.pump(child);
  }

  private async pump(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    const drainStderr = this.drainStderr(child);
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
    if (!this.sawEnd && !this.disposed) {
      if (!this.interrupting && exitCode !== 0 && this.stderrTail.trim()) {
        this.emit({ kind: 'error', message: this.stderrTail.trim().slice(-400) });
      }
      this.emit({ kind: 'session-end', reason: this.interrupting ? 'interrupted' : exitCode === 0 ? 'completed' : 'error' });
    }
  }

  private async drainStderr(child: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!child.stderr) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stderr as AsyncIterable<Uint8Array>) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000);
      }
    } catch {
      /* ignore */
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }
    const threadId = CodexStreamMapping.Class.threadIdOf(raw);
    if (threadId) this.threadId = threadId;
    for (const event of CodexStreamMapping.Class.mapEvent(raw)) {
      if (event.kind === 'session-end') this.sawEnd = true;
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

export namespace CodexStreamBackend {
  export const $Class = $CodexStreamBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
