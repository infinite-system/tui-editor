// Pure projection of the append-only transcript into flat, width-wrapped visual lines — the ONE place
// the pane's geometry is computed, so the renderer only paints and the pane content only hit-tests. It
// holds NO history: every call reads the passed-in transcript and returns fresh lines, so it can never
// drift from the single source of truth. Tool-use / tool-result entries fold to a ONE-LINE summary
// unless their entry index is in `expandedIndices` (view state owned by the pane, never the transcript),
// so a long tool dump does not flood the pane until the user opens it.
//
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { GlyphLevel } from '../theme/TerminalCapabilities';
import type { TranscriptEntry } from './AgentEvents';

/** One projected visual line: its text, paint colour, weight, the transcript entry it belongs to, and
 *  whether clicking it toggles that entry's collapsed/expanded state (tool rows only). */
export interface ProjectedLine {
  readonly text: string;
  readonly color: string;
  readonly bold: boolean;
  /** Index into the transcript this line was projected from (-1 for synthetic lines: blanks, hint). */
  readonly entryIndex: number;
  /** True when a pointer-down on this line toggles the entry's expand state. */
  readonly toggleable: boolean;
}

/** Collapse/expand caret glyphs per fallback tier (single-cell at every level). */
const CARET: Record<GlyphLevel, { collapsed: string; expanded: string }> = {
  nerd: { collapsed: '\u{f0da}', expanded: '\u{f0d7}' }, // fa caret-right / caret-down
  unicode: { collapsed: '▸', expanded: '▾' },
  ascii: { collapsed: '>', expanded: 'v' },
};

/** Tool-call glyph per tier (mirrors the settings-cog ladder). */
const TOOL_GLYPH: Record<GlyphLevel, string> = { nerd: '\u{f013}', unicode: '⚙', ascii: '*' };

/** Tool-result outcome glyphs per tier. */
const RESULT_GLYPH: Record<GlyphLevel, { ok: string; error: string }> = {
  nerd: { ok: '\u{f00c}', error: '\u{f00d}' }, // fa check / times
  unicode: { ok: '✓', error: '✗' },
  ascii: { ok: '+', error: 'x' },
};

/** The empty-transcript hint (shown before any turn). */
const EMPTY_HINT = 'Ask Claude anything. Type a prompt and press Enter.';

/** Collapse any run of whitespace (incl. newlines) to single spaces — for one-line summaries. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate to `width` display cells (code-point exact), appending an ellipsis when it overflows. */
function truncate(text: string, width: number, glyphLevel: GlyphLevel): string {
  if (width <= 0) return '';
  const codePoints = Array.from(text);
  if (codePoints.length <= width) return text;
  const ellipsis = glyphLevel === 'ascii' ? '.' : '…';
  return codePoints.slice(0, Math.max(0, width - 1)).join('') + ellipsis;
}

/** Hard-wrap a string to `width` columns (no word logic — deterministic and width-exact). */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      out.push('');
      continue;
    }
    for (let start = 0; start < rawLine.length; start += width) out.push(rawLine.slice(start, start + width));
  }
  return out;
}

/** The one-line body a tool-use entry summarises to (its input, whitespace-collapsed). */
function toolInputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input) ?? '';
}

/** The pretty (multi-line) body a tool-use entry expands to. */
function toolInputPretty(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2) ?? '';
}

/** Project the whole transcript into flat visual lines at `width`, expanding only the given entries. */
function $project(
  transcript: readonly TranscriptEntry[],
  palette: Palette,
  glyphLevel: GlyphLevel,
  width: number,
  expandedIndices: ReadonlySet<number>,
): ProjectedLine[] {
  const lines: ProjectedLine[] = [];
  const caret = CARET[glyphLevel];
  transcript.forEach((entry, entryIndex) => {
    switch (entry.role) {
      case 'user':
        lines.push({ text: 'You', color: palette.accent, bold: true, entryIndex, toggleable: false });
        for (const wrapped of wrap(entry.text, width))
          lines.push({ text: wrapped, color: palette.accent, bold: false, entryIndex, toggleable: false });
        break;
      case 'assistant':
        lines.push({ text: 'Claude', color: palette.func, bold: true, entryIndex, toggleable: false });
        for (const wrapped of wrap(entry.text, width))
          lines.push({ text: wrapped, color: palette.fg, bold: false, entryIndex, toggleable: false });
        break;
      case 'error':
        lines.push({ text: '! error', color: palette.error, bold: true, entryIndex, toggleable: false });
        for (const wrapped of wrap(entry.text, width))
          lines.push({ text: wrapped, color: palette.error, bold: false, entryIndex, toggleable: false });
        break;
      case 'tool-use': {
        const expanded = expandedIndices.has(entryIndex);
        const marker = expanded ? caret.expanded : caret.collapsed;
        const head = `${marker} ${TOOL_GLYPH[glyphLevel]} ${entry.name}`;
        if (!expanded) {
          const summary = collapseWhitespace(toolInputText(entry.input));
          const oneLine = summary.length > 0 ? `${head}  ${summary}` : head;
          lines.push({ text: truncate(oneLine, width, glyphLevel), color: palette.type, bold: true, entryIndex, toggleable: true });
        } else {
          lines.push({ text: truncate(head, width, glyphLevel), color: palette.type, bold: true, entryIndex, toggleable: true });
          for (const wrapped of wrap(toolInputPretty(entry.input), width))
            lines.push({ text: wrapped, color: palette.dim, bold: false, entryIndex, toggleable: true });
        }
        break;
      }
      case 'tool-result': {
        const expanded = expandedIndices.has(entryIndex);
        const marker = expanded ? caret.expanded : caret.collapsed;
        const outcome = entry.isError ? RESULT_GLYPH[glyphLevel].error : RESULT_GLYPH[glyphLevel].ok;
        const color = entry.isError ? palette.error : palette.dim;
        const head = `${marker} ${outcome} result`;
        if (!expanded) {
          const summary = collapseWhitespace(entry.result);
          const oneLine = summary.length > 0 ? `${head}  ${summary}` : head;
          lines.push({ text: truncate(oneLine, width, glyphLevel), color, bold: true, entryIndex, toggleable: true });
        } else {
          lines.push({ text: truncate(head, width, glyphLevel), color, bold: true, entryIndex, toggleable: true });
          for (const wrapped of wrap(entry.result, width))
            lines.push({ text: wrapped, color: palette.dim, bold: false, entryIndex, toggleable: true });
        }
        break;
      }
    }
  });
  if (lines.length === 0) lines.push({ text: EMPTY_HINT, color: palette.dim, bold: false, entryIndex: -1, toggleable: false });
  return lines;
}

/** The first visible line index for a tail-anchored window: stuck-to-bottom shows the newest
 *  `bodyHeight` lines; otherwise it holds `scrollTopLines`, clamped into range. Pure. */
function $firstVisibleLine(totalLines: number, bodyHeight: number, scrollTopLines: number, stickToBottom: boolean): number {
  const maximumTop = Math.max(0, totalLines - bodyHeight);
  if (stickToBottom) return maximumTop;
  return Math.max(0, Math.min(scrollTopLines, maximumTop));
}

class $AgentTranscriptProjection {
  static project = $project;
  static firstVisibleLine = $firstVisibleLine;
}

export namespace AgentTranscriptProjection {
  export const $Class = $AgentTranscriptProjection;
  export const Class = Static($AgentTranscriptProjection);
}
