// The Claude Agent SDK backend — the interactive-approval path the AgentBackend seam anticipated
// ("ClaudeSdkBackend"). It drives @anthropic-ai/claude-agent-sdk's query() (which wraps the bundled CLI,
// so the user's subscription OAuth works headless) and maps each SDK message through the SAME
// ClaudeStreamMapping the CLI backend uses — the SDK yields the very objects `--output-format
// stream-json` prints, so there is ONE Claude dialect translation, not a fork.
//
// PERMISSIONS are the point of this backend: in ask-mode it passes canUseTool, which PAUSES a gated tool
// call until the user answers; the pause surfaces as a 'permission-request' AgentEvent whose respond()
// resolves the SDK callback (allow runs the tool, deny blocks it and the turn continues with the denial
// visible to the agent). 'always-allow' adds the tool to a session-scoped auto-allow set so future calls
// skip the prompt. In bypass-mode it runs permissionMode 'bypassPermissions' with no gating. The mode is
// resolved LIVE per send() (each turn is a fresh query() resumed by session id), so a Shift+Tab toggle
// takes effect on the next turn — one backend for both modes, never a frozen creation-time choice.
//
// SDK REALITIES (verified by driving on this box): subscription auth works headless (apiKeySource
// "none"); an auto-mode classifier approves SAFE read-only commands without consulting canUseTool (only
// consequential calls prompt — no prompt spam); bare `allowedTools` entries would SHADOW canUseTool, so
// this backend never passes them.
//
// invariant: Agent events cross exactly one backend seam (src/modules/agent/agent.invariants.md)
import { query, type Query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend } from './AgentBackend';
import { AgentPermissions } from './AgentPermissions';
import type { AgentEvent, PermissionDecision } from './AgentEvents';
import { ClaudeStreamMapping } from './ClaudeStreamMapping';

export interface SdkStreamOptions {
  /** Working directory for the agent (the workspace root), so Claude operates in the user's project. */
  cwd?: string;
  /** Permission mode, resolved LIVE at each send(): true = bypass (no gating), false = ask (canUseTool
   *  prompts). A GETTER honors a Shift+Tab toggle on the next turn. */
  skipPermissions?: boolean | (() => boolean);
  /** Model override; empty/undefined uses Claude's default. */
  model?: string;
}

class $SdkStreamBackend implements AgentBackend {
  readonly supportsPermissionPrompts = true;

  private eventCallback: ((event: AgentEvent) => void) | null = null;
  private activeQuery: Query | null = null;
  private sessionId: string | null = null;
  private sawResult = false;
  private interrupting = false;
  private disposed = false;
  /** Session-scoped auto-allow: tools the user answered 'always-allow' for — future calls skip the prompt. */
  private readonly autoAllowedTools = new Set<string>();
  private permissionRequestCounter = 0;

  constructor(private readonly options: SdkStreamOptions) {}

  send(prompt: string): void {
    if (this.disposed || this.activeQuery) return; // one turn at a time (AgentSession also guards this)
    this.sawResult = false;
    this.interrupting = false;
    const bypass = AgentPermissions.Class.resolveLive(this.options.skipPermissions);
    let turn: Query;
    try {
      turn = query({
        prompt,
        options: {
          cwd: this.options.cwd,
          model: this.options.model || undefined,
          resume: this.sessionId ?? undefined,
          ...(bypass
            ? { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }
            : { permissionMode: 'default' as const, canUseTool: this.gateToolCall }),
        },
      });
    } catch (error) {
      this.emit({ kind: 'error', message: `Failed to start the Claude SDK session: ${String(error)}` });
      this.emit({ kind: 'session-end', reason: 'error' });
      return;
    }
    this.activeQuery = turn;
    void this.pump(turn);
  }

  /** The SDK's canUseTool: pause the gated call as a 'permission-request' event until respond() answers.
   *  Auto-allowed tools (a previous 'always-allow') resolve immediately with no prompt. */
  private readonly gateToolCall = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (this.disposed) return { behavior: 'deny', message: 'Session closed' };
    if (this.autoAllowedTools.has(toolName)) return { behavior: 'allow', updatedInput: input };
    return new Promise<PermissionResult>((resolve) => {
      this.permissionRequestCounter += 1;
      const id = `permission-${this.permissionRequestCounter}`;
      let settled = false;
      this.emit({
        kind: 'permission-request',
        id,
        toolName,
        input,
        respond: (decision: PermissionDecision) => {
          if (settled) return; // exactly-once (the session also guards, belt and braces)
          settled = true;
          if (decision === 'always-allow') this.autoAllowedTools.add(toolName);
          resolve(
            decision === 'deny'
              ? { behavior: 'deny', message: 'The user denied this tool call.' }
              : { behavior: 'allow', updatedInput: input },
          );
        },
      });
    });
  };

  private async pump(turn: Query): Promise<void> {
    try {
      for await (const message of turn) {
        const sessionId = ClaudeStreamMapping.Class.sessionIdOf(message);
        if (sessionId) this.sessionId = sessionId; // captured for `resume` on the next turn
        for (const event of ClaudeStreamMapping.Class.mapEvent(message)) {
          if (event.kind === 'session-end') this.sawResult = true; // the stream ended the turn itself
          this.emit(event);
        }
      }
    } catch (error) {
      if (!this.interrupting && !this.disposed) this.emit({ kind: 'error', message: String(error) });
    }
    this.activeQuery = null;
    // Synthesize an end if the stream did not carry its own result, so the session never hangs.
    if (!this.sawResult && !this.disposed) {
      this.emit({ kind: 'session-end', reason: this.interrupting ? 'interrupted' : 'completed' });
    }
  }

  onEvent(callback: (event: AgentEvent) => void): void {
    this.eventCallback = callback;
  }

  interrupt(): void {
    if (this.activeQuery) {
      this.interrupting = true;
      void this.activeQuery.interrupt().catch(() => {
        /* already ending — nothing to interrupt */
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.activeQuery?.interrupt().catch(() => {
      /* already gone */
    });
    this.activeQuery = null;
    this.eventCallback = null;
  }

  private emit(event: AgentEvent): void {
    if (!this.disposed) this.eventCallback?.(event);
  }
}

export namespace SdkStreamBackend {
  export const $Class = $SdkStreamBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
