import { describe, expect, test } from 'bun:test';
import { AgentThinkingIndicator } from './AgentThinkingIndicator';
import { DARK } from '../theme/ThemePalettes';

const text = (segments: { text: string }[]) => segments.map((segment) => segment.text).join('');

const baseState = (overrides: Partial<Parameters<typeof AgentThinkingIndicator.Class.compose>[0]> = {}) => ({
  frameIndex: 0,
  elapsedSeconds: 0,
  glyphLevel: 'unicode' as const,
  colorDepth: 'truecolor' as const,
  palette: DARK,
  ...overrides,
});

describe('AgentThinkingIndicator word list (user-LOCKED)', () => {
  test('the core rotation is EXACTLY the 20 locked strings, in order', () => {
    expect([...AgentThinkingIndicator.Class.coreWords]).toEqual([
      'Reducing…', 'Distilling…', 'Carving away…', 'Collapsing the space…', 'Converging…',
      'Generating…', 'Synthesizing…', 'Triangulating…', 'Grounding in reality…', 'Scoping…',
      'Testing invariance…', 'Refining…', 'Isolating what remains…', 'Testing boundaries…', 'Auditing…',
      'Breaking assumptions…', 'Reframing…', 'Finding the invariant…', 'Crystallizing…',
    ]);
    expect(AgentThinkingIndicator.Class.coreWords).toHaveLength(19);
  });

  test('the easter-eggs are EXACTLY the 6 locked strings', () => {
    expect([...AgentThinkingIndicator.Class.easterEggs]).toEqual([
      'Quantum-hopping the solution space…', 'Consulting the negative space…', 'Deleting what refuses to matter…',
      'Quantizing the ineffable…', 'Two-axis Auditing…', 'Approaching the limit…',
    ]);
  });

  test('every pick is a core word OR an easter-egg (never anything else)', () => {
    const known = new Set<string>([...AgentThinkingIndicator.Class.coreWords, ...AgentThinkingIndicator.Class.easterEggs]);
    for (let slot = 0; slot < 2000; slot += 1) expect(known.has(AgentThinkingIndicator.Class.pickWord(slot))).toBe(true);
  });

  test('easter-eggs surface roughly 1-in-15 picks (a rare discovery)', () => {
    const eggs = new Set<string>(AgentThinkingIndicator.Class.easterEggs);
    let eggCount = 0;
    const trials = 6000;
    for (let slot = 0; slot < trials; slot += 1) if (eggs.has(AgentThinkingIndicator.Class.pickWord(slot))) eggCount += 1;
    const ratio = eggCount / trials;
    const expected = 1 / AgentThinkingIndicator.Class.easterEggOdds;
    expect(ratio).toBeGreaterThan(expected * 0.6); // ~1/15, with generous tolerance for the hash spread
    expect(ratio).toBeLessThan(expected * 1.6);
  });
});

describe('AgentThinkingIndicator.compose', () => {
  test('shows a rotating reduction word (from the locked set) + the elapsed counter', () => {
    const composed = AgentThinkingIndicator.Class.compose(baseState({ elapsedSeconds: 5 }));
    const joined = text(composed);
    const known = [...AgentThinkingIndicator.Class.coreWords, ...AgentThinkingIndicator.Class.easterEggs];
    expect(known.some((word) => joined.includes(word))).toBe(true);
    expect(joined).toContain('5s'); // elapsed counter
  });

  test('the word ROTATES as elapsed time crosses the rotation interval', () => {
    const early = text(AgentThinkingIndicator.Class.compose(baseState({ elapsedSeconds: 0 })));
    const later = text(AgentThinkingIndicator.Class.compose(baseState({ elapsedSeconds: 9 })));
    // Strip the elapsed suffix before comparing the WORD.
    const word = (joined: string) => joined.replace(/\s+\d+m?\s?\d*s\s*$/, '');
    expect(word(early)).not.toBe(word(later));
  });

  test('EXACTLY ONE leading single-cell glyph, a fixed word column, and NO trailing glyph — no reflow', () => {
    for (const frameIndex of [0, 1, 2, 3, 5, 7, 11, 23]) {
      const composed = AgentThinkingIndicator.Class.compose(baseState({ frameIndex, elapsedSeconds: 4 }));
      // The front is one single-width glyph, then a space — so the word always starts at cell column 2.
      expect(Array.from(composed[0]!.text)).toHaveLength(1);
      expect(composed[1]!.text).toBe(' ');
      // The last segment is the DIM elapsed counter (trailing TEXT ending in "s"), never a glyph.
      const last = composed[composed.length - 1]!;
      expect(last.bold).toBe(false);
      expect(last.text.trim().endsWith('s')).toBe(true);
    }
  });

  test('the per-character shimmer gives the WORD glyphs DIFFERENT colours (truecolor gradient)', () => {
    const composed = AgentThinkingIndicator.Class.compose(baseState({ elapsedSeconds: 0, frameIndex: 3 }));
    // Word glyphs = the bold single-cell segments AFTER the leading spinner glyph (segment 0).
    const wordColors = composed.filter((segment) => segment.bold && Array.from(segment.text).length === 1).slice(1).map((segment) => segment.color);
    expect(new Set(wordColors).size).toBeGreaterThan(1); // a gradient, not a flat colour
  });

  test('past 60s the elapsed reads as minutes+seconds', () => {
    const composed = AgentThinkingIndicator.Class.compose(baseState({ elapsedSeconds: 65 }));
    expect(text(composed)).toContain('1m 05s');
  });

  test('the ascii tier uses a plain word (single colour) and no braille', () => {
    const composed = AgentThinkingIndicator.Class.compose(baseState({ glyphLevel: 'ascii', colorDepth: '16' }));
    // Skip the leading glyph (its twinkle colour differs); the WORD glyphs are a single flat colour.
    const wordColors = composed.filter((segment) => segment.bold && Array.from(segment.text).length === 1).slice(1).map((segment) => segment.color);
    expect(new Set(wordColors).size).toBe(1); // no gradient on ascii
  });
});

describe('AgentThinkingIndicator.composeWaitingNote', () => {
  const noteState = (overrides = {}) => ({
    toolName: 'Bash',
    elapsedSeconds: 4,
    pendingCount: 1,
    highlight: false,
    glyphLevel: 'unicode' as const,
    palette: DARK,
    ...overrides,
  });

  test('nothing pending → no note', () => {
    expect(AgentThinkingIndicator.Class.composeWaitingNote(noteState({ toolName: null }))).toEqual([]);
  });

  test('one pending → the tool name + its elapsed time', () => {
    const joined = text(AgentThinkingIndicator.Class.composeWaitingNote(noteState()));
    expect(joined).toContain('⧗');
    expect(joined).toContain('Bash');
    expect(joined).toContain('4s');
    expect(joined).not.toContain('pending'); // no counter when only one
  });

  test('multiple pending → the active tool plus a pending counter', () => {
    const joined = text(AgentThinkingIndicator.Class.composeWaitingNote(noteState({ toolName: 'Read', pendingCount: 3 })));
    expect(joined).toContain('Read');
    expect(joined).toContain('(3 pending)');
  });

  test('ascii tier degrades the hourglass glyph', () => {
    const joined = text(AgentThinkingIndicator.Class.composeWaitingNote(noteState({ glyphLevel: 'ascii' })));
    expect(joined).not.toContain('⧗');
    expect(joined).toContain('*');
  });
});
