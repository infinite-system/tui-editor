// The quick-open (Ctrl+P go-to-file / open-project-folder) result-list renderer: turns the ranked
// QuickOpen matches into a StyledText for the modal body. Extracted from OverlayLayer's closure so the
// picker's rendering lives with its own contract (smoke-search-mouse) — the same move that gave the
// file tree and git panes their own renderers.
//
// Stateless capability (project.conventions.md): a pure Static behind the Static() seam. Selection and
// hover are the SAME row-background signal the tree uses — there is NO selected-row arrow marker (the
// '›' was noise; the row background IS the selection signal). render() returns the text plus the count
// of hit-testable match rows so OverlayLayer maps a pointer row to a match without a parallel model.
//
// invariant: Renderables hold no model state (src/modules/ui/ui.invariants.md)
// invariant: Search results are click-set and highlight-shown (src/modules/search/search.invariants.md)
// invariant: Selection is item-anchored click-set keyboard-moved and stays (src/modules/ui/ui.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import type { Palette } from '../theme/ThemePalettes';
import type { QuickOpen } from '../search/QuickOpen';

export interface QuickOpenRenderContext {
  quickOpen: QuickOpen.Instance;
  palette: Palette;
  /** List inner width — rows pad to this so the row highlight spans the full width (VS Code-style). */
  innerWidth: number;
  /** Maximum result rows the modal shows (the render window). */
  maxRows: number;
}

/** The rendered list plus how many hit-testable match rows it drew (0 for the message/empty states). */
export interface QuickOpenRenderResult {
  text: StyledText;
  rowCount: number;
}

const padToDisplayWidth = EditorCoordinates.Class.padToDisplayWidth;

function messageResult(lines: string[], palette: Palette): QuickOpenRenderResult {
  return { text: new StyledText([fg(palette.dim)(lines.join('\n'))]), rowCount: 0 };
}

function $renderQuickOpen(context: QuickOpenRenderContext): QuickOpenRenderResult {
  const { quickOpen, palette, innerWidth, maxRows } = context;
  const openingWorkspace = quickOpen.mode.value === 'workspacePath';

  if (openingWorkspace && quickOpen.errorMessage.value) {
    return messageResult([`  ${quickOpen.errorMessage.value}`, '  Enter opens · Esc cancels'], palette);
  }

  const matches = quickOpen.matches.value.slice(0, maxRows);
  if (matches.length === 0) {
    if (openingWorkspace) return messageResult(['  Type an existing folder path', '  Enter opens · Esc cancels'], palette);
    return messageResult([quickOpen.query.value ? '  (no matching files)' : '  (type to filter project files)'], palette);
  }

  const selectedIndex = quickOpen.selectedIndex.value;
  const hoveredIndex = quickOpen.hoveredIndex.value;
  const chunks: TextChunk[] = [];
  matches.forEach((match, rowIndex) => {
    const selected = rowIndex === selectedIndex;
    const hovered = rowIndex === hoveredIndex;
    // No selection arrow — the row background is the selection signal (the '›' marker was noise). Two
    // intensities: selection (stronger, quick-open owns the keyboard while open) over hover (subtle).
    const rowBackground = selected ? palette.selection : hovered ? palette.cursorLine : null;
    const label = padToDisplayWidth(` ${match.path}`, innerWidth);
    const styled = fg(selected ? palette.accent : palette.fg)(label);
    chunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
    if (rowIndex < matches.length - 1) chunks.push(fg(palette.fg)('\n'));
  });
  return { text: new StyledText(chunks), rowCount: matches.length };
}

class $QuickOpenRenderer {
  static render = $renderQuickOpen;
}

export namespace QuickOpenRenderer {
  export const $Class = $QuickOpenRenderer;
  export const Class = Static($QuickOpenRenderer);
}
