// The codex approval-capable backend: drives `codex app-server` (JSON-RPC over stdio — the successor of
// `codex proto`) behind the same AgentBackend seam every other engine implements. This is codex's
// PERMISSION-PROMPT PARITY with claude's SdkStreamBackend: in ask-mode the server sends a genuine
// server→client request (item/commandExecution/requestApproval / item/fileChange/requestApproval) that
// PAUSES the turn until answered; the pane's y/n/a decisions route back as the v2 enums —
// allow → 'accept', always-allow → 'acceptForSession' (codex's NATIVE session-scoped auto-allow cache,
// so no client-side set is needed), deny → 'decline' (the agent continues the turn and sees the denial).
//
// The process is LONG-LIVED (one app-server per backend; threads live inside it): the first send()
// spawns + initialize + thread/start, later sends reuse the thread (multi-turn continuity). The
// permission mode resolves LIVE per turn (turn/start accepts approvalPolicy + sandboxPolicy overrides):
// bypass → approvalPolicy 'never' + danger-full-access; ask → 'on-request' + workspace-write — so a
// Shift+Tab toggle applies on the next turn, never a frozen creation-time choice (the same
// one-backend-both-modes architecture as the claude SDK backend).
//
// PROTOCOL REALITIES (verified by driving codex-cli 0.144.6 headless): the server speaks the v2 dialect
// (v2 method names + v2 decision enums — the v1 'approved'/'denied' strings are REJECTED and fail-safe
// to decline); on boxes where the bubblewrap sandbox cannot initialize (no user namespaces) codex
// escalates EVERY command to an approval request, so prompts are more frequent there, never fewer.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import type { AgentBackend } from './AgentBackend';
import { AgentPermissions } from './AgentPermissions';
import type { AgentEvent, PermissionDecision } from './AgentEvents';
import { CodexAppServerMapping, type ApprovalDescriptor, type MappingTurnState } from './CodexAppServerMapping';
import { Files } from '../system/Files';

export interface CodexAppServerOptions {
  /** Absolute path to the `codex` binary (resolved by the factory via Bun.which). */
  codexPath: string;
  /** Working directory for the agent (the workspace root). */
  cwd?: string;
  /** Permission mode, resolved LIVE at each send(): true = bypass, false = ask (approval prompts). */
  skipPermissions?: boolean | (() => boolean);
  /** Model override; empty/undefined uses codex's default. */
  model?: string;
}

/** One in-flight JSON-RPC request awaiting its response. */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

class $CodexAppServerBackend implements AgentBackend {
  readonly supportsPermissionPrompts = true;

  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private threadId: string | null = null;
  private turnState: MappingTurnState = CodexAppServerMapping.Class.createTurnState();
  private turnInFlight = false;
  private interrupting = false;
  private disposed = false;
  private permissionRequestCounter = 0;
  private stderrTail = '';

  constructor(private readonly options: CodexAppServerOptions) {}

  send(prompt: string): void {
    if (this.disposed || this.turnInFlight) return; // one turn at a time (AgentSession also guards)
    this.turnInFlight = true;
    this.interrupting = false;
    this.turnState = CodexAppServerMapping.Class.createTurnState();
    void this.runTurn(prompt).catch((error) => {
      this.emit({ kind: 'error', message: String(error) });
      this.emit({ kind: 'session-end', reason: 'error' });
      this.turnInFlight = false;
    });
  }

