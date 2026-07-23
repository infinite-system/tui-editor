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

// --- split capability -------------------------------------------------------------------------------

test('split puts two contents side by side with normalized shares; unsplit restores single', () => {
  const host = new PanelHost.Class();
  const agent = fakeContent('agent');
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.register(agent);
  expect(host.isSplit).toBe(false); // single pane by default

  host.split(['agent', 'terminal']);
  expect(host.isSplit).toBe(true);
  const cells = host.resolvedCells;
  expect(cells.map((cell) => cell.content.id)).toEqual(['agent', 'terminal']);
  expect(cells[0]!.ratio + cells[1]!.ratio).toBeCloseTo(1, 6);

  host.unsplit();
  expect(host.isSplit).toBe(false);
  expect(host.resolvedCells.map((cell) => cell.content.id)).toEqual(['terminal']);
});

test('a focused split routes keystrokes to the FOCUSED cell; focusCell moves the target', () => {
  const host = new PanelHost.Class();
  const agent = fakeContent('agent');
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.register(agent);
  host.show(); // visible + focused
  host.split(['agent', 'terminal']);

  const first = { name: 'a' } as KeyEvent;
  host.handleKey(first);
  expect(agent.keys).toContain(first); // cell 0 (agent) is focused
  expect(terminal.keys).not.toContain(first);

  host.focusCell(1);
  const second = { name: 'b' } as KeyEvent;
  host.handleKey(second);
  expect(terminal.keys).toContain(second); // routing followed the focus
  expect(agent.keys).not.toContain(second);
});

test('splitting while focused blurs the old focused content and focuses the new focused cell', () => {
  const host = new PanelHost.Class();
  const agent = fakeContent('agent');
  const terminal = fakeContent('terminal');
  host.register(terminal); // active + focus target in the degenerate case
  host.register(agent);
  host.show();
  expect(terminal.focused).toBe(true);

  host.split(['agent', 'terminal']); // cell 0 (agent) becomes the focused cell
  expect(agent.focused).toBe(true);
  expect(terminal.focused).toBe(false);
});

test('setViewportSize sizes each cell independently, reserving a column for the divider', () => {
  const host = new PanelHost.Class();
  const agent = fakeContent('agent');
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.register(agent);
  host.split(['agent', 'terminal'], [0.5, 0.5]);
  host.setViewportSize(81, 24); // 81 cols - 1 divider = 80 shared → 40 / 40

  const spans = host.cellSpans(81);
  expect(spans.map((span) => span.columns)).toEqual([40, 40]);
  expect(agent.resizes.at(-1)).toEqual([40, 24]);
  expect(terminal.resizes.at(-1)).toEqual([40, 24]);
});

test('moveDivider re-flows both adjacent cells and never collapses one below the minimum', () => {
  const host = new PanelHost.Class();
  const agent = fakeContent('agent');
  const terminal = fakeContent('terminal');
  host.register(terminal);
  host.register(agent);
  host.split(['agent', 'terminal'], [0.5, 0.5]);

  host.moveDivider(0, 0.7); // push the boundary right → left cell grows
  const cells = host.resolvedCells;
  expect(cells[0]!.ratio).toBeCloseTo(0.7, 6);
  expect(cells[1]!.ratio).toBeCloseTo(0.3, 6);

  host.moveDivider(0, 0.0); // try to collapse the left cell to nothing
  expect(host.resolvedCells[0]!.ratio).toBeGreaterThan(0); // clamped to the minimum, never zero
});
