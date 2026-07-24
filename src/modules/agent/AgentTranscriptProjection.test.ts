import { describe, expect, test } from 'bun:test';
import { AgentTranscriptProjection } from './AgentTranscriptProjection';
import { DARK } from '../theme/ThemePalettes';
import type { TranscriptEntry } from './AgentEvents';

const project = (
  transcript: TranscriptEntry[],
  width: number,
  expanded: ReadonlySet<number> = new Set(),
  glyph: 'nerd' | 'unicode' | 'ascii' = 'unicode',
) => AgentTranscriptProjection.Class.project(transcript, DARK, glyph, width, expanded);

describe('AgentTranscriptProjection.project', () => {
  test('an empty transcript projects the single empty-state hint (not a toggle row)', () => {
    const lines = project([], 40);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('Ask Claude');
    expect(lines[0]?.toggleable).toBe(false);
    expect(lines[0]?.entryIndex).toBe(-1);
  });

  test('user + assistant render a bold label line then wrapped body lines tagged to their entry', () => {
    const lines = project(
      [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
      ],
      40,
    );
    expect(lines[0]).toMatchObject({ text: 'You', bold: true, entryIndex: 0, toggleable: false });
    expect(lines[1]).toMatchObject({ text: 'hello', bold: false, entryIndex: 0 });
    // A blank turn-separator line precedes the assistant turn (airy spacing).
    expect(lines[2]).toMatchObject({ text: '', entryIndex: -1, toggleable: false });
    expect(lines[3]).toMatchObject({ text: 'Claude', bold: true, entryIndex: 1, toggleable: false });
    expect(lines[4]).toMatchObject({ text: 'hi there', bold: false, entryIndex: 1 });
  });

  test('a tool-use collapses to ONE toggleable summary line with caret + gear + name + input', () => {
    const lines = project([{ role: 'tool-use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }], 60);
    expect(lines).toHaveLength(1);
    const summary = lines[0]!;
    expect(summary.toggleable).toBe(true);
    expect(summary.entryIndex).toBe(0);
    expect(summary.text).toContain('▸'); // collapsed caret
    expect(summary.text).toContain('⚙');
    expect(summary.text).toContain('Bash');
    expect(summary.text).toContain('echo hi');
  });

  test('an expanded tool-use shows an expanded caret header PLUS pretty multi-line input', () => {
    const entry: TranscriptEntry = { role: 'tool-use', id: 't1', name: 'Bash', input: { command: 'echo hi' } };
    const lines = project([entry], 60, new Set([0]));
    expect(lines.length).toBeGreaterThan(1); // header + pretty body
    expect(lines[0]!.text).toContain('▾'); // expanded caret
    expect(lines.every((line) => line.entryIndex === 0 && line.toggleable)).toBe(true);
    expect(lines.some((line) => line.text.includes('"command"'))).toBe(true); // pretty JSON
  });

  test('a tool-result collapses to ✓ (ok) / ✗ (error) summary rows', () => {
    const ok = project([{ role: 'tool-result', id: 't1', result: 'done ok', isError: false }], 60);
    expect(ok[0]!.text).toContain('✓');
    expect(ok[0]!.toggleable).toBe(true);
    const bad = project([{ role: 'tool-result', id: 't1', result: 'boom', isError: true }], 60);
    expect(bad[0]!.text).toContain('✗');
  });

  test('bodies WRAP to width — no projected line exceeds the width in code points', () => {
    const long = 'x'.repeat(200);
    const lines = project([{ role: 'assistant', text: long }], 20);
    for (const line of lines) expect(Array.from(line.text).length).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThan(1); // it actually wrapped
  });

  test('a collapsed summary is truncated to width (never overflows the pane)', () => {
    const lines = project([{ role: 'tool-use', id: 't1', name: 'Bash', input: 'a'.repeat(200) }], 25);
    expect(lines).toHaveLength(1);
    expect(Array.from(lines[0]!.text).length).toBeLessThanOrEqual(25);
  });

  test('the ascii glyph tier uses > / v carets and a * tool glyph (no unicode)', () => {
    const collapsed = project([{ role: 'tool-use', id: 't1', name: 'Bash', input: 'x' }], 40, new Set(), 'ascii');
    expect(collapsed[0]!.text).toContain('>');
    expect(collapsed[0]!.text).toContain('*');
    expect(collapsed[0]!.text).not.toContain('⚙');
    const expanded = project([{ role: 'tool-use', id: 't1', name: 'Bash', input: 'x' }], 40, new Set([0]), 'ascii');
    expect(expanded[0]!.text).toContain('v');
  });
});

describe('AgentTranscriptProjection.firstVisibleLine', () => {
  const first = AgentTranscriptProjection.Class.firstVisibleLine;

  test('stuck-to-bottom anchors the newest bodyHeight lines (maxTop)', () => {
    expect(first(100, 10, 0, true)).toBe(90);
  });

  test('when content is shorter than the body, the window starts at 0', () => {
    expect(first(5, 10, 0, true)).toBe(0);
    expect(first(5, 10, 3, false)).toBe(0);
  });

  test('unstuck holds scrollTopLines, clamped into [0, maxTop]', () => {
    expect(first(100, 10, 25, false)).toBe(25);
    expect(first(100, 10, 999, false)).toBe(90); // clamped to maxTop
    expect(first(100, 10, -5, false)).toBe(0); // clamped to 0
  });
});
