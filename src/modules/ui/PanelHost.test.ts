// The generic bottom panel slot: registration, switching, visibility/focus, and focused-key routing —
// all with plain fake PaneContents (the host is content-agnostic by construction).
import { test, expect } from 'bun:test';
import { PanelHost } from './PanelHost';
import type { PaneContent } from './PaneContent';
import { ref, type Ref } from 'vue';
import type { StyledText, KeyEvent } from '@opentui/core';

function fakeContent(id: string): PaneContent & { keys: KeyEvent[]; focused: boolean; resizes: Array<[number, number]> } {
  const revision: Ref<number> = ref(0);
  return {
    id,
    title: id,
    renderRevision: revision,
    keys: [],
    focused: false,
    resizes: [],
    render: () => ({}) as StyledText,
    handleKey(key: KeyEvent) { this.keys.push(key); return true; },
    onResize(columns: number, rows: number) { this.resizes.push([columns, rows]); },
    onFocus() { this.focused = true; },
    onBlur() { this.focused = false; },
    dispose() {},
  };
}

test('the first registered content becomes active', () => {
  const host = new PanelHost.Class();
  const terminal = fakeContent('terminal');
  host.register(terminal);
  expect(host.activeId.value).toBe('terminal');
  expect(host.activeContent).toBe(terminal);
  expect(host.order.value).toEqual(['terminal']);
});

test('toggle shows+focuses then hides+blurs', () => {
  const host = new PanelHost.Class();
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.toggle();
  expect(host.visible.value).toBe(true);
  expect(host.focused.value).toBe(true);
  expect(terminal.focused).toBe(true);
  host.toggle();
  expect(host.visible.value).toBe(false);
  expect(host.focused.value).toBe(false);
  expect(terminal.focused).toBe(false);
});

test('a focused panel routes keystrokes to the active content', () => {
  const host = new PanelHost.Class();
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.show();
  const event = { name: 'a' } as KeyEvent;
  expect(host.handleKey(event)).toBe(true);
  expect(terminal.keys).toContain(event);
});

test('switching is generic: a second content activates with zero host rewiring', () => {
  const host = new PanelHost.Class();
  const terminal = fakeContent('terminal');
  const output = fakeContent('output');
  host.register(terminal);
  host.register(output);
  expect(host.order.value).toEqual(['terminal', 'output']);
  host.activate('output');
  expect(host.activeContent).toBe(output);
  host.cycle(1);
  expect(host.activeId.value).toBe('terminal');
});

test('setViewportSize converges onto the active content', () => {
  const host = new PanelHost.Class();
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.setViewportSize(80, 24);
  expect(terminal.resizes.at(-1)).toEqual([80, 24]);
});
