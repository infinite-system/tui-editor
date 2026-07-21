// Detects terminal color depth and glyph support so palettes and icons can degrade.
// invariant: Terminal color and glyph support varies (project.invariants.md)
// invariant: Terminal capability can only be inferred from the environment (src/modules/theme/theme.invariants.md)
import { Environment } from '../system/Environment';

export type ColorDepth = 'truecolor' | '256' | '16';
export type GlyphLevel = 'nerd' | 'unicode' | 'ascii';

class $TerminalCapabilities {
  static detectColorDepth(): ColorDepth {
    const colorTerm = Environment.Class.env('COLORTERM') ?? '';
    if (/truecolor|24bit/i.test(colorTerm)) return 'truecolor';
    const term = Environment.Class.env('TERM') ?? '';
    if (/256color/i.test(term)) return '256';
    if (/color/i.test(term)) return '16';
    // Modern terminals default to truecolor; assume it unless TERM says otherwise.
    return term ? '16' : 'truecolor';
  }

  static detectGlyphLevel(): GlyphLevel {
    // Nerd fonts announce themselves rarely; use env hints, else unicode (safe default).
    const termProgram = Environment.Class.env('TERM_PROGRAM') ?? '';
    if (Environment.Class.env('NERD_FONT') === '1') return 'nerd';
    if (/wezterm|kitty|ghostty/i.test(termProgram)) return 'nerd';
    const language = Environment.Class.env('LANG') ?? '';
    if (/utf-?8/i.test(language)) return 'unicode';
    return 'ascii';
  }
}

export namespace TerminalCapabilities {
  export const $Class = $TerminalCapabilities;
  export let Class = $TerminalCapabilities;
}
