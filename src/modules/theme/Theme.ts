// The active theme: a reactive selection of palette + icon set, resolved through the
// capability fallback ladders. Consumed by ui, editor, syntax, diagnostics.
//
// invariant: Appearance is data with a capability fallback (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { TerminalCapabilities, type ColorDepth, type GlyphLevel } from './TerminalCapabilities';
import { PALETTES, DARK, ThemePalettes, type Palette } from './theme.palettes';
import { ThemeIcons, type IconSet } from './theme.icons';

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
  get palette(): Palette {
    const base = PALETTES[this.paletteName.value] ?? DARK;
    return ThemePalettes.Class.quantizePalette(base, this.colorDepth.value);
  }
  get icons(): IconSet {
    return ThemeIcons.Class.iconSetFor(this.glyphLevel.value);
  }

  icon(name: string, isDir: boolean, open = false): string {
    return ThemeIcons.Class.iconFor(this.icons, name, isDir, open);
  }

  setPalette(name: string): void {
    if (PALETTES[name]) this.paletteName.value = name;
  }
  toggleDark(): void {
    this.paletteName.value = this.paletteName.value === DARK.name ? 'fable-light' : DARK.name;
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
