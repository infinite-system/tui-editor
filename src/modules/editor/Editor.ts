// The editor: owns a document, a cursor, and a viewport, and coordinates movement + scroll.
// Read-only navigation in M2; editing added in M3 (same document, mutation surface exists).
//
// invariant: Data flows one way (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { TextDocument } from './TextDocument';
import { Viewport } from './Viewport';
import { Cursor } from './Cursor';
import { UndoStore, type EditKind } from '../storage/UndoStore';
import { Files } from '../system/Files';
import { Clock } from '../system/Clock';

class $Editor {
  // invariant: Construction goes through overridable seams (project.invariants.md)
  document = this.createDocument();
  viewport = this.createViewport();
  cursor = this.createCursor();
  private undo = this.createUndo();

  protected createDocument() { return new TextDocument.Class(); }
  protected createViewport() { return new Viewport.Class(); }
  protected createCursor() { return new Cursor.Class(); }
  protected createUndo() { return new UndoStore.Class(); }

  get hasDocument() {
    return ref(false);
  }
  get readOnly() {
    return ref(false);
  }

  openFile(path: string): void {
    this.document.loadFromFile(path);
    this.cursor.set(0, 0);
    this.viewport.scrollTop.value = 0;
    this.hasDocument.value = true;
    this.readOnly.value = this.document.binary.value;
    this.undo.clear();
  }

  // --- editing --------------------------------------------------------------

  private captureBefore(kind: EditKind): void {
    this.undo.record(
      {
        lines: this.document.snapshot(),
        cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
        kind,
        at: Clock.Class.now(),
      },
      Clock.Class.now(),
    );
  }

  insertText(str: string): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('insert');
    const col = this.document.insertInline(this.cursor.line.value, this.cursor.col.value, str);
    this.cursor.set(this.cursor.line.value, col);
  }

  insertNewline(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('newline');
    // Auto-indent: copy leading whitespace of the current line.
    const cur = this.document.line(this.cursor.line.value);
    const indent = cur.match(/^\s*/)?.[0] ?? '';
    const pos = this.document.splitLine(this.cursor.line.value, this.cursor.col.value);
    if (indent) {
      const col = this.document.insertInline(pos.line, 0, indent);
      this.cursor.set(pos.line, col);
    } else {
      this.cursor.set(pos.line, pos.col);
    }
    this.viewport.scrollToLine(this.cursor.line.value, this.document.lineCount);
  }

  backspace(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    const pos = this.document.deleteBackward(this.cursor.line.value, this.cursor.col.value);
    this.cursor.set(pos.line, pos.col);
    this.viewport.scrollToLine(pos.line, this.document.lineCount);
  }

  deleteChar(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    this.document.deleteForward(this.cursor.line.value, this.cursor.col.value);
  }

  performUndo(): void {
    const current = {
      lines: this.document.snapshot(),
      cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
      kind: 'other' as EditKind,
      at: Clock.Class.now(),
    };
    const target = this.undo.undo(current);
    if (!target) return;
    this.document.restore(target.lines);
    this.document.dirty.value = true;
    this.cursor.set(target.cursor.line, target.cursor.col);
    this.viewport.scrollToLine(target.cursor.line, this.document.lineCount);
  }

  performRedo(): void {
    const current = {
      lines: this.document.snapshot(),
      cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
      kind: 'other' as EditKind,
      at: Clock.Class.now(),
    };
    const target = this.undo.redo(current);
    if (!target) return;
    this.document.restore(target.lines);
    this.document.dirty.value = true;
    this.cursor.set(target.cursor.line, target.cursor.col);
    this.viewport.scrollToLine(target.cursor.line, this.document.lineCount);
  }

  save(): boolean {
    if (!this.hasDocument.value || !this.document.path) return false;
    Files.Class.write(this.document.path, this.document.text);
    this.document.markSaved();
    return true;
  }

  get title(): string {
    if (!this.hasDocument.value) return 'Editor';
    const name = this.document.path ? Files.Class.basename(this.document.path) : 'untitled';
    return this.document.dirty.value ? `${name} ●` : name;
  }

  private curLineLen(): number {
    return this.document.line(this.cursor.line.value).length;
  }

  moveVertical(delta: number): void {
    const target = this.cursor.line.value + delta;
    const max = this.document.lineCount - 1;
    const clamped = Math.max(0, Math.min(target, max));
    this.cursor.setLinePreserveGoal(clamped, this.document.line(clamped).length);
    this.viewport.scrollToLine(clamped, this.document.lineCount);
  }

  moveHorizontal(delta: number): void {
    let line = this.cursor.line.value;
    let col = this.cursor.col.value + delta;
    if (col < 0) {
      if (line > 0) {
        line -= 1;
        col = this.document.line(line).length;
      } else {
        col = 0;
      }
    } else if (col > this.curLineLen()) {
      if (line < this.document.lineCount - 1) {
        line += 1;
        col = 0;
      } else {
        col = this.curLineLen();
      }
    }
    this.cursor.set(line, col);
    this.viewport.scrollToLine(line, this.document.lineCount);
  }

  moveToLineStart(): void {
    this.cursor.set(this.cursor.line.value, 0);
  }
  moveToLineEnd(): void {
    this.cursor.set(this.cursor.line.value, this.curLineLen());
  }
  pageDown(): void {
    this.moveVertical(this.viewport.height.value - 1);
  }
  pageUp(): void {
    this.moveVertical(-(this.viewport.height.value - 1));
  }
  gotoTop(): void {
    this.cursor.set(0, 0);
    this.viewport.scrollToLine(0, this.document.lineCount);
  }
  gotoBottom(): void {
    const last = this.document.lineCount - 1;
    this.cursor.set(last, 0);
    this.viewport.scrollToLine(last, this.document.lineCount);
  }
}

export namespace Editor {
  export const $Class = $Editor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
