import { describe, expect, test } from 'bun:test';
import { StyledText } from '@opentui/core';
import { AgentPaneContent } from './AgentPaneContent';
import { AgentSession } from './AgentSession';
import { MockAgentBackend } from './MockAgentBackend';
import { DARK } from '../theme/ThemePalettes';
import type { PaneRenderContext } from '../ui/PaneContent';

function makePane(): { pane: AgentPaneContent.Model; backend: MockAgentBackend.Model } {
  const backend = new MockAgentBackend.Class();
  const session = new AgentSession.Class(backend);
  return { pane: new AgentPaneContent.Class(session), backend };
}

const context = (overrides: Partial<PaneRenderContext> = {}): PaneRenderContext => ({
  width: 60,
  height: 12,
  palette: DARK,
  glyphLevel: 'unicode',
  focused: true,
  ...overrides,
});

/** The full painted text of a render (all chunk texts joined) — for asserting what's on screen. */
function paintedText(styled: StyledText): string {
  const chunks = styled.chunks as unknown as { text: string }[];
  return chunks.map((chunk) => chunk.text).join('');
}

describe('AgentPaneContent — collapsible tool rows', () => {
  test('a tool call renders COLLAPSED by default and EXPANDS on a click of its row', () => {
    const { pane, backend } = makePane();
    backend.script([
      { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
      { kind: 'tool-result', id: 't1', result: 'hi\nsecond line', isError: false },
      { kind: 'session-end', reason: 'completed' },
    ]);

    const collapsed = paintedText(pane.render(context()));
    expect(collapsed).toContain('▸'); // collapsed caret
    expect(collapsed).toContain('{"command":"echo hi"}'); // compact one-line summary
    expect(collapsed).not.toContain('  "command"'); // NOT the pretty (indented) multi-line form
    expect(pane.expandedCount).toBe(0);

    // Click the tool-use summary row. A short transcript pads blanks at the top, so the two real rows
    // (tool-use, tool-result) are the last two of the bodyHeight rows (height-1, composer excluded).
    const bodyHeight = context().height - 1;
    const consumed = pane.onPointerDown(0, bodyHeight - 2); // the tool-use row
    expect(consumed).toBe(true);
    expect(pane.expandedCount).toBe(1);

    const expanded = paintedText(pane.render(context()));
    expect(expanded).toContain('▾'); // expanded caret
    expect(expanded).toContain('  "command"'); // pretty (indented) JSON now visible

    // Clicking a non-toggle row (a blank pad line at the top) is ignored.
    expect(pane.onPointerDown(0, 0)).toBe(false);
  });
});

describe('AgentPaneContent — scroll + tail-anchor', () => {
  test('overflowing content stays tail-anchored; wheel-up unsticks; scrolling to bottom re-sticks', () => {
    const { pane, backend } = makePane();
    // Many assistant lines so the projection overflows the 12-row pane.
    for (let index = 0; index < 40; index += 1) backend.emit({ kind: 'text-delta', text: `line ${index}\n` });
    backend.emit({ kind: 'session-end', reason: 'completed' });

    pane.render(context()); // populates last geometry
    expect(pane.stuckToBottom).toBe(true);

    expect(pane.onWheel(-5)).toBe(true); // wheel up
    expect(pane.stuckToBottom).toBe(false); // held position, no longer sticking

    pane.render(context());
    pane.onWheel(1000); // scroll all the way back to the bottom
    expect(pane.stuckToBottom).toBe(true); // reaching the bottom re-arms auto-stick
  });

  test('sending a prompt re-anchors to the newest output', () => {
    const { pane, backend } = makePane();
    for (let index = 0; index < 40; index += 1) backend.emit({ kind: 'text-delta', text: `line ${index}\n` });
    backend.emit({ kind: 'session-end', reason: 'completed' });
    pane.render(context());
    pane.onWheel(-5);
    expect(pane.stuckToBottom).toBe(false);

    pane.handleKey({ name: 'return' } as never);
    expect(pane.stuckToBottom).toBe(true);
  });
});
