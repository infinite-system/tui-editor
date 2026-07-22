// The editor pane controller: owns the code body's behaviour — the wrap-mode visual-row window, the
// document⇄cell coordinate mapping, the model→native selection sync, the selection-drag behaviour,
// Ctrl/Cmd+click go-to-definition, and the wheel scroll. It also drives the pane RENDER by delegating
// to EditorPaneRenderer and storing the returned wrap window (the caret block, applySelection, and
// the hit-test all read it — so it is the one source of truth, kept here).
//
// RootView still constructs + mounts the renderables and owns the editor viewport geometry (it is in
// RootView's public interface) and the diff/markdown mount; those come in as accessors.
import type { BoxRenderable, CliRenderer, StyledText } from '@opentui/core';
import { Reactive } from 'ivue';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { EditorWrap, type VisualRow } from '../editor/EditorWrap';
import { EditorPaneRenderer } from './EditorPaneRenderer';
import { ScrollGesture } from './ScrollGesture';
import { SelectionDragBehavior } from './SelectionDragBehavior';
import { SelectableText } from './SelectableText';
import { Logging } from '../system/Logging';
import type { Palette } from '../theme/ThemePalettes';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { FindBar } from '../search/FindBar';
import type { Settings } from '../settings/Settings';

export interface EditorPaneDeps {
  renderer: CliRenderer;
  editorArea: BoxRenderable;
  codeBody: SelectableText;
  workspaceSet: WorkspaceSet.Instance;
  findBar: FindBar.Instance;
  settings: Settings.Instance;
  readPalette: () => Palette;
  editorViewportHeight: () => number;
  editorViewportWidth: () => number;
  /** Focus the markdown split's source pane on an editor click (no-op when no split is mounted). */
  focusMarkdownSource: () => void;
  /** The LSP hover-card handle: a mouse-move over a symbol points it; leaving the code clears it. */
  hover: { pointAt(position: { line: number; column: number }, screenX: number, screenY: number): void; clear(): void };
}

class $EditorPane {
  // Wrap-mode view geometry of the last-rendered frame: the visual rows the window showed, written by
  // renderEditor and read by the caret block, applySelection, and the mouse hit-test — so all
  // consumers agree on what is where. Empty when wrap is off.
  private wrapRowsWindow: VisualRow[] = [];
  private readonly drag: SelectionDragBehavior;

  constructor(private readonly deps: EditorPaneDeps) {
    this.drag = this.buildDragBehavior();
    this.wireHandlers();
  }

  /** Render the editor window (delegates to EditorPaneRenderer); stores the wrap window. Returns null
   *  for the empty state (diff shown / no document), leaving the stored window untouched. */
  renderEditor(): { gutter: StyledText; code: StyledText } | null {
    const { workspaceSet, readPalette, editorViewportHeight, editorViewportWidth, findBar } = this.deps;
    const result = EditorPaneRenderer.Class.render({
      workspace: workspaceSet.active,
      palette: readPalette(),
      viewportHeight: editorViewportHeight(),
      viewportWidth: editorViewportWidth(),
      findEngineFor: (documentPath) => findBar.engineFor(`source:${documentPath}`),
    });
    if (!result) return null;
    this.wrapRowsWindow = result.wrapRowsWindow;
    return { gutter: result.gutter, code: result.code };
  }

  /** Advance the selection-drag auto-scroll; true while it still needs frames. */
  tickDrag(deltaTimeSeconds: number): boolean {
    return this.drag.tick(deltaTimeSeconds);
  }

