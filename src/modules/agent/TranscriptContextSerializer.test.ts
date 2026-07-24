import { describe, expect, test } from 'bun:test';
import { TranscriptContextSerializer } from './TranscriptContextSerializer';
import type { TranscriptEntry } from './AgentEvents';

const serialize = (transcript: TranscriptEntry[], budget?: number) =>
  TranscriptContextSerializer.Class.serialize(transcript, budget);

describe('TranscriptContextSerializer.serialize', () => {
  test('an empty (or note-only) transcript serializes to the empty string', () => {
    expect(serialize([])).toBe('');
    expect(serialize([{ role: 'system', text: 'switched to codex' }, { role: 'error', text: 'oops' }])).toBe('');
  });

  test('renders user/assistant/tool turns as a bounded, header/footer-framed preamble', () => {
    const preamble = serialize([
      { role: 'user', text: 'What is the capital of France?' },
      { role: 'assistant', text: 'Paris.' },
      { role: 'tool-use', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
      { role: 'tool-result', id: 't1', result: 'hi', isError: false },
    ]);
    expect(preamble).toContain('[Context ported from the previous engine');
    expect(preamble).toContain('User: What is the capital of France?');
    expect(preamble).toContain('Assistant: Paris.');
    expect(preamble).toContain('(tool Bash: {"command":"echo hi"})');
    expect(preamble).toContain('(tool result: hi)');
    expect(preamble).toContain('[End of ported context.');
  });

  test('system + error entries are OMITTED (session-local, not conversation context)', () => {
    const preamble = serialize([
      { role: 'user', text: 'hello' },
      { role: 'system', text: 'switched to codex — context ported' },
      { role: 'error', text: 'transient network error' },
      { role: 'assistant', text: 'hi' },
    ]);
    expect(preamble).not.toContain('switched to codex');
    expect(preamble).not.toContain('transient network');
    expect(preamble).toContain('User: hello');
    expect(preamble).toContain('Assistant: hi');
  });

  test('a tight budget keeps the NEWEST turns and marks the elision', () => {
    const many: TranscriptEntry[] = [];
    for (let index = 0; index < 30; index += 1) many.push({ role: 'user', text: `turn number ${index} with some words` });
    const preamble = serialize(many, 200);
    expect(preamble).toContain('(…earlier turns elided…)');
    expect(preamble).toContain('turn number 29'); // the newest survived
    expect(preamble).not.toContain('turn number 0'); // the oldest was dropped
    expect(preamble.length).toBeLessThan(200 + 200); // header/footer + budget, not the whole 30 turns
  });

  test('a single giant entry is clipped, never allowed to blow the window', () => {
    const preamble = serialize([{ role: 'assistant', text: 'x'.repeat(5000) }]);
    expect(preamble).toContain('…'); // the entry was clipped
    expect(preamble.length).toBeLessThan(1200);
  });
});
