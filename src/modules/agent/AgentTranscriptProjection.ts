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
import { WrapText } from '../ui/WrapText';
import { ThemeIcons } from '../theme/ThemeIcons';
import { AgentToolSummary } from './AgentToolSummary';
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

// Transcript glyphs (carets, tool cog, result marks, ellipses) come from the theme's
// AgentTranscriptIconSet ladder — no private glyph ladders in this module.
// invariant: Appearance is data with a capability fallback (project.invariants.md)

/** The empty-transcript hint (shown before any turn). */
const EMPTY_HINT = 'Ask Claude anything. Type a prompt and press Enter.';

/** Truncate to `width` display cells (code-point exact), appending an ellipsis when it overflows. */
function truncate(text: string, width: number, glyphLevel: GlyphLevel): string {
  if (width <= 0) return '';
  const codePoints = Array.from(text);
  if (codePoints.length <= width) return text;
  const ellipsis = ThemeIcons.Class.agentTranscriptIconsFor(glyphLevel).ellipsisCell;
  return codePoints.slice(0, Math.max(0, width - 1)).join('') + ellipsis;
}

/** Hard-wrap a string to `width` columns via the shared, width-exact seam. */
function wrap(text: string, width: number): string[] {
  return WrapText.Class.wrap(text, width);
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
  const transcriptIcons = ThemeIcons.Class.agentTranscriptIconsFor(glyphLevel);
  const caret = { collapsed: transcriptIcons.caretCollapsed, expanded: transcriptIcons.caretExpanded };
  const blank = (): void => { lines.push({ text: '', color: palette.dim, bold: false, entryIndex: -1, toggleable: false }); };
  transcript.forEach((entry, entryIndex) => {
    // Airy turn spacing (Claude-style): a blank line BEFORE each user/error turn (separating it from the
    // previous turn) AND a blank line AFTER every user turn (so a just-posted "You" turn is followed by
    // space before the reply/thinking, not only agent→agent gaps). Tool-use/tool-result stay tight under
    // their assistant. The blank is a real projected line, so it wraps/scrolls/selects with the content.
    if (entryIndex > 0 && (entry.role === 'user' || entry.role === 'error' || entry.role === 'system')) blank();
    switch (entry.role) {
      case 'system':
        // A dim, centered aside (e.g. an engine-switch banner) — "— <text> —", framed by em-dashes.
        for (const wrapped of wrap(`— ${entry.text} —`, width))
          lines.push({ text: wrapped, color: palette.dim, bold: false, entryIndex: -1, toggleable: false });
        blank();
        break;
      case 'user':
        lines.push({ text: 'You', color: palette.accent, bold: true, entryIndex, toggleable: false });
        for (const wrapped of wrap(entry.text, width))
          lines.push({ text: wrapped, color: palette.accent, bold: false, entryIndex, toggleable: false });
        blank(); // trailing space after the user's own turn
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
        const head = `${marker} ${transcriptIcons.tool} ${entry.name}`;
        if (!expanded) {
          // COLLAPSED: a readable human phrase (tool name + salient arg), never the raw JSON.
          const summary = AgentToolSummary.Class.summarize(entry.name, entry.input);
          const oneLine = summary.length > 0 ? `${head}  ${summary}` : head;
          lines.push({ text: truncate(oneLine, width, glyphLevel), color: palette.type, bold: true, entryIndex, toggleable: true });
        } else {
          // EXPANDED: full pretty-printed input for those who want the detail.
          lines.push({ text: truncate(head, width, glyphLevel), color: palette.type, bold: true, entryIndex, toggleable: true });
          for (const wrapped of wrap(toolInputPretty(entry.input), width))
            lines.push({ text: wrapped, color: palette.dim, bold: false, entryIndex, toggleable: true });
        }
        break;
      }
      case 'permission-request': {
        // The interactive approval surface. PENDING = a highlighted two-line prompt (what + the keys);
        // RESOLVED = one compact record line. Human-readable via the same AgentToolSummary seam the
        // collapsed tool rows use — never raw JSON.
        const phrase = AgentToolSummary.Class.summarize(entry.toolName, entry.input) || entry.toolName;
        if (entry.status === 'pending') {
          lines.push({
            text: truncate(`? Claude wants to run  ${phrase}`, width, glyphLevel),
            color: palette.warning,
            bold: true,
            entryIndex,
            toggleable: false,
          });
          lines.push({
            text: truncate('  [y] allow · [n] deny · [a] always (session)', width, glyphLevel),
            color: palette.dim,
            bold: false,
            entryIndex,
            toggleable: false,
          });
        } else {
          const allowed = entry.status === 'allowed';
          const outcome = allowed ? transcriptIcons.resultOk : transcriptIcons.resultError;
          lines.push({
            text: truncate(`${outcome} ${allowed ? 'allowed' : 'denied'}  ${phrase}`, width, glyphLevel),
            color: allowed ? palette.dim : palette.error,
            bold: false,
            entryIndex,
            toggleable: false,
          });
        }
        break;
      }
      case 'tool-result': {
        const expanded = expandedIndices.has(entryIndex);
        const marker = expanded ? caret.expanded : caret.collapsed;
        const outcome = entry.isError ? transcriptIcons.resultError : transcriptIcons.resultOk;
        const color = entry.isError ? palette.error : palette.dim;
        if (!expanded) {
          // COLLAPSED: a short outcome summary — "✓ 42 lines" / "✗ error: …", not the raw dump.
          const summary = AgentToolSummary.Class.summarizeResult(entry.result, entry.isError);
          lines.push({ text: truncate(`${marker} ${outcome} ${summary}`, width, glyphLevel), color, bold: true, entryIndex, toggleable: true });
        } else {
          // EXPANDED: the full wrapped output.
          lines.push({ text: truncate(`${marker} ${outcome} result`, width, glyphLevel), color, bold: true, entryIndex, toggleable: true });
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