  // Map a document (line, column) to its wrap-mode viewport cell (row within the window + local
  // display column), or 'before'/'after' when it is off the window on that side. Public: the caret
  // block in RootView's update() reads it too, to place the native terminal cursor in wrap mode.
  wrapVisualPosition(line: number, column: number): { rowIndex: number; column: number } | 'before' | 'after' {
    const { workspaceSet } = this.deps;
    const firstRow = this.wrapRowsWindow[0];
    const lastRow = this.wrapRowsWindow[this.wrapRowsWindow.length - 1];
    if (!firstRow || !lastRow) return 'before';
    const lineText = workspaceSet.active.editor.document.line(line);
    const segments = EditorWrap.Class.wrapLine(lineText, workspaceSet.active.editor.wrapWidth());
    const segmentIndex = EditorWrap.Class.segmentIndexForCursor(segments, column);
    if (line < firstRow.lineIndex || (line === firstRow.lineIndex && segmentIndex < firstRow.segmentIndex))
      return 'before';
    if (line > lastRow.lineIndex || (line === lastRow.lineIndex && segmentIndex > lastRow.segmentIndex))
      return 'after';
    const rowIndex = this.wrapRowsWindow.findIndex(
      (row) => row.lineIndex === line && row.segmentIndex === segmentIndex,
    );
    if (rowIndex < 0) return 'after';
    const segment = segments[segmentIndex];
    return { rowIndex, column: EditorCoordinates.Class.displayColumn(lineText, column) - (segment?.startDisplayColumn ?? 0) };
  }

  // Drive OpenTUI's native selection on the code renderable from the model selection, mapped into
  // code-local coords (x = display column, y = visible-line index). Clamps to the visible window.
  // invariant: The selected range renders with a background (src/modules/ui/ui.invariants.md)
  applySelection(): void {
    const { workspaceSet, codeBody, editorViewportHeight, editorViewportWidth } = this.deps;
    const editor = workspaceSet.active.editor;
    const selection = editor.hasDocument.value ? editor.cursor.selectionRange() : null;
    const top = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    if (editor.wordWrap.value) {
      // Wrap mode: the native selection coords are viewport-local VISUAL rows — map both ends through
      // the ONE logical↔visual layer, clamping off-window ends to the window edges.
      if (!selection || this.wrapRowsWindow.length === 0) {
        codeBody.clearSelectionRange();
        return;
      }
      const startPosition = this.wrapVisualPosition(selection.start.line, selection.start.col);
      const endPosition = this.wrapVisualPosition(selection.end.line, selection.end.col);
      if (startPosition === 'after' || endPosition === 'before') {
        codeBody.clearSelectionRange();
        return;
      }
      const anchorCell = startPosition === 'before' ? { rowIndex: 0, column: 0 } : startPosition;
      const focusCell =
        endPosition === 'after'
          ? { rowIndex: this.wrapRowsWindow.length - 1, column: editorViewportWidth() }
          : endPosition;
      codeBody.setSelectionRange(
        Math.max(0, anchorCell.column),
        anchorCell.rowIndex,
        Math.max(0, focusCell.column),
        focusCell.rowIndex,
      );
      return;
    }
    if (!selection || selection.end.line < top || selection.start.line >= top + viewportHeight) {
      codeBody.clearSelectionRange();
      return;
    }
    const selectionScrollLeft = editor.viewport.scrollLeft.value;
    const anchorY = Math.max(0, selection.start.line - top);
    const anchorX = selection.start.line >= top ? EditorCoordinates.Class.displayColumn(editor.document.line(selection.start.line), selection.start.col) : 0;
    const focusY = Math.min(viewportHeight - 1, selection.end.line - top);
    const focusX =
      selection.end.line < top + viewportHeight
        ? EditorCoordinates.Class.displayColumn(editor.document.line(selection.end.line), selection.end.col)
        : EditorCoordinates.Class.lineWidth(editor.document.line(Math.min(top + viewportHeight - 1, editor.document.lineCount - 1)));
    codeBody.setSelectionRange(
      Math.max(0, anchorX - selectionScrollLeft),
      anchorY,
      Math.max(0, focusX - selectionScrollLeft),
      focusY,
    );
  }

