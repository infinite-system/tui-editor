import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTree } from '../FileTree';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ftree-'));
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
  writeFileSync(join(root, 'b.md'), '# b');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'c.ts'), 'export const c = 3;');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test('root lists directories first, then files, alphabetical', () => {
  const tree = new FileTree.Class();
  tree.open(root);
  const names = tree.rows.map((row) => row.name);
  expect(names).toEqual(['sub', 'a.ts', 'b.md']);
});

test('expanding a directory reveals its children indented, cost only on expand', () => {
  const tree = new FileTree.Class();
  tree.open(root);
  expect(tree.rows.length).toBe(3); // sub collapsed — child not materialized
  tree.setSelection(0); // 'sub'
  const result = tree.activateSelected();
  expect(result).toEqual({ toggled: true });
  const rows = tree.rows;
  expect(rows.length).toBe(4);
  const child = rows.find((row) => row.name === 'c.ts');
  expect(child?.depth).toBe(1);
});

test('activating a file returns its path to open', () => {
  const tree = new FileTree.Class();
  tree.open(root);
  tree.setSelection(1); // 'a.ts'
  const result = tree.activateSelected();
  expect(result).toHaveProperty('openFile');
  expect((result as { openFile: string }).openFile.endsWith('a.ts')).toBe(true);
});

test('selection movement clamps to bounds', () => {
  const tree = new FileTree.Class();
  tree.open(root);
  tree.moveSelection(-5);
  expect(tree.selectedIndex.value).toBe(0);
  tree.moveSelection(100);
  expect(tree.selectedIndex.value).toBe(tree.rows.length - 1);
});
