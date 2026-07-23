import { describe, expect, test } from 'bun:test';
import { CodexStreamMapping } from './CodexStreamMapping';

const map = CodexStreamMapping.Class.mapEvent;

describe('CodexStreamMapping (envelope confirmed via live probe; items best-effort)', () => {
  test('thread.started → session-start, and threadIdOf captures the id', () => {
    const event = { type: 'thread.started', thread_id: 'abc-123' };
    expect(map(event)).toEqual([{ kind: 'session-start' }]);
    expect(CodexStreamMapping.Class.threadIdOf(event)).toBe('abc-123');
  });

  test('turn.completed → session-end completed', () => {
    expect(map({ type: 'turn.completed', usage: {} })).toEqual([{ kind: 'session-end', reason: 'completed' }]);
  });

  test('turn.failed → error (with message) + session-end error', () => {
    expect(map({ type: 'turn.failed', error: { message: 'usage limit' } })).toEqual([
      { kind: 'error', message: 'usage limit' },
      { kind: 'session-end', reason: 'error' },
    ]);
  });

  test('top-level error event → error', () => {
    expect(map({ type: 'error', message: 'boom' })).toEqual([{ kind: 'error', message: 'boom' }]);
  });

  test('item.completed assistant_message → text-delta', () => {
    const event = { type: 'item.completed', item: { type: 'assistant_message', text: 'hello from codex' } };
    expect(map(event)).toEqual([{ kind: 'text-delta', text: 'hello from codex' }]);
  });

  test('item.completed command_execution → tool-use + tool-result, error flag from exit_code', () => {
    const ok = { type: 'item.completed', item: { type: 'command_execution', id: 'c1', command: 'ls', aggregated_output: 'a\nb', exit_code: 0 } };
    expect(map(ok)).toEqual([
      { kind: 'tool-use', id: 'c1', name: 'command', input: 'ls' },
      { kind: 'tool-result', id: 'c1', result: 'a\nb', isError: false },
    ]);
    const failed = { type: 'item.completed', item: { type: 'command_execution', id: 'c2', command: 'false', output: '', exit_code: 1 } };
    expect(map(failed)[1]).toEqual({ kind: 'tool-result', id: 'c2', result: '', isError: true });
  });

  test('unknown/uninteresting events map to nothing (total function)', () => {
    expect(map({ type: 'turn.started' })).toEqual([]);
    expect(map({ type: 'item.started', item: {} })).toEqual([]);
    expect(map({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } })).toEqual([]);
    expect(map(null)).toEqual([]);
    expect(map('nope')).toEqual([]);
  });
});
