// The file-tree pane renderer: turns the visible window of the FileTree model into a StyledText
// for the sidebar body. Extracted from RootView's closure so the tree pane's rendering lives with
// its own contract (smoke-selection, smoke-tree-scroll) instead of inside the god-view. RootView
// still owns the sidebar renderable and the geometry; it hands this a context and mounts the result.
//
// Stateless capability (project.conventions.md): pure statics behind the Static() seam. All model
// reads happen through the passed-in FileTree instance, so reactivity flows when RootView calls
// render() inside its reactive update — no state is held here.
//
// invariant: Renderables hold no model state (src/modules/ui/ui.invariants.md)
// invariant: Only the visible window is rendered (src/modules/ui/ui.invariants.md)
// invariant: Selection is item-anchored, click-set, keyboard-moved, and stays (src/modules/ui/ui.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import type { Palette } from '../theme/ThemePalettes';
import type { FileTree } from '../workspace/FileTree';

export interface TreePaneRenderContext {
  /** The active workspace's file-tree model (rows + selection/hover/scroll state). */
  tree: FileTree.Instance;
  /** True while the files pane owns the keyboard — selection paints at full intensity, else dimmed. */
  filesFocused: boolean;
  palette: Palette;
  /** File-type icon for a row (name, isDir, expanded) — passed in so the renderer needs no Theme. */
  icon: (name: string, isDirectory: boolean, expanded: boolean) => string;
  /** Visible row count (sidebar body height). */
  height: number;
  /** Pane inner width — rows pad to this so the row highlight spans the full width. */
  innerWidth: number;
  /** Text viewport width (inner width minus the scrollbar column). */
  viewportWidth: number;
  /** First visible row index (the flyweight window top). */
  windowTop: number;
}

function $renderTree(context: TreePaneRenderContext): StyledText {
  const { tree, palette, filesFocused, innerWidth, viewportWidth } = context;
  const rows = tree.rows;
  const selectedIndex = tree.selectedIndex.value;
  const hoveredIndex = tree.hoveredIndex.value;
  const top = context.windowTop;
  const visible = rows.slice(top, top + context.height);
  const chunks: TextChunk[] = [];
  visible.forEach((row, visibleIndex) => {
    const rowIndex = top + visibleIndex;
    // Selection truth is independent of focus, hover, and viewport position. Focus changes only its
    // intensity: full while keyboard-active, dim while the editor or another pane owns keys.
    const selected = rowIndex === selectedIndex;
    const selectionFocused = filesFocused;
    const hovered = rowIndex === hoveredIndex;
    // No selection arrow — the row background is the selection signal (the '›' marker was noise).
    const marker = ' ';
    const indent = '  '.repeat(row.depth);
    const icon = context.icon(row.name, row.isDir, row.expanded);
    const completeLabel = `${marker}${indent}${icon} ${row.name}`;
    let label = EditorCoordinates.Class.displayColumnWindow(completeLabel, tree.scrollLeft.value, viewportWidth);
    label = EditorCoordinates.Class.padToDisplayWidth(label, viewportWidth);
    // Pad to the pane's inner width so the row highlight spans the full row (VS Code-style).
    label = EditorCoordinates.Class.padToDisplayWidth(label, innerWidth);
    // Two intensities: selection (stronger) over hover (subtle); bg is the primary signal.
    const rowBackground = selected
      ? selectionFocused
        ? palette.selection
        : palette.cursorLine
      : hovered
        ? palette.cursorLine
        : null;
    const styled = fg(selected && selectionFocused ? palette.accent : palette.fg)(label);
    chunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
    if (visibleIndex < visible.length - 1) chunks.push(fg(palette.fg)('\n'));
  });
  return new StyledText(chunks);
}

class $TreePaneRenderer {
  static render = $renderTree;
}

export namespace TreePaneRenderer {
  export const $Class = $TreePaneRenderer;
  export const Class = Static($TreePaneRenderer);
}
