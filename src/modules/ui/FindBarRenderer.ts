// The find / find-replace bar renderer (Ctrl+F / Ctrl+H): the query line, the optional replacement
// line, and a row of MOUSE-CLICKABLE action buttons (prev · next · Aa case toggle · replace ·
// replace-all · find↔replace mode). Extracted from OverlayLayer's closure so the bar's rendering
// lives with its own contract (smoke-search-mouse) — the same move the tree/git panes made.
//
// Stateless capability (project.conventions.md): a pure Static behind the Static() seam. render()
// RETURNS the button hit-zones (list-local row + column ranges) alongside the text, so OverlayLayer's
// pointer dispatch reads the SAME geometry the renderer drew — a drawn button and its hit-rect can
// never disagree (the one-geometry-source rule the git action buttons already follow).
//
// invariant: Renderables hold no model state (src/modules/ui/ui.invariants.md)
// invariant: Find bar controls are mouse-clickable buttons (src/modules/search/search.invariants.md)
// invariant: Case sensitivity is a live toggle that re-runs the query (src/modules/search/search.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import type { Palette } from '../theme/ThemePalettes';
import type { FindIconSet } from '../theme/ThemeIcons';
import type { FindBar } from '../search/FindBar';

export type FindBarButtonAction = 'previous' | 'next' | 'toggleCase' | 'replace' | 'replaceAll' | 'toggleMode';

/** A drawn button's hit-rect in the bar body's own coordinates (row 0 = the bar's first content line). */
export interface FindBarButtonZone {
  action: FindBarButtonAction;
  row: number;
  startColumn: number;
  endColumn: number;
}

export interface FindBarRenderResult {
  text: StyledText;
  buttons: FindBarButtonZone[];
}

export interface FindBarRenderContext {
  findBar: FindBar.Instance;
  palette: Palette;
  findIcons: FindIconSet;
}

const lineWidth = EditorCoordinates.Class.lineWidth;

function $renderFindBar(context: FindBarRenderContext): FindBarRenderResult {
  const { findBar, palette, findIcons } = context;
  const engine = findBar.engine;
  const replaceMode = findBar.mode.value === 'replace';
  const queryFocused = !(replaceMode && findBar.replaceFocused.value);
  const matchCount = engine ? engine.matchCount : 0;
  const position = engine && engine.currentMatchIndex.value >= 0 ? engine.currentMatchIndex.value + 1 : 0;
  const counter = matchCount > 0 ? `${position} of ${matchCount}` : engine && engine.query.value ? 'no results' : '';

  const chunks: TextChunk[] = [];
  chunks.push(fg(palette.fg)(`⌕ ${engine?.query.value ?? ''}${queryFocused ? '▏' : ''}   `));
  chunks.push(fg(palette.dim)(`${counter}\n`));
  if (replaceMode) {
    chunks.push(fg(palette.fg)(`⇄ ${engine?.replacement.value ?? ''}${queryFocused ? '' : '▏'}\n`));
  }

  // Button row: one geometry source drives both the chunks and the hit-zones. Each button is its glyph
  // (single-cell, from the theme ladder) or the `Aa` case label, flanked by spaces, then a 1-cell gap.
  const buttonRow = replaceMode ? 2 : 1;
  const buttons: FindBarButtonZone[] = [];
  let column = 0;
  const pushButton = (action: FindBarButtonAction, label: string, color: string, active: boolean): void => {
    const cellLabel = ` ${label} `;
    const startColumn = column;
    const painted = active ? bg(palette.selection)(fg(palette.accent)(cellLabel)) : fg(color)(cellLabel);
    chunks.push(painted);
    column += lineWidth(cellLabel);
    buttons.push({ action, row: buttonRow, startColumn, endColumn: column });
    chunks.push(fg(palette.fg)(' '));
    column += 1;
  };

  pushButton('previous', findIcons.previous, palette.fg, false);
  pushButton('next', findIcons.next, palette.fg, false);
  pushButton('toggleCase', 'Aa', palette.fg, findBar.caseSensitive);
  if (replaceMode) {
    pushButton('replace', findIcons.replace, palette.fg, false);
    pushButton('replaceAll', findIcons.replaceAll, palette.fg, false);
  }
  if (findBar.target?.replaceAllowed) {
    pushButton('toggleMode', findIcons.toggleMode, palette.accent, false);
  }
  chunks.push(fg(palette.dim)('  esc'));

  return { text: new StyledText(chunks), buttons };
}

class $FindBarRenderer {
  static render = $renderFindBar;
}

export namespace FindBarRenderer {
  export const $Class = $FindBarRenderer;
  export const Class = Static($FindBarRenderer);
}
