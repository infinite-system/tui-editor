// The Ctrl+, settings panel: an editable, LIVE-APPLYING view over the reactive Settings store. The
// panel is display + navigation + edit state only; every change goes straight to Settings.set() (which
// live-applies through the reactive fields) and is persisted with Settings.save(). View-only over the
// store — it owns no settings values itself.
//
// invariant: Every setting is a reactive cell read through its value ref (settings.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import {
  Settings,
  type SettingsValues,
  type ScrollModifier,
  type GlyphMode,
  type WorkspaceTabPosition,
  type TypeScriptServer,
} from './Settings';

/** How one setting is edited: numbers step, booleans toggle, enums cycle through a fixed option list. */
export type SettingSpec =
  | { kind: 'number'; step: number; minimum: number; maximum: number; decimals: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: readonly string[] };

export interface SettingDescriptor {
  key: keyof SettingsValues;
  label: string;
  spec: SettingSpec;
}

const SCROLL_MODIFIER_OPTIONS: readonly ScrollModifier[] = ['none', 'alt', 'shift', 'ctrl'];
const GLYPH_MODE_OPTIONS: readonly GlyphMode[] = ['auto', 'nerd', 'unicode', 'ascii'];
const WORKSPACE_TAB_POSITION_OPTIONS: readonly WorkspaceTabPosition[] = ['top', 'left'];
const TYPESCRIPT_SERVER_OPTIONS: readonly TypeScriptServer[] = ['tsgo', 'typescript-language-server'];

// The editable settings, in display order. Grouped loosely: scroll physics, modifiers, appearance.
const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
  { key: 'verticalFlingCeiling', label: 'Vertical fling ceiling (rows/s)', spec: { kind: 'number', step: 20, minimum: 40, maximum: 2000, decimals: 0 } },
  { key: 'scrollAccelGain', label: 'Scroll accel gain (per notch)', spec: { kind: 'number', step: 2, minimum: 2, maximum: 200, decimals: 0 } },
  { key: 'scrollFriction', label: 'Scroll friction (decay/s)', spec: { kind: 'number', step: 0.005, minimum: 0.001, maximum: 0.5, decimals: 3 } },
  { key: 'linesPerNotch', label: 'Lines per wheel notch', spec: { kind: 'number', step: 1, minimum: 1, maximum: 10, decimals: 0 } },
  { key: 'horizontalScrollModifier', label: 'Horizontal-scroll modifier', spec: { kind: 'enum', options: SCROLL_MODIFIER_OPTIONS } },
  { key: 'fastScrollModifier', label: 'Fast-scroll modifier', spec: { kind: 'enum', options: SCROLL_MODIFIER_OPTIONS } },
  { key: 'fastScrollMultiplier', label: 'Fast-scroll multiplier', spec: { kind: 'number', step: 1, minimum: 1, maximum: 20, decimals: 0 } },
  { key: 'scrollbarThickness', label: 'Scrollbar thickness', spec: { kind: 'number', step: 1, minimum: 1, maximum: 3, decimals: 0 } },
  { key: 'glyphMode', label: 'Glyph mode', spec: { kind: 'enum', options: GLYPH_MODE_OPTIONS } },
  { key: 'theme', label: 'Theme', spec: { kind: 'enum', options: ['dark', 'light'] } },
  { key: 'wordWrap', label: 'Word wrap', spec: { kind: 'boolean' } },
  { key: 'workspaceTabPosition', label: 'Workspace tabs', spec: { kind: 'enum', options: WORKSPACE_TAB_POSITION_OPTIONS } },
  { key: 'typescriptServer', label: 'TypeScript server', spec: { kind: 'enum', options: TYPESCRIPT_SERVER_OPTIONS } },
  { key: 'lspFileSizeLimitKb', label: 'LSP file size limit (KB, 0 = no limit)', spec: { kind: 'number', step: 512, minimum: 0, maximum: 51200, decimals: 0 } },
  { key: 'sidebarWidth', label: 'Sidebar width', spec: { kind: 'number', step: 1, minimum: 16, maximum: 80, decimals: 0 } },
  { key: 'gitSplitRatio', label: 'Git changes/log split', spec: { kind: 'number', step: 0.05, minimum: 0.1, maximum: 0.9, decimals: 2 } },
  { key: 'diffSplitRatio', label: 'Diff previous/current split', spec: { kind: 'number', step: 0.05, minimum: 0.15, maximum: 0.85, decimals: 2 } },
  { key: 'markdownSplitRatio', label: 'Markdown source/preview split', spec: { kind: 'number', step: 0.05, minimum: 0.2, maximum: 0.8, decimals: 2 } },
];

