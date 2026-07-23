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

/**
 * The rendered list plus how many hit-testable match rows it drew (0 for the message/empty states) and
 * the model index of the FIRST drawn row (the scroll window's top). A pointer row maps to the match
 * `firstVisible + rowIndex`, so a hit-test on a scrolled list resolves to the right match.
 */
export interface QuickOpenRenderResult {
  text: StyledText;
  rowCount: number;
  firstVisible: number;
}

/** The scroll window a render draws: the top model index and how many rows fit. */
export interface QuickOpenWindow {
  firstVisible: number;
  count: number;
}

const padToDisplayWidth = EditorCoordinates.Class.padToDisplayWidth;

/**
 * Stateless scroll-to-selection window. Given the selected model index, the total match count, and the
 * visible-row budget, return the slice `[firstVisible, firstVisible + count)` to draw so the selection
 * is ALWAYS on screen. Pure (no persisted scroll offset) so the renderer keeps holding no model state:
 * the window is recomputed from selection each frame, centering the selection and clamping to both ends
 * (so the first/last pages never scroll past the list). Lists that fit whole draw from the top unchanged.
 */
function computeQuickOpenWindow(selectedIndex: number, total: number, maxRows: number): QuickOpenWindow {
  const visibleRows = Math.max(1, maxRows);
  if (total <= visibleRows) return { firstVisible: 0, count: total };
  const anchorIndex = selectedIndex < 0 ? 0 : Math.min(selectedIndex, total - 1);
  const halfWindow = Math.floor((visibleRows - 1) / 2);
  const lastPossibleFirst = total - visibleRows;
  const firstVisible = Math.max(0, Math.min(anchorIndex - halfWindow, lastPossibleFirst));
  return { firstVisible, count: visibleRows };
}

function messageResult(lines: string[], palette: Palette): QuickOpenRenderResult {
  return { text: new StyledText([fg(palette.dim)(lines.join('\n'))]), rowCount: 0, firstVisible: 0 };
}

function $renderQuickOpen(context: QuickOpenRenderContext): QuickOpenRenderResult {
  const { quickOpen, palette, innerWidth, maxRows } = context;
  const openingWorkspace = quickOpen.mode.value === 'workspacePath';

  if (openingWorkspace && quickOpen.errorMessage.value) {
    return messageResult([`  ${quickOpen.errorMessage.value}`, '  Enter opens · Esc cancels'], palette);
  }

  const allMatches = quickOpen.matches.value;
  if (allMatches.length === 0) {
    if (openingWorkspace) return messageResult(['  Type an existing folder path', '  Enter opens · Esc cancels'], palette);
    return messageResult([quickOpen.query.value ? '  (no matching files)' : '  (type to filter project files)'], palette);
  }

  const selectedIndex = quickOpen.selectedIndex.value;
  const hoveredIndex = quickOpen.hoveredIndex.value;
  // Scroll the render window to keep the selection visible: a long list windows around the selected row
  // instead of always slicing from the top (which would let the selection vanish below the window).
  // invariant: The selected quick-open row is always visible (src/modules/search/search.invariants.md)
  const { firstVisible, count } = computeQuickOpenWindow(selectedIndex, allMatches.length, maxRows);
  const windowedMatches = allMatches.slice(firstVisible, firstVisible + count);
  const chunks: TextChunk[] = [];
  windowedMatches.forEach((match, rowIndex) => {
    const modelIndex = firstVisible + rowIndex;
    const selected = modelIndex === selectedIndex;
    const hovered = modelIndex === hoveredIndex;
    // No selection arrow — the row background is the selection signal (the '›' marker was noise). Two
    // intensities: selection (stronger, quick-open owns the keyboard while open) over hover (subtle).
    const rowBackground = selected ? palette.selection : hovered ? palette.cursorLine : null;
    const label = padToDisplayWidth(` ${match.path}`, innerWidth);
    const styled = fg(selected ? palette.accent : palette.fg)(label);
    chunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
    if (rowIndex < windowedMatches.length - 1) chunks.push(fg(palette.fg)('\n'));
  });
  return { text: new StyledText(chunks), rowCount: windowedMatches.length, firstVisible };
}

class $QuickOpenRenderer {
  static render = $renderQuickOpen;
  /** The pure scroll-to-selection window math, exposed for direct unit testing. */
  static computeWindow = computeQuickOpenWindow;
}

export namespace QuickOpenRenderer {
  export const $Class = $QuickOpenRenderer;
  export const Class = Static($QuickOpenRenderer);
}
