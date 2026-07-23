// Pure mapping from `claude ... --output-format stream-json` objects to the provider-neutral AgentEvent
// vocabulary. Kept separate from CliStreamBackend (the subprocess-bound half) so the translation is a
// Static capability that is unit-tested against recorded fixtures with no shell involved. Each provider
// gets its own mapping (this one for Claude; CodexStreamMapping for Codex) — the dialect translation
// that lives BELOW the one backend seam.
//
// invariant: An agent session is a structured event stream, not a screen (src/modules/agent/agent.invariants.md)
import { Static } from 'ivue/extras';
import type { AgentEvent } from './AgentEvents';

/** Extract plain text from a tool_result block's `content` (a string, or an array of text parts). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

/** Map ONE parsed claude stream-json object to zero or more AgentEvents. Pure and total — unknown or
 *  uninteresting event types (rate_limit_event, stream_event, …) map to []. */
function $mapEvent(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'system':
      return record.subtype === 'init' ? [{ kind: 'session-start' }] : [];
    case 'assistant': {
      const content = (record.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const part = block as Record<string, unknown>;
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          events.push({ kind: 'text-delta', text: part.text });
        } else if (part.type === 'tool_use') {
          events.push({ kind: 'tool-use', id: String(part.id ?? ''), name: String(part.name ?? 'tool'), input: part.input });
        }
      }
      return events;
    }
    case 'user': {
      const content = (record.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const part = block as Record<string, unknown>;
        if (part.type === 'tool_result') {
          events.push({
            kind: 'tool-result',
            id: String(part.tool_use_id ?? ''),
            result: toolResultText(part.content),
            isError: part.is_error === true,
          });
        }
      }
      return events;
    }
    case 'result':
      return [{ kind: 'session-end', reason: record.is_error === true ? 'error' : 'completed' }];
    default:
      return [];
  }
}

/** Whether an init object carries a session id (captured by the backend for `--resume`). */
function $sessionIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.type === 'system' && record.subtype === 'init' && typeof record.session_id === 'string') {
    return record.session_id;
  }
  return null;
}

class $ClaudeStreamMapping {
  static mapEvent = $mapEvent;
  static sessionIdOf = $sessionIdOf;
}

export namespace ClaudeStreamMapping {
  export const $Class = $ClaudeStreamMapping;
  export const Class = Static($ClaudeStreamMapping);
}
