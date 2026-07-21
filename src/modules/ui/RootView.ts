// The root frame, rendered from workspace + theme state. A column of
// [ main row: files sidebar | editor ] over a status bar. `update()` re-syncs content from
// state after each input (one-way flow: state → view, never the reverse).
//
// invariant: ivue owns state, OpenTUI owns projection (project.invariants.md)
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
import type { Palette } from '../theme/theme.palettes';
import { highlightLine, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';

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
    title: 'Editor',
  });
  const editorBody = new TextRenderable(renderer, { id: 'editor-body', content: '' });
  editorArea.add(editorBody);
  // Empty-state text is plain; file content is a StyledText (colored spans).
  let editorStyled: StyledText | null = null;

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

  // Builds a StyledText of the visible window with syntax colors + gutter. Only the visible
  // lines are tokenized (flyweight). Returns null for the empty state (plain string).
  function renderEditorStyled(): StyledText | null {
    const ed = ws.editor;
    if (!ed.hasDocument.value) return null;
    const pal = p();
    const lang = LanguageRegistry.Class.forPath(ed.document.path);
    const height = editorViewportHeight();
    const top = ed.viewport.scrollTop.value;
    const win = ed.document.slice(top, height);
    const gutterW = String(ed.document.lineCount).length + 1;
    const curLine = ed.cursor.line.value;
    const focused = ws.focus.value === 'editor';
    const chunks: TextChunk[] = [];
    win.forEach((text, i) => {
      const lineNo = top + i;
      const isCur = lineNo === curLine;
      const num = String(lineNo + 1).padStart(gutterW, ' ');
      chunks.push(fg(isCur ? pal.accent : pal.dim)(`${num} `));
      chunks.push(fg(pal.accent)(isCur && focused ? '▏' : ' '));
      if (ed.document.binary.value || lang === 'plain') {
        chunks.push(fg(pal.fg)(text));
      } else {
        for (const span of highlightLine(text, lang)) {
          chunks.push(fg(roleColor(span.role, pal))(span.text));
        }
      }
      if (i < win.length - 1) chunks.push(fg(pal.fg)('\n'));
    });
    return new StyledText(chunks);
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
    editorStyled = renderEditorStyled();
    editorBody.content = editorStyled ?? EMPTY_STATE;
    editorBody.fg = pal.fg;
    statusText.content = renderStatus();
    statusText.fg = pal.dim;
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
