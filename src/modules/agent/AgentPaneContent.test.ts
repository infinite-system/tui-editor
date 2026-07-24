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
    expect(collapsed).toContain('$ echo hi'); // human summary, not raw JSON
    expect(collapsed).not.toContain('{"command"'); // the raw JSON blob is NOT shown collapsed
    expect(collapsed).not.toContain('  "command"'); // nor the pretty (indented) form
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
    pane.render(context());
    const page = pane.viewportRows - 1; // PageUp/Down move one body height minus one row

    expect(pane.stuckToBottom).toBe(true); // reads port.stuckToBottom
    pane.handleKey({ name: 'pageup' } as never);
    pane.handleKey({ name: 'pagedown' } as never);
    pane.handleKey({ name: 'up' } as never); // composer empty → scroll
    pane.handleKey({ name: 'down' } as never);
    expect(port.calls).toEqual([`rows:${-page}`, `rows:${page}`, 'rows:-1', 'rows:1']);

    port.stuckToBottom = false;
    pane.handleKey({ name: 'a', sequence: 'a' } as never); // type into composer
    pane.handleKey({ name: 'return' } as never); // send → re-anchor
    expect(port.calls).toContain('bottom');
  });

  test('Up on a SINGLE-line composer falls through to transcript scroll (cursor on the only line)', () => {
    const { pane, port } = makePane();
    pane.render(context());
    pane.handleKey({ name: 'a', sequence: 'a' } as never); // one visual line of text
    pane.handleKey({ name: 'up' } as never);
    expect(port.calls).toContain('rows:-1'); // first visual line → scroll the transcript
  });

  test('Up MOVES the composer cursor (no scroll) when it is multi-line and not on the first line', () => {
    const { pane, port } = makePane();
    for (const character of 'x'.repeat(200)) pane.handleKey({ name: character, sequence: character } as never);
    pane.render(context()); // cursor at the end → last of several wrapped visual lines
    const scrollCallsBefore = port.calls.length;
    pane.handleKey({ name: 'up' } as never); // moves the cursor up a visual line
    expect(port.calls.length).toBe(scrollCallsBefore); // no transcript scroll
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

describe('AgentPaneContent — permission prompt keyboard routing', () => {
  const pending = () => {
    const { pane, backend } = makePane();
    const decisions: string[] = [];
    backend.emit({ kind: 'session-start' });
    backend.emit({ kind: 'permission-request', id: 'p1', toolName: 'Bash', input: { command: 'echo x' }, respond: (d) => decisions.push(d) });
    return { pane, backend, decisions };
  };

  test('y allows, and the prompt renders while pending', () => {
    const { pane, decisions } = pending();
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('? Claude wants to run');
    expect(painted).toContain('[y] allow');
    pane.handleKey({ name: 'y', sequence: 'y' } as never);
    expect(decisions).toEqual(['allow']);
  });

  test('n denies; Escape denies too', () => {
    const first = pending();
    first.pane.handleKey({ name: 'n', sequence: 'n' } as never);
    expect(first.decisions).toEqual(['deny']);
    const second = pending();
    second.pane.handleKey({ name: 'escape' } as never);
    expect(second.decisions).toEqual(['deny']);
  });

  test('a answers always-allow', () => {
    const { pane, decisions } = pending();
    pane.handleKey({ name: 'a', sequence: 'a' } as never);
    expect(decisions).toEqual(['always-allow']);
  });

  test('while pending, other typing is SWALLOWED (composer suspended, no accidental answers)', () => {
    const { pane, decisions } = pending();
    pane.handleKey({ name: 'z', sequence: 'z' } as never);
    pane.handleKey({ name: 'return' } as never);
    expect(decisions).toEqual([]); // nothing resolved
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('? Claude wants to run'); // still pending
    expect(painted).not.toContain('❯ z'); // the z never reached the composer
    // After resolving, the composer works again.
    pane.handleKey({ name: 'y', sequence: 'y' } as never);
    pane.handleKey({ name: 'z', sequence: 'z' } as never);
    expect(paintedText(pane.render(context()))).toContain('z');
  });

  test('PageUp still scrolls the transcript while a prompt is pending', () => {
    const { pane, backend, port } = makePane();
    backend.emit({ kind: 'session-start' });
    backend.emit({ kind: 'permission-request', id: 'p1', toolName: 'Bash', input: {}, respond: () => {} });
    pane.render(context());
    pane.handleKey({ name: 'pageup' } as never);
    expect(port.calls.some((call) => call.startsWith('rows:-'))).toBe(true); // review keys stay live
  });
});

/** A fake engine port recording cycle() calls. */
class FakeEnginePort {
  provider = 'claude';
  canCycle = true;
  cycles = 0;
  cycle(): boolean { this.cycles += 1; this.provider = this.provider === 'claude' ? 'codex' : 'claude'; return true; }
}

describe('AgentPaneContent — engine switcher', () => {
  test('the mode line shows the current engine + a cycle affordance; currentEngine reflects it', () => {
    const { pane } = makePane();
    const enginePort = new FakeEnginePort();
    pane.attachEnginePort(enginePort);
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('engine: claude');
    expect(painted).toContain('⇄'); // cyclable affordance
    expect(pane.currentEngine).toBe('claude');
  });

  test('Ctrl+E cycles the engine', () => {
    const { pane } = makePane();
    const enginePort = new FakeEnginePort();
    pane.attachEnginePort(enginePort);
    pane.render(context());
    pane.handleKey({ name: 'e', ctrl: true } as never);
    expect(enginePort.cycles).toBe(1);
    expect(pane.currentEngine).toBe('codex');
  });

  test('a click on the engine segment (mode-line row) cycles; a click off it does not', () => {
    const { pane } = makePane();
    const enginePort = new FakeEnginePort();
    pane.attachEnginePort(enginePort);
    pane.render(context());
    // The mode line is the second-to-last row; the engine segment starts at the left gutter (col 2).
    const modeRow = context().height - 2;
    expect(pane.onPointerDown(3, modeRow)).toBe(true); // on "engine: claude ⇄"
    expect(enginePort.cycles).toBe(1);
    // A click far to the right on the same row (the hint text) does not cycle.
    pane.render(context());
    const before = enginePort.cycles;
    pane.onPointerDown(context().width - 3, modeRow);
    expect(enginePort.cycles).toBe(before);
  });

  test('a non-cyclable port (one engine) shows a passive label, no affordance, and clicks/keys no-op', () => {
    const { pane } = makePane();
    const enginePort = new FakeEnginePort();
    enginePort.canCycle = false;
    pane.attachEnginePort(enginePort);
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('engine: claude');
    expect(painted).not.toContain('⇄');
    pane.handleKey({ name: 'e', ctrl: true } as never); // cycleEngine → port.cycle still called but…
    // The pane calls cycle(); the port itself decides. Here canCycle=false but our fake still flips —
    // the REAL guard (availability) lives in Bootstrap's port. The pane's hit-test, however, refuses the
    // click when canCycle is false:
    const before = enginePort.cycles;
    pane.onPointerDown(3, context().height - 2);
    expect(enginePort.cycles).toBe(before); // click ignored when not cyclable
  });
});

describe('AgentPaneContent — system (engine switch) note renders', () => {
  test('a system entry renders as a dim centered aside', () => {
    const { pane, backend } = makePane();
    backend.emit({ kind: 'text-delta', text: 'hello' });
    backend.emit({ kind: 'session-end', reason: 'completed' });
    pane.agentSession.swapBackend(new MockAgentBackend.Class(), 'codex');
    const painted = paintedText(pane.render(context()));
    expect(painted).toContain('— switched to codex — context ported —');
  });
});
