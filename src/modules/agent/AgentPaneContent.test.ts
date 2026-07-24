import { describe, expect, test } from 'bun:test';
import { StyledText } from '@opentui/core';
import { AgentPaneContent, type AgentScrollPort } from './AgentPaneContent';
import { AgentSession } from './AgentSession';
import { MockAgentBackend } from './MockAgentBackend';
import { DARK } from '../theme/ThemePalettes';
import type { PaneRenderContext } from '../ui/PaneContent';

/** A fake scroll engine — records the scroll commands the pane issues, without any renderer. */
class FakePort implements AgentScrollPort {
  scrollTop = 0;
  stuckToBottom = true;
  readonly calls: string[] = [];
  scrollRowsBy(deltaRows: number): void { this.calls.push(`rows:${deltaRows}`); }
  scrollToBottom(): void { this.calls.push('bottom'); this.stuckToBottom = true; }
}

function makePane(): { pane: AgentPaneContent.Model; backend: MockAgentBackend.Model; port: FakePort } {
  const backend = new MockAgentBackend.Class();
  const session = new AgentSession.Class(backend);
  const pane = new AgentPaneContent.Class(session);
  const port = new FakePort();
  pane.attachScrollPort(port);
  return { pane, backend, port };
}

const context = (overrides: Partial<PaneRenderContext> = {}): PaneRenderContext => ({
  width: 60,
  height: 16,
  palette: DARK,
  glyphLevel: 'unicode',
  colorDepth: 'truecolor',
  focused: true,
  ...overrides,
});

function paintedText(styled: StyledText): string {
  const chunks = styled.chunks as unknown as { text: string }[];
  return chunks.map((chunk) => chunk.text).join('');
}
function chunkTexts(styled: StyledText): string[] {
  return (styled.chunks as unknown as { text: string }[]).map((chunk) => chunk.text);
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
    expect(collapsed).toContain('▸');
    expect(collapsed).toContain('{"command":"echo hi"}');
    expect(collapsed).not.toContain('  "command"');
    expect(pane.expandedCount).toBe(0);

    // The two tool rows sit at the bottom of the (top-padded) transcript body.
    const bodyHeight = pane.viewportRows;
    expect(pane.onPointerDown(0, bodyHeight - 2)).toBe(true); // the tool-use row
    expect(pane.expandedCount).toBe(1);

    const expanded = paintedText(pane.render(context()));
    expect(expanded).toContain('▾');
    expect(expanded).toContain('  "command"');
    expect(pane.onPointerDown(0, 0)).toBe(false); // a blank pad row toggles nothing
  });
});

describe('AgentPaneContent — scroll delegates to the injected engine', () => {
  test('PageUp/PageDown/arrows drive the port; Enter re-anchors to the bottom; stuck reads the port', () => {
    const { pane, backend, port } = makePane();
    for (let index = 0; index < 40; index += 1) backend.emit({ kind: 'text-delta', text: `line ${index}\n` });
    backend.emit({ kind: 'session-end', reason: 'completed' });
    pane.render(context()); // bodyHeight = 11 (12 − 1 composer)

    expect(pane.stuckToBottom).toBe(true); // reads port.stuckToBottom
    pane.handleKey({ name: 'pageup' } as never);
    pane.handleKey({ name: 'pagedown' } as never);
    pane.handleKey({ name: 'up' } as never); // composer empty → scroll
    pane.handleKey({ name: 'down' } as never);
    expect(port.calls).toEqual(['rows:-10', 'rows:10', 'rows:-1', 'rows:1']);

    port.stuckToBottom = false;
    pane.handleKey({ name: 'a', sequence: 'a' } as never); // type into composer
    pane.handleKey({ name: 'return' } as never); // send → re-anchor
    expect(port.calls).toContain('bottom');
  });

  test('arrow keys type-scroll only when the composer is empty', () => {
    const { pane, port } = makePane();
    pane.render(context());
    pane.handleKey({ name: 'a', sequence: 'a' } as never); // composer now non-empty
    pane.handleKey({ name: 'up' } as never);
    expect(port.calls).not.toContain('rows:-1'); // arrows no longer scroll while composing
  });
});

describe('AgentPaneContent — multi-line composer', () => {
  test('a long composer input WRAPS and GROWS the composer, shrinking the transcript body', () => {
    const { pane } = makePane();
    const emptyBodyRows = (() => { pane.render(context()); return pane.viewportRows; })();
    // Type well past one wrapped row at width 60 (inner 58 after the 2-col prompt gutter).
    for (const character of 'x'.repeat(180)) pane.handleKey({ name: character, sequence: character } as never);
    pane.render(context());
    expect(pane.viewportRows).toBeLessThan(emptyBodyRows); // composer grew, transcript body shrank
  });

  test('Alt+Backspace deletes the previous WORD via the shared TextEditing seam', () => {
    const { pane } = makePane();
    for (const character of 'hello world') pane.handleKey({ name: character, sequence: character } as never);
    pane.handleKey({ name: 'backspace', option: true } as never);
    pane.render(context());
    // The last word ("world") is gone; the earlier word remains.
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('hello');
    expect(painted).not.toContain('world');
  });
});

describe('AgentPaneContent — transcript selection + highlight', () => {
  test('a transcript selection highlights the span (a chunk equals the selected text) and copies it', async () => {
    const { pane, backend } = makePane();
    backend.script([
      { kind: 'text-delta', text: 'hello there' },
      { kind: 'session-end', reason: 'completed' },
    ]);
    pane.render(context());
    // Select "hello" on the assistant body line. The body line is at absolute projected-line index 1
    // ("Claude" label is line 0). Column 0..5.
    pane.beginTranscriptSelection({ line: 1, column: 0 });
    pane.extendTranscriptSelection({ line: 1, column: 5 });
    expect(pane.hasSelection()).toBe(true);

    const styled = pane.render(context());
    expect(chunkTexts(styled)).toContain('hello'); // the highlighted span became its own chunk
    expect(await pane.copySelection()).toBe(5); // copied "hello"
  });
});