  // Public so RootView/HoverCard can map a screen cell to a document position (mirrors wrapVisualPosition).
  documentPositionAtCell(cellX: number, cellY: number): { line: number; column: number } | null {
    const { workspaceSet, codeBody } = this.deps;
    if (!workspaceSet.active.editor.hasDocument.value) return null;
    if (workspaceSet.active.editor.wordWrap.value) {
      // Wrap mode: a viewport row is a VISUAL row — resolve it through the rendered window, then
      // hit-test the display column WITHIN that row's segment (clamped into the segment so a click
      // past a wrapped row's end lands on its last grapheme, not the next row's first).
      if (this.wrapRowsWindow.length === 0) return null;
      const rowIndex = Math.max(0, Math.min(cellY - codeBody.y, this.wrapRowsWindow.length - 1));
      const row = this.wrapRowsWindow[rowIndex];
      if (!row) return null;
      const lineText = workspaceSet.active.editor.document.line(row.lineIndex);
      const segments = EditorWrap.Class.wrapLine(lineText, workspaceSet.active.editor.wrapWidth());
      const lastSegmentOfLine = row.segmentIndex === segments.length - 1;
      const hitColumn = EditorCoordinates.Class.graphemeAtDisplayColumn(
        lineText,
        row.segment.startDisplayColumn + Math.max(0, cellX - codeBody.x),
      );
      const maxColumn = lastSegmentOfLine
        ? row.segment.endGrapheme
        : Math.max(row.segment.startGrapheme, row.segment.endGrapheme - 1);
      return {
        line: row.lineIndex,
        column: Math.max(row.segment.startGrapheme, Math.min(hitColumn, maxColumn)),
      };
    }
    const line = Math.max(
      0,
      Math.min(
        workspaceSet.active.editor.viewport.scrollTop.value + (cellY - codeBody.y),
        workspaceSet.active.editor.document.lineCount - 1,
      ),
    );
    const column = EditorCoordinates.Class.graphemeAtDisplayColumn(
      workspaceSet.active.editor.document.line(line),
      workspaceSet.active.editor.viewport.scrollLeft.value + (cellX - codeBody.x),
    );
    return { line, column };
  }

  private scrollEditorVertically(delta: number): void {
    const editor = this.deps.workspaceSet.active.editor;
    const editorViewport = editor.viewport;
    if (editor.wordWrap.value) {
      // scrollTop is a VISUAL-row offset; clamp to the wrapped extent so the last visual row is reachable.
      const maxTop = Math.max(0, EditorWrap.Class.totalVisualRows(editor.document, editor.wrapWidth()) - editorViewport.height.value);
      editorViewport.scrollTop.value = Math.max(0, Math.min(editorViewport.scrollTop.value + delta, maxTop));
    } else {
      editorViewport.scrollBy(delta, editor.document.lineCount);
    }
  }

