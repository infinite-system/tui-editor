import { describe, expect, test } from 'bun:test';
import { QuickOpen, type ProjectFileEnumerator } from './QuickOpen';

const FIXED_PROJECT_FILES = [
  'src/show-a-value-everywhere.ts',
  'src/save.ts',
  'src/modules/search/QuickOpen.ts',
  'readme.md',
] as const;

function fixedProjectFileEnumerator(
  enumeratedProjectRoots: string[] = [],
): ProjectFileEnumerator {
  return async (projectRoot) => {
    enumeratedProjectRoots.push(projectRoot);
    return FIXED_PROJECT_FILES;
  };
}

describe('QuickOpen', () => {
  test('deletePreviousWord edits the query through the shared text boundary', async () => {
    const quickOpen = new QuickOpen.Class({ enumerateProjectFiles: async () => ['foo bar.ts'] });
    await quickOpen.show('/project');
    quickOpen.setQuery('foo bar');
    quickOpen.deletePreviousWord();
    expect(quickOpen.query.value).toBe('foo ');
  });

  test('show uses the injected enumerator and an empty query lists every file alphabetically', async () => {
    const enumeratedProjectRoots: string[] = [];
    const quickOpen = new QuickOpen.Class({
      enumerateProjectFiles: fixedProjectFileEnumerator(enumeratedProjectRoots),
    });

    await quickOpen.show('/project');

    expect(enumeratedProjectRoots).toEqual(['/project']);
    expect(quickOpen.open.value).toBe(true);
    expect(quickOpen.query.value).toBe('');
    expect(quickOpen.matches.value).toEqual([
      { path: 'readme.md', score: 0 },
      { path: 'src/modules/search/QuickOpen.ts', score: 0 },
      { path: 'src/save.ts', score: 0 },
      { path: 'src/show-a-value-everywhere.ts', score: 0 },
    ]);
    expect(quickOpen.selectedIndex.value).toBe(0);
  });

  test('setQuery filters subsequences and ranks tighter matches first', async () => {
    const quickOpen = new QuickOpen.Class({
      enumerateProjectFiles: fixedProjectFileEnumerator(),
    });
    await quickOpen.show('/project');

    quickOpen.setQuery('save');

    expect(quickOpen.matches.value.map((match) => match.path)).toEqual([
      'src/save.ts',
      'src/show-a-value-everywhere.ts',
    ]);
    expect(quickOpen.matches.value[0]!.score).toBeLessThan(quickOpen.matches.value[1]!.score);
    expect(quickOpen.selectedIndex.value).toBe(0);
  });

  test('moveSelection clamps at both ends and stays unselected when there are no matches', async () => {
    const quickOpen = new QuickOpen.Class({
      enumerateProjectFiles: fixedProjectFileEnumerator(),
    });
    await quickOpen.show('/project');

    quickOpen.moveSelection(100);
    expect(quickOpen.selectedIndex.value).toBe(FIXED_PROJECT_FILES.length - 1);
    quickOpen.moveSelection(-100);
    expect(quickOpen.selectedIndex.value).toBe(0);

    quickOpen.setQuery('no-matching-file');
    expect(quickOpen.matches.value).toEqual([]);
    expect(quickOpen.selectedIndex.value).toBe(-1);
    quickOpen.moveSelection(1);
    expect(quickOpen.selectedIndex.value).toBe(-1);
  });

  test('activate returns the selected file path without opening it', async () => {
    const quickOpen = new QuickOpen.Class({
      enumerateProjectFiles: fixedProjectFileEnumerator(),
    });
    await quickOpen.show('/project');
    quickOpen.setQuery('save');
    quickOpen.moveSelection(1);

    expect(quickOpen.activate()).toBe('src/show-a-value-everywhere.ts');
    expect(quickOpen.open.value).toBe(true);
  });

  test('workspace-path mode prefills the parent path and lists fuzzy-searchable sibling folders', () => {
    const enumeratedParentDirectories: string[] = [];
    const quickOpen = new QuickOpen.Class({
      enumerateSiblingFolders: (parentDirectory) => {
        enumeratedParentDirectories.push(parentDirectory);
        return ['/projects/alpha', '/projects/beta', '/projects/gamma'];
      },
    });

    quickOpen.showWorkspacePath('/projects/alpha');

    expect(enumeratedParentDirectories).toEqual(['/projects']);
    expect(quickOpen.mode.value).toBe('workspacePath');
    expect(quickOpen.query.value).toBe('/projects');
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual([
      '/projects/alpha',
      '/projects/beta',
      '/projects/gamma',
    ]);
    expect(quickOpen.selectedIndex.value).toBe(0);

    quickOpen.setQuery('/projects/gm');
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual(['/projects/gamma']);

    quickOpen.moveSelection(0);
    expect(quickOpen.activate()).toBe('/projects/gamma');
  });

  test('workspace-path mode returns the typed path when it matches no sibling folder', () => {
    const quickOpen = new QuickOpen.Class({
      enumerateSiblingFolders: () => ['/projects/alpha', '/projects/beta'],
    });

    quickOpen.showWorkspacePath('/projects/alpha');
    quickOpen.setQuery('  /elsewhere/custom  ');

    expect(quickOpen.matches.value).toEqual([]);
    expect(quickOpen.selectedIndex.value).toBe(-1);
    expect(quickOpen.activate()).toBe('/elsewhere/custom');
  });

  test('workspace-path mode reuses the input and returns the typed folder', () => {
    const quickOpen = new QuickOpen.Class();
    quickOpen.showWorkspacePath();
    quickOpen.setQuery('  /projects/second  ');

    expect(quickOpen.open.value).toBe(true);
    expect(quickOpen.mode.value).toBe('workspacePath');
    expect(quickOpen.matches.value).toEqual([]);
    expect(quickOpen.activate()).toBe('/projects/second');

    quickOpen.setError('Enter an existing folder path');
    expect(quickOpen.errorMessage.value).toBe('Enter an existing folder path');
    quickOpen.setQuery('/projects/first');
    expect(quickOpen.errorMessage.value).toBe('');
  });

  test('close clears state and prevents an in-flight enumeration from reopening candidates', async () => {
    let finishEnumeration!: (projectFiles: readonly string[]) => void;
    const enumerateProjectFiles: ProjectFileEnumerator = () =>
      new Promise((resolveEnumeration) => {
        finishEnumeration = resolveEnumeration;
      });
    const quickOpen = new QuickOpen.Class({ enumerateProjectFiles });

    const showing = quickOpen.show('/project');
    quickOpen.close();
    finishEnumeration(FIXED_PROJECT_FILES);
    await showing;

    expect(quickOpen.open.value).toBe(false);
    expect(quickOpen.query.value).toBe('');
    expect(quickOpen.matches.value).toEqual([]);
    expect(quickOpen.selectedIndex.value).toBe(-1);
    expect(quickOpen.activate()).toBeNull();
  });
});
