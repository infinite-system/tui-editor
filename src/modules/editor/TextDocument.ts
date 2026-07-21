// A loaded text document: ground truth is a compact line array (non-reactive at rest); a
// revision counter stamps every mutation so async consumers (syntax/LSP/git) can discard
// stale results. M2 is read-only; M3 adds editing on top of this same document.
//
// invariant: Cost tracks the actively observed set (project.invariants.md)
// invariant: Async results are revision-stamped and stale results discarded (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { Files } from '../system/Files';

class $TextDocument {
  path = '';
  // Compact ground truth — a plain string[], not a reactive-per-line structure.
  private _lines: string[] = [''];
  private _eol: '\n' | '\r\n' = '\n';

  // Reactive signals: revision (bumped on any change) and dirty flag.
  get revision() {
    return ref(0);
  }
  get dirty() {
    return ref(false);
  }
  get binary() {
    return ref(false);
  }

  loadFromFile(path: string): void {
    this.path = path;
    if (Files.Class.looksBinary(path)) {
      this._lines = ['(binary file not shown)'];
      this._eol = '\n';
      this.binary.value = true;
      this.dirty.value = false;
      this.revision.value++;
      return;
    }
    const text = Files.Class.read(path);
    this._eol = text.includes('\r\n') ? '\r\n' : '\n';
    this._lines = text.split(/\r?\n/);
    if (this._lines.length === 0) this._lines = [''];
    this.binary.value = false;
    this.dirty.value = false;
    this.revision.value++;
  }

  loadFromText(text: string, path = ''): void {
    this.path = path;
    this._eol = text.includes('\r\n') ? '\r\n' : '\n';
    this._lines = text.split(/\r?\n/);
    if (this._lines.length === 0) this._lines = [''];
    this.binary.value = false;
    this.dirty.value = false;
    this.revision.value++;
  }

  get lineCount(): number {
    return this._lines.length;
  }

  line(i: number): string {
    return this._lines[i] ?? '';
  }

  /** A window of lines [start, start+count) — the flyweight read the viewport uses. */
  slice(start: number, count: number): string[] {
    const s = Math.max(0, start);
    return this._lines.slice(s, s + count);
  }

  get lines(): readonly string[] {
    return this._lines;
  }

  get text(): string {
    return this._lines.join(this._eol);
  }

  get eol(): '\n' | '\r\n' {
    return this._eol;
  }

  // --- mutation surface (used from M3) ---
  replaceAll(lines: string[]): void {
    this._lines = lines.length ? lines : [''];
    this.dirty.value = true;
    this.revision.value++;
  }

  setLine(i: number, text: string): void {
    if (i < 0 || i >= this._lines.length) return;
    this._lines[i] = text;
    this.dirty.value = true;
    this.revision.value++;
  }

  insertLine(i: number, text: string): void {
    this._lines.splice(Math.max(0, Math.min(i, this._lines.length)), 0, text);
    this.dirty.value = true;
    this.revision.value++;
  }

  removeLine(i: number): void {
    if (this._lines.length <= 1) {
      this._lines = [''];
    } else if (i >= 0 && i < this._lines.length) {
      this._lines.splice(i, 1);
    }
    this.dirty.value = true;
    this.revision.value++;
  }

  markSaved(): void {
    this.dirty.value = false;
  }

  // --- character-level editing (used from M3) ---

  /** Insert `str` (no newlines) at line/col. Returns the new col. */
  insertInline(line: number, col: number, str: string): number {
    const cur = this.line(line);
    const c = Math.max(0, Math.min(col, cur.length));
    this._lines[line] = cur.slice(0, c) + str + cur.slice(c);
    this.dirty.value = true;
    this.revision.value++;
    return c + str.length;
  }

  /** Split a line at col into two lines (Enter). Returns new cursor {line, col}. */
  splitLine(line: number, col: number): { line: number; col: number } {
    const cur = this.line(line);
    const c = Math.max(0, Math.min(col, cur.length));
    const before = cur.slice(0, c);
    const after = cur.slice(c);
    this._lines[line] = before;
    this._lines.splice(line + 1, 0, after);
    this.dirty.value = true;
    this.revision.value++;
    return { line: line + 1, col: 0 };
  }

  /** Delete the character before line/col (Backspace). Returns new cursor. */
  deleteBackward(line: number, col: number): { line: number; col: number } {
    if (col > 0) {
      const cur = this.line(line);
      this._lines[line] = cur.slice(0, col - 1) + cur.slice(col);
      this.dirty.value = true;
      this.revision.value++;
      return { line, col: col - 1 };
    }
    if (line > 0) {
      const prev = this.line(line - 1);
      const cur = this.line(line);
      const newCol = prev.length;
      this._lines[line - 1] = prev + cur;
      this._lines.splice(line, 1);
      this.dirty.value = true;
      this.revision.value++;
      return { line: line - 1, col: newCol };
    }
    return { line, col };
  }

  /** Delete the character at line/col (Delete). Returns cursor unchanged. */
  deleteForward(line: number, col: number): { line: number; col: number } {
    const cur = this.line(line);
    if (col < cur.length) {
      this._lines[line] = cur.slice(0, col) + cur.slice(col + 1);
      this.dirty.value = true;
      this.revision.value++;
    } else if (line < this._lines.length - 1) {
      this._lines[line] = cur + this.line(line + 1);
      this._lines.splice(line + 1, 1);
      this.dirty.value = true;
      this.revision.value++;
    }
    return { line, col };
  }

  /** Snapshot the full line array (for undo). */
  snapshot(): string[] {
    return this._lines.slice();
  }

  /** Restore from a snapshot without marking dirty state itself (caller sets it). */
  restore(lines: string[]): void {
    this._lines = lines.length ? lines.slice() : [''];
    this.revision.value++;
  }
}

export namespace TextDocument {
  export const $Class = $TextDocument;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
