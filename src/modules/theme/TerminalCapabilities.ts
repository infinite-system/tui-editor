// Detects terminal color depth, glyph support, and the image graphics tier so palettes, icons, and
// the image preview can degrade.
// invariant: Terminal color and glyph support varies (project.invariants.md)
// invariant: Terminal capability can only be inferred from the environment (src/modules/theme/theme.invariants.md)
// invariant: Graphics tier prefers the reported capability and degrades to cells (src/modules/theme/theme.invariants.md)
import { Environment } from '../system/Environment';

export type ColorDepth = 'truecolor' | '256' | '16';
export type GlyphLevel = 'nerd' | 'unicode' | 'ascii';
/** How the image preview reaches the screen, richest first: kitty APC graphics → sixel → half-block cells. */
export type GraphicsTier = 'kitty' | 'sixel' | 'halfblock';

/** The slice of OpenTUI's terminal-capability report that graphics-tier detection consumes.
 *  Structural (not the @opentui/core type) so tests can pose any matrix without a renderer. */
export interface ReportedGraphicsCapabilities {
  kitty_graphics: boolean;
  sixel: boolean;
  multiplexer: string;
}

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

  /** Resolve the image-preview graphics tier. Precedence:
   *  1. `TUI_GRAPHICS_TIER` env override (the test seam and user escape hatch) — beats everything,
   *     including the tmux guard, so smokes driven inside the tmux harness can force any tier.
   *  2. tmux (either the reported multiplexer or `$TMUX`): half-block — graphics passthrough under
   *     tmux is unreliable, a scoped limitation, not a detection failure.
   *  3. OpenTUI's reported capabilities (the terminal's own answer — never second-guessed by env).
   *  4. No report yet (the async query has not round-tripped, or the caller has no renderer):
   *     conservative env heuristics, else the universal half-block floor. Detection may only ever
   *     move UP a tier when the report lands — the floor never flashes a wrong rich tier. */
  static detectGraphicsTier(reported: ReportedGraphicsCapabilities | null): GraphicsTier {
    const forced = Environment.Class.env('TUI_GRAPHICS_TIER');
    if (forced === 'kitty' || forced === 'sixel' || forced === 'halfblock') return forced;
    if (Environment.Class.env('TMUX')) return 'halfblock';
    if (reported) {
      if (reported.multiplexer !== 'none' && reported.multiplexer !== 'unknown') return 'halfblock';
      if (reported.kitty_graphics) return 'kitty';
      if (reported.sixel) return 'sixel';
      return 'halfblock';
    }
    const term = Environment.Class.env('TERM') ?? '';
    if (/^xterm-(kitty|ghostty)$/i.test(term)) return 'kitty';
    if (Environment.Class.env('KITTY_WINDOW_ID')) return 'kitty';
    const termProgram = Environment.Class.env('TERM_PROGRAM') ?? '';
    if (/^(wezterm|iterm\.app)$/i.test(termProgram)) return 'sixel';
    return 'halfblock';
  }
}

export namespace TerminalCapabilities {
  export const $Class = $TerminalCapabilities;
  export let Class = $TerminalCapabilities;
}
