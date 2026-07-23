// The bottom panel SLOT: a generic host for a switchable set of PaneContents. It owns only WHICH
// content is active and whether the slot is visible/focused — never the contents' internals. This is
// the same switch idiom the sidebar uses for Files/Git, generalized so registering another
// PaneContent (Output, Problems, a plugin) needs zero host changes. For tier S the registered set is
// just { terminal }, but the host is content-agnostic by construction.
//
// The host holds NO renderable and NO OpenTUI dependency: RootView mounts the slot, pulls
// activeContent.render(region) each frame, routes focused keys through handleKey, and converges the
// region size through onResize — so the host stays a pure model, unit-testable with plain values.
//
// invariant: The panel renders exactly the active pane content cells each frame (src/modules/terminal/terminal.invariants.md)
// invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import type { KeyEvent } from '@opentui/core';
import type { PaneContent } from './PaneContent';

class $PanelHost {
  /** The registry, keyed by content id. Non-reactive — `order` drives what the switcher shows. */
  private readonly contents = new Map<string, PaneContent>();

  /** Whether the slot is shown at all (VS Code: the bottom panel is toggled). */
  get visible() {
    return ref(false);
  }

  /** Whether the slot owns the keyboard. */
  get focused() {
    return ref(false);
  }

  /** The active content's id, or null when nothing is registered. */
  get activeId() {
    return ref<string | null>(null);
  }

  /** Registered content ids in registration order — the switcher's tab order (reactive so a late
   *  registration repaints the switcher). */
  get order() {
    return shallowRef<string[]>([]);
  }

  /** Register a content. The first one registered becomes active. Idempotent per id. */
  register(content: PaneContent): void {
    if (this.contents.has(content.id)) return;
    this.contents.set(content.id, content);
    this.order.value = [...this.order.value, content.id];
    if (this.activeId.value === null) this.activeId.value = content.id;
  }

  /** The active content, or null. */
  get activeContent(): PaneContent | null {
    const id = this.activeId.value;
    return id === null ? null : this.contents.get(id) ?? null;
  }

  /** Switch the active content (no-op for an unknown id). */
  activate(id: string): void {
    if (!this.contents.has(id) || this.activeId.value === id) return;
    if (this.focused.value) this.activeContent?.onBlur();
    this.activeId.value = id;
    if (this.focused.value) this.activeContent?.onFocus();
  }

  /** Cycle the active content (for a future switcher key); wraps. */
  cycle(delta: number): void {
    const ids = this.order.value;
    if (ids.length < 2) return;
    const current = Math.max(0, ids.indexOf(this.activeId.value ?? ''));
    const next = (current + delta + ids.length) % ids.length;
    const nextId = ids[next];
    if (nextId) this.activate(nextId);
  }

  /** Show the slot AND focus it (VS Code: toggling the panel on focuses it). */
  show(): void {
    this.visible.value = true;
    this.focus();
  }

  /** Hide the slot AND release focus. */
  hide(): void {
    this.visible.value = false;
    this.blur();
  }

  /** Show+focus when hidden, hide+blur when visible. */
  toggle(): void {
    if (this.visible.value) this.hide();
    else this.show();
  }

  focus(): void {
    if (this.focused.value) return;
    this.focused.value = true;
    this.activeContent?.onFocus();
  }

  blur(): void {
    if (!this.focused.value) return;
    this.focused.value = false;
    this.activeContent?.onBlur();
  }

  /** Route a focused keystroke to the active content; true if consumed. */
  handleKey(key: KeyEvent): boolean {
    return this.activeContent?.handleKey(key) ?? false;
  }

  /** Converge the slot's region size onto the active content. */
  setViewportSize(columns: number, rows: number): void {
    this.activeContent?.onResize(columns, rows);
  }

  dispose(): void {
    for (const content of this.contents.values()) content.dispose();
    this.contents.clear();
    this.order.value = [];
    this.activeId.value = null;
  }
}

export namespace PanelHost {
  export const $Class = $PanelHost;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
