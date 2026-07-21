// The root frame, rendered from workspace + theme state. A column of
// [ main row: files sidebar | editor ] over a status bar. `update()` re-syncs content from
// state after each input (one-way flow: state → view, never the reverse).
//
// invariant: ivue owns state and OpenTUI owns projection (project.invariants.md)
// invariant: The terminal shows a bounded viewport (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import {
  BoxRenderable,
  TextRenderable,
  StyledText,
  fg,
  type TextChunk,
  type CliRenderer,
} from '@opentui/core';
import type { Workspace } from '../workspace/Workspace';
import type { App } from '../app/App';
import type { Theme } from '../theme/Theme';
import type { CommandRegistry } from '../commands/CommandRegistry';
import type { Palette } from '../theme/theme.palettes';
import { highlightLine, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import { displayColumn, lineWidth, graphemeAtDisplayColumn } from '../editor/editor.coordinates';
import { SelectableText } from './SelectableText';
import { Logging } from '../system/Logging';

function roleColor(role: Role, palette: Palette): string {
  switch (role) {
    case 'keyword': return palette.keyword;
    case 'string': return palette.string;
    case 'number': return palette.number;
    case 'comment': return palette.comment;
    case 'func': return palette.func;
    case 'type': return palette.type;
    case 'operator': return palette.operator;
    default: return palette.fg;
  }
}

const SIDEBAR_WIDTH = 32;

export interface RootView {
  update(): void;
  editorViewportHeight(): number;
  editorViewportWidth(): number;
  dispose(): void;
}

export function buildRootView(
  renderer: CliRenderer,
  workspace: Workspace.Instance,
  theme: Theme.Instance,
  commands: CommandRegistry.Instance,
  app: App.Instance,
): RootView {
  const root = renderer.root;
  const readPalette = () => theme.palette;

  const column = new BoxRenderable(renderer, {
    id: 'root-column',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: readPalette().bg,
  });

  const mainRow = new BoxRenderable(renderer, {
    id: 'main-row',
    flexDirection: 'row',
    flexGrow: 1,
    width: '100%',
  });

  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: SIDEBAR_WIDTH,
    height: '100%',
    border: true,
    borderStyle: 'rounded',
    title: 'Files',
    backgroundColor: readPalette().panel,
  });
  const sidebarBody = new TextRenderable(renderer, { id: 'sidebar-body', content: '' });
  sidebar.add(sidebarBody);

  const editorArea = new BoxRenderable(renderer, {
    id: 'editor-area',
    flexGrow: 1,
    height: '100%',
    border: true,
    borderStyle: 'rounded',
    flexDirection: 'row',
    title: 'Editor',
  });
  // Gutter (line numbers + current-line marker) and code are SEPARATE renderables so the code
  // buffer holds only code — OpenTUI's native selection then never shades the gutter on a
  // multi-line span, and code-local selection coords are pure display columns.
  const gutterBody = new TextRenderable(renderer, { id: 'editor-gutter', content: '' });
  const codeBody = new SelectableText(renderer, {
    id: 'editor-code',
    content: '',
    // selectable:false — OpenTUI's OWN mouse-drag selection is a second writer of selection state
    // that the model never sees: its highlight appeared on drag, then the next paint's
    // applySelection() (reading the EMPTY model selection) wiped it — the human-QA
    // "selection appears then disappears" bug. The model is the one writer; mouse events below
    // drive cursor+anchor, and the native selection is only ever set programmatically from them.
    selectable: false,
    flexGrow: 1,
    // An editor pane NEVER soft-wraps: one file line == one visual row, always; long lines clip at
    // the right edge (horizontal scroll covers the rest). Wrapping desyncs the gutter (which
    // numbers file lines) and every row-based mapping (caret Y, selection rows, click hit-testing).
    wrapMode: 'none',
  });
  editorArea.add(gutterBody);
  editorArea.add(codeBody);

  mainRow.add(sidebar);
  mainRow.add(editorArea);

  const statusBar = new BoxRenderable(renderer, {
    id: 'status-bar',
    width: '100%',
    height: 1,
    flexDirection: 'row',
    backgroundColor: readPalette().statusBg,
  });
  const statusText = new TextRenderable(renderer, { id: 'status-text', content: '' });
  statusBar.add(statusText);

  column.add(mainRow);
  column.add(statusBar);
  root.add(column);

  // Command palette overlay — added last so it renders on top; shown only when open.
  const commandPalette = new BoxRenderable(renderer, {
    id: 'palette',
    position: 'absolute',
    left: '20%',
    top: 2,
    width: '60%',
    border: true,
    borderStyle: 'rounded',
    title: 'Command Palette',
    flexDirection: 'column',
    visible: false,
    zIndex: 100,
  });
  const commandPaletteInput = new TextRenderable(renderer, { id: 'palette-input', content: '' });
  const commandPaletteList = new TextRenderable(renderer, { id: 'palette-list', content: '' });
  commandPalette.add(commandPaletteInput);
  commandPalette.add(commandPaletteList);
  root.add(commandPalette);

  // Interior height of a bordered box = box height - 2 (top+bottom border).
  const editorViewportHeight = () => Math.max(1, (editorArea.height as number) - 2);
  const editorViewportWidth = () => Math.max(1, (editorArea.width as number) - 2 - 6); // gutter

  // First visible tree row (the render window slides to keep the selection on screen); shared by
  // the renderer and the mouse hit-test so clicks land on the row the user actually sees.
  function treeWindowTop(): number {
    const selectedIndex = workspace.tree.selectedIndex.value;
    const height = Math.max(1, (sidebar.height as number) - 2);
    return selectedIndex >= height ? selectedIndex - height + 1 : 0;
  }

  function renderTree(): string {
    const palette = readPalette();
    const rows = workspace.tree.rows;
    const selectedIndex = workspace.tree.selectedIndex.value;
    const height = Math.max(1, (sidebar.height as number) - 2);
    // Flyweight: only render the visible window around the selection.
    const top = treeWindowTop();
    const visible = rows.slice(top, top + height);
    const lines = visible.map((row, visibleIndex) => {
      const rowIndex = top + visibleIndex;
      const indent = '  '.repeat(row.depth);
      const icon = theme.icon(row.name, row.isDir, row.expanded);
      const marker =
        rowIndex === selectedIndex && workspace.focus.value === 'files'
          ? '›'
          : rowIndex === workspace.tree.hoveredIndex.value
            ? '·'
            : ' ';
      let label = `${marker}${indent}${icon} ${row.name}`;
      if (label.length > SIDEBAR_WIDTH - 2) label = label.slice(0, SIDEBAR_WIDTH - 2);
      return label;
    });
    return lines.join('\n');
  }

  const EMPTY_STATE = [
    '',
    '   Fable — a terminal code workspace',
    '',
    '   ↑/↓  navigate files      Enter  open / expand',
    '   Tab  switch pane         Ctrl+P command palette',
    '   Ctrl+Q or F10  quit   (VS Code: Ctrl+X then Ctrl+C)',
    '',
  ].join('\n');

  // Gutter width in cells for the current document: "NN " (line number + space) + 1 marker cell.
  const gutterWidth = () => String(workspace.editor.document.lineCount).length + 1 + 2;

  // Builds the visible window as two aligned StyledTexts — the gutter (line numbers + current-line
  // marker) and the code (syntax colors only, NO gutter). Only the visible lines are tokenized
  // (flyweight). Returns null for the empty state.
  function renderEditor(): { gutter: StyledText; code: StyledText } | null {
    const editor = workspace.editor;
    if (!editor.hasDocument.value) return null;
    const palette = readPalette();
    const language = LanguageRegistry.Class.forPath(editor.document.path);
    const height = editorViewportHeight();
    const top = editor.viewport.scrollTop.value;
    const visibleLines = editor.document.slice(top, height);
    const lineNumberWidth = String(editor.document.lineCount).length + 1;
    const currentLineIndex = editor.cursor.line.value;
    const focused = workspace.focus.value === 'editor';
    const gutterChunks: TextChunk[] = [];
    const codeChunks: TextChunk[] = [];
    visibleLines.forEach((text, visibleIndex) => {
      const lineNumber = top + visibleIndex;
      const isCurrentLine = lineNumber === currentLineIndex;
      const lineNumberText = String(lineNumber + 1).padStart(lineNumberWidth, ' ');
      gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
      gutterChunks.push(fg(palette.accent)(isCurrentLine && focused ? '▏' : ' '));
      if (editor.document.binary.value || language === 'plain') {
        codeChunks.push(fg(palette.fg)(text));
      } else {
        for (const span of highlightLine(text, language)) {
          codeChunks.push(fg(roleColor(span.role, palette))(span.text));
        }
      }
      if (visibleIndex < visibleLines.length - 1) {
        gutterChunks.push(fg(palette.fg)('\n'));
        codeChunks.push(fg(palette.fg)('\n'));
      }
    });
    return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks) };
  }

  // Drive OpenTUI's native selection on the code renderable from the model selection, mapped into
  // code-local coords (x = display column, y = visible-line index). Clamps to the visible window.
  // invariant: The selected range renders with a background (ui.invariants.md)
  function applySelection(): void {
    const editor = workspace.editor;
    const selection = editor.hasDocument.value ? editor.cursor.selectionRange() : null;
    const top = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    if (!selection || selection.end.line < top || selection.start.line >= top + viewportHeight) {
      codeBody.clearSelectionRange();
      return;
    }
    const anchorY = Math.max(0, selection.start.line - top);
    const anchorX = selection.start.line >= top ? displayColumn(editor.document.line(selection.start.line), selection.start.col) : 0;
    const focusY = Math.min(viewportHeight - 1, selection.end.line - top);
    const focusX =
      selection.end.line < top + viewportHeight
        ? displayColumn(editor.document.line(selection.end.line), selection.end.col)
        : lineWidth(editor.document.line(Math.min(top + viewportHeight - 1, editor.document.lineCount - 1)));
    codeBody.setSelectionRange(anchorX, anchorY, focusX, focusY);
  }

  // The git sidebar: a changes region (staged/unstaged/untracked + branch header) over a
  // VIRTUALIZED commit log (only the visible window is materialized, via CommitLog.rows). Split by
  // gitPanel.splitRatio. Keyboard-driven for now; mouse + drill-down + drag layer on next.
  // invariant: Cost tracks the actively observed set (project.invariants.md)
  function renderGitPanel(): StyledText {
    const palette = readPalette();
    const clip = (text: string) => (text.length > SIDEBAR_WIDTH - 2 ? text.slice(0, SIDEBAR_WIDTH - 2) : text);
    const chunks: TextChunk[] = [];
    const push = (text: string, color: string, newline = true) => {
      chunks.push(fg(color)(clip(text)));
      if (newline) chunks.push(fg(palette.fg)('\n'));
    };
    const git = workspace.git.value;
    const gitPanel = workspace.gitPanel;
    const active = workspace.focus.value === 'git';
    if (!git) return new StyledText([fg(palette.dim)('  no repository')]);

    const bodyHeight = Math.max(1, (sidebar.height as number) - 2);
    push(` ${git.branch.value || '(no branch)'}  ${git.head.value.slice(0, 7)}`, palette.accent);
    if (git.error.value) {
      push(`  ${git.error.value}`, palette.number);
      return new StyledText(chunks);
    }

    // Changes region (top). Rows: staged (green), unstaged (yellow), untracked (dim).
    const rows: { label: string; color: string }[] = [];
    for (const file of git.staged.value) rows.push({ label: `+ ${file.xy.trim() || 'M'} ${file.path}`, color: palette.string });
    for (const file of git.unstaged.value) rows.push({ label: `  ${file.xy.trim() || 'M'} ${file.path}`, color: palette.number });
    for (const file of git.untracked.value) rows.push({ label: `? ${file.path}`, color: palette.dim });
    const topHeight = Math.max(2, Math.floor(bodyHeight * gitPanel.splitRatio.value));
    if (rows.length === 0) push('  (working tree clean)', palette.dim);
    else
      rows.slice(0, topHeight - 1).forEach((row, index) => {
        const marker = active && gitPanel.region.value === 'changes' && index === gitPanel.changesIndex.value ? '›' : ' ';
        push(`${marker}${row.label}`, row.color);
      });

    push('─'.repeat(SIDEBAR_WIDTH - 2), palette.border);

    // Commit log region (bottom) — virtualized: only the visible window is read from the cache.
    const logHeight = Math.max(1, bodyHeight - topHeight - 1);
    const commitLog = workspace.commitLog.value;
    if (commitLog) {
      const top = gitPanel.logScrollTop.value;
      const visibleCommits = commitLog.rows(top, logHeight);
      visibleCommits.forEach((record, index) => {
        const commitIndex = top + index;
        const marker = active && gitPanel.region.value === 'log' && commitIndex === gitPanel.logIndex.value ? '›' : ' ';
        if (record) push(`${marker}${record.shortSha} ${record.subject}`, palette.fg, index < visibleCommits.length - 1);
        else push(`${marker}…`, palette.dim, index < visibleCommits.length - 1);
      });
    }
    return new StyledText(chunks);
  }

  function renderStatus(): string {
    const editor = workspace.editor;
    const parts: string[] = [` ${workspace.name.value || '—'}`];
    if (editor.hasDocument.value) {
      parts.push(editor.title);
      parts.push(`Ln ${editor.cursor.line.value + 1}, Col ${editor.cursor.col.value + 1}`);
      parts.push(`${editor.document.lineCount} lines`);
    }
    parts.push(workspace.focus.value === 'files' ? '[Files]' : '[Editor]');
    parts.push(
      app.quitChordArmed.value ? 'Ctrl+X armed — Ctrl+C quits' : 'Ctrl+Q/F10 quit',
    );
    return parts.join('  ·  ');
  }

  function update(): void {
    const palette = readPalette();
    column.backgroundColor = palette.bg;
    const gitView = workspace.focus.value === 'git';
    sidebar.backgroundColor = palette.panel;
    sidebar.borderColor = workspace.focus.value === 'files' || gitView ? palette.borderActive : palette.border;
    sidebar.titleColor = workspace.focus.value === 'files' || gitView ? palette.accent : palette.dim;
    sidebar.title = gitView ? 'Git' : 'Files';
    editorArea.backgroundColor = palette.bg;
    editorArea.borderColor = workspace.focus.value === 'editor' ? palette.borderActive : palette.border;
    editorArea.title = workspace.editor.hasDocument.value ? workspace.editor.title : 'Editor';
    editorArea.titleColor = workspace.focus.value === 'editor' ? palette.accent : palette.dim;
    statusBar.backgroundColor = palette.statusBg;

    sidebarBody.content = gitView ? renderGitPanel() : renderTree();
    sidebarBody.fg = palette.fg;
    const rendered = renderEditor();
    if (rendered) {
      gutterBody.width = gutterWidth();
      gutterBody.content = rendered.gutter;
      codeBody.content = rendered.code;
    } else {
      gutterBody.width = 0;
      gutterBody.content = '';
      codeBody.content = EMPTY_STATE;
    }
    codeBody.fg = palette.fg;
    codeBody.selectionBg = palette.selection;
    applySelection(); // after content is set, so selection maps onto the current buffer
    statusText.content = renderStatus();
    statusText.fg = palette.dim;

    // Palette overlay.
    const open = commands.open.value;
    commandPalette.visible = open;
    if (open) {
      commandPalette.borderColor = palette.borderActive;
      commandPalette.titleColor = palette.accent;
      commandPalette.backgroundColor = palette.panel;
      commandPaletteInput.content = `> ${commands.query.value}▏`;
      commandPaletteInput.fg = palette.fg;
      const items = commands.filtered.slice(0, 12);
      const selectedIndex = commands.selectedIndex.value;
      commandPaletteList.content = items.length
        ? items
            .map((command, index) => `${index === selectedIndex ? '›' : ' '} ${command.title}`)
            .join('\n')
        : '  (no matching commands)';
      commandPaletteList.fg = palette.dim;
    }

    // Native terminal caret at the cursor's DISPLAY column (tab/wide aware). Shown only when the
    // editor is focused, has a document, no palette overlay, and the cursor line is on screen.
    // invariant: The caret renders at the cursor display column (ui.invariants.md)
    const editor = workspace.editor;
    const scrollTop = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    const cursorLine = editor.cursor.line.value;
    if (editor.hasDocument.value && workspace.focus.value === 'editor' && !open && cursorLine >= scrollTop && cursorLine < scrollTop + viewportHeight) {
      const cursorDisplayColumn = displayColumn(editor.document.line(cursorLine), editor.cursor.col.value);
      // Anchor the caret to the code renderable's ACTUAL laid-out screen cell (codeBody.x/y from
      // yoga), not hand-derived layout constants — the constants drifted from the real layout (the
      // human-QA off-by-one) and would break again when the sidebar becomes draggable.
      const caretCellX = codeBody.x + cursorDisplayColumn;
      const caretCellY = codeBody.y + (cursorLine - scrollTop);
      // The native terminal cursor is 1-BASED (ANSI CUP): +1 on both axes — OpenTUI's own
      // renderCursor does `screenX + visualCol + 1`.
      renderer.setCursorPosition(caretCellX + 1, caretCellY + 1, true);
    } else {
      renderer.setCursorPosition(0, 0, false);
    }
  }

  // Mouse wheel, POSITION-ROUTED: OpenTUI hit-tests the pointer to the pane under it and calls its
  // onMouseScroll (events bubble to the box). Each scrollable pane mutates only its own window
  // (scrollTop / selection), never materializing the whole list — the frame effect observes those
  // signals and repaints. invariant: Cost tracks the actively observed set (project.invariants.md)
  const WHEEL_STEP = 3;
  const wheelDelta = (event: { scroll?: { direction?: string } }): number =>
    (event.scroll?.direction === 'up' ? -1 : 1) * WHEEL_STEP;
  sidebar.onMouseScroll = (event) => {
    if (workspace.focus.value === 'git') workspace.impulseGitLog(event.scroll?.direction === 'up' ? -1 : 1); // momentum glide
    else workspace.tree.moveSelection(wheelDelta(event));
  };
  editorArea.onMouseScroll = (event) => {
    if (workspace.editor.hasDocument.value)
      workspace.editor.viewport.scrollBy(wheelDelta(event), workspace.editor.document.lineCount);
  };

  // Mouse selection drives the MODEL (cursor + anchor) — the single writer; the native highlight
  // is then applied FROM the model by applySelection() each paint, so it persists across repaints
  // and Ctrl+C copies exactly what is highlighted.
  // invariant: The selected range renders with a background (ui.invariants.md)
  const documentPositionAtCell = (cellX: number, cellY: number): { line: number; column: number } | null => {
    if (!workspace.editor.hasDocument.value) return null;
    const line = Math.max(
      0,
      Math.min(
        workspace.editor.viewport.scrollTop.value + (cellY - codeBody.y),
        workspace.editor.document.lineCount - 1,
      ),
    );
    const column = graphemeAtDisplayColumn(workspace.editor.document.line(line), cellX - codeBody.x);
    return { line, column };
  };
  codeBody.onMouseDown = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDown (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    workspace.focusEditor(); // click-to-focus
    workspace.editor.placeCursor(hit.line, hit.column);
    workspace.editor.cursor.setAnchorHere(); // anchor at the press; dragging extends from here
  };
  codeBody.onMouseDrag = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDrag (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    workspace.editor.placeCursor(hit.line, hit.column); // anchor stays — selection = anchor -> cursor
  };
  codeBody.onMouseUp = () => {
    // A plain click (no drag) leaves anchor == cursor: clear it so no empty selection lingers.
    if (!workspace.editor.cursor.hasSelection) workspace.editor.cursor.clearSelection();
  };

  // Sidebar clicks: focus follows the click (files or git view), and a click on a tree row SELECTS
  // it — clicking the already-selected row ACTIVATES it (open file / toggle folder). Keyboard
  // parity holds: everything here is also reachable via arrows/Enter.
  // Hover highlight (enhancement only — selection/activation stay on click/keys). The hovered row
  // is model view-state so the frame effect repaints when it changes; cost is one marker cell.
  sidebar.onMouseMove = (event) => {
    if (workspace.focus.value === 'git') return;
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1));
    workspace.tree.hoveredIndex.value =
      rowIndex >= 0 && rowIndex < workspace.tree.rows.length ? rowIndex : -1;
  };
  sidebar.onMouseOut = () => {
    workspace.tree.hoveredIndex.value = -1;
  };

  sidebar.onMouseDown = (event) => {
    if (workspace.focus.value === 'git') {
      // Git rows get click-select with the changes-list treatment; for now the click just keeps
      // focus on the git panel.
      workspace.focusGit();
      return;
    }
    workspace.focusFiles(); // click-to-focus
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1)); // +1: sidebar top border
    if (rowIndex < 0 || rowIndex >= workspace.tree.rows.length) return;
    if (workspace.tree.selectedIndex.value === rowIndex) {
      workspace.activate(); // second click on the selected row opens/toggles
    } else {
      workspace.tree.selectedIndex.value = rowIndex;
    }
  };

  update();

  return {
    update,
    editorViewportHeight,
    editorViewportWidth,
    dispose() {
      try {
        root.remove(column);
        column.destroyRecursively();
      } catch {
        /* ignore */
      }
    },
  };
}
