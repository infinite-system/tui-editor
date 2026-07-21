import { test, expect } from 'bun:test';
import { DARK, quantizePalette } from '../theme.palettes';
import { iconSetFor, iconFor } from '../theme.icons';

test('truecolor quantization is identity', () => {
  const p = quantizePalette(DARK, 'truecolor');
  expect(p.bg).toBe(DARK.bg);
});

test('16-color quantization maps every color into the ANSI-16 set', () => {
  const p = quantizePalette(DARK, '16');
  const ansi = new Set([
    '#000000', '#800000', '#008000', '#808000', '#000080', '#800080',
    '#008080', '#c0c0c0', '#808080', '#ff0000', '#00ff00', '#ffff00',
    '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
  ]);
  for (const key of Object.keys(p) as Array<keyof typeof p>) {
    const v = p[key];
    if (typeof v === 'string' && v.startsWith('#')) {
      expect(ansi.has(v)).toBe(true);
    }
  }
});

test('256 quantization keeps hex shape', () => {
  const p = quantizePalette(DARK, '256');
  expect(p.accent).toMatch(/^#[0-9a-f]{6}$/);
});

test('icon fallback ladder: nerd has glyphs, ascii uses markers', () => {
  const nerd = iconSetFor('nerd');
  const ascii = iconSetFor('ascii');
  expect(iconFor(nerd, 'x.ts', false).length).toBeGreaterThan(0);
  expect(iconFor(ascii, 'sub', true, false)).toBe('+');
  expect(iconFor(ascii, 'sub', true, true)).toBe('-');
});

test('unicode icon set resolves known extension and falls back for unknown', () => {
  const u = iconSetFor('unicode');
  expect(iconFor(u, 'main.ts', false)).toBe('◆');
  expect(iconFor(u, 'weird.zzz', false)).toBe(u.file);
});
