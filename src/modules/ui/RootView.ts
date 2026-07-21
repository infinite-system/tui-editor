// The root frame: a column of [ main row: sidebar | editor ] over a status bar.
// A custom-built OpenTUI renderable tree, never a template renderer.
//
// invariant: ivue owns state, OpenTUI owns projection (project.invariants.md)
import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import type { App } from '../app/App';

// Minimal built-in palette until the theme module (M2) takes over.
const COLORS = {
  bg: '#1e1e2e',
  panel: '#181825',
  border: '#313244',
  borderActive: '#89b4fa',
  fg: '#cdd6f4',
  dim: '#6c7086',
  accent: '#89b4fa',
  statusBg: '#11111b',
};

export interface RootViewHandles {
  sidebar: BoxRenderable;
  editorArea: BoxRenderable;
  statusBar: BoxRenderable;
  sidebarBody: TextRenderable;
  editorBody: TextRenderable;
  statusText: TextRenderable;
  dispose(): void;
}

export function buildRootView(renderer: CliRenderer, app: App.Instance): RootViewHandles {
  const root = renderer.root;

  const column = new BoxRenderable(renderer, {
    id: 'root-column',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.bg,
  });

  const mainRow = new BoxRenderable(renderer, {
    id: 'main-row',
    flexDirection: 'row',
    flexGrow: 1,
    width: '100%',
  });

  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: 32,
    height: '100%',
    border: true,
    borderColor: COLORS.border,
    borderStyle: 'rounded',
    title: 'Files',
    titleColor: COLORS.dim,
    backgroundColor: COLORS.panel,
    padding: 0,
  });

  const sidebarBody = new TextRenderable(renderer, {
    id: 'sidebar-body',
    content: '  (no workspace)',
    fg: COLORS.dim,
  });
  sidebar.add(sidebarBody);

  const editorArea = new BoxRenderable(renderer, {
    id: 'editor-area',
    flexGrow: 1,
    height: '100%',
    border: true,
    borderColor: COLORS.borderActive,
    borderStyle: 'rounded',
    title: 'Editor',
    titleColor: COLORS.accent,
    backgroundColor: COLORS.bg,
  });

  const editorBody = new TextRenderable(renderer, {
    id: 'editor-body',
    content: [
      '',
      '   Fable — a terminal code workspace',
      '',
      '   Ctrl+P   command palette',
      '   Ctrl+Q   quit',
      '',
    ].join('\n'),
    fg: COLORS.fg,
  });
  editorArea.add(editorBody);

  mainRow.add(sidebar);
  mainRow.add(editorArea);

  const statusBar = new BoxRenderable(renderer, {
    id: 'status-bar',
    width: '100%',
    height: 1,
    backgroundColor: COLORS.statusBg,
    flexDirection: 'row',
  });

  const statusText = new TextRenderable(renderer, {
    id: 'status-text',
    content: ' Ready · Ctrl+Q to quit',
    fg: COLORS.dim,
  });
  statusBar.add(statusText);

  column.add(mainRow);
  column.add(statusBar);
  root.add(column);

  return {
    sidebar,
    editorArea,
    statusBar,
    sidebarBody,
    editorBody,
    statusText,
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

export { COLORS as BuiltinColors };
