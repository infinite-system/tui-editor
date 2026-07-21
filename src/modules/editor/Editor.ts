// The editor: owns a document, a cursor, and a viewport, and coordinates movement + scroll.
// Read-only navigation in M2; editing added in M3 (same document, mutation surface exists).
//
// invariant: Data flows one way (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { TextDocument } from './TextDocument';
import { Viewport } from './Viewport';
import { Cursor } from './Cursor';
import { Files } from '../system/Files';

class $Editor {
  document = new TextDocument.Class();
  viewport = new Viewport.Class();
  cursor = new Cursor.Class();

  get hasDocument() {
    return ref(false);
  }

  openFile(path: string): void {
    this.document.loadFromFile(path);
    this.cursor.set(0, 0);
    this.viewport.scrollTop.value = 0;
    this.hasDocument.value = true;
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
