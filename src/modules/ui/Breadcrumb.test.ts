import { describe, expect, test } from 'bun:test';
import { Breadcrumb } from './TabBarRenderer';
const { breadcrumbSegments, fitBreadcrumb } = Breadcrumb.Class;

describe('breadcrumbSegments', () => {
  test('project + intermediate dirs + filename', () => {
    expect(breadcrumbSegments('/home/me/proj/src/ui/Foo.ts', '/home/me/proj')).toEqual([
      'proj', 'src', 'ui', 'Foo.ts',
    ]);
  });

  test('file directly in the project root is [project, file]', () => {
    expect(breadcrumbSegments('/home/me/proj/README.md', '/home/me/proj')).toEqual(['proj', 'README.md']);
  });

  test('a trailing slash on the root does not create an empty crumb', () => {
    expect(breadcrumbSegments('/home/me/proj/a/b.ts', '/home/me/proj/')).toEqual(['proj', 'a', 'b.ts']);
  });

  test('a path outside the project root falls back to just the filename', () => {
    expect(breadcrumbSegments('/etc/hosts', '/home/me/proj')).toEqual(['hosts']);
  });
});

describe('fitBreadcrumb', () => {
  const sep = 3; // ' › ' is 3 cells

  test('everything fits → unchanged', () => {
    // 'proj'(4)+'src'(3)+'Foo.ts'(6) + 2*3 sep = 19
    expect(fitBreadcrumb(['proj', 'src', 'Foo.ts'], 40, sep)).toEqual(['proj', 'src', 'Foo.ts']);
  });

  test('leading crumbs collapse to a single … but the filename stays', () => {
    // Force a tight width: only '… › Foo.ts' (1+3+6 = 10) fits.
    const fitted = fitBreadcrumb(['proj', 'src', 'ui', 'Foo.ts'], 10, sep);
    expect(fitted[fitted.length - 1]).toBe('Foo.ts');
    expect(fitted[0]).toBe('…');
    expect(fitted.length).toBe(2);
  });

  test('when even … + filename overflows, the filename alone is hard-truncated with an ellipsis', () => {
    const fitted = fitBreadcrumb(['proj', 'src', 'VeryLongFileName.ts'], 8, sep);
    expect(fitted.length).toBe(1);
    expect(fitted[0]).toBe('VeryLon…'); // 7 chars + …  = 8 cells
  });

  test('the filename always survives even at width 1', () => {
    expect(fitBreadcrumb(['proj', 'Foo.ts'], 1, sep)).toEqual(['…']);
  });
});
