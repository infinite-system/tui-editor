// Pure mapping from `codex exec --json` JSONL objects to the provider-neutral AgentEvent vocabulary —
// the Codex-dialect sibling of ClaudeStreamMapping, living BELOW the one backend seam. The event
// ENVELOPE (thread.started / turn.started / turn.completed / turn.failed / error) is confirmed from a
// live probe (2026-07-23); the item.* payload shapes (assistant_message / command_execution) follow
// codex's documented exec-json format and are handled defensively (total function, unknown → []).
//
// NOTE: full item-level mapping is not yet DRIVE-verified — codex was out of usage credits at build
// time (resets 2026-07-28). The envelope mapping is verified; item mapping is best-effort until a live
// run confirms the exact field names, at which point this file is the single place to adjust.
//
// invariant: An agent session is a structured event stream, not a screen (src/modules/agent/agent.invariants.md)
import { Static } from 'ivue/extras';
import type { AgentEvent } from './AgentEvents';

/** Best-effort text extraction from a codex item (string field under a few likely names). */
function itemText(item: Record<string, unknown>): string {
  const candidate = item.text ?? item.message ?? item.content;
  return typeof candidate === 'string' ? candidate : candidate == null ? '' : JSON.stringify(candidate);
}

/** Map ONE parsed codex stream-json object to zero or more AgentEvents. Pure and total. */
function $mapEvent(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'thread.started':
      return [{ kind: 'session-start' }];
    case 'turn.completed':
      return [{ kind: 'session-end', reason: 'completed' }];
    case 'turn.failed': {
      const message = (record.error as { message?: unknown })?.message;
      const events: AgentEvent[] = [];
      if (typeof message === 'string' && message) events.push({ kind: 'error', message });
      events.push({ kind: 'session-end', reason: 'error' });
      return events;
    }
    case 'error': {
      const message = typeof record.message === 'string' ? record.message : 'codex error';
      return [{ kind: 'error', message }];
    }
    case 'item.completed': {
      const item = record.item;
      if (!item || typeof item !== 'object') return [];
      const itemRecord = item as Record<string, unknown>;
      switch (itemRecord.type) {
        case 'assistant_message':
        case 'agent_message': {
          const text = itemText(itemRecord);
          return text ? [{ kind: 'text-delta', text }] : [];
        }
        case 'command_execution': {
          const id = String(itemRecord.id ?? '');
          const command = itemRecord.command ?? itemRecord.parsed_cmd ?? '';
          const output = itemRecord.aggregated_output ?? itemRecord.output ?? '';
          const events: AgentEvent[] = [
            { kind: 'tool-use', id, name: 'command', input: command },
          ];
          const resultText = typeof output === 'string' ? output : JSON.stringify(output);
          events.push({ kind: 'tool-result', id, result: resultText, isError: itemRecord.exit_code != null && itemRecord.exit_code !== 0 });
          return events;
        }
        case 'error': {
          const text = itemText(itemRecord);
          return text ? [{ kind: 'error', message: text }] : [];
        }
        default:
          return []; // reasoning, file_change, todo_list, web_search, … not projected in tier S
      }
    }
    default:
      return []; // turn.started, item.started/updated, and unknowns
  }
}

/** The thread id from a thread.started event (captured by the backend for `codex exec resume`). */
function $threadIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.type === 'thread.started' && typeof record.thread_id === 'string') return record.thread_id;
  return null;
}

class $CodexStreamMapping {
  static mapEvent = $mapEvent;
  static threadIdOf = $threadIdOf;
}

export namespace CodexStreamMapping {
  export const $Class = $CodexStreamMapping;
  export const Class = Static($CodexStreamMapping);
}
