// The agent pane renderer: paints an ALREADY-WINDOWED set of body rows (tail-anchored, wrapped, and
// scrolled by the pane content), an optional thinking-spinner line, and the composer line pinned to the
// bottom — into ONE StyledText. Stateless Static capability: it holds no transcript and no scroll state
// (those live in AgentPaneContent, projected fresh each frame from the single source of truth), so it
// can never drift. Prefers fg styling (a PaneContent is StyledText; multi-line bg spans mis-position).
//
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import { StyledText, fg, bold, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { ProjectedLine } from './AgentTranscriptProjection';

/** The spinner line to draw above the composer while the session is busy. */
export interface SpinnerLine {
  readonly glyph: string;
  readonly label: string;
  readonly color: string;
}

export interface AgentPaneRenderContext {
  palette: Palette;
  /** The body rows to paint, TOP-padded to exactly `bodyHeight` (blank lines lead a short transcript). */
  bodyRows: readonly ProjectedLine[];
  /** The spinner line, or null when idle/ended. Occupies one row directly above the composer. */
  spinner: SpinnerLine | null;
  /** The current composer text (owned by the PaneContent, echoed here). */
  composer: string;
  /** True while the pane owns the keyboard (draws the composer prompt brighter). */
  focused: boolean;
}

function $render(context: AgentPaneRenderContext): StyledText {
  const { palette, bodyRows, spinner, composer, focused } = context;
  const chunks: TextChunk[] = [];

  for (const line of bodyRows) {
    chunks.push(line.bold ? bold(fg(line.color)(line.text)) : fg(line.color)(line.text));
    chunks.push(fg(palette.fg)('\n'));
  }

  // The thinking-spinner line (glyph + label), directly above the composer while busy.
  if (spinner) {
    chunks.push(bold(fg(spinner.color)(`${spinner.glyph} ${spinner.label}`)));
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
