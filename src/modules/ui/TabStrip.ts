import { Reactive } from 'ivue';
import { ref } from 'vue';

export type TabStripOrientation = 'horizontal' | 'vertical';

export interface TabStripItem {
  identifier: string;
  label: string;
  /** Optional second display line (the workspace strip shows worktree/branch under the name). */
  detailLabel?: string;
  active: boolean;
  dirty?: boolean;
  closable?: boolean;
}

/**
 * Shared state for a viewport over an ordered tab layer. Rendering stays in RootView, while this
 * model owns the orientation and pan position used by both workspace tabs and editor-buffer tabs.
 */
class $TabStrip {
  constructor(
    initialOrientation: TabStripOrientation = 'horizontal',
    private readonly readItems: () => readonly TabStripItem[] = () => [],
  ) {
    this.orientation.value = initialOrientation;
  }

  get orientation() {
    return ref<TabStripOrientation>('horizontal');
  }

  get items(): readonly TabStripItem[] {
    return this.readItems();
  }

  get scrollOffset() {
    return ref(0);
  }

  get activeIndex(): number {
    return this.items.findIndex((item) => item.active);
  }

  setOrientation(orientation: TabStripOrientation): void {
    this.orientation.value = orientation;
  }

  /** Pan the strip viewport only. Active-item state is owned by the layer behind the strip. */
  // invariant: Tab strip panning never activates tabs (src/modules/workspace/workspace.invariants.md)
  pan(itemDelta: number): void {
    this.scrollOffset.value = Math.max(
      0,
      Math.min(this.scrollOffset.value + itemDelta, Math.max(0, this.items.length - 1)),
    );
  }

  clampScrollOffset(maximumScrollOffset: number): void {
    this.scrollOffset.value = Math.max(
      0,
      Math.min(this.scrollOffset.value, Math.max(0, maximumScrollOffset)),
    );
  }
}

export namespace TabStrip {
  export const $Class = $TabStrip;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
