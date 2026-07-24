// The Ctrl+, settings panel: an editable, LIVE-APPLYING view over the reactive Settings store. The
// panel is display + navigation + edit state only; every change goes straight to Settings.set() (which
// live-applies through the reactive fields) and is persisted with Settings.save(). View-only over the
// store — it owns no settings values itself.
//
// invariant: Every setting is a reactive cell read through its value ref (settings.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { VoiceDiscovery } from '../narration/VoiceDiscovery';
import {
  Settings,
  type SettingsValues,
  type ScrollModifier,
  type GlyphMode,
  type WorkspaceTabPosition,
  type TypeScriptServer,
  type AgentProvider,
} from './Settings';

/** How one setting is edited: numbers step, booleans toggle, enums cycle a fixed list, and DYNAMIC enums
 *  cycle a list PROBED at runtime (panel-open) — e.g. the installed piper voices — so the options track
 *  what is actually present without a hardcoded list. */
export type SettingSpec =
  | { kind: 'number'; step: number; minimum: number; maximum: number; decimals: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: readonly string[] }
  | { kind: 'dynamic-enum'; resolveOptions: () => readonly string[] };

export interface SettingDescriptor {
  key: keyof SettingsValues;
  label: string;
  spec: SettingSpec;
  /** The section this setting is grouped under in the panel (a rendered header, not a selectable row). */
  section: string;
}

const SCROLL_MODIFIER_OPTIONS: readonly ScrollModifier[] = ['none', 'alt', 'shift', 'ctrl'];
const GLYPH_MODE_OPTIONS: readonly GlyphMode[] = ['auto', 'nerd', 'unicode', 'ascii'];
const WORKSPACE_TAB_POSITION_OPTIONS: readonly WorkspaceTabPosition[] = ['top', 'left'];
const TYPESCRIPT_SERVER_OPTIONS: readonly TypeScriptServer[] = ['tsgo', 'typescript-language-server'];
const AGENT_PROVIDER_OPTIONS: readonly AgentProvider[] = ['auto', 'claude', 'codex'];

// The editable settings, in display order, grouped into SECTIONS (contiguous — the renderer draws a
// header whenever the section changes). Sections are presentation only; selection still indexes the
// flat list.
const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
  { key: 'verticalFlingCeiling', label: 'Vertical fling ceiling (rows/s)', section: 'Scrolling', spec: { kind: 'number', step: 20, minimum: 40, maximum: 2000, decimals: 0 } },
  { key: 'scrollAccelGain', label: 'Scroll accel gain (per notch)', section: 'Scrolling', spec: { kind: 'number', step: 2, minimum: 2, maximum: 200, decimals: 0 } },
  { key: 'scrollFriction', label: 'Scroll friction (decay/s)', section: 'Scrolling', spec: { kind: 'number', step: 0.005, minimum: 0.001, maximum: 0.5, decimals: 3 } },
  { key: 'linesPerNotch', label: 'Lines per wheel notch', section: 'Scrolling', spec: { kind: 'number', step: 1, minimum: 1, maximum: 10, decimals: 0 } },
  { key: 'horizontalScrollModifier', label: 'Horizontal-scroll modifier', section: 'Scrolling', spec: { kind: 'enum', options: SCROLL_MODIFIER_OPTIONS } },
  { key: 'fastScrollModifier', label: 'Fast-scroll modifier', section: 'Scrolling', spec: { kind: 'enum', options: SCROLL_MODIFIER_OPTIONS } },
  { key: 'fastScrollMultiplier', label: 'Fast-scroll multiplier', section: 'Scrolling', spec: { kind: 'number', step: 1, minimum: 1, maximum: 20, decimals: 0 } },
  { key: 'scrollbarThickness', label: 'Scrollbar thickness', section: 'Scrolling', spec: { kind: 'number', step: 1, minimum: 1, maximum: 3, decimals: 0 } },
  { key: 'glyphMode', label: 'Glyph mode', section: 'Appearance', spec: { kind: 'enum', options: GLYPH_MODE_OPTIONS } },
  { key: 'theme', label: 'Theme', section: 'Appearance', spec: { kind: 'enum', options: ['dark', 'light'] } },
  { key: 'wordWrap', label: 'Word wrap', section: 'Editor', spec: { kind: 'boolean' } },
  { key: 'workspaceTabPosition', label: 'Workspace tabs', section: 'Editor', spec: { kind: 'enum', options: WORKSPACE_TAB_POSITION_OPTIONS } },
  { key: 'typescriptServer', label: 'TypeScript server', section: 'Language', spec: { kind: 'enum', options: TYPESCRIPT_SERVER_OPTIONS } },
  { key: 'lspFileSizeLimitKb', label: 'LSP file size limit (KB, 0 = no limit)', section: 'Language', spec: { kind: 'number', step: 512, minimum: 0, maximum: 51200, decimals: 0 } },
  { key: 'agentProvider', label: 'Agent engine', section: 'Agent', spec: { kind: 'enum', options: AGENT_PROVIDER_OPTIONS } },
  { key: 'agentSkipPermissions', label: 'Agent bypasses permissions (off = ask interactively)', section: 'Agent', spec: { kind: 'boolean' } },
  { key: 'agentAudioNarration', label: 'Speak agent replies aloud (needs a TTS engine)', section: 'Narration', spec: { kind: 'boolean' } },
  { key: 'agentNarrationVoice', label: 'Narration voice', section: 'Narration', spec: { kind: 'dynamic-enum', resolveOptions: () => VoiceDiscovery.Class.options() } },
  { key: 'agentNarrationRate', label: 'Narration rate (lower = faster)', section: 'Narration', spec: { kind: 'number', step: 0.1, minimum: 0.5, maximum: 2.0, decimals: 1 } },
  { key: 'sidebarWidth', label: 'Sidebar width', section: 'Layout', spec: { kind: 'number', step: 1, minimum: 16, maximum: 80, decimals: 0 } },
  { key: 'gitSplitRatio', label: 'Git changes/log split', section: 'Layout', spec: { kind: 'number', step: 0.05, minimum: 0.1, maximum: 0.9, decimals: 2 } },
  { key: 'diffSplitRatio', label: 'Diff previous/current split', section: 'Layout', spec: { kind: 'number', step: 0.05, minimum: 0.15, maximum: 0.85, decimals: 2 } },
  { key: 'markdownSplitRatio', label: 'Markdown source/preview split', section: 'Layout', spec: { kind: 'number', step: 0.05, minimum: 0.2, maximum: 0.8, decimals: 2 } },
];

