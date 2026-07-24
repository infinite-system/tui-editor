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
  /** A softer blue selection background for MULTI-selected rows (git range-select) — reads as "selected"
   *  and keeps the row text legible, distinct from the subtle grey hover/cursor-line. */
  selectionMuted: string;
  cursorLine: string;
  added: string;
  modified: string;
  deleted: string;
  /** Diff ROW backgrounds — subtle, theme-fitting fills (distinct from the bright added/modified/deleted
   *  accents, which stay the gutter-marker foreground). Bright accents as row fills read as harsh neon
   *  on a near-black editor; these are muted so the code text on top stays legible. */
  diffAddedBg: string;
  diffModifiedBg: string;
  diffDeletedBg: string;
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

// Tokyo Night (Storm) — a blue-matte night, softer than pure black/white: fg is a soft blue-white,
// bg is a matte blue (never #000), comments/dim are gently muted for lower overall contrast.
export const DARK: Palette = {
  name: 'invar-dark',
  bg: '#24283b', panel: '#1f2335', statusBg: '#16161e',
  border: '#3b4261', borderActive: '#7aa2f7',
  fg: '#c0caf5', dim: '#565f89', accent: '#7aa2f7',
  selection: '#283457', selectionMuted: '#33467c', cursorLine: '#2c3350',
  added: '#9ece6a', modified: '#e0af68', deleted: '#f7768e',
  diffAddedBg: '#1e3328', diffModifiedBg: '#35311f', diffDeletedBg: '#3d2831',
  keyword: '#bb9af7', string: '#9ece6a', number: '#ff9e64',
  comment: '#565f89', func: '#7aa2f7', type: '#7dcfff',
  variable: '#c0caf5', operator: '#89ddff',
  error: '#f7768e', warning: '#e0af68', info: '#7aa2f7',
};

// Tokyo Night Day — a soft grey-blue light theme (bg is never #fff so it doesn't burn the eyes),
// body text a dark blue-grey rather than black, all accents desaturated for easy daytime reading.
export const LIGHT: Palette = {
  name: 'invar-light',
  bg: '#e1e2e7', panel: '#d4d6e4', statusBg: '#c4c8da',
  border: '#b6bad0', borderActive: '#2e7de9',
  fg: '#343b58', dim: '#848cb5', accent: '#2e7de9',
  selection: '#b7c1e3', selectionMuted: '#a3b6e8', cursorLine: '#d6d8e6',
  added: '#587539', modified: '#8c6c3e', deleted: '#f52a65',
  diffAddedBg: '#d5e6d0', diffModifiedBg: '#ece6d0', diffDeletedBg: '#f2d5dc',
  keyword: '#9854f1', string: '#587539', number: '#b15c00',
  comment: '#848cb5', func: '#2e7de9', type: '#007197',
  variable: '#343b58', operator: '#0f4b6e',
  error: '#f52a65', warning: '#8c6c3e', info: '#2e7de9',
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
// invariant: The palette ladder quantizes color without leaving the palette (src/modules/theme/theme.invariants.md)
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
