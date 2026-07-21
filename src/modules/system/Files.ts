import { Static } from './Static';
// Filesystem capability. Static, allocation-free. All path access is confined here so the
// path-traversal boundary (L9) has one home.
//
// invariant: Imported dependencies are read late (project.invariants.md)
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve, relative, basename, extname, dirname, sep } from 'node:path';

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

class $Files {
  static exists(path: string): boolean {
    return existsSync(path);
  }

  static isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  static basename(path: string): string {
    return basename(path);
  }

  static extname(path: string): string {
    return extname(path);
  }

  static dirname(path: string): string {
    return dirname(path);
  }

  static join(...parts: string[]): string {
    return join(...parts);
  }

  static relative(from: string, to: string): string {
    return relative(from, to);
  }

  /** List a directory, directories first then files, both alphabetical. */
  static list(dir: string): DirEntry[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const entries: DirEntry[] = names.map((name) => {
      const path = join(dir, name);
      return { name, path, isDir: this.isDir(path) };
    });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  static read(path: string): string {
    return readFileSync(path, 'utf8');
  }

  static readBytes(path: string): Buffer {
    return readFileSync(path);
  }

  static write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  /**
   * Resolve `child` and confirm it stays inside `root` — the path-traversal guard.
   * Returns the resolved absolute path or null if it escapes root.
   * invariant: file operations stay within the workspace root (path traversal) — see L9.
   */
  static confineToRoot(root: string, child: string): string | null {
    const absRoot = resolve(root);
    const abs = resolve(absRoot, child);
    if (abs === absRoot) return abs;
    if (abs.startsWith(absRoot + sep)) return abs;
    return null;
  }

  /** Heuristic binary sniff: a NUL byte in the first 8 KB. */
  static looksBinary(path: string): boolean {
    try {
      const buf = readFileSync(path);
      const n = Math.min(buf.length, 8192);
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

export namespace Files {
  export const $Class = $Files;
  export let Class = Static($Files);
}
