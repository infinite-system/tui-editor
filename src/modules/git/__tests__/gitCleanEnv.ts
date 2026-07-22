// Hermetic git environment for tests that spawn `git` against a temporary FIXTURE repo.
//
// When the test suite runs INSIDE a git hook (the pre-commit merge-gate runs `bun test`), git exports
// GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_OBJECT_DIRECTORY (and more) into the environment. A
// fixture that spawns `git commit` in its own temp dir would INHERIT those and operate on the PARENT
// repo's index instead of the temp repo — producing "invalid object … / Error building trees" and a
// flaky, context-dependent failure (green when run directly, red under the commit hook). Stripping
// every GIT_* variable makes fixture git commands hermetic regardless of the ambient git context.
export function gitCleanEnv(): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('GIT_')) continue;
    cleaned[key] = value;
  }
  return cleaned;
}
