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

  test('workspace-path mode opens listing the parent folder and filters its subfolders by the last segment', () => {
    const enumeratedDirectories: string[] = [];
    const quickOpen = new QuickOpen.Class({
      enumerateSiblingFolders: (directory) => {
        enumeratedDirectories.push(directory);
        return ['/projects/alpha', '/projects/beta', '/projects/gamma'];
      },
    });

    quickOpen.showWorkspacePath('/projects/alpha');

    // Prefill lists the parent's subfolders (siblings), with a trailing slash so the input shows it is
    // browsing INSIDE /projects.
    expect(enumeratedDirectories).toEqual(['/projects']);
    expect(quickOpen.mode.value).toBe('workspacePath');
    expect(quickOpen.query.value).toBe('/projects/');
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual([
      '/projects/alpha',
      '/projects/beta',
      '/projects/gamma',
    ]);
    expect(quickOpen.selectedIndex.value).toBe(0);

    // Typing a segment filters the SAME directory's subfolders by that segment (fuzzy) — no re-read.
    quickOpen.setQuery('/projects/gm');
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual(['/projects/gamma']);
    expect(enumeratedDirectories).toEqual(['/projects']);

    // A click/keyboard drill navigates INTO the highlighted folder: the path completes and re-lists.
    quickOpen.navigateIntoSelected();
    expect(quickOpen.query.value).toBe('/projects/gamma/');
    expect(enumeratedDirectories).toEqual(['/projects', '/projects/gamma']);

    // Enter opens the CURRENT path (the folder navigated to), trailing slash stripped.
    expect(quickOpen.activate()).toBe('/projects/gamma');
  });

  test('workspace-path mode re-roots the listing live as the directory part of the input changes', () => {
    const enumeratedDirectories: string[] = [];
    const quickOpen = new QuickOpen.Class({
      enumerateSiblingFolders: (directory) => {
        enumeratedDirectories.push(directory);
        if (directory === '/home/user') return ['/home/user/dev', '/home/user/desktop', '/home/user/music'];
        if (directory === '/home/user/dev') return ['/home/user/dev/invar', '/home/user/dev/ibr'];
        return [];
      },
    });

    quickOpen.showWorkspacePath('/home/user/dev'); // parent = /home/user
    expect(quickOpen.query.value).toBe('/home/user/');

    // Filter /home/user by "de" → desktop + dev (equal fuzzy score, alphabetical tiebreak), not music.
    quickOpen.setQuery('/home/user/de');
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual(['/home/user/desktop', '/home/user/dev']);

    // Extend to a new directory → the listing re-roots to /home/user/dev's contents.
    quickOpen.setQuery('/home/user/dev/');
    expect(enumeratedDirectories).toEqual(['/home/user', '/home/user/dev']);
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual(['/home/user/dev/ibr', '/home/user/dev/invar']);
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

  test('workspace-path enumeration caps a huge directory to a fixed ceiling', () => {
    // A pathological parent with 5000 entries — the unbounded synchronous classification that froze the
    // picker. The hardened default reads names via the listDirectoryNames seam, caps them, then
    // classifies each; the cap bounds how many entries get classified.
    const classifiedPaths: string[] = [];
    const entryNames = Array.from({ length: 5000 }, (_unused, index) => `entry-${index}`);
    const quickOpen = new QuickOpen.Class({
      listDirectoryNames: () => entryNames,
      isDirectory: (path) => {
        classifiedPaths.push(path);
        return true; // every entry is a directory, so the only thing trimming the list is the cap
      },
    });

    quickOpen.showWorkspacePath('/huge/child'); // parent = /huge

    // Only the first 2000 entries are classified and listed — never the full 5000. (isDirectory is also
    // used once for the live openable-check on the parent path itself, so count only the entry classifications.)
    const classifiedEntries = classifiedPaths.filter((path) => path.includes('/entry-'));
    expect(classifiedEntries.length).toBe(2000);
    expect(quickOpen.matches.value.length).toBe(2000);
  });

  test('a single bad entry whose stat throws is skipped, never propagated as a hang or throw', () => {
    // A broken symlink / vanished race: its classification throws. The navigator must skip it and still
    // list the good folders — a thrown stat must never escape (that is the freeze/crash path).
    const quickOpen = new QuickOpen.Class({
      listDirectoryNames: () => ['good-alpha', 'broken-symlink', 'good-beta'],
      isDirectory: (path) => {
        if (path.endsWith('broken-symlink')) throw new Error('ELOOP: broken symlink');
        return true;
      },
    });

    expect(() => quickOpen.showWorkspacePath('/parent/child')).not.toThrow();
    expect(quickOpen.matches.value.map((match) => match.path)).toEqual([
      '/parent/good-alpha',
      '/parent/good-beta',
    ]);
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
