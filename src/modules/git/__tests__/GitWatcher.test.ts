import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  watch,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitRepository } from '../GitRepository';
import { gitCleanEnv } from './gitCleanEnv';
import { GitWatcher } from '../GitWatcher';

// These tests exercise the REAL fs.watch inotify path. A resource-starved sandbox (exhausted inotify
// instances) makes fs.watch throw EMFILE — an ENVIRONMENT limitation, not a code fault (the feature is
// also covered end-to-end by scripts/smoke-git-watch.sh). Skip cleanly when the OS can't open a watch,
// so the merge gate is not blocked by an unavailable OS capability; on real hardware the tests run.
const FS_WATCH_AVAILABLE = (() => {
  const probeDirectory = mkdtempSync(join(tmpdir(), 'fable-fswatch-probe-'));
  try {
    const handle = watch(probeDirectory, () => {});
    handle.close();
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
})();
if (!FS_WATCH_AVAILABLE) {
  console.warn('GitWatcher.test: fs.watch unavailable (EMFILE — inotify exhausted); skipping watch-path tests. smoke-git-watch.sh covers the behavior.');
}
const watchTest = test.skipIf(!FS_WATCH_AVAILABLE);

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function git(cwd: string, arguments_: string[]): void {
  const result = spawnSync('git', arguments_, { cwd, encoding: 'utf8', env: gitCleanEnv() });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
  }
}

/** A temp git repository with a real `node_modules/` gitignore, a large-ish ignored subtree, and
 *  tracked nested files. Returns the repository root; the caller removes it. */
function makeRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fable-git-watch-'));
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);

  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(cwd, 'src', 'deep'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'deep', 'nested.ts'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'root.txt'), 'root\n');

  // A large-ish ignored subtree: exactly the kind of thing a recursive root watch would open a
  // watch handle per directory for.
  for (let packageIndex = 0; packageIndex < 120; packageIndex++) {
    const packageDirectory = join(cwd, 'node_modules', `package-${packageIndex}`, 'lib');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, 'index.js'), 'module.exports = {};\n');
  }

  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'init']);
  return cwd;
}

test('watcher disposal cancels a pending refresh', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fable-git-watch-'));
  let refreshCount = 0;
  const repository = {
    async refresh(): Promise<void> {
      refreshCount++;
    },
  } as unknown as GitRepository.Model;

  class TestGitWatcher extends GitWatcher.$Class {
    trigger(): void {
      this.scheduleRefresh();
    }
  }

  const watcher = new TestGitWatcher(cwd, repository, { debounceMs: 15 });
  try {
    watcher.trigger();
    watcher.trigger();
    watcher.trigger();
    await wait(35);
    expect(refreshCount).toBe(1);

    watcher.trigger();
    watcher.dispose();
    await wait(35);
    expect(refreshCount).toBe(1);
    expect(watcher.active).toBe(false);
  } finally {
    watcher.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

watchTest('no watch handle is ever opened inside an ignored directory', () => {
  const cwd = makeRepository();
  const repository = {
    async refresh(): Promise<void> {},
  } as unknown as GitRepository.Model;

  const watcher = new GitWatcher.Class(cwd, repository, { debounceMs: 15 });
  try {
    const watchedDirectories = watcher.watchedDirectories();
    // The root and the tracked src subtree are watched.
    expect(watchedDirectories).toContain(cwd);
    expect(watchedDirectories).toContain(join(cwd, 'src'));
    expect(watchedDirectories).toContain(join(cwd, 'src', 'deep'));
    // The ignored node_modules subtree — 120 packages, 240+ directories — is watched by NOTHING.
    expect(watchedDirectories.some((path) => path.includes('node_modules'))).toBe(false);
    // A recursive watch would open a handle per directory (250+); the walk opens only a handful.
    expect(watcher.watchedDirectoryCount).toBeLessThan(10);
  } finally {
    watcher.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

watchTest('a nested tracked change refreshes but a change inside an ignored directory does not', async () => {
  const cwd = makeRepository();
  let refreshCount = 0;
  const repository = {
    async refresh(): Promise<void> {
      refreshCount++;
    },
  } as unknown as GitRepository.Model;

  const watcher = new GitWatcher.Class(cwd, repository, { debounceMs: 20 });
  try {
    // A change INSIDE the ignored node_modules subtree must NOT trigger a refresh.
    writeFileSync(
      join(cwd, 'node_modules', 'package-0', 'lib', 'index.js'),
      'module.exports = { changed: true };\n',
    );
    await wait(120);
    expect(refreshCount).toBe(0);

    // A change to a NESTED tracked file must trigger exactly one debounced refresh.
    writeFileSync(join(cwd, 'src', 'deep', 'nested.ts'), 'export const value = 2;\n');
    await wait(120);
    expect(refreshCount).toBe(1);
  } finally {
    watcher.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});

watchTest('a newly created nested directory is watched but a new ignored directory is not', async () => {
  const cwd = makeRepository();
  let refreshCount = 0;
  const repository = {
    async refresh(): Promise<void> {
      refreshCount++;
    },
  } as unknown as GitRepository.Model;

  const watcher = new GitWatcher.Class(cwd, repository, { debounceMs: 20 });
  try {
    // A brand-new tracked subdirectory appears and then gains a file: the walk must have added a
    // watch for it, so the nested change refreshes.
    const freshDirectory = join(cwd, 'src', 'feature');
    mkdirSync(freshDirectory, { recursive: true });
    await wait(120);
    refreshCount = 0;
    expect(watcher.watchedDirectories()).toContain(freshDirectory);

    writeFileSync(join(freshDirectory, 'thing.ts'), 'export const thing = 1;\n');
    await wait(120);
    expect(refreshCount).toBe(1);

    // A brand-new IGNORED directory (under node_modules) must never gain a watch.
    const ignoredDirectory = join(cwd, 'node_modules', 'package-new');
    mkdirSync(ignoredDirectory, { recursive: true });
    await wait(120);
    expect(watcher.watchedDirectories().some((path) => path.includes('node_modules'))).toBe(false);
  } finally {
    watcher.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
});
