// The active theme: a reactive selection of palette + icon set, resolved through the
// capability fallback ladders. Consumed by ui, editor, syntax, diagnostics.
//
// invariant: Appearance is data with a capability fallback (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { TerminalCapabilities, type ColorDepth, type GlyphLevel } from './TerminalCapabilities';
import { PALETTES, DARK, ThemePalettes, type Palette } from './ThemePalettes';
import { ThemeIcons, type IconSet, type ActionIconSet, type CheckboxIconSet, type ActivityIconSet } from './ThemeIcons';

class $Theme {
  get paletteName() {
    return ref(DARK.name);
  }
  get colorDepth() {
    return ref<ColorDepth>(TerminalCapabilities.Class.detectColorDepth());
  }
  get glyphLevel() {
    return ref<GlyphLevel>(TerminalCapabilities.Class.detectGlyphLevel());
  }

  // Derived (plain getters — re-derive on read, zero per-instance cost).
  // invariant: Appearance comes only from theme data (src/modules/theme/theme.invariants.md)
  get palette(): Palette {
    const base = PALETTES[this.paletteName.value] ?? DARK;
    return ThemePalettes.Class.quantizePalette(base, this.colorDepth.value);
  }
  get icons(): IconSet {
    return ThemeIcons.Class.iconSetFor(this.glyphLevel.value);
  }
  /** Status-bar settings (gear) glyph at the current glyph level (nerd cog → ⚙ → `*`). */
  get settingsIcon(): string {
    return ThemeIcons.Class.settingsIconFor(this.glyphLevel.value);
  }
  /** Status-bar terminal-toggle glyph at the current glyph level (nerd terminal → ❯ → `>`). */
  get terminalIcon(): string {
    return ThemeIcons.Class.terminalIconFor(this.glyphLevel.value);
  }
  /** Git changes-row action button glyphs at the current glyph level (nerd → unicode → ascii). */
  get actionIcons(): ActionIconSet {
    return ThemeIcons.Class.actionIconsFor(this.glyphLevel.value);
  }
  /** Staging-checkbox glyphs (unchecked/checked) at the current glyph level. */
  get checkboxIcons(): CheckboxIconSet {
    return ThemeIcons.Class.checkboxIconsFor(this.glyphLevel.value);
  }
  /** Activity-bar view-switcher glyphs at the current glyph level (nerd → unicode → ascii). The tier
   *  follows the SAME single source as every other glyph — settings.glyphMode → theme.glyphLevel
   *  (auto-detected via TerminalCapabilities, or forced) — so swapping tiers is one config, not per-icon. */
  get activityIcons(): ActivityIconSet {
    return ThemeIcons.Class.activityIconsFor(this.glyphLevel.value);
  }

  icon(name: string, isDir: boolean, open = false): string {
    return ThemeIcons.Class.iconFor(this.icons, name, isDir, open);
  }

  setPalette(name: string): void {
    if (PALETTES[name]) this.paletteName.value = name;
  }
  toggleDark(): void {
    this.paletteName.value = this.paletteName.value === DARK.name ? 'invar-light' : DARK.name;
  }
  setColorDepth(d: ColorDepth): void {
    this.colorDepth.value = d;
  }
  setGlyphLevel(l: GlyphLevel): void {
    this.glyphLevel.value = l;
  }
}

export namespace Theme {
  export const $Class = $Theme;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
