import { describe, expect, test } from 'bun:test';
import { AgentToolSummary } from './AgentToolSummary';

const summarize = AgentToolSummary.Class.summarize;
const summarizeResult = AgentToolSummary.Class.summarizeResult;

describe('AgentToolSummary.summarize — human phrases, never raw JSON', () => {
  test('Read/Write/Edit show the file BASENAME, not the full path', () => {
    expect(summarize('Read', { file_path: '/home/me/project/src/Foo.ts' })).toBe('Reading Foo.ts');
    expect(summarize('Write', { file_path: 'a/b/Bar.md' })).toBe('Writing Bar.md');
    expect(summarize('Edit', { file_path: 'x\\y\\Baz.tsx' })).toBe('Editing Baz.tsx');
    expect(summarize('MultiEdit', { file_path: '/q/Qux.js' })).toBe('Editing Qux.js');
  });

  test('Bash shows "$ <command>", truncated to ~60 chars', () => {
    expect(summarize('Bash', { command: 'echo hi' })).toBe('$ echo hi');
    const long = summarize('Bash', { command: 'x'.repeat(200) });
    expect(long.startsWith('$ ')).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(62); // "$ " + 60
    expect(long.endsWith('…')).toBe(true);
  });

  test('Grep / Glob / LS / WebFetch / WebSearch / Task / TodoWrite each read their salient arg', () => {
    expect(summarize('Grep', { pattern: 'TODO', path: '/repo/src' })).toBe('Searching "TODO" in src');
    expect(summarize('Grep', { pattern: 'x' })).toBe('Searching "x"');
    expect(summarize('Glob', { pattern: '**/*.ts' })).toBe('Finding **/*.ts');
    expect(summarize('LS', { path: '/home/me/dir' })).toBe('Listing dir');
    expect(summarize('WebFetch', { url: 'https://example.com/a/b?c=1' })).toBe('Fetching example.com');
    expect(summarize('WebSearch', { query: 'how to reduce' })).toBe('Searching "how to reduce"');
    expect(summarize('Task', { description: 'refactor the parser', prompt: 'long prompt…' })).toBe('refactor the parser');
    expect(summarize('TodoWrite', { todos: [] })).toBe('Updating the plan');
  });

  test('an unknown tool degrades to its FIRST string arg (compact), never the whole JSON', () => {
    const phrase = summarize('MysteryTool', { count: 3, label: 'the salient value', nested: { a: 1 } });
    expect(phrase).toBe('the salient value');
    expect(phrase).not.toContain('{'); // never a JSON blob
  });
});

describe('AgentToolSummary.summarizeResult — short outcome', () => {
  test('a multi-line ok result reads as "<N> lines"', () => {
    expect(summarizeResult('a\nb\nc', false)).toBe('3 lines');
  });
  test('a short ok result shows its text; empty reads "done"', () => {
    expect(summarizeResult('all good', false)).toBe('all good');
    expect(summarizeResult('   ', false)).toBe('done');
  });
  test('an error result reads "error: <message>"', () => {
    expect(summarizeResult('boom happened', true)).toBe('error: boom happened');
  });
});
