import { test, expect } from 'bun:test';
import { DARK, ThemePalettes } from '../ThemePalettes';
import { ThemeIcons } from '../ThemeIcons';

test('truecolor quantization is identity', () => {
  const palette = ThemePalettes.Class.quantizePalette(DARK, 'truecolor');
  expect(palette.bg).toBe(DARK.bg);
});

test('16-color quantization maps every color into the ANSI-16 set', () => {
  const palette = ThemePalettes.Class.quantizePalette(DARK, '16');
  const ansi = new Set([
    '#000000', '#800000', '#008000', '#808000', '#000080', '#800080',
    '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00',
    '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ]);
  for (const key of Object.keys(palette) as Array<keyof typeof palette>) {
    const value = palette[key];
    if (typeof value === 'string' && value.startsWith('#')) {
      expect(ansi.has(value)).toBe(true);
    }
  }
});

test('256 quantization keeps hex shape', () => {
  const palette = ThemePalettes.Class.quantizePalette(DARK, '256');
  expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/);
});

test('icon fallback ladder: nerd has glyphs, ascii uses markers', () => {
  const nerd = ThemeIcons.Class.iconSetFor('nerd');
  const ascii = ThemeIcons.Class.iconSetFor('ascii');
  expect(ThemeIcons.Class.iconFor(nerd, 'x.ts', false).length).toBeGreaterThan(0);
  expect(ThemeIcons.Class.iconFor(ascii, 'sub', true, false)).toBe('+');
  expect(ThemeIcons.Class.iconFor(ascii, 'sub', true, true)).toBe('-');
});

test('unicode icon set resolves known extension and falls back for unknown', () => {
  const unicodeSet = ThemeIcons.Class.iconSetFor('unicode');
  expect(ThemeIcons.Class.iconFor(unicodeSet, 'main.ts', false)).toBe('◆');
  expect(ThemeIcons.Class.iconFor(unicodeSet, 'weird.zzz', false)).toBe(unicodeSet.file);
});

test('checkbox icons ladder: real glyphs on nerd/unicode, single-cell, ascii degrades', () => {
  expect(ThemeIcons.Class.checkboxIconsFor('ascii')).toEqual({ unchecked: ' ', checked: 'x' });
  for (const level of ['unicode', 'nerd'] as const) {
    const box = ThemeIcons.Class.checkboxIconsFor(level);
    expect([...box.unchecked].length).toBe(1); // single cell so the click hit-column stays fixed
    expect([...box.checked].length).toBe(1);
    expect(box.unchecked).not.toBe(box.checked); // the two states are visually distinct
  }
});

test('git action icons ladder: real glyphs on nerd/unicode, letters as the ascii fallback', () => {
  // Ascii is the graceful degrade: o / d / + / - so a no-nerd-font terminal still reads.
  expect(ThemeIcons.Class.actionIconsFor('ascii')).toEqual({ open: 'o', discard: 'd', stage: '+', unstage: '-', preview: 'p' });
  // Nerd + unicode are real single-cell glyphs (distinct from the letters).
  const unicode = ThemeIcons.Class.actionIconsFor('unicode');
  const nerd = ThemeIcons.Class.actionIconsFor('nerd');
  for (const level of [unicode, nerd]) {
    for (const glyph of [level.open, level.discard, level.stage, level.unstage]) {
      expect([...glyph].length).toBe(1); // exactly one code point -> one cell, hit-zones stay aligned
      expect('od+-'.includes(glyph)).toBe(false); // not the ascii letters
    }
  }
});
