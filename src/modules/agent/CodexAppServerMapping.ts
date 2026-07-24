// Pure mapping from `codex app-server` v2 JSON-RPC NOTIFICATIONS to the provider-neutral AgentEvent
// vocabulary — the codex-side twin of ClaudeStreamMapping, kept separate from the subprocess-bound
// backend so the translation is a Static capability unit-tested with plain objects. The app-server is
// codex's approval-capable stdio protocol (the successor of `codex proto`): agent text arrives as
// item/agentMessage deltas + completions, tool activity as commandExecution item lifecycle, and the turn
// boundary as turn/completed. APPROVALS are server→client REQUESTS (not notifications) — the backend
// routes those; this file supplies the pure param→descriptor translation for them.
//
// invariant: An agent session is a structured event stream, not a screen (src/modules/agent/agent.invariants.md)
import { Static } from 'ivue/extras';
import type { AgentEvent } from './AgentEvents';

/** A JSON-RPC notification (method + params) as parsed off the app-server stdout. */
export interface AppServerNotification {
  method: string;
  params?: unknown;
}

/** What a server→client approval REQUEST asks, translated to the pane's vocabulary — plus the
 *  per-METHOD response builder (the wire shapes differ: command/patch approvals answer a decision
 *  enum; a permission-profile request answers a granted profile). */
export interface ApprovalDescriptor {
  /** The tool name the pane prompt renders (through AgentToolSummary). */
  toolName: string;
  /** The salient input (the shell command / patch summary / permission reason). */
  input: unknown;
  /** Build THIS method's JSON-RPC result for the user's decision. */
  respondWith(decision: 'allow' | 'always-allow' | 'deny'): unknown;
}

/** Mutable per-turn mapping state: which agentMessage items already streamed deltas (so their
 *  item/completed does not re-emit the full text) — owned by the caller, one per turn. */
export interface MappingTurnState {
  streamedItemIds: Set<string>;
}

function createMappingTurnState(): MappingTurnState {
  return { streamedItemIds: new Set() };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Map ONE app-server notification to zero or more AgentEvents. Pure over (notification, turnState);
 *  unknown or uninteresting methods (reasoning deltas, token usage, rate limits, …) map to []. */
function $mapNotification(notification: AppServerNotification, turnState: MappingTurnState): AgentEvent[] {
  const params = record(notification.params);
  switch (notification.method) {
    case 'thread/started':
      return [{ kind: 'session-start' }];
    case 'item/agentMessage/delta': {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      if (!delta) return [];
      if (itemId) turnState.streamedItemIds.add(itemId);
      return [{ kind: 'text-delta', text: delta }];
    }
    case 'item/started': {
      const item = record(params.item);
      if (item.type === 'commandExecution') {
        return [
          {
            kind: 'tool-use',
            id: String(item.id ?? ''),
            name: 'Bash',
            input: { command: String(item.command ?? '') },
          },
        ];
      }
      return [];
    }
    case 'item/completed': {
      const item = record(params.item);
      if (item.type === 'agentMessage') {
        // Emit the full text ONLY when no deltas streamed for this item (delta-less servers/configs).
        const itemId = String(item.id ?? '');
        const text = typeof item.text === 'string' ? item.text : '';
        if (!text || turnState.streamedItemIds.has(itemId)) return [];
        return [{ kind: 'text-delta', text }];
      }
      if (item.type === 'commandExecution') {
        const status = String(item.status ?? '');
        const declined = status === 'declined';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        return [
          {
            kind: 'tool-result',
            id: String(item.id ?? ''),
            result: declined ? 'The user denied this command.' : output,
            isError: declined || (exitCode !== null && exitCode !== 0),
          },
        ];
      }
      return [];
    }
    case 'turn/completed': {
      const turn = record(params.turn);
      const status = String(turn.status ?? 'completed');
      if (status === 'failed') {
        return [{ kind: 'session-end', reason: 'error' }];
      }
      return [{ kind: 'session-end', reason: status === 'interrupted' ? 'interrupted' : 'completed' }];
    }
    default:
      return [];
  }
}

/** Translate a server→client approval REQUEST's method+params into the pane's prompt vocabulary (with
 *  its method-specific response builder), or null when the method is not an approval at all. Three
 *  approval families exist in the current dialect (the reviewed gap: the permissions request was
 *  unrecognized, so it hung to the fail-safe instead of reaching the y/n/a prompt):
 *  - command execution / file change → decision enum (accept / acceptForSession / decline);
 *  - permission-profile requests → a GRANT: the requested profile back (allow: this turn;
 *    always-allow: session scope) or an EMPTY profile (deny grants nothing; the turn continues). */
function $approvalOf(method: string, params: unknown): ApprovalDescriptor | null {
  const parameters = record(params);
  const decisionResponse = (decision: 'allow' | 'always-allow' | 'deny'): unknown => ({
    decision: $decisionToCodex(decision),
  });
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    const command = parameters.command;
    const commandText = Array.isArray(command) ? command.join(' ') : String(command ?? '');
    return {
      toolName: 'Bash',
      input: { command: commandText, reason: parameters.reason ?? undefined },
      respondWith: decisionResponse,
    };
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return {
      toolName: 'ApplyPatch',
      input: { reason: parameters.reason ?? 'apply file changes' },
      respondWith: decisionResponse,
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const requestedProfile = parameters.permissions ?? {};
    return {
      toolName: 'Permissions',
      input: { reason: parameters.reason ?? 'grant additional permissions', request: requestedProfile },
      respondWith: (decision) =>
        decision === 'deny'
          ? { permissions: {} } // grant NOTHING — a valid answer; the turn continues denied
          : { permissions: requestedProfile, scope: decision === 'always-allow' ? 'session' : 'turn' },
    };
  }
  return null;
}

/** Translate the pane's y/n/a decision to the v2 wire enum. allow → accept; always-allow →
 *  acceptForSession (codex's native session-scoped auto-allow — no client-side set needed); deny →
 *  decline (the agent continues the turn — exactly our deny semantics). The v1 strings
 *  ('approved'/'denied') are REJECTED by the server and fail-safe to decline — never send them. */
function $decisionToCodex(decision: 'allow' | 'always-allow' | 'deny'): 'accept' | 'acceptForSession' | 'decline' {
  if (decision === 'deny') return 'decline';
  if (decision === 'always-allow') return 'acceptForSession';
  return 'accept';
}

class $CodexAppServerMapping {
  static mapNotification = $mapNotification;
  static approvalOf = $approvalOf;
  static decisionToCodex = $decisionToCodex;
  static createTurnState = createMappingTurnState;
}

export namespace CodexAppServerMapping {
  export const $Class = $CodexAppServerMapping;
  export const Class = Static($CodexAppServerMapping);
}
