import { describe, expect, test } from 'bun:test';
import { TabStrip, type TabStripItem } from './TabStrip';

describe('TabStrip', () => {
  test('one capability supports horizontal and vertical orientation', () => {
    const items: TabStripItem[] = [
      { identifier: 'first', label: 'First', active: true },
      { identifier: 'second', label: 'Second', active: false },
    ];
    const tabStrip = new TabStrip.Class('horizontal', () => items);

    expect(tabStrip.orientation.value).toBe('horizontal');
    tabStrip.setOrientation('vertical');
    expect(tabStrip.orientation.value).toBe('vertical');
    expect(tabStrip.items.map((item) => item.identifier)).toEqual(['first', 'second']);
  });

  test('panning changes only the viewport offset and never activates a tab', () => {
    const items: TabStripItem[] = [
      { identifier: 'first', label: 'First', active: true },
      { identifier: 'second', label: 'Second', active: false },
      { identifier: 'third', label: 'Third', active: false },
    ];
    const tabStrip = new TabStrip.Class('horizontal', () => items);

    tabStrip.pan(2);
    expect(tabStrip.scrollOffset.value).toBe(2);
    expect(tabStrip.activeIndex).toBe(0);
    expect(items.map((item) => item.active)).toEqual([true, false, false]);
  });
});
