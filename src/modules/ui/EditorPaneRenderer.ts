// The editor pane renderer: the gutter (line numbers + diff markers) and the code body, in both
// wrap and no-wrap modes, with syntax highlighting and find-match backgrounds. Extracted from
// RootView's closure so the editor render lives with its own contracts (smoke-editor, smoke-wrap,
// smoke-gutter-diff, smoke-find) instead of inside the god-view.
//
// Wrap mode produces the VISUAL-ROW WINDOW (wrapRowsWindow) that the caret block, applySelection,
// and the mouse hit-test all read, so — like the other pane renderers — render() RETURNS that window
// and RootView stores it (the shared source of truth). No closure capture, no state held here.
//
// invariant: Word wrap is a pure view mapping (src/modules/editor/editor.invariants.md)
// invariant: The editor gutter reflects HEAD changes (src/modules/diff/diff.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { EditorWrap, type VisualRow } from '../editor/EditorWrap';
import { Highlighter, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import type { Palette } from '../theme/ThemePalettes';
import type { Workspace } from '../workspace/Workspace';
import type { FindInBuffer } from '../search/FindInBuffer';

export interface EditorPaneRenderContext {
  workspace: Workspace.Instance;
  palette: Palette;
  viewportHeight: number;
  viewportWidth: number;
  /** The find engine for a document path (RootView prefixes the `source:` pane identifier). */
  findEngineFor: (documentPath: string) => FindInBuffer.Instance | null;
}

export interface EditorPaneRender {
  gutter: StyledText;
  code: StyledText;
  /** Wrap-mode visual-row window (empty in no-wrap mode); RootView stores it for caret/hit-test. */
  wrapRowsWindow: VisualRow[];
}

/** Map a syntax role to its palette colour. */
function roleColor(role: Role, palette: Palette): string {
  switch (role) {
    case 'keyword': return palette.keyword;
    case 'string': return palette.string;
    case 'number': return palette.number;
    case 'comment': return palette.comment;
    case 'func': return palette.func;
    case 'type': return palette.type;
    case 'operator': return palette.operator;
    case 'added': return palette.added;
    case 'removed': return palette.deleted;
    default: return palette.fg;
  }
}

function $renderEditor(context: EditorPaneRenderContext): EditorPaneRender | null {
  const { workspace, palette } = context;
  if (workspace.showingDiff.value) return null;
  const editor = workspace.editor;
  if (!editor.hasDocument.value) return null;
  const language = LanguageRegistry.Class.forPath(editor.document.path);
  const height = context.viewportHeight;
  const top = editor.viewport.scrollTop.value;
  const visibleLines = editor.document.slice(top, height);
  const lineNumberWidth = String(editor.document.lineCount).length + 1;
  const currentLineIndex = editor.cursor.line.value;
  const focused = workspace.focus.value === 'editor';
  const gutterDiffByLine = workspace.gutterDiffByLine.value;
  const gutterChunks: TextChunk[] = [];
  const codeChunks: TextChunk[] = [];
  const pushGutterMarker = (lineIndex: number, isCurrentLine: boolean): void => {
    const gutterDiffStatus = gutterDiffByLine.get(lineIndex);
    if (gutterDiffStatus === 'added') {
      gutterChunks.push(fg(palette.added)('▎'));
    } else if (gutterDiffStatus === 'modified') {
      gutterChunks.push(fg(palette.modified)('▎'));
    } else if (gutterDiffStatus === 'deleted') {
      gutterChunks.push(fg(palette.deleted)('▁'));
    } else {
      gutterChunks.push(fg(palette.accent)(isCurrentLine && focused ? '▏' : ' '));
    }
  };
  const sourceFindEngine = context.findEngineFor(editor.document.path);
  const pushCodeChunks = (
    windowText: string,
    lineIndex: number,
    windowStartGrapheme = 0,
  ): void => {
    const lineMatches = sourceFindEngine?.matches.value.filter((match) => match.line === lineIndex) ?? [];
    const windowGraphemeCount = EditorCoordinates.Class.graphemeCount(windowText);
    const boundaries = new Set<number>([0, windowGraphemeCount]);
    for (const match of lineMatches) {
      boundaries.add(Math.max(0, Math.min(windowGraphemeCount, match.startColumn - windowStartGrapheme)));
      boundaries.add(Math.max(0, Math.min(windowGraphemeCount, match.endColumn - windowStartGrapheme)));
    }
    const orderedBoundaries = [...boundaries].sort((first, second) => first - second);
    for (let boundaryIndex = 0; boundaryIndex < orderedBoundaries.length - 1; boundaryIndex += 1) {
      const segmentStart = orderedBoundaries[boundaryIndex]!;
      const segmentEnd = orderedBoundaries[boundaryIndex + 1]!;
      if (segmentEnd <= segmentStart) continue;
      const segmentText = windowText.slice(
        EditorCoordinates.Class.graphemeToU16(windowText, segmentStart),
        EditorCoordinates.Class.graphemeToU16(windowText, segmentEnd),
      );
      const findHighlighted = lineMatches.some(
        (match) =>
          match.startColumn < windowStartGrapheme + segmentEnd &&
          match.endColumn > windowStartGrapheme + segmentStart,
      );
      if (editor.document.binary.value || language === 'plain') {
        const textChunk = fg(palette.fg)(segmentText);
        codeChunks.push(findHighlighted ? bg(palette.cursorLine)(textChunk) : textChunk);
      } else {
        for (const span of Highlighter.Class.highlightLine(segmentText, language)) {
          const syntaxChunk = fg(roleColor(span.role, palette))(span.text);
          codeChunks.push(findHighlighted ? bg(palette.cursorLine)(syntaxChunk) : syntaxChunk);
        }
      }
    }
  };
  if (editor.wordWrap.value) {
    // WRAP MODE: iterate VISUAL rows from the pure mapping layer — a long line contributes multiple
    // rows; the gutter numbers only a line's FIRST visual row (continuation rows are blank, VS
    // Code-style); each row's code is the segment's grapheme-safe slice. `top` is a VISUAL-row offset
    // in wrap mode, so the window can start MID-LINE. The walk is O(window) — never materialized.
    const wrapRowsWindow = EditorWrap.Class.visualRowsFromOffset(editor.document, top, editor.wrapWidth(), height);
    wrapRowsWindow.forEach((row, rowIndex) => {
      const isCurrentLine = row.lineIndex === currentLineIndex;
      if (row.firstOfLine) {
        const lineNumberText = String(row.lineIndex + 1).padStart(lineNumberWidth, ' ');
        gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
        pushGutterMarker(row.lineIndex, isCurrentLine);
      } else {
        gutterChunks.push(fg(palette.dim)(' '.repeat(lineNumberWidth + 2)));
      }
      const lineText = editor.document.line(row.lineIndex);
      pushCodeChunks(
        lineText.slice(
          EditorCoordinates.Class.graphemeToU16(lineText, row.segment.startGrapheme),
          EditorCoordinates.Class.graphemeToU16(lineText, row.segment.endGrapheme),
        ),
        row.lineIndex,
        row.segment.startGrapheme,
      );
      if (rowIndex < wrapRowsWindow.length - 1) {
        gutterChunks.push(fg(palette.fg)('\n'));
        codeChunks.push(fg(palette.fg)('\n'));
      }
    });
    return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks), wrapRowsWindow };
  }
  // COLUMN virtualization (the horizontal twin of the line flyweight): each visible line is sliced to
  // the visible display-column window BEFORE tokenizing, so per-frame cost tracks visible columns —
  // never total line length (50k-char lines render at normal speed). Trade-off: tokens start at the
  // slice, so left-context-sensitive highlighting can differ at the boundary (documented).
  const scrollLeft = editor.viewport.scrollLeft.value;
  const viewportWidth = context.viewportWidth;
  visibleLines.forEach((text, visibleIndex) => {
    const lineNumber = top + visibleIndex;
    const isCurrentLine = lineNumber === currentLineIndex;
    const lineNumberText = String(lineNumber + 1).padStart(lineNumberWidth, ' ');
    gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
    pushGutterMarker(lineNumber, isCurrentLine);
    let windowText = text;
    let windowStartGrapheme = 0;
    if (scrollLeft > 0 || text.length > viewportWidth) { // O(1) test; a needless slice is harmless
      let startGrapheme = EditorCoordinates.Class.graphemeAtDisplayColumn(text, scrollLeft);
      if (EditorCoordinates.Class.displayColumn(text, startGrapheme) < scrollLeft) startGrapheme += 1; // never split a straddling wide glyph
      const endGrapheme = EditorCoordinates.Class.graphemeAtDisplayColumn(text, scrollLeft + viewportWidth) + 1;
      windowStartGrapheme = startGrapheme;
      windowText = text.slice(EditorCoordinates.Class.graphemeToU16(text, startGrapheme), EditorCoordinates.Class.graphemeToU16(text, endGrapheme));
    }
    pushCodeChunks(windowText, lineNumber, windowStartGrapheme);
    if (visibleIndex < visibleLines.length - 1) {
      gutterChunks.push(fg(palette.fg)('\n'));
      codeChunks.push(fg(palette.fg)('\n'));
    }
  });
  return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks), wrapRowsWindow: [] };
}

class $EditorPaneRenderer {
  static render = $renderEditor;
}

export namespace EditorPaneRenderer {
  export const $Class = $EditorPaneRenderer;
  export const Class = Static($EditorPaneRenderer);
}
