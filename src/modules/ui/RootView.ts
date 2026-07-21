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
import type { Theme } from '../theme/Theme';
import type { CommandRegistry } from '../commands/CommandRegistry';
import type { Palette } from '../theme/theme.palettes';
import { highlightLine, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import { displayColumn, lineWidth } from '../editor/editor.coordinates';
import { SelectableText } from './SelectableText';

function roleColor(role: Role, pal: Palette): string {
  switch (role) {
    case 'keyword': return pal.keyword;
    case 'string': return pal.string;
    case 'number': return pal.number;
    case 'comment': return pal.comment;
    case 'func': return pal.func;
    case 'type': return pal.type;
    case 'operator': return pal.operator;
    default: return pal.fg;
  }
}

const SIDEBAR_W = 32;

export interface RootView {
  update(): void;
  editorViewportHeight(): number;
  editorViewportWidth(): number;
  dispose(): void;
}

export function buildRootView(
  renderer: CliRenderer,
  ws: Workspace.Instance,
  theme: Theme.Instance,
  commands: CommandRegistry.Instance,
): RootView {
  const root = renderer.root;
  const p = () => theme.palette;

  const column = new BoxRenderable(renderer, {
    id: 'root-column',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: p().bg,
  });

  const mainRow = new BoxRenderable(renderer, {
    id: 'main-row',
    flexDirection: 'row',
    flexGrow: 1,
    width: '100%',
  });

  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: SIDEBAR_W,
    height: '100%',
    border: true,
    borderStyle: 'rounded',
    title: 'Files',
    backgroundColor: p().panel,
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
    selectable: true,
    flexGrow: 1,
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
    backgroundColor: p().statusBg,
  });
  const statusText = new TextRenderable(renderer, { id: 'status-text', content: '' });
  statusBar.add(statusText);

  column.add(mainRow);
  column.add(statusBar);
  root.add(column);

  // Command palette overlay — added last so it renders on top; shown only when open.
  const palette = new BoxRenderable(renderer, {
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
  const paletteInput = new TextRenderable(renderer, { id: 'palette-input', content: '' });
  const paletteList = new TextRenderable(renderer, { id: 'palette-list', content: '' });
  palette.add(paletteInput);
  palette.add(paletteList);
  root.add(palette);

  // Interior height of a bordered box = box height - 2 (top+bottom border).
  const editorViewportHeight = () => Math.max(1, (editorArea.height as number) - 2);
  const editorViewportWidth = () => Math.max(1, (editorArea.width as number) - 2 - 6); // gutter

  function renderTree(): string {
    const pal = p();
    const rows = ws.tree.rows;
    const sel = ws.tree.selectedIndex.value;
    const height = Math.max(1, (sidebar.height as number) - 2);
    // Flyweight: only render the visible window around the selection.
    let top = 0;
    if (sel >= height) top = sel - height + 1;
    const visible = rows.slice(top, top + height);
    const lines = visible.map((r, i) => {
      const idx = top + i;
      const indent = '  '.repeat(r.depth);
      const icon = theme.icon(r.name, r.isDir, r.expanded);
      const marker = idx === sel && ws.focus.value === 'files' ? '›' : ' ';
      let label = `${marker}${indent}${icon} ${r.name}`;
      if (label.length > SIDEBAR_W - 2) label = label.slice(0, SIDEBAR_W - 2);
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
    '   Ctrl+Q  quit',
    '',
  ].join('\n');

  // Gutter width in cells for the current document: "NN " (line number + space) + 1 marker cell.
  const gutterWidth = () => String(ws.editor.document.lineCount).length + 1 + 2;

  // Builds the visible window as two aligned StyledTexts — the gutter (line numbers + current-line
  // marker) and the code (syntax colors only, NO gutter). Only the visible lines are tokenized
  // (flyweight). Returns null for the empty state.
  function renderEditor(): { gutter: StyledText; code: StyledText } | null {
    const ed = ws.editor;
    if (!ed.hasDocument.value) return null;
    const pal = p();
    const lang = LanguageRegistry.Class.forPath(ed.document.path);
    const height = editorViewportHeight();
    const top = ed.viewport.scrollTop.value;
    const win = ed.document.slice(top, height);
    const gw = String(ed.document.lineCount).length + 1;
    const curLine = ed.cursor.line.value;
    const focused = ws.focus.value === 'editor';
    const gutterChunks: TextChunk[] = [];
    const codeChunks: TextChunk[] = [];
    win.forEach((text, i) => {
      const lineNo = top + i;
      const isCur = lineNo === curLine;
      const num = String(lineNo + 1).padStart(gw, ' ');
      gutterChunks.push(fg(isCur ? pal.accent : pal.dim)(`${num} `));
      gutterChunks.push(fg(pal.accent)(isCur && focused ? '▏' : ' '));
      if (ed.document.binary.value || lang === 'plain') {
        codeChunks.push(fg(pal.fg)(text));
      } else {
        for (const span of highlightLine(text, lang)) {
          codeChunks.push(fg(roleColor(span.role, pal))(span.text));
        }
      }
      if (i < win.length - 1) {
        gutterChunks.push(fg(pal.fg)('\n'));
        codeChunks.push(fg(pal.fg)('\n'));
      }
    });
    return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks) };
  }

  // Drive OpenTUI's native selection on the code renderable from the model selection, mapped into
  // code-local coords (x = display column, y = visible-line index). Clamps to the visible window.
  // invariant: The selected range renders with a background (ui.invariants.md)
  function applySelection(): void {
    const ed = ws.editor;
    const sel = ed.hasDocument.value ? ed.cursor.selectionRange() : null;
    const top = ed.viewport.scrollTop.value;
    const vh = editorViewportHeight();
    if (!sel || sel.end.line < top || sel.start.line >= top + vh) {
      codeBody.clearSelectionRange();
      return;
    }
    const anchorY = Math.max(0, sel.start.line - top);
    const anchorX = sel.start.line >= top ? displayColumn(ed.document.line(sel.start.line), sel.start.col) : 0;
    const focusY = Math.min(vh - 1, sel.end.line - top);
    const focusX =
      sel.end.line < top + vh
        ? displayColumn(ed.document.line(sel.end.line), sel.end.col)
        : lineWidth(ed.document.line(Math.min(top + vh - 1, ed.document.lineCount - 1)));
    // NOTE: OpenTUI's setLocalSelection currently mis-maps our local (col,row) coords — a fixed
    // (0,0,5,0) probe shaded y=5, x=28..46 in period-4 groups (a ~4x scale + offset), and a real
    // selection on doc line N lands ~4N rows too low. The selection MODEL is correct (copy/cut/
    // paste/select-all work); only this visual shading is affected. Gated OFF by default until the
    // coordinate space setLocalSelection expects is pinned down (see ui.invariants.md). Verify a fix
    // with the FrameProbe frame-diff (scripts + artifacts/frame.json).
    if (process.env.TUI_SEL_RENDER === '1') {
      codeBody.setSelectionRange(anchorX, anchorY, focusX, focusY);
    } else {
      codeBody.clearSelectionRange();
    }
  }

  function renderStatus(): string {
    const ed = ws.editor;
    const parts: string[] = [` ${ws.name.value || '—'}`];
    if (ed.hasDocument.value) {
      parts.push(ed.title);
      parts.push(`Ln ${ed.cursor.line.value + 1}, Col ${ed.cursor.col.value + 1}`);
      parts.push(`${ed.document.lineCount} lines`);
    }
    parts.push(ws.focus.value === 'files' ? '[Files]' : '[Editor]');
    parts.push('Ctrl+Q quit');
    return parts.join('  ·  ');
  }

  function update(): void {
    const pal = p();
    column.backgroundColor = pal.bg;
    sidebar.backgroundColor = pal.panel;
    sidebar.borderColor = ws.focus.value === 'files' ? pal.borderActive : pal.border;
    sidebar.titleColor = ws.focus.value === 'files' ? pal.accent : pal.dim;
    editorArea.backgroundColor = pal.bg;
    editorArea.borderColor = ws.focus.value === 'editor' ? pal.borderActive : pal.border;
    editorArea.title = ws.editor.hasDocument.value ? ws.editor.title : 'Editor';
    editorArea.titleColor = ws.focus.value === 'editor' ? pal.accent : pal.dim;
    statusBar.backgroundColor = pal.statusBg;

    sidebarBody.content = renderTree();
    sidebarBody.fg = pal.fg;
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
    codeBody.fg = pal.fg;
    codeBody.selectionBg = pal.selection;
    applySelection(); // after content is set, so selection maps onto the current buffer
    statusText.content = renderStatus();
    statusText.fg = pal.dim;

    // Palette overlay.
    const open = commands.open.value;
    palette.visible = open;
    if (open) {
      palette.borderColor = pal.borderActive;
      palette.titleColor = pal.accent;
      palette.backgroundColor = pal.panel;
      paletteInput.content = `> ${commands.query.value}▏`;
      paletteInput.fg = pal.fg;
      const items = commands.filtered.slice(0, 12);
      const sel = commands.selectedIndex.value;
      paletteList.content = items.length
        ? items
            .map((c, i) => `${i === sel ? '›' : ' '} ${c.title}`)
            .join('\n')
        : '  (no matching commands)';
      paletteList.fg = pal.dim;
    }

    // Native terminal caret at the cursor's DISPLAY column (tab/wide aware). Shown only when the
    // editor is focused, has a document, no palette overlay, and the cursor line is on screen.
    // invariant: The caret renders at the cursor display column (ui.invariants.md)
    const ed = ws.editor;
    const scrollTop = ed.viewport.scrollTop.value;
    const vh = editorViewportHeight();
    const cl = ed.cursor.line.value;
    if (ed.hasDocument.value && ws.focus.value === 'editor' && !open && cl >= scrollTop && cl < scrollTop + vh) {
      const dc = displayColumn(ed.document.line(cl), ed.cursor.col.value);
      const gutterW = String(ed.document.lineCount).length + 1;
      // x: sidebar + editorArea left border + gutter("NN ") + the current-line marker cell + display col.
      const x = SIDEBAR_W + 1 + gutterW + 2 + dc;
      const y = 1 + (cl - scrollTop); // mainRow top + editorArea top border
      renderer.setCursorPosition(x, y, true);
    } else {
      renderer.setCursorPosition(0, 0, false);
    }
  }

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
