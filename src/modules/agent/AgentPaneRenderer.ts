// The agent pane renderer: projects the session transcript into a StyledText each frame — role-labelled,
// hard-wrapped to the pane width, tail-anchored (newest visible), with a composer line pinned to the
// bottom. Stateless Static capability: every read flows through the passed-in AgentSession, so
// reactivity flows when the owner calls render() inside its reactive update. This is a pure PROJECTION
// of the transcript — it holds no history of its own (that would be a second source of truth).
//
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import { StyledText, fg, bold, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { AgentSession } from './AgentSession';
import type { TranscriptEntry } from './AgentEvents';

export interface AgentPaneRenderContext {
  session: AgentSession.Instance;
  palette: Palette;
  /** Available cell rows for the whole pane (body + composer line). */
  height: number;
  /** Available cell columns. */
  width: number;
  /** The current composer text (owned by the PaneContent, echoed here). */
  composer: string;
  /** True while the pane owns the keyboard (draws the composer prompt brighter). */
  focused: boolean;
}

/** One projected visual line: its text and the palette color to paint it. */
interface VisualLine {
  text: string;
  color: string;
  bold: boolean;
}

/** Hard-wrap a string to `width` columns (no word logic — deterministic and width-exact for Tier S). */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    for (let start = 0; start < rawLine.length; start += width) {
      out.push(rawLine.slice(start, start + width));
    }
  }
  return out;
}

/** The label + color a transcript entry leads with. */
function labelFor(entry: TranscriptEntry, palette: Palette): { label: string; color: string } {
  switch (entry.role) {
    case 'user':
      return { label: 'You', color: palette.accent };
    case 'assistant':
      return { label: 'Claude', color: palette.func };
    case 'tool-use':
      return { label: `⚙ ${entry.name}`, color: palette.type };
    case 'tool-result':
      return { label: entry.isError ? '✗ result' : '✓ result', color: entry.isError ? palette.error : palette.dim };
    case 'error':
      return { label: '! error', color: palette.error };
  }
}

/** The body text of a transcript entry (what wraps under its label). */
function bodyFor(entry: TranscriptEntry): string {
  switch (entry.role) {
    case 'user':
    case 'assistant':
    case 'error':
      return entry.text;
    case 'tool-use':
      return typeof entry.input === 'string' ? entry.input : JSON.stringify(entry.input);
    case 'tool-result':
      return entry.result;
  }
}

function $render(context: AgentPaneRenderContext): StyledText {
  const { session, palette, width, height, composer, focused } = context;
  const bodyHeight = Math.max(1, height - 1); // last row is the composer

  // Project every transcript entry into labelled, wrapped visual lines.
  const lines: VisualLine[] = [];
  for (const entry of session.transcript) {
    const { label, color } = labelFor(entry, palette);
    lines.push({ text: label, color, bold: true });
    for (const wrapped of wrap(bodyFor(entry), width)) {
      lines.push({ text: wrapped, color: entry.role === 'assistant' ? palette.fg : color, bold: false });
    }
  }
  if (lines.length === 0) {
    lines.push({ text: 'Ask Claude anything. Type a prompt and press Enter.', color: palette.dim, bold: false });
  }

  // Tail-anchor: show the newest bodyHeight lines.
  const visible = lines.slice(Math.max(0, lines.length - bodyHeight));
  while (visible.length < bodyHeight) visible.unshift({ text: '', color: palette.fg, bold: false });

  const chunks: TextChunk[] = [];
  for (const line of visible) {
    chunks.push(line.bold ? bold(fg(line.color)(line.text)) : fg(line.color)(line.text));
    chunks.push(fg(palette.fg)('\n'));
  }

  // The composer line, pinned to the bottom.
  const promptColor = focused ? palette.accent : palette.dim;
  chunks.push(fg(promptColor)('❯ '));
  chunks.push(fg(palette.fg)(composer));

  return new StyledText(chunks);
}

class $AgentPaneRenderer {
  static render = $render;
}

export namespace AgentPaneRenderer {
  export const $Class = $AgentPaneRenderer;
  export const Class = Static($AgentPaneRenderer);
}
