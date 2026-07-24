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
    // Genuinely legacy / limited terminals that cannot render 24-bit color get the 16-color floor.
    if (term === '' || /^(dumb|linux|vt\d+|ansi|xterm|xterm-color|xterm-16color)$/i.test(term)) return '16';
    // Everything modern — xterm-256color, screen/tmux-256color, alacritty, xterm-kitty, … — is assumed
    // truecolor. Such terminals under-report via TERM (`…-256color` for legacy compat) and FREQUENTLY
    // have COLORTERM unset (tmux/ssh strip it). The old "TERM has 256color → '256'" rule therefore served
    // real 24-bit terminals a coarse 256-cube quantization that mangled soft palettes (Tokyo Night) into
    // harsh, DOS-like approximations. A wrong guess here degrades gracefully in the terminal; the reverse
    // (assuming 256 on a truecolor terminal) does not.
    return 'truecolor';
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
