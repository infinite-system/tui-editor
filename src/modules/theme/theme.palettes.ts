// Color palettes as semantic tokens, with truecolor → 256 → 16 down-quantization.
// invariant: Appearance is data with a capability fallback (project.invariants.md)
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
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Map an rgb triple to the nearest xterm-256 index, then back to a hex approximation. */
function to256Hex(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  // 6x6x6 color cube
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  const clamp5 = (v: number) => Math.max(0, Math.min(5, v));
  const cube = [0, 95, 135, 175, 215, 255];
  return rgbToHex(cube[clamp5(q(r))]!, cube[clamp5(q(g))]!, cube[clamp5(q(b))]!);
}

/** Map to the nearest of the 16 ANSI colors (approx hexes). */
const ANSI16: Array<[number, number, number]> = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function to16Hex(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < ANSI16.length; i++) {
    const [cr, cg, cb] = ANSI16[i]!;
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const [r2, g2, b2] = ANSI16[best]!;
  return rgbToHex(r2, g2, b2);
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Return a palette whose colors are quantized to the terminal's depth. */
export function quantizePalette(p: Palette, depth: ColorDepth): Palette {
  if (depth === 'truecolor') return p;
  const map = depth === '256' ? to256Hex : to16Hex;
  const out = { ...p };
  for (const key of Object.keys(out) as Array<keyof Palette>) {
    const v = out[key];
    if (typeof v === 'string' && v.startsWith('#')) {
      (out[key] as string) = map(v);
    }
  }
  return out;
}
