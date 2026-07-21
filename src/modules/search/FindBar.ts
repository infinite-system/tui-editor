// The in-editor find/replace bar's VIEW STATE (Ctrl+F / Ctrl+H). It owns the open/mode/focused-field
// state and composes the pure FindInBuffer engine (search + replace over the active document). It never
// touches the editor's cursor/scroll — revealing a match is the caller's job (the one writer of the
// editor selection), so this stays a pure overlay model like the command palette.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import type { TextDocument } from '../editor/TextDocument';
import { FindInBuffer } from './FindInBuffer';

export type FindBarMode = 'find' | 'replace';

class $FindBar {
  get open() {
    return ref(false);
  }
  get mode() {
    return ref<FindBarMode>('find');
  }
  // In replace mode the input focus toggles (Tab) between the query and the replacement field.
  get replaceFocused() {
    return ref(false);
  }
  get engineRef() {
    return shallowRef<FindInBuffer.Instance | null>(null);
  }
  get engine(): FindInBuffer.Instance | null {
    return this.engineRef.value;
  }

  protected createEngine(document: TextDocument.Instance) {
    return new FindInBuffer.Class(document);
  }

  /** Open (or re-open) the bar over the ACTIVE document; a document swap makes a fresh engine so the
   *  matches are always the current buffer's. Seeds matches immediately so a count shows at once. */
  openFor(document: TextDocument.Instance, mode: FindBarMode): void {
    if (!this.engineRef.value || this.engineRef.value.document !== document) {
      this.engineRef.value = this.createEngine(document);
    }
    this.open.value = true;
    this.mode.value = mode;
    this.replaceFocused.value = false;
    this.engine?.findAll();
  }

  close(): void {
    this.open.value = false;
    this.replaceFocused.value = false;
  }

  /** True while typing should edit the REPLACEMENT field (replace mode + that field focused). */
  private get editingReplacement(): boolean {
    return this.mode.value === 'replace' && this.replaceFocused.value;
  }

  append(character: string): void {
    const engine = this.engine;
    if (!engine) return;
    if (this.editingReplacement) {
      engine.replacement.value += character;
    } else {
      engine.query.value += character;
      engine.findAll();
    }
  }

  backspace(): void {
    const engine = this.engine;
    if (!engine) return;
    if (this.editingReplacement) {
      engine.replacement.value = engine.replacement.value.slice(0, -1);
    } else {
      engine.query.value = engine.query.value.slice(0, -1);
      engine.findAll();
    }
  }

  /** Tab switches which field types (replace mode only). */
  switchField(): void {
    if (this.mode.value === 'replace') this.replaceFocused.value = !this.replaceFocused.value;
  }

  next(): void {
    this.engine?.next();
  }
  previous(): void {
    this.engine?.previous();
  }
  replaceCurrent(): void {
    if (!this.engine) return;
    this.engine.replaceCurrent();
    this.engine.findAll(); // the document changed — re-derive matches + counts
  }
  replaceAll(): void {
    if (!this.engine) return;
    this.engine.replaceAll();
    this.engine.findAll();
  }
}

export namespace FindBar {
  export const $Class = $FindBar;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