/** One rendered row: the label, the current value as text, and whether it is the selected row. */
export interface SettingsPanelRow {
  label: string;
  valueText: string;
  selected: boolean;
}

class $SettingsPanel {
  // The reactive settings store the panel edits; read late so it stays swappable/testable.
  constructor(private readonly settingsStore: Settings.Instance) {}

  get open() {
    return ref(false);
  }
  get selectedIndex() {
    return ref(0);
  }

  get descriptors(): readonly SettingDescriptor[] {
    return SETTING_DESCRIPTORS;
  }

  /** The bound settings store (so the view can read live values without re-injecting it). */
  get settings(): Settings.Instance {
    return this.settingsStore;
  }

  toggle(): void {
    this.open.value = !this.open.value;
  }
  show(): void {
    this.open.value = true;
    this.selectedIndex.value = 0;
  }
  close(): void {
    this.open.value = false;
  }

  /** Move the selection up/down, clamped (no wrap — a settings list is not a carousel). */
  moveSelection(delta: number): void {
    const last = SETTING_DESCRIPTORS.length - 1;
    this.selectedIndex.value = Math.max(0, Math.min(this.selectedIndex.value + delta, last));
  }

  /** Change the selected setting by `direction` (+1/-1): numbers step, booleans toggle, enums cycle.
   *  The change live-applies through Settings.set() and is persisted with Settings.save(). */
  adjust(direction: number): void {
    const descriptor = SETTING_DESCRIPTORS[this.selectedIndex.value];
    if (!descriptor) return;
    const current = this.settingsStore.snapshot()[descriptor.key];
    if (descriptor.spec.kind === 'number') {
      const { step, minimum, maximum, decimals } = descriptor.spec;
      const raw = (current as number) + step * direction;
      const rounded = Math.round(raw * 10 ** decimals) / 10 ** decimals;
      const next = Math.max(minimum, Math.min(rounded, maximum));
      this.settingsStore.set(descriptor.key, next as SettingsValues[typeof descriptor.key]);
    } else if (descriptor.spec.kind === 'boolean') {
      this.settingsStore.set(descriptor.key, !(current as boolean) as SettingsValues[typeof descriptor.key]);
    } else {
      const { options } = descriptor.spec;
      const currentIndex = Math.max(0, options.indexOf(current as string));
      const nextIndex = (currentIndex + direction + options.length) % options.length;
      this.settingsStore.set(descriptor.key, options[nextIndex] as SettingsValues[typeof descriptor.key]);
    }
    this.settingsStore.save();
  }

  /** The rows to render, with each value formatted for display. */
  rows(): SettingsPanelRow[] {
    const values = this.settingsStore.snapshot();
    const selected = this.selectedIndex.value;
    return SETTING_DESCRIPTORS.map((descriptor, index) => ({
      label: descriptor.label,
      valueText: this.formatValue(descriptor, values[descriptor.key]),
      selected: index === selected,
    }));
  }

  private formatValue(descriptor: SettingDescriptor, value: SettingsValues[keyof SettingsValues]): string {
    if (descriptor.spec.kind === 'number') return (value as number).toFixed(descriptor.spec.decimals);
    if (descriptor.spec.kind === 'boolean') return value ? 'on' : 'off';
    return String(value);
  }
}

export namespace SettingsPanel {
  export const $Class = $SettingsPanel;
  export let Class = Reactive($SettingsPanel);
  export type Instance = typeof Class.Instance;
}
