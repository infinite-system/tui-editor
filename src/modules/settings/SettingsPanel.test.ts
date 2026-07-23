import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings, type SettingsFileSystem } from './Settings';
import { SettingsPanel } from './SettingsPanel';

function makeSettings(): { settings: Settings.Instance; store: Record<string, string> } {
  const store: Record<string, string> = {};
  const fileSystem: SettingsFileSystem = {
    readTextFile: (path) => store[path] ?? null,
    writeTextFile: (path, content) => {
      store[path] = content;
    },
    homeDirectory: () => '/home/test',
  };
  const settings = new Settings.Class({ fileSystem });
  settings.load({});
  return { settings, store };
}

function indexOfKey(panel: SettingsPanel.Instance, key: string): number {
  return panel.descriptors.findIndex((descriptor) => descriptor.key === key);
}

describe('SettingsPanel', () => {
  test('toggle/show/close drive the open flag; show resets the selection', () => {
    const { settings } = makeSettings();
    const panel = new SettingsPanel.Class(settings);
    expect(panel.open.value).toBe(false);
    panel.toggle();
    expect(panel.open.value).toBe(true);
    panel.moveSelection(3);
    panel.show();
    expect(panel.selectedIndex.value).toBe(0);
    panel.close();
    expect(panel.open.value).toBe(false);
  });

  test('moveSelection clamps to the list bounds (no wrap)', () => {
    const { settings } = makeSettings();
    const panel = new SettingsPanel.Class(settings);
    panel.moveSelection(-5);
    expect(panel.selectedIndex.value).toBe(0);
    panel.moveSelection(1000);
    expect(panel.selectedIndex.value).toBe(panel.descriptors.length - 1);
  });

  test('adjust a NUMBER steps + clamps and live-applies + persists', () => {
    const { settings, store } = makeSettings();
    const panel = new SettingsPanel.Class(settings);
    panel.selectedIndex.value = indexOfKey(panel, 'verticalFlingCeiling');
    const before = settings.verticalFlingCeiling.value;
    panel.adjust(1);
    expect(settings.verticalFlingCeiling.value).toBe(before + 20); // stepped, live-applied
    expect(Object.keys(store).length).toBeGreaterThan(0); // save() wrote the user file

    panel.selectedIndex.value = indexOfKey(panel, 'diffSplitRatio');
    panel.adjust(1);
    expect(settings.diffSplitRatio.value).toBe(0.55);

    panel.selectedIndex.value = indexOfKey(panel, 'markdownSplitRatio');
    panel.adjust(1);
    expect(settings.markdownSplitRatio.value).toBe(0.55);
  });

  test('adjust a BOOLEAN toggles, an ENUM cycles', () => {
    const { settings } = makeSettings();
    const panel = new SettingsPanel.Class(settings);
    panel.selectedIndex.value = indexOfKey(panel, 'wordWrap');
    const wrapBefore = settings.wordWrap.value;
    panel.adjust(1);
    expect(settings.wordWrap.value).toBe(!wrapBefore);

    panel.selectedIndex.value = indexOfKey(panel, 'glyphMode');
    const modeBefore = settings.glyphMode.value;
    panel.adjust(1);
    expect(settings.glyphMode.value).not.toBe(modeBefore);
    panel.adjust(-1);
    expect(settings.glyphMode.value).toBe(modeBefore); // cycles back

    panel.selectedIndex.value = indexOfKey(panel, 'workspaceTabPosition');
    panel.adjust(1);
    expect(settings.workspaceTabPosition.value).toBe('left');
    panel.adjust(-1);
    expect(settings.workspaceTabPosition.value).toBe('top');
  });

  test('rows() reflects the current values and the selection', () => {
    const { settings } = makeSettings();
    const panel = new SettingsPanel.Class(settings);
    panel.selectedIndex.value = 2;
    const rows = panel.rows();
    expect(rows.length).toBe(panel.descriptors.length);
    expect(rows[2]?.selected).toBe(true);
    expect(rows[0]?.selected).toBe(false);
    expect(rows[0]?.valueText).toBe(String(settings.verticalFlingCeiling.value)); // number formatted
  });

  describe('dynamic-enum (voice picker)', () => {
    const savedXdg = process.env.XDG_DATA_HOME;
    let dataHome = '';
    afterEach(() => {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (dataHome) rmSync(dataHome, { recursive: true, force: true });
    });

    function seedVoices(): void {
      dataHome = mkdtempSync(join(tmpdir(), 'invar-panel-voices-'));
      const voices = join(dataHome, 'piper-voices');
      mkdirSync(voices, { recursive: true });
      writeFileSync(join(voices, 'aaa.onnx'), 'x');
      writeFileSync(join(voices, 'bbb.onnx'), 'x');
      process.env.XDG_DATA_HOME = dataHome;
    }

    test('the voice row is a dynamic-enum whose options are probed at panel-open and cycle the setting', () => {
      seedVoices();
      const { settings, store } = makeSettings();
      const panel = new SettingsPanel.Class(settings);
      const voiceIndex = indexOfKey(panel, 'agentNarrationVoice');
      expect(voiceIndex).toBeGreaterThanOrEqual(0);
      expect(panel.descriptors[voiceIndex]?.spec.kind).toBe('dynamic-enum');

      panel.show(); // probes the installed voices
      panel.selectedIndex.value = voiceIndex;
      expect(settings.agentNarrationVoice.value).toBe(''); // default: auto
      expect(panel.rows()[voiceIndex]?.valueText).toBe('auto (first found)');

      panel.adjust(1); // cycle from '' → first discovered voice
      expect(settings.agentNarrationVoice.value).toBe('aaa');
      expect(panel.rows()[voiceIndex]?.valueText).toBe('aaa');
      expect(Object.keys(store).length).toBeGreaterThan(0); // persisted

      panel.adjust(1); // → next voice
      expect(settings.agentNarrationVoice.value).toBe('bbb');
      panel.adjust(-1); // back
      expect(settings.agentNarrationVoice.value).toBe('aaa');
    });

    test('cycling with no voices installed is a safe no-op (only the "" auto option exists)', () => {
      dataHome = mkdtempSync(join(tmpdir(), 'invar-empty-voices-'));
      process.env.XDG_DATA_HOME = dataHome; // no piper-voices dir → no voices
      const { settings } = makeSettings();
      const panel = new SettingsPanel.Class(settings);
      panel.show();
      panel.selectedIndex.value = indexOfKey(panel, 'agentNarrationVoice');
      panel.adjust(1); // options = [''] → cycles to itself
      expect(settings.agentNarrationVoice.value).toBe('');
    });
  });
});