/** One rendered row: the label, the current value as text, whether it is selected, its editing KIND
 *  (which mouse widget to draw), its SECTION (for the grouped header), and its descriptor INDEX (the
 *  target a mouse action selects/adjusts). */
export interface SettingsPanelRow {
  label: string;
  valueText: string;
  selected: boolean;
  kind: SettingSpec['kind'];
  section: string;
  index: number;
}

class $SettingsPanel {
  // The reactive settings store the panel edits; read late so it stays swappable/testable.
  constructor(private readonly settingsStore: Settings.Instance) {}

  // Options for dynamic-enum rows, PROBED once per panel-open (show()) and cached — so a filesystem scan
  // (installed voices) runs on open, not on every keystroke. Plain field (the Tooltip idiom: a Reactive
  // class holding non-reactive scratch state).
  private dynamicOptionsCache = new Map<string, readonly string[]>();

  private refreshDynamicOptions(): void {
    this.dynamicOptionsCache.clear();
    for (const descriptor of SETTING_DESCRIPTORS) {
      if (descriptor.spec.kind === 'dynamic-enum') this.dynamicOptionsCache.set(descriptor.key, descriptor.spec.resolveOptions());
    }
  }

  /** The cycle options for an enum / dynamic-enum row (dynamic ones from the panel-open probe, freshly
   *  resolved if the cache is cold — e.g. a test that adjusts without show()). */
  private optionsFor(descriptor: SettingDescriptor): readonly string[] {
    if (descriptor.spec.kind === 'enum') return descriptor.spec.options;
    if (descriptor.spec.kind === 'dynamic-enum') return this.dynamicOptionsCache.get(descriptor.key) ?? descriptor.spec.resolveOptions();
    return [];
  }

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
    this.refreshDynamicOptions(); // probe dynamic-enum options (installed voices) at panel-open
  }
  close(): void {
    this.open.value = false;
  }

  /** Move the selection up/down, clamped (no wrap — a settings list is not a carousel). */
  moveSelection(delta: number): void {
    const last = SETTING_DESCRIPTORS.length - 1;
    this.selectedIndex.value = Math.max(0, Math.min(this.selectedIndex.value + delta, last));
  }

  /** Select a specific row by descriptor index (a mouse click on a row / its widget). Clamped. */
  select(index: number): void {
    this.selectedIndex.value = Math.max(0, Math.min(index, SETTING_DESCRIPTORS.length - 1));
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
      // enum or dynamic-enum: cycle the option list (dynamic ones probed at panel-open).
      const options = this.optionsFor(descriptor);
      if (options.length === 0) return; // nothing to cycle (e.g. no voices installed)
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
      kind: descriptor.spec.kind,
      section: descriptor.section,
      index,
    }));
  }

  private formatValue(descriptor: SettingDescriptor, value: SettingsValues[keyof SettingsValues]): string {
    if (descriptor.spec.kind === 'number') return (value as number).toFixed(descriptor.spec.decimals);
    if (descriptor.spec.kind === 'boolean') return value ? 'on' : 'off';
    // A dynamic-enum's empty value means "auto" (the first discovered voice); show that, not blank.
    if (descriptor.spec.kind === 'dynamic-enum' && (value as string) === '') return 'auto (first found)';
    return String(value);
  }
}

export namespace SettingsPanel {
  export const $Class = $SettingsPanel;
  export let Class = Reactive($SettingsPanel);
  export type Instance = typeof Class.Instance;
}
