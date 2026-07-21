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
  const t = new FileTree.Class();
  t.open(root);
  const names = t.rows.map((r) => r.name);
  expect(names).toEqual(['sub', 'a.ts', 'b.md']);
});

test('expanding a directory reveals its children indented, cost only on expand', () => {
  const t = new FileTree.Class();
  t.open(root);
  expect(t.rows.length).toBe(3); // sub collapsed — child not materialized
  t.setSelection(0); // 'sub'
  const res = t.activateSelected();
  expect(res).toEqual({ toggled: true });
  const rows = t.rows;
  expect(rows.length).toBe(4);
  const child = rows.find((r) => r.name === 'c.ts');
  expect(child?.depth).toBe(1);
});

test('activating a file returns its path to open', () => {
  const t = new FileTree.Class();
  t.open(root);
  t.setSelection(1); // 'a.ts'
  const res = t.activateSelected();
  expect(res).toHaveProperty('openFile');
  expect((res as { openFile: string }).openFile.endsWith('a.ts')).toBe(true);
});

test('selection movement clamps to bounds', () => {
  const t = new FileTree.Class();
  t.open(root);
  t.moveSelection(-5);
  expect(t.selectedIndex.value).toBe(0);
  t.moveSelection(100);
  expect(t.selectedIndex.value).toBe(t.rows.length - 1);
});
