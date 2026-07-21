// Color palettes as semantic tokens, with truecolor → 256 → 16 down-quantization.
// invariant: Appearance is data with a capability fallback (project.invariants.md)
import { Static } from 'ivue/extras';
import type { ColorDepth } from './TerminalCapabilities';

export interface Palette {
  name: string;
  bg: string;
  panel: string;
  statusBg: string;
  border: string;
  borderActive: string;
  fg: string;
  dim: string;
  accent: string;
  selection: string;
  cursorLine: string;
  added: string;
  modified: string;
  deleted: string;
  // syntax roles
  keyword: string;
  string: string;
  number: string;
  comment: string;
  func: string;
  type: string;
  variable: string;
  operator: string;
  // diagnostics
  error: string;
  warning: string;
  info: string;
}

export const DARK: Palette = {
  name: 'fable-dark',
  bg: '#1e1e2e', panel: '#181825', statusBg: '#11111b',
  border: '#313244', borderActive: '#89b4fa',
  fg: '#cdd6f4', dim: '#6c7086', accent: '#89b4fa',
  selection: '#45475a', cursorLine: '#292c3c',
  added: '#a6e3a1', modified: '#f9e2af', deleted: '#f38ba8',
  keyword: '#cba6f7', string: '#a6e3a1', number: '#fab387',
  comment: '#6c7086', func: '#89b4fa', type: '#f9e2af',
  variable: '#cdd6f4', operator: '#94e2d5',
  error: '#f38ba8', warning: '#f9e2af', info: '#89b4fa',
};

export const LIGHT: Palette = {
  name: 'fable-light',
  bg: '#eff1f5', panel: '#e6e9ef', statusBg: '#dce0e8',
  border: '#ccd0da', borderActive: '#1e66f5',
  fg: '#4c4f69', dim: '#8c8fa1', accent: '#1e66f5',
  selection: '#bcc0cc', cursorLine: '#e6e9ef',
  added: '#40a02b', modified: '#df8e1d', deleted: '#d20f39',
  keyword: '#8839ef', string: '#40a02b', number: '#fe640b',
  comment: '#8c8fa1', func: '#1e66f5', type: '#df8e1d',
  variable: '#4c4f69', operator: '#179299',
  error: '#d20f39', warning: '#df8e1d', info: '#1e66f5',
};

export const PALETTES: Record<string, Palette> = {
  [DARK.name]: DARK,
  [LIGHT.name]: LIGHT,
};

// --- Down-quantization ---------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const hexDigits = hex.replace('#', '');
  return [parseInt(hexDigits.slice(0, 2), 16), parseInt(hexDigits.slice(2, 4), 16), parseInt(hexDigits.slice(4, 6), 16)];
}

/** Map an rgb triple to the nearest xterm-256 index, then back to a hex approximation. */
function to256Hex(hex: string): string {
  const [red, green, blue] = hexToRgb(hex);
  // 6x6x6 color cube
  const quantize = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.round((value - 35) / 40));
  const clamp5 = (value: number) => Math.max(0, Math.min(5, value));
  const cube = [0, 95, 135, 175, 215, 255];
  return rgbToHex(cube[clamp5(quantize(red))]!, cube[clamp5(quantize(green))]!, cube[clamp5(quantize(blue))]!);
}

/** Map to the nearest of the 16 ANSI colors (approx hexes). */
const ANSI16: Array<[number, number, number]> = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function to16Hex(hex: string): string {
  const [red, green, blue] = hexToRgb(hex);
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < ANSI16.length; index++) {
    const [candidateRed, candidateGreen, candidateBlue] = ANSI16[index]!;
    const distance = (red - candidateRed) ** 2 + (green - candidateGreen) ** 2 + (blue - candidateBlue) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  const [nearestRed, nearestGreen, nearestBlue] = ANSI16[best]!;
  return rgbToHex(nearestRed, nearestGreen, nearestBlue);
}

function rgbToHex(red: number, green: number, blue: number): string {
  const toHexByte = (value: number) => value.toString(16).padStart(2, '0');
  return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`;
}

/** Return a palette whose colors are quantized to the terminal's depth. */
function $quantizePalette(palette: Palette, depth: ColorDepth): Palette {
  if (depth === 'truecolor') return palette;
  const mapColor = depth === '256' ? to256Hex : to16Hex;
  const result = { ...palette };
  for (const key of Object.keys(result) as Array<keyof Palette>) {
    const value = result[key];
    if (typeof value === 'string' && value.startsWith('#')) {
      (result[key] as string) = mapColor(value);
    }
  }
  return result;
}

class $ThemePalettes {
  static quantizePalette = $quantizePalette;
}

export namespace ThemePalettes {
  export const $Class = $ThemePalettes;
  export const Class = Static($ThemePalettes);
}
