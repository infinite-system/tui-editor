// The in-editor find/replace bar's VIEW STATE (Ctrl+F / Ctrl+H). It owns the open/mode/focused-field
// state and composes the pure FindInBuffer engine (search + replace over the active document). It never
// touches the editor's cursor/scroll — revealing a match is the caller's job (the one writer of the
// editor selection), so this stays a pure overlay model like the command palette.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import type { TextDocument } from '../editor/TextDocument';
import { TextEditing } from '../editor/TextEditing';
import { FindInBuffer, type FindInBufferMatch } from './FindInBuffer';

export type FindBarMode = 'find' | 'replace';

/** One independently searchable text pane. The identifier preserves its query/matches while focus
 * moves to another pane; revealMatch is the pane's sole scroll/selection writer. */
export interface FindBarTarget {
  identifier: string;
  document: TextDocument.Instance;
  replaceAllowed: boolean;
  revealMatch(match: FindInBufferMatch): void;
}

class $FindBar {
  // invariant: Markdown panes keep independent find state (src/modules/markdown/markdown.invariants.md)
  // invariant: Diff panes keep independent find state (src/modules/diff/diff.invariants.md)
  private readonly enginesByTargetIdentifier = new Map<string, FindInBuffer.Instance>();
  private readonly documentIdentifiers = new WeakMap<object, string>();
  private nextDocumentIdentifier = 0;

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
  get targetRef() {
    return shallowRef<FindBarTarget | null>(null);
  }
  get engine(): FindInBuffer.Instance | null {
    return this.engineRef.value;
  }
  get target(): FindBarTarget | null {
    return this.targetRef.value;
  }

  protected createEngine(document: TextDocument.Instance) {
    return new FindInBuffer.Class(document);
  }

  /** Open (or re-open) the bar over the ACTIVE document; a document swap makes a fresh engine so the
   *  matches are always the current buffer's. Seeds matches immediately so a count shows at once. */
  openFor(document: TextDocument.Instance, mode: FindBarMode): void {
    let identifier = this.documentIdentifiers.get(document as object);
    if (!identifier) {
      identifier = `document-${++this.nextDocumentIdentifier}`;
      this.documentIdentifiers.set(document as object, identifier);
    }
    this.openForTarget({
      identifier,
      document,
      replaceAllowed: true,
      revealMatch: () => {},
    }, mode);
  }

  /** Bind the bar to one pane without discarding any other pane's query or matches. */
  openForTarget(target: FindBarTarget, mode: FindBarMode): void {
    let engine = this.enginesByTargetIdentifier.get(target.identifier);
    if (!engine || engine.document !== target.document) {
      engine = this.createEngine(target.document);
      this.enginesByTargetIdentifier.set(target.identifier, engine);
    }
    this.engineRef.value = engine;
    this.targetRef.value = target;
    this.open.value = true;
    this.mode.value = target.replaceAllowed ? mode : 'find';
    this.replaceFocused.value = false;
    this.engine?.findAll();
  }

  /** Read a pane's retained engine so its highlights remain visible while another pane is searched. */
  engineFor(targetIdentifier: string): FindInBuffer.Instance | null {
    return this.enginesByTargetIdentifier.get(targetIdentifier) ?? null;
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

  // invariant: Word deletion uses the navigation boundary (src/modules/editor/editor.invariants.md)
  deletePreviousWord(): void {
    const engine = this.engine;
    if (!engine) return;
    if (this.editingReplacement) {
      engine.replacement.value = TextEditing.Class.deletePreviousWord(engine.replacement.value).text;
    } else {
      engine.query.value = TextEditing.Class.deletePreviousWord(engine.query.value).text;
      engine.findAll();
    }
  }

  /** Tab switches which field types (replace mode only). */
  switchField(): void {
    if (this.mode.value === 'replace') this.replaceFocused.value = !this.replaceFocused.value;
  }

  /** True while the active engine matches case exactly — read by the renderer for the toggle state. */
  get caseSensitive(): boolean {
    return this.engine?.caseSensitive.value ?? false;
  }

  /** Flip case-sensitivity on the active engine and re-run the query so matches reflect it at once. */
  // invariant: Case sensitivity is a live toggle that re-runs the query (src/modules/search/search.invariants.md)
  toggleCaseSensitive(): void {
    const engine = this.engine;
    if (!engine) return;
    engine.caseSensitive.value = !engine.caseSensitive.value;
    engine.findAll();
  }

  /** Switch between find and replace modes (only where the bound pane allows replacement) — the mode
   *  toggle button. Leaving replace mode returns typing focus to the query field. */
  switchMode(): void {
    if (!this.target?.replaceAllowed) return;
    this.mode.value = this.mode.value === 'find' ? 'replace' : 'find';
    if (this.mode.value === 'find') this.replaceFocused.value = false;
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
