// State-machine tests for the reusable modal context menu (the pure model half of the contract).
// invariant: A context menu is modal and single-consumer (src/modules/ui/ui.invariants.md)
import { test, expect, describe } from 'bun:test';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

const SCREEN = { width: 80, height: 24 };

const threeItems = (): ContextMenuItem[] => [
  { id: 'first', label: 'First', enabled: true },
  { id: 'second', label: 'Second (disabled)', enabled: false },
  { id: 'third', label: 'Third', enabled: true },
];

describe('ContextMenu', () => {
  test('openAt opens with the first ENABLED item selected and no hover', () => {
    const menu = new ContextMenu.Class();
    menu.openAt(threeItems(), 10, 5, SCREEN, () => {});
    expect(menu.open.value).toBe(true);
    expect(menu.selectedIndex.value).toBe(0);
    expect(menu.hoveredIndex.value).toBe(-1);
    expect(menu.anchorX.value).toBe(10);
    expect(menu.anchorY.value).toBe(5);
  });

  test('openAt with no items does not open', () => {
    const menu = new ContextMenu.Class();
    menu.openAt([], 10, 5, SCREEN, () => {});
    expect(menu.open.value).toBe(false);
  });

  test('geometry: width fits the widest label plus frame; height is items plus borders', () => {
    const menu = new ContextMenu.Class();
    menu.openAt(threeItems(), 0, 0, SCREEN, () => {});
    expect(menu.width).toBe('Second (disabled)'.length + 4);
    expect(menu.height).toBe(3 + 2);
  });

  test('openAt clamps the box fully onto the screen', () => {
    const menu = new ContextMenu.Class();
    menu.openAt(threeItems(), SCREEN.width - 2, SCREEN.height - 1, SCREEN, () => {});
    expect(menu.anchorX.value).toBe(SCREEN.width - menu.width);
    expect(menu.anchorY.value).toBe(SCREEN.height - menu.height);
    menu.close();
    menu.openAt(threeItems(), -5, -5, SCREEN, () => {});
    expect(menu.anchorX.value).toBe(0);
    expect(menu.anchorY.value).toBe(0);
  });

  test('moveSelection skips disabled items and stops at the ends (no wrap)', () => {
    const menu = new ContextMenu.Class();
    menu.openAt(threeItems(), 0, 0, SCREEN, () => {});
    menu.moveSelection(1);
    expect(menu.selectedIndex.value).toBe(2); // skipped the disabled item
    menu.moveSelection(1);
    expect(menu.selectedIndex.value).toBe(2); // no wrap
    menu.moveSelection(-1);
    expect(menu.selectedIndex.value).toBe(0);
    menu.moveSelection(-1);
    expect(menu.selectedIndex.value).toBe(0);
  });

  test('hover highlights only enabled items', () => {
    const menu = new ContextMenu.Class();
    menu.openAt(threeItems(), 0, 0, SCREEN, () => {});
    menu.hover(2);
    expect(menu.hoveredIndex.value).toBe(2);
    menu.hover(1); // disabled
    expect(menu.hoveredIndex.value).toBe(-1);
    menu.hover(99); // out of range
    expect(menu.hoveredIndex.value).toBe(-1);
  });

  test('runAt closes the menu BEFORE the handler runs, then runs it exactly once', () => {
    const menu = new ContextMenu.Class();
    const observed: Array<{ itemId: string; openDuringHandler: boolean }> = [];
    menu.openAt(threeItems(), 0, 0, SCREEN, (itemId) => {
      observed.push({ itemId, openDuringHandler: menu.open.value });
    });
    menu.runAt(2);
    expect(observed).toEqual([{ itemId: 'third', openDuringHandler: false }]);
    expect(menu.open.value).toBe(false);
  });

  test('runAt on a disabled or out-of-range item is a no-op (menu stays open)', () => {
    const menu = new ContextMenu.Class();
    let ran = 0;
    menu.openAt(threeItems(), 0, 0, SCREEN, () => {
      ran += 1;
    });
    menu.runAt(1); // disabled
    menu.runAt(-1);
    menu.runAt(99);
    expect(ran).toBe(0);
    expect(menu.open.value).toBe(true);
  });

  test('runSelected runs the keyboard selection', () => {
    const menu = new ContextMenu.Class();
    const ranIds: string[] = [];
    menu.openAt(threeItems(), 0, 0, SCREEN, (itemId) => ranIds.push(itemId));
    menu.moveSelection(1);
    menu.runSelected();
    expect(ranIds).toEqual(['third']);
  });

  test('close resets all state and drops the handler', () => {
    const menu = new ContextMenu.Class();
    let ran = 0;
    menu.openAt(threeItems(), 0, 0, SCREEN, () => {
      ran += 1;
    });
    menu.close();
    expect(menu.open.value).toBe(false);
    expect(menu.items.value.length).toBe(0);
    expect(menu.selectedIndex.value).toBe(-1);
    menu.runSelected(); // nothing to run after close
    expect(ran).toBe(0);
  });

  test('a menu of only disabled items opens with no selection and Enter is a no-op', () => {
    const menu = new ContextMenu.Class();
    let ran = 0;
    menu.openAt(
      [
        { id: 'first', label: 'First', enabled: false },
        { id: 'second', label: 'Second', enabled: false },
      ],
      0,
      0,
      SCREEN,
      () => {
        ran += 1;
      },
    );
    expect(menu.selectedIndex.value).toBe(-1);
    menu.moveSelection(1);
    expect(menu.selectedIndex.value).toBe(-1);
    menu.runSelected();
    expect(ran).toBe(0);
  });
});
