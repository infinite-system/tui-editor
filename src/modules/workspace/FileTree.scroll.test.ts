// The file tree scrolls via an INDEPENDENT window offset (like the git-changes list), NOT derived
// from the selection. This is the fix for: (a) the scroll "swim" (wheel moved the selection, pinning
// the highlight to a screen edge while content flowed under it), and (b) clicking a visible row
// snapping the list to the top. Contract: wheel/scrollBy moves the window and leaves the selection
// put; clicking (setSelection) leaves the window put; keyboard (moveSelection) reveals minimally.
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { FileTree } from './FileTree';
import { mkdtempSync as makeTemporaryDirectorySync, rmSync as removeSync, writeFileSync } from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';

let treeRoot = '';

beforeEach(() => {
  treeRoot = makeTemporaryDirectorySync(join(temporaryDirectory(), 'fable-tree-scroll-'));
  for (let fileNumber = 0; fileNumber < 20; fileNumber += 1) {
    writeFileSync(join(treeRoot, `file-${String(fileNumber).padStart(2, '0')}.txt`), 'x');
  }
});
afterEach(() => removeSync(treeRoot, { recursive: true, force: true }));

describe('FileTree independent scroll window', () => {
  test('scrollBy moves the window (clamped) and never moves the selection', () => {
    const tree = new FileTree.Class();
    tree.open(treeRoot);
    tree.viewportHeight.value = 10;
    expect(tree.rows.length).toBe(20);

    tree.scrollBy(5);
    expect(tree.scrollTop.value).toBe(5);
    expect(tree.selectedIndex.value).toBe(0); // selection untouched by wheel

    tree.scrollBy(100); // clamps to rows.length - viewportHeight
    expect(tree.scrollTop.value).toBe(10);
    tree.scrollBy(-100);
    expect(tree.scrollTop.value).toBe(0);
  });

  test('setSelection (click) changes selection but LEAVES the scroll offset (no jump)', () => {
    const tree = new FileTree.Class();
    tree.open(treeRoot);
    tree.viewportHeight.value = 10;
    tree.scrollBy(8); // scrolled down
    expect(tree.scrollTop.value).toBe(8);

    tree.setSelection(9); // click a visible row (rows 8..17 visible)
    expect(tree.selectedIndex.value).toBe(9);
    expect(tree.scrollTop.value).toBe(8); // UNCHANGED — the bug was this snapping to 0
  });

  test('moveSelection (keyboard) reveals the selection minimally when it goes off-screen', () => {
    const tree = new FileTree.Class();
    tree.open(treeRoot);
    tree.viewportHeight.value = 10;
    // Move selection below the viewport bottom -> reveal to the bottom edge (minimum scroll).
    tree.moveSelection(15);
    expect(tree.selectedIndex.value).toBe(15);
    expect(tree.scrollTop.value).toBe(15 - 10 + 1); // 6 — just enough to show row 15
    // Move back up above the window top -> reveal to the top edge.
    tree.moveSelection(-15);
    expect(tree.selectedIndex.value).toBe(0);
    expect(tree.scrollTop.value).toBe(0);
  });

  test('windowTop clamps a stale offset back into range', () => {
    const tree = new FileTree.Class();
    tree.open(treeRoot);
    tree.viewportHeight.value = 10;
    tree.scrollTop.value = 999; // e.g. rows collapsed after a scroll
    expect(tree.windowTop()).toBe(10); // rows.length(20) - viewportHeight(10)
    expect(tree.scrollTop.value).toBe(10); // and the clamp is written back
  });
});
