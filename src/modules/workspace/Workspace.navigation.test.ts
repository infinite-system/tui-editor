// The Workspace-level navigation-history wiring: opening files records the trail, Alt+[/Alt+]
// (navigateBack/navigateForward) restore the file AND cursor, a programmatic restore does NOT
// record new history, and a new navigation after going back truncates the forward trail. Real
// Editors over real temp files (end-to-end through openFileInTab).
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Workspace } from './Workspace';
import {
  mkdtempSync as makeTemporaryDirectorySync,
  rmSync as removeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';

let workspaceDirectory = '';
const filePaths: string[] = [];

beforeEach(() => {
  workspaceDirectory = makeTemporaryDirectorySync(join(temporaryDirectory(), 'tui-nav-'));
  filePaths.length = 0;
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    const path = join(workspaceDirectory, name);
    writeFileSync(path, 'line one\nline two\nline three\nline four\nline five\n');
    filePaths.push(path);
  }
});

afterEach(() => {
  removeSync(workspaceDirectory, { recursive: true, force: true });
});

describe('Workspace navigation history (Go Back / Go Forward)', () => {
  test('opening two files records the trail; back returns to the first, forward to the second', () => {
    const workspace = new Workspace.Class();
    const [alpha, beta] = filePaths as [string, string, string];
    workspace.openFileInTab(alpha);
    workspace.openFileInTab(beta);
    expect(workspace.editor.document.path).toBe(beta);

    workspace.navigateBack();
    expect(workspace.editor.document.path).toBe(alpha);

    workspace.navigateForward();
    expect(workspace.editor.document.path).toBe(beta);
  });

  test('back restores the cursor position left behind in the source file', () => {
    const workspace = new Workspace.Class();
    const [alpha, beta] = filePaths as [string, string, string];
    workspace.openFileInTab(alpha);
    workspace.editor.placeCursor(3, 2); // move within alpha, then leave it
    workspace.openFileInTab(beta);

    workspace.navigateBack();
    expect(workspace.editor.document.path).toBe(alpha);
    expect(workspace.editor.cursor.line.value).toBe(3);
    expect(workspace.editor.cursor.col.value).toBe(2);
  });

  test('a programmatic back/forward does not itself record new history', () => {
    const workspace = new Workspace.Class();
    const [alpha, beta] = filePaths as [string, string, string];
    workspace.openFileInTab(alpha);
    workspace.openFileInTab(beta);
    const sizeAfterOpens = workspace.navigationHistory.size;
    workspace.navigateBack();
    workspace.navigateForward();
    expect(workspace.navigationHistory.size).toBe(sizeAfterOpens);
  });

  test('a new navigation after going back truncates the forward trail', () => {
    const workspace = new Workspace.Class();
    const [alpha, beta, gamma] = filePaths as [string, string, string];
    workspace.openFileInTab(alpha);
    workspace.openFileInTab(beta);
    workspace.navigateBack(); // back to alpha, beta is ahead
    expect(workspace.editor.document.path).toBe(alpha);

    workspace.openFileInTab(gamma); // new branch — beta must be discarded
    expect(workspace.navigationHistory.canGoForward).toBe(false);
    expect(workspace.editor.document.path).toBe(gamma);

    workspace.navigateBack();
    expect(workspace.editor.document.path).toBe(alpha);
  });

  test('navigateBack is a safe no-op with no history', () => {
    const workspace = new Workspace.Class();
    expect(() => workspace.navigateBack()).not.toThrow();
    expect(() => workspace.navigateForward()).not.toThrow();
    expect(workspace.editor.hasDocument.value).toBe(false);
  });
});
