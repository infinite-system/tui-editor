import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitRepository } from '../GitRepository';
import { GitWatcher } from '../GitWatcher';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
