import { describe, expect, test } from 'bun:test';
import { mapClaudeStreamEvent } from './CliStreamBackend';

// Fixtures trimmed from a REAL `claude -p "…" --output-format stream-json --verbose` run (2026-07-23).
const INIT = { type: 'system', subtype: 'init', session_id: 'e85079b7', model: 'claude-fable-5' };
const ASSISTANT_TEXT = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
};
const ASSISTANT_TOOL = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }] },
};
const USER_TOOL_RESULT = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false }] },
};
const RESULT_OK = { type: 'result', subtype: 'success', is_error: false, result: 'hello world', total_cost_usd: 0.19 };
const RESULT_ERR = { type: 'result', subtype: 'error', is_error: true };
const RATE_LIMIT = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } };

describe('mapClaudeStreamEvent', () => {
  test('init → session-start', () => {
    expect(mapClaudeStreamEvent(INIT)).toEqual([{ kind: 'session-start' }]);
  });

  test('assistant text block → text-delta with the exact text', () => {
    expect(mapClaudeStreamEvent(ASSISTANT_TEXT)).toEqual([{ kind: 'text-delta', text: 'hello world' }]);
  });

  test('assistant tool_use block → tool-use with id/name/input', () => {
    expect(mapClaudeStreamEvent(ASSISTANT_TOOL)).toEqual([
      { kind: 'tool-use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    ]);
  });

  test('user tool_result → tool-result paired by tool_use_id', () => {
    expect(mapClaudeStreamEvent(USER_TOOL_RESULT)).toEqual([
      { kind: 'tool-result', id: 'toolu_1', result: 'file body', isError: false },
    ]);
  });

  test('tool_result with array content joins the text parts', () => {
    const event = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], is_error: true }] },
    };
    expect(mapClaudeStreamEvent(event)).toEqual([{ kind: 'tool-result', id: 't', result: 'ab', isError: true }]);
  });

  test('result → session-end, error flag honored', () => {
    expect(mapClaudeStreamEvent(RESULT_OK)).toEqual([{ kind: 'session-end', reason: 'completed' }]);
    expect(mapClaudeStreamEvent(RESULT_ERR)).toEqual([{ kind: 'session-end', reason: 'error' }]);
  });

  test('a multi-block assistant message maps each block in order', () => {
    const event = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'x', name: 'Bash', input: {} }] },
    };
    expect(mapClaudeStreamEvent(event)).toEqual([
      { kind: 'text-delta', text: 'Let me look.' },
      { kind: 'tool-use', id: 'x', name: 'Bash', input: {} },
    ]);
  });

  test('uninteresting / malformed events map to nothing (total function)', () => {
    expect(mapClaudeStreamEvent(RATE_LIMIT)).toEqual([]);
    expect(mapClaudeStreamEvent({ type: 'stream_event' })).toEqual([]);
    expect(mapClaudeStreamEvent(null)).toEqual([]);
    expect(mapClaudeStreamEvent('not an object')).toEqual([]);
    expect(mapClaudeStreamEvent({ type: 'assistant' })).toEqual([]); // no content
  });
});
