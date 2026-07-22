// Item 10a: the Workspace-level editor buffer-tab integration — opening a file adds/focuses a tab
// (never replaces), the flyweight keeps N clean tabs at ONE live document, closing disposes, and a
// dirty tab requires a close confirmation. Uses real Editors over real temp files (end-to-end).
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Workspace } from './Workspace';
import {
  mkdirSync as makeDirectorySync,
  mkdtempSync as makeTemporaryDirectorySync,
  rmSync as removeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';

let workspaceDirectory = '';
const filePaths: string[] = [];

beforeEach(() => {
  workspaceDirectory = makeTemporaryDirectorySync(join(temporaryDirectory(), 'tui-tabs-'));
  filePaths.length = 0;
  for (let index = 1; index <= 4; index += 1) {
    const path = join(workspaceDirectory, `file${index}.txt`);
    writeFileSync(path, `file ${index} line one\nline two\nline three\n`);
    filePaths.push(path);
  }
});

afterEach(() => {
  removeSync(workspaceDirectory, { recursive: true, force: true });
});

describe('Workspace editor buffer tabs (item 10a)', () => {
  test('opening files ADDS tabs and activates the newest; reopening focuses the existing tab', () => {
    const workspace = new Workspace.Class();
    workspace.openFileInTab(filePaths[0]!);
    workspace.openFileInTab(filePaths[1]!);
    workspace.openFileInTab(filePaths[2]!);
    expect(workspace.buffers.count).toBe(3);
    expect(workspace.buffers.activeIndex.value).toBe(2);
    expect(workspace.editor.document.path).toBe(filePaths[2]!);

    // Reopening an already-open file focuses its tab — no new tab.
    workspace.openFileInTab(filePaths[0]!);
    expect(workspace.buffers.count).toBe(3);
    expect(workspace.buffers.activeIndex.value).toBe(0);
    expect(workspace.editor.document.path).toBe(filePaths[0]!);
  });

  test('FLYWEIGHT: N clean tabs cost ONE live document', () => {
    const workspace = new Workspace.Class();
    for (const path of filePaths) workspace.openFileInTab(path);
    expect(workspace.buffers.count).toBe(4);
    // Only the active buffer holds a live document; the three clean background tabs are dehydrated.
    expect(workspace.buffers.liveCount).toBe(1);
  });

  test('cycleTab wraps and rehydrates; a rehydrated clean tab is still one live document', () => {
    const workspace = new Workspace.Class();
    for (const path of filePaths) workspace.openFileInTab(path); // active = 3
    workspace.cycleTab(1); // wraps to 0
    expect(workspace.buffers.activeIndex.value).toBe(0);
    expect(workspace.editor.document.path).toBe(filePaths[0]!);
    expect(workspace.buffers.liveCount).toBe(1); // outgoing dehydrated, incoming hydrated
    workspace.cycleTab(-1); // wraps back to the last
    expect(workspace.buffers.activeIndex.value).toBe(3);
  });

  test('closing a clean tab disposes it and activates a neighbour; closing all returns to empty', () => {
    const workspace = new Workspace.Class();
    for (const path of filePaths) workspace.openFileInTab(path);
    workspace.closeTab(workspace.buffers.activeIndex.value);
    expect(workspace.buffers.count).toBe(3);
    workspace.closeTab(0);
    workspace.closeTab(0);
    workspace.closeTab(0);
    expect(workspace.buffers.count).toBe(0);
    // No tabs -> the empty-state editor (no document); focus falls back to the file tree.
    expect(workspace.editor.hasDocument.value).toBe(false);
    expect(workspace.focus.value).toBe('files');
  });

  test('a DIRTY tab requires a close confirmation; confirm closes, cancel keeps it', () => {
    const workspace = new Workspace.Class();
    workspace.openFileInTab(filePaths[0]!);
    workspace.editor.insertText('x'); // now dirty
    expect(workspace.editor.dirty).toBe(true);

    workspace.closeActiveTab();
    // Not closed yet — a confirmation is pending.
    expect(workspace.buffers.count).toBe(1);
    expect(workspace.pendingCloseTabIndex.value).toBe(0);

    workspace.cancelCloseTab();
    expect(workspace.pendingCloseTabIndex.value).toBe(-1);
    expect(workspace.buffers.count).toBe(1); // kept

    workspace.closeActiveTab();
    workspace.confirmCloseTab();
    expect(workspace.buffers.count).toBe(0);
  });

  test('a DIRTY background tab stays live (its unsaved edits survive dehydration)', () => {
    const workspace = new Workspace.Class();
    workspace.openFileInTab(filePaths[0]!);
    workspace.editor.insertText('edit'); // tab 0 is dirty
    workspace.openFileInTab(filePaths[1]!); // switch away — tab 0 must NOT dehydrate
    expect(workspace.buffers.liveCount).toBe(2); // active (1) + dirty background (0)
  });

  test('opening a real file leaves diff view; the visible editor becomes the active tab', () => {
    const workspace = new Workspace.Class();
    workspace.showingDiff.value = true; // pretend a git diff is displayed over the tabs
    workspace.openFileInTab(filePaths[0]!);
    expect(workspace.showingDiff.value).toBe(false);
    expect(workspace.editor.document.path).toBe(filePaths[0]!);
  });

  // invariant: A file reference opens from rendered Markdown (src/modules/markdown/markdown.invariants.md)
  test('rendered file references resolve only to real files inside the workspace', () => {
    const sourceDirectory = join(workspaceDirectory, 'guides');
    const sourcePath = join(sourceDirectory, 'guide.md');
    const sourceRelativeTarget = join(sourceDirectory, 'details.md');
    const rootRelativeTarget = join(workspaceDirectory, 'project.invariants.md');
    makeDirectorySync(sourceDirectory);
    writeFileSync(sourcePath, '# Guide\n');
    writeFileSync(sourceRelativeTarget, '# Details\n');
    writeFileSync(rootRelativeTarget, '# Invariants\n');

    const workspace = new Workspace.Class();
    workspace.root = workspaceDirectory;
    workspace.openFileInTab(sourcePath);

    expect(workspace.resolveFileReference('details.md')).toBe(sourceRelativeTarget);
    expect(workspace.resolveFileReference('project.invariants.md#record')).toBe(rootRelativeTarget);
    expect(workspace.resolveFileReference('https://example.com/file.md')).toBeNull();
    expect(workspace.resolveFileReference('../outside.md')).toBeNull();
    expect(workspace.resolveFileReference('missing.md')).toBeNull();

    expect(workspace.openFileReference('project.invariants.md')).toBe(true);
    expect(workspace.editor.document.path).toBe(rootRelativeTarget);
  });
});
