// A reusable, MODAL context menu — pure reactive state: whether it is open, where it is anchored,
// which items it offers, and which item is hovered/selected. The VIEW (RootView) projects this
// into an absolute overlay box above a full-screen backdrop, so while the menu is open a pointer
// event lands either ON the menu or on the backdrop — never on the panes beneath (the menu is the
// single consumer of input while open). Running an item CLOSES the menu first, then invokes the
// opener-supplied handler: an action can never observe (or race with) an open menu.
//
// invariant: A context menu is modal and single-consumer (src/modules/ui/ui.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

export interface ContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

/** Horizontal padding inside the box (one cell each side) plus the two border cells. */
const MENU_HORIZONTAL_FRAME = 4;
/** Top and bottom border rows. */
const MENU_VERTICAL_FRAME = 2;

class $ContextMenu {
  get open() {
    return ref(false);
  }
  get items() {
    return shallowRef<readonly ContextMenuItem[]>([]);
  }
  /** Top-left cell of the rendered box (already screen-clamped by openAt). */
  get anchorX() {
    return ref(0);
  }
  get anchorY() {
    return ref(0);
  }
  /** Pointer-hover highlight; -1 when the pointer is on no enabled item. */
  get hoveredIndex() {
    return ref(-1);
  }
  /** Keyboard selection; -1 when no item is enabled. */
  get selectedIndex() {
    return ref(-1);
  }

  /** The opener-supplied handler; receives the chosen item id AFTER the menu has closed. */
  private runHandler: ((itemId: string) => void) | null = null;

  /** Rendered box width in cells: the widest label plus padding and borders. */
  get width(): number {
    let widestLabel = 0;
    for (const item of this.items.value) widestLabel = Math.max(widestLabel, item.label.length);
    return widestLabel + MENU_HORIZONTAL_FRAME;
  }

  /** Rendered box height in cells: one row per item plus the borders. */
  get height(): number {
    return this.items.value.length + MENU_VERTICAL_FRAME;
  }

  /**
   * Open the menu with its top-left at the pointer, clamped so the WHOLE box stays on screen.
   * `onRun` is called with the chosen item's id after the menu closes. No items → no menu.
   */
  openAt(
    items: readonly ContextMenuItem[],
    pointerX: number,
    pointerY: number,
    screen: { width: number; height: number },
    onRun: (itemId: string) => void,
  ): void {
    if (items.length === 0) return;
    this.items.value = items;
    this.runHandler = onRun;
    this.anchorX.value = Math.max(0, Math.min(pointerX, screen.width - this.width));
    this.anchorY.value = Math.max(0, Math.min(pointerY, screen.height - this.height));
    this.hoveredIndex.value = -1;
    this.selectedIndex.value = items.findIndex((item) => item.enabled);
    this.open.value = true;
  }

  close(): void {
    this.open.value = false;
    this.items.value = [];
    this.hoveredIndex.value = -1;
    this.selectedIndex.value = -1;
    this.runHandler = null;
  }

  /** Move the keyboard selection to the next/previous ENABLED item (disabled items are skipped;
   *  no wrap — the selection stops at the ends). */
  moveSelection(direction: 1 | -1): void {
    const items = this.items.value;
    for (
      let index = this.selectedIndex.value + direction;
      index >= 0 && index < items.length;
      index += direction
    ) {
      if (items[index]?.enabled) {
        this.selectedIndex.value = index;
        return;
      }
    }
  }

  /** Pointer hover: highlight an enabled item under the pointer, or nothing. */
  hover(index: number): void {
    this.hoveredIndex.value = this.items.value[index]?.enabled ? index : -1;
  }

  /** Run the item at `index` (a click on its row): close FIRST, then invoke the handler —
   *  the action never executes while the menu is open. Disabled/out-of-range rows no-op. */
  runAt(index: number): void {
    const item = this.items.value[index];
    if (!item?.enabled) return;
    const handler = this.runHandler;
    this.close();
    handler?.(item.id);
  }

  /** Run the keyboard-selected item (Enter). */
  runSelected(): void {
    this.runAt(this.selectedIndex.value);
  }
}

export namespace ContextMenu {
  export const $Class = $ContextMenu;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
