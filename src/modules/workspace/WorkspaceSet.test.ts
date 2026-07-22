import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync as makeTemporaryDirectorySync,
  mkdirSync as makeDirectorySync,
  rmSync as removeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';
import { Settings, type SettingsFileSystem } from '../settings/Settings';
import { WorkspaceSet } from './WorkspaceSet';

let temporaryRoot = '';
let workspaceRoots: string[] = [];

beforeEach(() => {
  temporaryRoot = makeTemporaryDirectorySync(join(temporaryDirectory(), 'workspace-set-'));
  workspaceRoots = ['first-project', 'second-project', 'third-project'].map((directoryName) => {
    const workspaceRoot = join(temporaryRoot, directoryName);
    makeDirectorySync(workspaceRoot);
    return workspaceRoot;
  });
});

afterEach(() => {
  removeSync(temporaryRoot, { recursive: true, force: true });
});

function createSettings(): Settings.Instance {
  const settingsFileSystem: SettingsFileSystem = {
    readTextFile: () => null,
    writeTextFile: () => {},
    homeDirectory: () => temporaryRoot,
  };
  return new Settings.Class({ fileSystem: settingsFileSystem });
}

describe('WorkspaceSet project-layer flyweight', () => {
  test('N open workspaces keep exactly one live GitWatcher', () => {
    const workspaceSet = new WorkspaceSet.Class(createSettings());
    for (const workspaceRoot of workspaceRoots) workspaceSet.open(workspaceRoot);

    expect(workspaceSet.count).toBe(3);
    expect(workspaceSet.activeWorkspaceIndex.value).toBe(2);
    expect(workspaceSet.liveGitWatcherCount).toBe(1);
    expect(workspaceSet.entries.value.map((workspace) => workspace.hasLiveGitWatcher)).toEqual([
      false,
      false,
      true,
    ]);

    workspaceSet.activate(0);
    expect(workspaceSet.liveGitWatcherCount).toBe(1);
    expect(workspaceSet.entries.value.map((workspace) => workspace.hasLiveGitWatcher)).toEqual([
      true,
      false,
      false,
    ]);
    workspaceSet.dispose();
  });

  test('switching restores each workspace tree and editor state', () => {
    const firstFilePath = join(workspaceRoots[0]!, 'first.txt');
    const secondFilePath = join(workspaceRoots[1]!, 'second.txt');
    writeFileSync(firstFilePath, 'first workspace\n');
    writeFileSync(secondFilePath, 'second workspace\n');
    const workspaceSet = new WorkspaceSet.Class(createSettings());

    workspaceSet.open(workspaceRoots[0]!);
    workspaceSet.active.openFileInTab(firstFilePath);
    workspaceSet.open(workspaceRoots[1]!);
    workspaceSet.active.openFileInTab(secondFilePath);

    expect(workspaceSet.active.editor.document.path).toBe(secondFilePath);
    workspaceSet.activate(0);
    expect(workspaceSet.active.root).toBe(workspaceRoots[0]!);
    expect(workspaceSet.active.editor.document.path).toBe(firstFilePath);
    workspaceSet.activate(1);
    expect(workspaceSet.active.editor.document.path).toBe(secondFilePath);
    workspaceSet.dispose();
  });

  test('closing disposes one workspace and activates a stable neighbour', () => {
    const workspaceSet = new WorkspaceSet.Class(createSettings());
    for (const workspaceRoot of workspaceRoots) workspaceSet.open(workspaceRoot);

    expect(workspaceSet.close(1)).toBe(true);
    expect(workspaceSet.tabs().map((workspaceTab) => workspaceTab.name)).toEqual([
      'first-project',
      'third-project',
    ]);
    expect(workspaceSet.active.root).toBe(workspaceRoots[2]!);
    expect(workspaceSet.closeActive()).toBe(true);
    expect(workspaceSet.count).toBe(1);
    expect(workspaceSet.closeActive()).toBe(false);
    expect(workspaceSet.liveGitWatcherCount).toBe(1);
    workspaceSet.dispose();
  });
});
