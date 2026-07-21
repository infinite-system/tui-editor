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
  bg,
  bold,
  ScrollBarRenderable,
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
import { displayColumn, lineWidth, graphemeAtDisplayColumn, graphemeToU16 } from '../editor/editor.coordinates';
import { SelectableText } from './SelectableText';
import { buildChangeRows, nextFileRow } from '../git/git.rows';
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
  /** Frame-tick hook: advance drag-edge auto-scroll; true while active (keep frames coming). */
  tickDragAutoScroll(dtSeconds: number): boolean;
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

  // Thin draggable scrollbars (OpenTUI ScrollBar: built-in draggable thumb + onChange). Each bar
  // is a 1-cell strip INSIDE its pane's border; onChange writes the SAME model offset the wheel
  // and keyboard write (One-Writer: the newest input wins; momentum halts on thumb drags).
  const editorVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'editor-scrollbar-v',
    orientation: 'vertical',
    position: 'absolute',
    right: 0,
    top: 1,
    width: 1,
    showArrows: false,
    onChange: (position) => {
      workspace.editor.viewport.scrollTop.value = Math.max(0, Math.round(position));
    },
  });
  const editorHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'editor-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    left: 1,
    bottom: 0,
    height: 1,
    showArrows: false,
    onChange: (position) => {
      workspace.editor.viewport.scrollLeft.value = Math.max(0, Math.round(position));
    },
  });
  editorArea.add(editorVerticalBar);
  editorArea.add(editorHorizontalBar);
  const changesBar = new ScrollBarRenderable(renderer, {
    id: 'git-changes-scrollbar',
    orientation: 'vertical',
    position: 'absolute',
    right: 0,
    width: 1,
    showArrows: false,
    onChange: (position) => {
      workspace.gitPanel.changesScrollTop.value = Math.max(0, Math.round(position));
    },
  });
  const logBar = new ScrollBarRenderable(renderer, {
    id: 'git-log-scrollbar',
    orientation: 'vertical',
    position: 'absolute',
    right: 0,
    width: 1,
    showArrows: false,
    onChange: (position) => {
      workspace.haltGitLogScroll(); // thumb drag adopts authority (One-Writer)
      workspace.gitPanel.logScrollTop.value = Math.max(0, Math.round(position));
      void workspace.commitLog.value?.ensureRange(workspace.gitPanel.logScrollTop.value, 50);
    },
  });
  sidebar.add(changesBar);
  sidebar.add(logBar);

  // Sync bar geometry + positions from the models each paint (bars auto-hide when content fits).
  function syncScrollbars(): void {
    const editor = workspace.editor;
    const editorVisible = editor.hasDocument.value;
    const viewportHeight = editorViewportHeight();
    editorVerticalBar.height = viewportHeight;
    editorVerticalBar.scrollSize = editorVisible ? editor.document.lineCount : 0;
    editorVerticalBar.viewportSize = viewportHeight;
    editorVerticalBar.scrollPosition = editor.viewport.scrollTop.value;
    const viewportWidth = editorViewportWidth();
    let widestVisible = 0;
    if (editorVisible) {
      const top = editor.viewport.scrollTop.value;
      for (const line of editor.document.slice(top, viewportHeight)) {
        widestVisible = Math.max(widestVisible, lineWidth(line));
      }
    }
    editorHorizontalBar.width = Math.max(1, (editorArea.width as number) - 2);
    editorHorizontalBar.scrollSize = widestVisible;
    editorHorizontalBar.viewportSize = viewportWidth;
    editorHorizontalBar.scrollPosition = editor.viewport.scrollLeft.value;

    const gitVisible = workspace.focus.value === 'git' && workspace.git.value !== null;
    const changeRowCount = gitVisible ? gitChangeRowsNow().length : 0;
    changesBar.top = 2;
    changesBar.height = Math.max(1, gitPanelGeometry.changesRows);
    changesBar.scrollSize = gitVisible ? changeRowCount : 0;
    changesBar.viewportSize = gitPanelGeometry.changesRows;
    changesBar.scrollPosition = workspace.gitPanel.changesScrollTop.value;
    const knownEnd = workspace.commitLog.value?.knownEnd.value ?? Number.POSITIVE_INFINITY;
    logBar.top = gitPanelGeometry.dividerRow + 1;
    logBar.height = Math.max(1, gitPanelGeometry.logRows);
    // Unknown history length: a rolling virtual size keeps the thumb draggable; it refines once
    // the end is discovered (a short page sets knownEnd).
    logBar.scrollSize = gitVisible
      ? Number.isFinite(knownEnd)
        ? (knownEnd as number)
        : workspace.gitPanel.logScrollTop.value + gitPanelGeometry.logRows * 4
      : 0;
    logBar.viewportSize = gitPanelGeometry.logRows;
    logBar.scrollPosition = workspace.gitPanel.logScrollTop.value;
  }


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

  function renderTree(): StyledText {
    const palette = readPalette();
    const rows = workspace.tree.rows;
    const selectedIndex = workspace.tree.selectedIndex.value;
    const hoveredIndex = workspace.tree.hoveredIndex.value;
    const height = Math.max(1, (sidebar.height as number) - 2);
    const innerWidth = SIDEBAR_WIDTH - 2;
    // Flyweight: only render the visible window around the selection.
    const top = treeWindowTop();
    const visible = rows.slice(top, top + height);
    const chunks: TextChunk[] = [];
    visible.forEach((row, visibleIndex) => {
      const rowIndex = top + visibleIndex;
      const selected = rowIndex === selectedIndex && workspace.focus.value === 'files';
      const hovered = rowIndex === hoveredIndex;
      const marker = selected ? '›' : ' ';
      const indent = '  '.repeat(row.depth);
      const icon = theme.icon(row.name, row.isDir, row.expanded);
      let label = `${marker}${indent}${icon} ${row.name}`;
      if (label.length > innerWidth) label = label.slice(0, innerWidth);
      // Pad to the pane's inner width so the row highlight spans the full row (VS Code-style).
      label = label.padEnd(innerWidth, ' ');
      // Two intensities: selection (stronger) over hover (subtle); bg is the primary signal.
      const rowBackground = selected ? palette.selection : hovered ? palette.cursorLine : null;
      const styled = fg(selected ? palette.accent : palette.fg)(label);
      chunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
      if (visibleIndex < visible.length - 1) chunks.push(fg(palette.fg)('\n'));
    });
    return new StyledText(chunks);
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
    // COLUMN virtualization (the horizontal twin of the line flyweight): each visible line is
    // sliced to the visible display-column window BEFORE tokenizing, so per-frame cost tracks
    // visible columns — never total line length (50k-char lines render at normal speed).
    // Trade-off: tokens start at the slice, so left-context-sensitive highlighting can differ at
    // the boundary (documented in the contract).
    // invariant: Cost tracks the actively observed set (project.invariants.md)
    const scrollLeft = editor.viewport.scrollLeft.value;
    const viewportWidth = editorViewportWidth();
    visibleLines.forEach((text, visibleIndex) => {
      const lineNumber = top + visibleIndex;
      const isCurrentLine = lineNumber === currentLineIndex;
      const lineNumberText = String(lineNumber + 1).padStart(lineNumberWidth, ' ');
      gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
      gutterChunks.push(fg(palette.accent)(isCurrentLine && focused ? '▏' : ' '));
      let windowText = text;
      if (scrollLeft > 0 || text.length > viewportWidth) { // O(1) test; a needless slice is harmless
        let startGrapheme = graphemeAtDisplayColumn(text, scrollLeft);
        if (displayColumn(text, startGrapheme) < scrollLeft) startGrapheme += 1; // never split a straddling wide glyph
        const endGrapheme = graphemeAtDisplayColumn(text, scrollLeft + viewportWidth) + 1;
        windowText = text.slice(graphemeToU16(text, startGrapheme), graphemeToU16(text, endGrapheme));
      }
      if (editor.document.binary.value || language === 'plain') {
        codeChunks.push(fg(palette.fg)(windowText));
      } else {
        for (const span of highlightLine(windowText, language)) {
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
    const selectionScrollLeft = editor.viewport.scrollLeft.value;
    const anchorY = Math.max(0, selection.start.line - top);
    const anchorX = selection.start.line >= top ? displayColumn(editor.document.line(selection.start.line), selection.start.col) : 0;
    const focusY = Math.min(viewportHeight - 1, selection.end.line - top);
    const focusX =
      selection.end.line < top + viewportHeight
        ? displayColumn(editor.document.line(selection.end.line), selection.end.col)
        : lineWidth(editor.document.line(Math.min(top + viewportHeight - 1, editor.document.lineCount - 1)));
    codeBody.setSelectionRange(
      Math.max(0, anchorX - selectionScrollLeft),
      anchorY,
      Math.max(0, focusX - selectionScrollLeft),
      focusY,
    );
  }

  // The git sidebar: a changes region (staged/unstaged/untracked + branch header) over a
  // VIRTUALIZED commit log (only the visible window is materialized, via CommitLog.rows). Split by
  // gitPanel.splitRatio. Keyboard-driven for now; mouse + drill-down + drag layer on next.
  // invariant: Cost tracks the actively observed set (project.invariants.md)
  // Layout geometry of the last-rendered git panel, for mouse hit-testing — the renderer writes
  // it, the click/hover/wheel handlers read it, so both always agree on what is where.
  let gitPanelGeometry = {
    changesTop: 0, // first screen row (sidebar-relative, border-inclusive) of the changes list
    changesRows: 0, // visible change rows
    dividerRow: 0,
    logTop: 0,
    logRows: 0,
  };

  function renderGitPanel(): StyledText {
    const palette = readPalette();
    const innerWidth = SIDEBAR_WIDTH - 2;
    const chunks: TextChunk[] = [];
    const pushRow = (
      text: string,
      color: string,
      options: { background?: string | null; bold?: boolean; newline?: boolean } = {},
    ) => {
      let label = text.length > innerWidth ? text.slice(0, innerWidth) : text;
      label = label.padEnd(innerWidth, ' ');
      let chunk = fg(color)(label);
      if (options.bold) chunk = bold(chunk);
      if (options.background) chunk = bg(options.background)(chunk);
      chunks.push(chunk);
      if (options.newline !== false) chunks.push(fg(palette.fg)('\n'));
    };
    const git = workspace.git.value;
    const gitPanel = workspace.gitPanel;
    const active = workspace.focus.value === 'git';
    if (!git) return new StyledText([fg(palette.dim)('  no repository')]);

    const bodyHeight = Math.max(1, (sidebar.height as number) - 2);
    pushRow(` ${git.branch.value || '(no branch)'}  ${git.head.value.slice(0, 7)}`, palette.accent);
    if (git.error.value) {
      pushRow(`  ${git.error.value}`, palette.deleted);
      return new StyledText(chunks);
    }

    // Changes region (top): headers + glyphed file rows from the SHARED row model, windowed.
    const changeRows = buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const topHeight = Math.max(2, Math.floor(bodyHeight * gitPanel.splitRatio.value));
    const changesVisible = topHeight - 1;
    const changesTop = Math.min(
      gitPanel.changesScrollTop.value,
      Math.max(0, changeRows.length - changesVisible),
    );
    const glyphColor = (glyph: string): string =>
      glyph === 'A' ? palette.added : glyph === 'D' ? palette.deleted : glyph === '?' ? palette.dim : palette.modified;
    changeRows.slice(changesTop, changesTop + changesVisible).forEach((row, visibleIndex) => {
      const rowIndex = changesTop + visibleIndex;
      if (row.kind === 'header') {
        pushRow(` ${row.label} (${row.count})`, palette.dim, { bold: true });
      } else if (row.kind === 'placeholder') {
        pushRow(`  ${row.label}`, palette.dim);
      } else {
        const selected = active && gitPanel.region.value === 'changes' && rowIndex === gitPanel.changesIndex.value;
        const hovered = rowIndex === gitPanel.changesHovered.value;
        const background = selected ? palette.selection : hovered ? palette.cursorLine : null;
        pushRow(`  ${row.glyph} ${row.path}`, glyphColor(row.glyph), { background });
      }
    });
    const changesRendered = Math.min(changeRows.length - changesTop, changesVisible);
    for (let filler = changesRendered; filler < changesVisible; filler++) pushRow('', palette.fg);

    pushRow('─'.repeat(innerWidth), palette.border);

    // Commit log region (bottom) — virtualized: only the visible window is read from the cache.
    const logHeight = Math.max(1, bodyHeight - topHeight - 1);
    const commitLog = workspace.commitLog.value;
    if (commitLog) {
      const top = gitPanel.logScrollTop.value;
      const visibleCommits = commitLog.rows(top, logHeight);
      visibleCommits.forEach((record, index) => {
        const commitIndex = top + index;
        const selected = active && gitPanel.region.value === 'log' && commitIndex === gitPanel.logIndex.value;
        const hovered = commitIndex === gitPanel.logHovered.value;
        const background = selected ? palette.selection : hovered ? palette.cursorLine : null;
        const newline = index < visibleCommits.length - 1;
        if (record) pushRow(` ${record.shortSha} ${record.subject}`, palette.fg, { background, newline });
        else pushRow(' …', palette.dim, { background, newline });
      });
    }

    // Geometry for the hit-testers (sidebar-relative rows; +1 = sidebar top border, +1 branch row).
    gitPanelGeometry = {
      changesTop,
      changesRows: changesVisible,
      dividerRow: 1 + 1 + changesVisible,
      logTop: gitPanel.logScrollTop.value,
      logRows: logHeight,
    };
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
    if (app.copyNotice.value) parts.push(app.copyNotice.value);
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

    syncScrollbars();

    // Native terminal caret at the cursor's DISPLAY column (tab/wide aware). Shown only when the
    // editor is focused, has a document, no palette overlay, and the cursor line is on screen.
    // invariant: The caret renders at the cursor display column (ui.invariants.md)
    const editor = workspace.editor;
    const scrollTop = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    const cursorLine = editor.cursor.line.value;
    const caretVisibleHorizontally =
      displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) >=
        editor.viewport.scrollLeft.value &&
      displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) <
        editor.viewport.scrollLeft.value + editorViewportWidth();
    if (editor.hasDocument.value && workspace.focus.value === 'editor' && !open && cursorLine >= scrollTop && cursorLine < scrollTop + viewportHeight && caretVisibleHorizontally) {
      const cursorDisplayColumn = displayColumn(editor.document.line(cursorLine), editor.cursor.col.value);
      // Anchor the caret to the code renderable's ACTUAL laid-out screen cell (codeBody.x/y from
      // yoga), not hand-derived layout constants — the constants drifted from the real layout (the
      // human-QA off-by-one) and would break again when the sidebar becomes draggable.
      const caretScrollLeft = editor.viewport.scrollLeft.value;
      const caretCellX = codeBody.x + (cursorDisplayColumn - caretScrollLeft);
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
    if (workspace.focus.value === 'git') {
      // Route by pointer position: wheel over the changes region scrolls it; over the log, the
      // momentum glide (same gesture, per-region window).
      const row = event.y - sidebar.y;
      if (row < gitPanelGeometry.dividerRow) {
        const total = gitChangeRowsNow().length;
        const maxTop = Math.max(0, total - gitPanelGeometry.changesRows);
        workspace.gitPanel.changesScrollTop.value = Math.max(
          0,
          Math.min(workspace.gitPanel.changesScrollTop.value + wheelDelta(event), maxTop),
        );
      } else {
        workspace.impulseGitLog(event.scroll?.direction === 'up' ? -1 : 1);
      }
    } else workspace.tree.moveSelection(wheelDelta(event));
  };
  editorArea.onMouseScroll = (event) => {
    if (!workspace.editor.hasDocument.value) return;
    if (event.modifiers.shift) {
      // Horizontal: clamp to the widest VISIBLE line (O(window), never the whole file).
      const top = workspace.editor.viewport.scrollTop.value;
      const visible = workspace.editor.document.slice(top, editorViewportHeight());
      let widestVisible = 0;
      for (const line of visible) widestVisible = Math.max(widestVisible, lineWidth(line));
      workspace.editor.viewport.scrollByColumns(wheelDelta(event), widestVisible);
    } else {
      workspace.editor.viewport.scrollBy(wheelDelta(event), workspace.editor.document.lineCount);
    }
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
    const column = graphemeAtDisplayColumn(
      workspace.editor.document.line(line),
      workspace.editor.viewport.scrollLeft.value + (cellX - codeBody.x),
    );
    return { line, column };
  };
  // Live drag tracking for edge auto-scroll: while a selection drag holds at/past a pane edge,
  // the frame tick scrolls the viewport and extends the selection to the newly revealed cells.
  let selectionDrag: { pointerX: number; pointerY: number } | null = null;

  codeBody.onMouseDown = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDown (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    workspace.focusEditor(); // click-to-focus
    workspace.editor.placeCursor(hit.line, hit.column);
    workspace.editor.cursor.setAnchorHere(); // anchor at the press; dragging extends from here
    selectionDrag = { pointerX: event.x, pointerY: event.y };
  };
  codeBody.onMouseDrag = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDrag (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    workspace.editor.placeCursor(hit.line, hit.column); // anchor stays — selection = anchor -> cursor
    if (selectionDrag) {
      selectionDrag.pointerX = event.x;
      selectionDrag.pointerY = event.y;
    }
  };
  const endSelectionDrag = (): void => {
    selectionDrag = null;
    // A plain click (no drag) leaves anchor == cursor: clear it so no empty selection lingers.
    if (!workspace.editor.cursor.hasSelection) workspace.editor.cursor.clearSelection();
  };
  codeBody.onMouseUp = endSelectionDrag;
  codeBody.onMouseDragEnd = endSelectionDrag;

  // Edge auto-scroll: called from the app frame tick with real dt. While the held pointer sits in
  // the one-cell edge zone (or beyond the pane), scroll that axis — rate grows with overshoot —
  // and re-extend the selection to the cell now under the pointer. The drag is the ONE scroll
  // writer while active. Returns whether an auto-scroll is in progress (keeps frames coming).
  // invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  let edgeScrollRemainder = { x: 0, y: 0 };
  function tickDragAutoScroll(dtSeconds: number): boolean {
    if (!selectionDrag || !workspace.editor.hasDocument.value) return false;
    const leftEdge = codeBody.x;
    const rightEdge = codeBody.x + Math.max(1, editorViewportWidth()) - 1;
    const topEdge = codeBody.y;
    const bottomEdge = codeBody.y + Math.max(1, editorViewportHeight()) - 1;
    const overshootX =
      selectionDrag.pointerX >= rightEdge
        ? selectionDrag.pointerX - rightEdge + 1
        : selectionDrag.pointerX <= leftEdge
          ? selectionDrag.pointerX - leftEdge - 1
          : 0;
    const overshootY =
      selectionDrag.pointerY >= bottomEdge
        ? selectionDrag.pointerY - bottomEdge + 1
        : selectionDrag.pointerY <= topEdge
          ? selectionDrag.pointerY - topEdge - 1
          : 0;
    if (overshootX === 0 && overshootY === 0) {
      edgeScrollRemainder = { x: 0, y: 0 };
      return false;
    }
    // Base 25 cells/sec, growing with how far past the edge the pointer sits (capped).
    const rate = (overshoot: number): number =>
      Math.sign(overshoot) * Math.min(120, 25 + 18 * (Math.abs(overshoot) - 1));
    edgeScrollRemainder.x += overshootX === 0 ? 0 : rate(overshootX) * dtSeconds;
    edgeScrollRemainder.y += overshootY === 0 ? 0 : rate(overshootY) * dtSeconds;
    const stepX = Math.trunc(edgeScrollRemainder.x);
    const stepY = Math.trunc(edgeScrollRemainder.y);
    edgeScrollRemainder.x -= stepX;
    edgeScrollRemainder.y -= stepY;
    if (stepX !== 0) {
      const top = workspace.editor.viewport.scrollTop.value;
      let widestVisible = 0;
      for (const line of workspace.editor.document.slice(top, editorViewportHeight())) {
        widestVisible = Math.max(widestVisible, lineWidth(line));
      }
      workspace.editor.viewport.scrollByColumns(stepX, widestVisible);
    }
    if (stepY !== 0) {
      workspace.editor.viewport.scrollBy(stepY, workspace.editor.document.lineCount);
    }
    // Extend the selection to the cell under the (edge-clamped) pointer in the NEW window.
    const clampedX = Math.max(leftEdge, Math.min(selectionDrag.pointerX, rightEdge));
    const clampedY = Math.max(topEdge, Math.min(selectionDrag.pointerY, bottomEdge));
    const hit = documentPositionAtCell(clampedX, clampedY);
    if (hit) {
      workspace.editor.cursor.moveToLineKeepingGoal(hit.line, hit.column); // anchor fixed; no rescroll fight
    }
    return true;
  }

  // Sidebar clicks: focus follows the click (files or git view), and a click on a tree row SELECTS
  // it — clicking the already-selected row ACTIVATES it (open file / toggle folder). Keyboard
  // parity holds: everything here is also reachable via arrows/Enter.
  // Hover highlight (enhancement only — selection/activation stay on click/keys). The hovered row
  // is model view-state so the frame effect repaints when it changes; cost is one marker cell.
  // Map a sidebar-relative screen row to a git-panel target using the SAME geometry the renderer
  // wrote (changes row / divider / log row).
  const gitRowAt = (screenY: number): { region: 'changes' | 'log'; index: number } | null => {
    const row = screenY - sidebar.y;
    if (row >= 2 && row < gitPanelGeometry.dividerRow) {
      return { region: 'changes', index: gitPanelGeometry.changesTop + (row - 2) };
    }
    if (row > gitPanelGeometry.dividerRow) {
      return { region: 'log', index: gitPanelGeometry.logTop + (row - gitPanelGeometry.dividerRow - 1) };
    }
    return null;
  };
  const gitChangeRowsNow = () => {
    const git = workspace.git.value;
    return git ? buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
  };
  sidebar.onMouseMove = (event) => {
    if (workspace.focus.value === 'git') {
      const hit = gitRowAt(event.y);
      const rows = gitChangeRowsNow();
      workspace.gitPanel.changesHovered.value =
        hit?.region === 'changes' && rows[hit.index]?.kind === 'file' ? hit.index : -1;
      workspace.gitPanel.logHovered.value = hit?.region === 'log' ? hit.index : -1;
      return;
    }
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1));
    workspace.tree.hoveredIndex.value =
      rowIndex >= 0 && rowIndex < workspace.tree.rows.length ? rowIndex : -1;
  };
  sidebar.onMouseOut = () => {
    workspace.tree.hoveredIndex.value = -1;
    workspace.gitPanel.changesHovered.value = -1;
    workspace.gitPanel.logHovered.value = -1;
  };

  sidebar.onMouseDown = (event) => {
    if (workspace.focus.value === 'git') {
      workspace.focusGit();
      const hit = gitRowAt(event.y);
      if (!hit) return;
      if (hit.region === 'changes') {
        const rows = gitChangeRowsNow();
        if (rows[hit.index]?.kind !== 'file') return;
        workspace.gitPanel.region.value = 'changes';
        workspace.gitPanel.changesIndex.value = hit.index;
        void workspace.toggleStageAtRow(hit.index); // single click selects AND stages/unstages
      } else {
        workspace.gitPanel.region.value = 'log';
        workspace.gitPanel.logIndex.value = hit.index;
      }
      return;
    }
    workspace.focusFiles(); // click-to-focus
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1)); // +1: sidebar top border
    if (rowIndex < 0 || rowIndex >= workspace.tree.rows.length) return;
    // Single-click activation: one click selects AND opens the file / toggles the folder.
    workspace.tree.selectedIndex.value = rowIndex;
    workspace.activate();
  };

  update();

  return {
    update,
    editorViewportHeight,
    editorViewportWidth,
    tickDragAutoScroll,
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
