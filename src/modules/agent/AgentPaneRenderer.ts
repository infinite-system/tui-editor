// The agent pane renderer: paints the whole pane into ONE StyledText from already-laid-out inputs —
// the tail-anchored transcript body (padded left/right, its selection highlighted per row), the animated
// thinking line while busy, then the framed composer (blank · rule · wrapped composer · rule · mode
// line). Stateless Static capability: it holds no transcript and no scroll/selection state (those live in
// AgentPaneContent), so it can never drift. Per-cell/per-row fg + single-row bg only (multi-line bg spans
// mis-position in a StyledText pane).
//
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import { StyledText, fg, bg, bold, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { ProjectedLine } from './AgentTranscriptProjection';
import type { ComposerRow } from './AgentComposer';
import type { ThinkingSegment } from './AgentThinkingIndicator';

/** The [start, end) column span of a body row that is selection-highlighted. */
export interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

export interface AgentPaneRenderContext {
  palette: Palette;
  /** Left padding (columns of blank gutter) before each transcript row. */
  padLeft: number;
  /** The transcript body rows, TOP-padded to exactly the body height (blank lines lead a short log). */
  bodyRows: readonly ProjectedLine[];
  /** Parallel to `bodyRows`: the selection span on each row (single-ROW background), or null. */
  selectionRanges: readonly (SelectionRange | null)[];
  /** The animated thinking line (segments), or null when idle. Sits above the composer frame. */
  thinking: readonly ThinkingSegment[] | null;
  /** The calm secondary "waiting on tool" note, or null. When present it sits below the thinking line
   *  after a blank-line gap (the airy two-line layout). */
  waitingNote: readonly ThinkingSegment[] | null;
  /** The horizontal rule string (already sized to width) framing the composer top and bottom. */
  rule: string;
  /** The composer's laid-out rows (1..cap), wrapped + cap-scrolled, each with its own selection span. */
  composer: readonly ComposerRow[];
  /** The mode line segments (permission mode + dim hint), painted under the bottom rule. */
  modeLine: readonly ThinkingSegment[];
  /** True while the pane owns the keyboard (draws the composer prompt brighter). */
  focused: boolean;
}

/** Split text into [before][selected(bg)][after], the selected span given a single-ROW background. */
function pushHighlighted(
  chunks: TextChunk[],
  text: string,
  selection: SelectionRange | null,
  paint: (text: string) => TextChunk,
  palette: Palette,
): void {
  if (!selection || selection.end <= selection.start) {
    chunks.push(paint(text));
    return;
  }
  const before = text.slice(0, selection.start);
  const selected = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  if (before) chunks.push(paint(before));
  chunks.push(bg(palette.selection)(fg(palette.fg)(selected)));
  if (after) chunks.push(paint(after));
}

/** Paint pre-composed styled segments (thinking line / mode line). */
function pushSegments(chunks: TextChunk[], segments: readonly ThinkingSegment[]): void {
  for (const segment of segments) {
    chunks.push(segment.bold ? bold(fg(segment.color)(segment.text)) : fg(segment.color)(segment.text));
  }
}

function $render(context: AgentPaneRenderContext): StyledText {
  const { palette, padLeft, bodyRows, selectionRanges, thinking, waitingNote, rule, composer, modeLine, focused } = context;
  const chunks: TextChunk[] = [];
  const leftPad = ' '.repeat(Math.max(0, padLeft));

  // Transcript body (padded left), each row with its single-row selection highlight.
  bodyRows.forEach((line, index) => {
    if (leftPad) chunks.push(fg(palette.fg)(leftPad));
    const paint = (text: string): TextChunk => (line.bold ? bold(fg(line.color)(text)) : fg(line.color)(text));
    pushHighlighted(chunks, line.text, selectionRanges[index] ?? null, paint, palette);
    chunks.push(fg(palette.fg)('\n'));
  });

  // The animated thinking line, directly above the composer frame while busy.
  if (thinking) {
    if (leftPad) chunks.push(fg(palette.fg)(leftPad));
    pushSegments(chunks, thinking);
    chunks.push(fg(palette.fg)('\n'));
  }
  // The calm secondary waiting-note, after a blank-line gap (airy Claude spacing).
  if (waitingNote) {
    chunks.push(fg(palette.fg)('\n'));
    if (leftPad) chunks.push(fg(palette.fg)(leftPad));
    pushSegments(chunks, waitingNote);
    chunks.push(fg(palette.fg)('\n'));
  }

  // Composer frame: TWO blank spacers, an (inset) top rule, the wrapped composer rows (inset), a bottom
  // rule, the mode line, and a blank bottom-pad row — airy margins above and below the composer canvas.
  chunks.push(fg(palette.fg)('\n')); // blank spacer 1
  chunks.push(fg(palette.fg)('\n')); // blank spacer 2
  if (leftPad) chunks.push(fg(palette.fg)(leftPad));
  chunks.push(fg(palette.dim)(rule));
  chunks.push(fg(palette.fg)('\n'));

  const promptColor = focused ? palette.accent : palette.dim;
  composer.forEach((row) => {
    if (leftPad) chunks.push(fg(palette.fg)(leftPad));
    chunks.push(fg(promptColor)(row.isFirstLine ? '❯ ' : '  '));
    pushHighlighted(chunks, row.text, row.selection, (text) => fg(palette.fg)(text), palette);
    chunks.push(fg(palette.fg)('\n'));
  });

  if (leftPad) chunks.push(fg(palette.fg)(leftPad));
  chunks.push(fg(palette.dim)(rule));
  chunks.push(fg(palette.fg)('\n'));
  pushSegments(chunks, modeLine);
  chunks.push(fg(palette.fg)('\n')); // trailing newline → a blank bottom-pad row at the very bottom

  return new StyledText(chunks);
}

class $AgentPaneRenderer {
  static render = $render;
}

export namespace AgentPaneRenderer {
  export const $Class = $AgentPaneRenderer;
  export const Class = Static($AgentPaneRenderer);
}
