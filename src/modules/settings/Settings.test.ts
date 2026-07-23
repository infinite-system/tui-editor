import { test, expect, describe } from 'bun:test';
import { effect } from 'vue';
import { Settings, type SettingsFileSystem } from './Settings';

const USER_PATH = '/home/tester/.config/invar/settings.json';
const PROJECT_PATH = '/workspace/.invar/settings.json';

/** An in-memory filesystem so the whole load/merge/save cycle runs without touching the real disk. */
function makeFakeFileSystem(initial: Record<string, string> = {}): {
  fileSystem: SettingsFileSystem;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const fileSystem: SettingsFileSystem = {
    readTextFile(path: string): string | null {
      return store.has(path) ? (store.get(path) as string) : null;
    },
    writeTextFile(path: string, content: string): void {
      store.set(path, content);
    },
    homeDirectory(): string {
      return '/home/tester';
    },
  };
  return { fileSystem, store };
}

function makeStore(initial: Record<string, string> = {}): {
  settings: Settings.Instance;
  store: Map<string, string>;
} {
  const { fileSystem, store } = makeFakeFileSystem(initial);
  const settings = new Settings.Class({ fileSystem });
  return { settings, store };
}

describe('Settings', () => {
  test('defaults are present before any file is loaded', () => {
    const { settings } = makeStore();
    expect(settings.verticalFlingCeiling.value).toBe(220);
    expect(settings.scrollAccelGain.value).toBe(34);
    expect(settings.scrollFriction.value).toBe(0.015);
    expect(settings.linesPerNotch.value).toBe(1);
    expect(settings.horizontalScrollModifier.value).toBe('alt');
    expect(settings.fastScrollModifier.value).toBe('none');
    expect(settings.fastScrollMultiplier.value).toBe(3);
    expect(settings.scrollbarThickness.value).toBe(1);
    expect(settings.glyphMode.value).toBe('auto');
    expect(settings.theme.value).toBe('dark');
    expect(settings.wordWrap.value).toBe(false);
    expect(settings.workspaceTabPosition.value).toBe('top');
    expect(settings.sidebarWidth.value).toBe(32);
    expect(settings.diffSplitRatio.value).toBe(0.5);
    expect(settings.markdownSplitRatio.value).toBe(0.5);
    expect(settings.gitSplitRatio.value).toBe(0.5);
  });

  test('load with no files keeps every default', () => {
    const { settings } = makeStore();
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    expect(settings.snapshot()).toEqual(Settings.$Class.defaults);
  });

  test('user file overrides defaults', () => {
    const { settings } = makeStore({
      [USER_PATH]: JSON.stringify({ theme: 'light', sidebarWidth: 40, wordWrap: true }),
    });
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    expect(settings.theme.value).toBe('light');
    expect(settings.sidebarWidth.value).toBe(40);
    expect(settings.wordWrap.value).toBe(true);
    // Untouched keys stay at their defaults.
    expect(settings.verticalFlingCeiling.value).toBe(220);
  });

  test('project file overrides the user file', () => {
    const { settings } = makeStore({
      [USER_PATH]: JSON.stringify({ theme: 'light', sidebarWidth: 40 }),
      [PROJECT_PATH]: JSON.stringify({ theme: 'solarized' }),
    });
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    expect(settings.theme.value).toBe('solarized'); // project wins over user
    expect(settings.sidebarWidth.value).toBe(40); // user still wins over default
  });

  test('corrupt JSON falls back to defaults without throwing', () => {
    const { settings } = makeStore({
      [USER_PATH]: '{ this is not valid json ,,,',
    });
    expect(() => settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH })).not.toThrow();
    expect(settings.snapshot()).toEqual(Settings.$Class.defaults);
  });

  test('unrecognized and mistyped keys are dropped, valid siblings kept', () => {
    const { settings } = makeStore({
      [USER_PATH]: JSON.stringify({
        theme: 'light', // valid, kept
        sidebarWidth: 'wide', // wrong type, dropped -> default 32
        glyphMode: 'bogus', // out of enum, dropped -> default 'auto'
        unknownKey: 99, // unknown, ignored
      }),
    });
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    expect(settings.theme.value).toBe('light');
    expect(settings.sidebarWidth.value).toBe(32);
    expect(settings.glyphMode.value).toBe('auto');
  });

  test('set() + save() round-trips through the filesystem', () => {
    const { settings, store } = makeStore();
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    settings.set('theme', 'nord');
    settings.set('sidebarWidth', 48);
    settings.set('diffSplitRatio', 0.65);
    settings.set('markdownSplitRatio', 0.6);
    settings.save();

    // The user file now holds the new values.
    const written = store.get(USER_PATH);
    expect(written).toBeDefined();
    expect(JSON.parse(written as string).theme).toBe('nord');
    expect(JSON.parse(written as string).sidebarWidth).toBe(48);
    expect(JSON.parse(written as string).diffSplitRatio).toBe(0.65);
    expect(JSON.parse(written as string).markdownSplitRatio).toBe(0.6);

    // A fresh store loading the same fake fs reads them back.
    const reloaded = new Settings.Class({
      fileSystem: {
        readTextFile: (path) => (store.has(path) ? (store.get(path) as string) : null),
        writeTextFile: (path, content) => store.set(path, content),
        homeDirectory: () => '/home/tester',
      },
    });
    reloaded.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    expect(reloaded.theme.value).toBe('nord');
    expect(reloaded.sidebarWidth.value).toBe(48);
    expect(reloaded.diffSplitRatio.value).toBe(0.65);
    expect(reloaded.markdownSplitRatio.value).toBe(0.6);
  });

  test('a reactive read re-runs when set() changes the value (live-apply)', () => {
    const { settings } = makeStore();
    const observed: string[] = [];
    // effect() runs immediately and re-runs whenever a tracked ref changes.
    effect(() => {
      observed.push(settings.theme.value);
    });
    expect(observed).toEqual(['dark']);
    settings.set('theme', 'light');
    expect(observed).toEqual(['dark', 'light']); // the effect observed the live change
    expect(settings.theme.value).toBe('light');
  });

  test('save() targets the user path resolved during load()', () => {
    const { settings, store } = makeStore();
    settings.load({ userPath: USER_PATH, projectPath: PROJECT_PATH });
    settings.set('wordWrap', true);
    settings.save();
    expect(store.has(USER_PATH)).toBe(true);
    expect(store.has(PROJECT_PATH)).toBe(false); // never writes the project override
  });
});
