// The detection that was UNTESTED and shipped inverted: a terminal with TERM set but COLORTERM unset
// (the tmux/ssh default, and the plain Ubuntu-terminal default) fell to '256'/'16', so soft palettes
// (Tokyo Night) rendered as harsh cube approximations — the "MS-DOS" look. These lock in that a modern
// terminal is assumed truecolor while genuinely legacy TERMs still get the 16-color floor.
// invariant: Terminal color and glyph support varies (project.invariants.md)
import { afterEach, expect, test } from 'bun:test';
import { TerminalCapabilities, type ColorDepth } from '../TerminalCapabilities';

const originalTerm = process.env.TERM;
const originalColorTerm = process.env.COLORTERM;

function withEnv(term: string | undefined, colorTerm: string | undefined): ColorDepth {
  if (term === undefined) delete process.env.TERM;
  else process.env.TERM = term;
  if (colorTerm === undefined) delete process.env.COLORTERM;
  else process.env.COLORTERM = colorTerm;
  return TerminalCapabilities.Class.detectColorDepth();
}

afterEach(() => {
  if (originalTerm === undefined) delete process.env.TERM;
  else process.env.TERM = originalTerm;
  if (originalColorTerm === undefined) delete process.env.COLORTERM;
  else process.env.COLORTERM = originalColorTerm;
});

test('COLORTERM=truecolor (or 24bit) wins outright', () => {
  expect(withEnv('xterm-256color', 'truecolor')).toBe('truecolor');
  expect(withEnv('dumb', '24bit')).toBe('truecolor');
});

test('a modern 256color terminal with COLORTERM unset is assumed truecolor (the fixed bug)', () => {
  // The exact reported environment: plain Ubuntu terminal, COLORTERM stripped.
  expect(withEnv('xterm-256color', undefined)).toBe('truecolor');
  expect(withEnv('screen-256color', undefined)).toBe('truecolor');
  expect(withEnv('tmux-256color', '')).toBe('truecolor');
  expect(withEnv('xterm-kitty', undefined)).toBe('truecolor');
  expect(withEnv('alacritty', undefined)).toBe('truecolor');
});

test('genuinely legacy / limited terminals keep the 16-color floor', () => {
  expect(withEnv('dumb', undefined)).toBe('16');
  expect(withEnv('linux', undefined)).toBe('16');
  expect(withEnv('vt100', undefined)).toBe('16');
  expect(withEnv('ansi', undefined)).toBe('16');
  expect(withEnv('xterm', undefined)).toBe('16'); // bare 8/16-color xterm
  expect(withEnv('xterm-color', undefined)).toBe('16');
  expect(withEnv('', undefined)).toBe('16');
});