  // One shared drag/autoscroll behavior serves this editor and DiffView. The hosts differ only in
  // coordinate mapping and scroll storage; pointer lifecycle, edge zones, rate, and re-extension are
  // identical. invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  private buildDragBehavior(): SelectionDragBehavior {
    const { workspaceSet, codeBody, editorViewportHeight, editorViewportWidth } = this.deps;
    return new SelectionDragBehavior({
      viewportRectangle: () => ({
        leftColumn: codeBody.x,
        rightColumn: codeBody.x + Math.max(1, editorViewportWidth()) - 1,
        topRow: codeBody.y,
        bottomRow: codeBody.y + Math.max(1, editorViewportHeight()) - 1,
      }),
      positionAtCell: (cellX, cellY) => this.documentPositionAtCell(cellX, cellY),
      horizontalScrollPosition: () => workspaceSet.active.editor.viewport.scrollLeft.value,
      horizontalScrollingEnabled: () => !workspaceSet.active.editor.wordWrap.value,
      beginSelection: (position) => {
        workspaceSet.active.focusEditor();
        workspaceSet.active.editor.placeCursor(position.line, position.column);
        workspaceSet.active.editor.cursor.setAnchorHere();
      },
      extendSelection: (position, pointerDisplayColumn) => {
        // Direct Cursor.set preserves the pointer's display-column goal while short lines clamp the
        // landing column; placeCursor would reveal/yank the viewport during a diagonal drag.
        workspaceSet.active.editor.cursor.set(position.line, position.column, pointerDisplayColumn);
      },
      finishSelection: () => {
        if (!workspaceSet.active.editor.cursor.hasSelection) workspaceSet.active.editor.cursor.clearSelection();
      },
      scrollColumns: (columnDelta) => {
        const topLineIndex = workspaceSet.active.editor.viewport.scrollTop.value;
        let widestVisibleLineWidth = 0;
        for (const line of workspaceSet.active.editor.document.slice(topLineIndex, editorViewportHeight())) {
          widestVisibleLineWidth = Math.max(widestVisibleLineWidth, EditorCoordinates.Class.lineWidth(line));
        }
        workspaceSet.active.editor.viewport.scrollByColumns(columnDelta, widestVisibleLineWidth);
      },
      scrollRows: (delta) => this.scrollEditorVertically(delta),
      haltCompetingScroll: () => workspaceSet.active.editor.viewport.haltScrollMomentum(),
    });
  }

  private wireHandlers(): void {
    const { editorArea, codeBody, workspaceSet, settings, focusMarkdownSource, hover } = this.deps;

    editorArea.onMouseScroll = (event) => {
      if (!workspaceSet.active.editor.hasDocument.value) return;
      // Horizontal scroll arrives by SEVERAL terminal-dependent encodings; route them ALL to columns.
      const direction = event.scroll?.direction;
      const step = ScrollGesture.Class.wheelStep(event, settings);
      if (workspaceSet.active.editor.wordWrap.value) {
        // Wrap mode: ONE scroll axis (horizontal gestures route to the vertical window), fed through the
        // SAME momentum engine as non-wrap so a wheel notch GLIDES then decays.
        const backward = direction === 'left' || direction === 'up';
        workspaceSet.active.impulseEditorVerticalScroll((backward ? -1 : 1) * step);
      } else {
        const modifierHorizontal = ScrollGesture.Class.modifierHeld(event, settings.horizontalScrollModifier.value);
        const horizontal = direction === 'left' || direction === 'right' || modifierHorizontal;
        if (horizontal) {
          const backward = direction === 'left' || direction === 'up';
          workspaceSet.active.impulseEditorHorizontalScroll((backward ? -1 : 1) * step);
        } else {
          workspaceSet.active.impulseEditorVerticalScroll((direction === 'up' ? -1 : 1) * step);
        }
      }
    };

    codeBody.onMouseDown = (event) => {
      focusMarkdownSource();
      if (process.env.TUI_DEBUG_MOUSE === '1') {
        Logging.Class.info(`mouseDown (${event.x},${event.y}) hit=${JSON.stringify(this.documentPositionAtCell(event.x, event.y))}`);
      }
      // Ctrl/Cmd+click on a symbol = go to definition (VS Code style). OpenTUI exposes terminal
      // Meta/Super mouse modifiers through the SGR alt bit, so ctrl OR alt covers Ctrl-click and
      // terminal Cmd/Meta-click without a second path. The event is consumed here — never a select begin.
      // invariant: A definition gesture jumps to the declaration (src/modules/lsp/lsp.invariants.md)
      if (event.button === 0 && (event.modifiers.ctrl || event.modifiers.alt)) {
        const definitionPosition = this.documentPositionAtCell(event.x, event.y);
        if (definitionPosition) {
          workspaceSet.active.focusEditor();
          void workspaceSet.active.goToDefinition(definitionPosition);
          return;
        }
      }
      this.drag.begin(event.x, event.y);
    };
    codeBody.onMouseDrag = (event) => {
      if (process.env.TUI_DEBUG_MOUSE === '1') {
        Logging.Class.info(`mouseDrag (${event.x},${event.y}) hit=${JSON.stringify(this.documentPositionAtCell(event.x, event.y))}`);
      }
      this.drag.drag(event.x, event.y);
    };
    codeBody.onMouseUp = () => this.drag.end();
    codeBody.onMouseDragEnd = () => this.drag.end();
    // Mouse-move over a code cell arms the LSP hover card for the symbol there (a >0.5s dwell shows
    // the language server's type/docs). Moving off any document, or over an empty cell, clears it.
    // invariant: A hover card reflects the language server's type at the pointed symbol (src/modules/ui/ui.invariants.md)
    codeBody.onMouseMove = (event) => {
      if (!workspaceSet.active.editor.hasDocument.value) {
        hover.clear();
        return;
      }
      const position = this.documentPositionAtCell(event.x, event.y);
      if (position) hover.pointAt(position, event.x, event.y);
      else hover.clear();
    };
  }
}

export namespace EditorPane {
  export const $Class = $EditorPane;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
