// The set of open editor buffers behind the editor tab bar (item 10a). Opening a file ADDS or
// FOCUSES a buffer — it never replaces. This is the EDITOR-layer buffer set; project/workspace tabs
// are a separate layer (see "Workspace and file navigation are separate layers"). It owns the
// FLYWEIGHT + DISPOSE discipline that makes tabs memory-safe: only the active buffer (and any dirty
// background buffer, whose unsaved edits must survive) holds a live document; clean background
// buffers are dehydrated to a light handle (path + cursor/scroll) and rehydrated on activation.
//
// invariant: N open tabs do not cost N live documents (workspace.invariants.md)
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

/** The minimal live-buffer surface the set drives — an Editor in production, a fake in tests. */
export interface LiveBuffer {
  openFile(path: string): void;
  readonly dirty: boolean;
  /** Capture the resumable position so a clean buffer can be dehydrated and later rehydrated. */
  snapshotPosition(): BufferPosition;
  restorePosition(position: BufferPosition): void;
}

export interface BufferPosition {
  cursorLine: number;
  cursorColumn: number;
  scrollTop: number;
  scrollLeft: number;
}

export interface OpenBufferSetSeams {
  /** Create a live buffer with `path` already open (production: a fresh Editor.openFile). */
  createBuffer: (path: string) => LiveBuffer;
  /** Fully dispose a live buffer's owned resources (document/undo/syntax). */
  disposeBuffer: (buffer: LiveBuffer) => void;
}

interface BufferEntry {
  path: string;
  /** The live buffer, or null when this entry is dehydrated (clean + not active). */
  buffer: LiveBuffer | null;
  /** Last known position — the rehydration source; kept fresh while live. */
  position: BufferPosition;
  /** Sticky dirty flag: a dirty buffer is NEVER dehydrated (its edits must survive). */
  dirty: boolean;
}

const ORIGIN: BufferPosition = { cursorLine: 0, cursorColumn: 0, scrollTop: 0, scrollLeft: 0 };

class $OpenBufferSet {
  constructor(private readonly seams: OpenBufferSetSeams) {}

  // Ordered open buffers (identity replaced on structural change so observers re-run).
  get entries() {
    return shallowRef<BufferEntry[]>([]);
  }
  get activeIndex() {
    return ref(-1);
  }

  get count(): number {
    return this.entries.value.length;
  }
  get active(): BufferEntry | null {
    return this.entries.value[this.activeIndex.value] ?? null;
  }
  /** The active buffer's LIVE handle (always live — the active entry is never dehydrated). */
  get activeBuffer(): LiveBuffer | null {
    return this.active?.buffer ?? null;
  }
  /** Number of entries currently holding a live document (active + any dirty background). */
  get liveCount(): number {
    return this.entries.value.filter((entry) => entry.buffer !== null).length;
  }

  /** Tab-bar view rows: path, active flag, dirty flag — never exposes the live document. */
  tabs(): Array<{ path: string; active: boolean; dirty: boolean }> {
    const activeIndex = this.activeIndex.value;
    return this.entries.value.map((entry, index) => ({
      path: entry.path,
      active: index === activeIndex,
      dirty: index === activeIndex ? (entry.buffer?.dirty ?? entry.dirty) : entry.dirty,
    }));
  }

  /** Open `path`: focus its tab if already open, else add a new (active) buffer. Returns the index. */
  open(path: string): number {
    const existing = this.entries.value.findIndex((entry) => entry.path === path);
    if (existing >= 0) {
      this.activate(existing);
      return existing;
    }
    const entry: BufferEntry = { path, buffer: null, position: { ...ORIGIN }, dirty: false };
    this.entries.value = [...this.entries.value, entry];
    this.activate(this.entries.value.length - 1);
    return this.activeIndex.value;
  }

  /** Make `index` active: dehydrate the outgoing active (if clean), hydrate the incoming. */
  activate(index: number): void {
    if (index < 0 || index >= this.entries.value.length || index === this.activeIndex.value) {
      if (index === this.activeIndex.value) this.hydrate(index); // ensure current is live
      return;
    }
    this.dehydrateIfClean(this.activeIndex.value);
    this.activeIndex.value = index;
    this.hydrate(index);
  }

  /** Cycle by `delta` tabs, wrapping (Ctrl+Tab / Ctrl+PageUp-Down). */
  cycle(delta: number): void {
    const total = this.entries.value.length;
    if (total === 0) return;
    this.activate(((this.activeIndex.value + delta) % total + total) % total);
  }

  /** Close `index`: fully dispose its live document and drop the entry; activate a neighbour. */
  close(index: number): void {
    const entry = this.entries.value[index];
    if (!entry) return;
    if (entry.buffer) this.seams.disposeBuffer(entry.buffer);
    const next = this.entries.value.filter((_, entryIndex) => entryIndex !== index);
    this.entries.value = next;
    if (next.length === 0) {
      this.activeIndex.value = -1;
      return;
    }
    // Keep a stable neighbour active: same slot if it still exists, else the previous one.
    const nextActive = Math.min(this.activeIndex.value > index ? this.activeIndex.value - 1 : this.activeIndex.value, next.length - 1);
    this.activeIndex.value = -1; // force hydrate to run
    this.activate(nextActive);
  }

  /** Mark the active buffer's dirty state (called on edit) so it is never dehydrated while dirty. */
  syncActiveDirty(): void {
    const entry = this.active;
    if (entry?.buffer) entry.dirty = entry.buffer.dirty;
  }

  /** Dispose every live buffer (workspace close / dispose). */
  disposeAll(): void {
    for (const entry of this.entries.value) if (entry.buffer) this.seams.disposeBuffer(entry.buffer);
    this.entries.value = [];
    this.activeIndex.value = -1;
  }

  private hydrate(index: number): void {
    const entry = this.entries.value[index];
    if (!entry || entry.buffer) return;
    const buffer = this.seams.createBuffer(entry.path);
    buffer.restorePosition(entry.position);
    entry.buffer = buffer;
    this.entries.value = [...this.entries.value]; // notify
  }

  private dehydrateIfClean(index: number): void {
    const entry = this.entries.value[index];
    if (!entry || !entry.buffer) return;
    entry.position = entry.buffer.snapshotPosition();
    entry.dirty = entry.buffer.dirty;
    if (entry.dirty) return; // a dirty buffer stays LIVE — its unsaved edits must survive
    this.seams.disposeBuffer(entry.buffer);
    entry.buffer = null;
    this.entries.value = [...this.entries.value]; // notify
  }
}

export namespace OpenBufferSet {
  export const $Class = $OpenBufferSet;
  export let Class = Reactive($OpenBufferSet);
  export type Instance = typeof Class.Instance;
}
