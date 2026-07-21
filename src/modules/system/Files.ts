import { Static } from 'ivue/extras';
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
  static list(directory: string): DirEntry[] {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return [];
    }
    const entries: DirEntry[] = names.map((name) => {
      const path = join(directory, name);
      return { name, path, isDir: this.isDir(path) };
    });
    entries.sort((first, second) => {
      if (first.isDir !== second.isDir) return first.isDir ? -1 : 1;
      return first.name.localeCompare(second.name);
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
    const absoluteRoot = resolve(root);
    const absolutePath = resolve(absoluteRoot, child);
    if (absolutePath === absoluteRoot) return absolutePath;
    if (absolutePath.startsWith(absoluteRoot + sep)) return absolutePath;
    return null;
  }

  /** Heuristic binary sniff: a NUL byte in the first 8 KB. */
  static looksBinary(path: string): boolean {
    try {
      const buffer = readFileSync(path);
      const scanLimit = Math.min(buffer.length, 8192);
      for (let index = 0; index < scanLimit; index++) {
        if (buffer[index] === 0) return true;
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