  private async runTurn(prompt: string): Promise<void> {
    await this.ensureThread();
    // Mode resolves LIVE per turn — a Shift+Tab toggle since the last turn applies here.
    const bypass = AgentPermissions.Class.resolveLive(this.options.skipPermissions);
    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: bypass ? 'never' : 'on-request',
      // SandboxPolicy is a TYPE-tagged union in the v2 dialect ({type: 'dangerFullAccess'|'workspaceWrite'}).
      sandboxPolicy: bypass ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite' },
    });
    // The turn's events (deltas, items, completion) now arrive as notifications; session-end is
    // emitted by the mapping when turn/completed lands. Nothing further to await here.
  }

  /** Spawn the app-server + initialize + start the one thread (first turn only). */
  private async ensureThread(): Promise<void> {
    if (this.child && this.threadId) return;
    if (!this.child) {
      const child = Bun.spawn([this.options.codexPath, 'app-server'], {
        cwd: this.options.cwd ? Files.Class.absolute(this.options.cwd) : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'pipe',
      });
      this.child = child;
      void this.pumpStdout(child);
      void this.drainStderr(child);
      void child.exited.then((exitCode) => {
        if (this.disposed) return;
        // IDENTITY-CHECK: a stale exit from a replaced child must not tear down its successor's state.
        if (this.child !== child) return;
        this.child = null;
        // The THREAD died with its server — a fresh server knows nothing of the old thread id; keeping
        // it made the next send submit a dead id (the reviewed recovery gap).
        this.threadId = null;
        // Reject + clear every in-flight RPC so no awaiting promise leaks forever.
        const reason = new Error(`codex app-server exited (${exitCode})`);
        for (const [, pending] of this.pendingRequests) pending.reject(reason);
        this.pendingRequests.clear();
        // A dead server with a turn in flight must not hang the session.
        if (this.turnInFlight) {
          if (!this.interrupting) {
            this.emit({ kind: 'error', message: this.stderrTail.trim().slice(-400) || `codex app-server exited (${exitCode})` });
          }
          this.emit({ kind: 'session-end', reason: this.interrupting ? 'interrupted' : 'error' });
          this.turnInFlight = false;
        }
      });
      await this.request('initialize', {
        clientInfo: { name: 'invar', title: 'Invar', version: '0.1.0' },
      });
    }
    if (!this.threadId) {
      const started = (await this.request('thread/start', {
        // ABSOLUTE path always: the app-server resolves a relative cwd against ITS OWN process cwd,
        // not ours — a workspace opened as '.' would silently anchor the thread elsewhere.
        ...(this.options.cwd ? { cwd: Files.Class.absolute(this.options.cwd) } : {}),
        ...(this.options.model ? { model: this.options.model } : {}),
      })) as { thread?: { id?: string } };
      this.threadId = started?.thread?.id ?? null;
      if (!this.threadId) throw new Error('codex app-server returned no thread id');
    }
  }

  /** Write one JSON-RPC line to the server's stdin. Bun.spawn's stdin is a FileSink (write + flush),
   *  NOT a WritableStream — a getWriter() path would silently no-op every message. */
  private write(payload: unknown): void {
    const sink = this.child?.stdin as unknown as { write?: (data: string) => unknown; flush?: () => unknown } | null;
    if (!sink || typeof sink.write !== 'function') return;
    try {
      sink.write(JSON.stringify(payload) + '\n');
      sink.flush?.();
    } catch {
      /* the exit handler surfaces a dead server */
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pendingRequests.set(id, { resolve, reject, method }));
  }

  private async pumpStdout(child: ReturnType<typeof Bun.spawn>): Promise<void> {
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
    } catch {
      /* stream closed — the exit handler owns surfacing it */
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise
    }
    const id = message.id;
    // A response to one of OUR requests.
    if (id !== undefined && message.method === undefined) {
      const pending = this.pendingRequests.get(id as number);
      if (pending) {
        this.pendingRequests.delete(id as number);
        if (message.error !== undefined) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
      }
      return;
    }
    // A SERVER→CLIENT REQUEST — an approval pause, or something we don't speak. EVERY request gets an
    // answer: an unanswered request leaves the server hanging to its timeout (the reviewed
    // permissions-request hang); unknown methods get a proper JSON-RPC method-not-found error, which the
    // server handles like any refused capability.
    if (id !== undefined && typeof message.method === 'string') {
      const approval = CodexAppServerMapping.Class.approvalOf(message.method, message.params);
      if (approval) this.emitPermissionRequest(id as number | string, approval);
      else this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not supported by this client: ${message.method}` } });
      return;
    }
    // A notification — map through the pure seam.
    if (typeof message.method === 'string') {
      for (const event of CodexAppServerMapping.Class.mapNotification(
        { method: message.method, params: message.params },
        this.turnState,
      )) {
        if (event.kind === 'session-end') this.turnInFlight = false;
        this.emit(event);
      }
    }
  }

  /** Surface a paused approval as the provider-neutral 'permission-request'; route the user's decision
   *  back through the approval's METHOD-SPECIFIC response builder (a decision enum for command/patch
   *  approvals, a granted profile for permission requests). Exactly-once (the session also guards). */
  private emitPermissionRequest(rpcId: number | string, approval: ApprovalDescriptor): void {
    this.permissionRequestCounter += 1;
    let settled = false;
    this.emit({
      kind: 'permission-request',
      id: `codex-permission-${this.permissionRequestCounter}`,
      toolName: approval.toolName,
      input: approval.input,
      respond: (decision: PermissionDecision) => {
        if (settled || this.disposed) return;
        settled = true;
        this.write({ jsonrpc: '2.0', id: rpcId, result: approval.respondWith(decision) });
      },
    });
  }

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

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    if (this.turnInFlight && this.threadId) {
      this.interrupting = true;
      void this.request('turn/interrupt', { threadId: this.threadId }).catch(() => {
        /* already ending */
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.child?.kill();
    this.child = null;
    this.eventCallback = null;
    this.pendingRequests.clear();
  }

  private emit(event: AgentEvent): void {
    if (!this.disposed) this.eventCallback?.(event);
  }
}

export namespace CodexAppServerBackend {
  export const $Class = $CodexAppServerBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
