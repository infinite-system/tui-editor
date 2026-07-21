// A lazily-expanded file tree. Children are read only when a directory is expanded, and the
// flattened visible list is a plain getter over the expansion state — no reactive node per
// file, and unexpanded subtrees cost nothing.
//
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { Files, type DirEntry } from '../system/Files';

export interface TreeRow {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
}

class $FileTree {
  root = '';
  // expansion state keyed by absolute path; cheap Set, not a node graph.
  private expanded = new Set<string>();
  // cache of directory listings so re-flatten does not re-stat the disk each render.
  private listings = new Map<string, DirEntry[]>();

  get version() {
    return ref(0);
  }
  // The currently highlighted row index in the flattened view.
  get selectedIndex() {
    return ref(0);
  }
  // shallowRef holding the last flattened rows (recomputed on structural change only).
  private get rowsRef() {
    return shallowRef<TreeRow[]>([]);
  }

  open(root: string): void {
    this.root = Files.Class.confineToRoot(root, '.') ?? root;
    this.expanded.clear();
    this.listings.clear();
    this.expanded.add(this.root);
    this.recompute();
    this.selectedIndex.value = 0;
  }

  private list(dir: string): DirEntry[] {
    let l = this.listings.get(dir);
    if (!l) {
      l = Files.Class.list(dir);
      this.listings.set(dir, l);
    }
    return l;
  }

  /** Flatten expanded directories into visible rows (depth-first, dirs first). */
  private flatten(): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const e of this.list(dir)) {
        const expanded = e.isDir && this.expanded.has(e.path);
        rows.push({ name: e.name, path: e.path, isDir: e.isDir, depth, expanded });
        if (expanded) walk(e.path, depth + 1);
      }
    };
    walk(this.root, 0);
    return rows;
  }

  private recompute(): void {
    this.rowsRef.value = this.flatten();
    this.version.value++;
  }

  get rows(): TreeRow[] {
    return this.rowsRef.value;
  }

  get selected(): TreeRow | null {
    return this.rows[this.selectedIndex.value] ?? null;
  }

  moveSelection(delta: number): void {
    const n = this.rows.length;
    if (n === 0) return;
    let i = this.selectedIndex.value + delta;
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    this.selectedIndex.value = i;
  }

  setSelection(i: number): void {
    const n = this.rows.length;
    if (n === 0) return;
    this.selectedIndex.value = Math.max(0, Math.min(i, n - 1));
  }

  toggleExpand(path: string): void {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      this.listings.delete(path); // refresh on expand
    }
    this.recompute();
  }

  /** Activate the selected row: expand/collapse a dir, or return a file path to open. */
  activateSelected(): { openFile: string } | { toggled: true } | null {
    const row = this.selected;
    if (!row) return null;
    if (row.isDir) {
      this.toggleExpand(row.path);
      return { toggled: true };
    }
    return { openFile: row.path };
  }

  /** Invalidate cached listings so an external change is picked up on next flatten. */
  refresh(): void {
    this.listings.clear();
    this.recompute();
  }
}

export namespace FileTree {
  export const $Class = $FileTree;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
