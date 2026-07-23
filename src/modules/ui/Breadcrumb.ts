// Path breadcrumbs for buffer tabs: turn an absolute file path into `project › dir › file` crumbs and
// fit them into a width by collapsing leading directories to an ellipsis while always keeping the
// filename. Pure string logic — a Static capability so the renderer composes it without a bare export.
import { Static } from 'ivue/extras';

/** Breadcrumb path segments for a buffer tab: the project folder, then each directory between it and
 *  the file, then the filename — rendered `project › src › ui › Foo.ts`. Paths outside the project
 *  root (rare) fall back to just the filename. POSIX separators (the app's paths are absolute POSIX). */
function $breadcrumbSegments(absolutePath: string, projectRoot: string): string[] {
  const fileName = absolutePath.split('/').filter(Boolean).pop() ?? absolutePath;
  const normalizedRoot = projectRoot.replace(/\/+$/, '');
  const projectName = normalizedRoot.split('/').filter(Boolean).pop() ?? normalizedRoot;
  if (!normalizedRoot || !absolutePath.startsWith(`${normalizedRoot}/`)) return [fileName];
  const relativeParts = absolutePath.slice(normalizedRoot.length).split('/').filter(Boolean);
  return relativeParts.length ? [projectName, ...relativeParts] : [projectName];
}

/** Fit breadcrumb segments into `maxWidth` display columns (separators included, `separatorWidth`
 *  cells each): drop LEADING segments — collapsing them into a single `…` crumb — until it fits, but
 *  ALWAYS keep the filename (the last segment) even if it alone must be hard-truncated. */
function $fitBreadcrumb(segments: string[], maxWidth: number, separatorWidth: number): string[] {
  if (segments.length === 0) return [];
  const width = (parts: string[]): number =>
    parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1) * separatorWidth;
  let visible = [...segments];
  // Collapse leading crumbs to a single '…' until the row fits or only the filename (+'…') remains.
  while (visible.length > 1 && width(visible) > maxWidth) {
    const droppedLeading = visible[0] === '…';
    visible = droppedLeading ? ['…', ...visible.slice(2)] : ['…', ...visible.slice(1)];
    if (visible.length === 2 && visible[0] === '…') break;
  }
  const fileName = visible[visible.length - 1]!;
  if (width(visible) > maxWidth) {
    // Even collapsed it overflows: keep only the filename, hard-truncated with a trailing ellipsis.
    if (fileName.length <= maxWidth) return [fileName];
    return [maxWidth <= 1 ? '…' : `${fileName.slice(0, maxWidth - 1)}…`];
  }
  return visible;
}

class $Breadcrumb {
  static breadcrumbSegments = $breadcrumbSegments;
  static fitBreadcrumb = $fitBreadcrumb;
}
export namespace Breadcrumb {
  export const $Class = $Breadcrumb;
  export const Class = Static($Breadcrumb);
}
