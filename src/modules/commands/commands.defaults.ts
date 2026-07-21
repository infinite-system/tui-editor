// Default command set — the core is complete without plugins, so every essential action is
// registered here. Plugins (M7) contribute additional commands to the same registry.
//
// invariant: The core is complete without plugins (project.invariants.md)
import type { CommandRegistry } from './CommandRegistry';
import type { Workspace } from '../workspace/Workspace';
import type { Theme } from '../theme/Theme';

export interface CommandContext {
  workspace: Workspace.Instance;
  theme: Theme.Instance;
  quit: () => void;
  requestRender: () => void;
}

export function registerDefaultCommands(
  registry: CommandRegistry.Instance,
  ctx: CommandContext,
): void {
  const ed = () => ctx.workspace.editor;
  const hasDoc = () => ctx.workspace.editor.hasDocument.value;

  registry.registerAll([
    {
      id: 'file.save',
      title: 'File: Save',
      category: 'File',
      when: hasDoc,
      run: () => {
        ed().save();
      },
    },
    {
      id: 'edit.undo',
      title: 'Edit: Undo',
      category: 'Edit',
      when: hasDoc,
      run: () => ed().performUndo(),
    },
    {
      id: 'edit.redo',
      title: 'Edit: Redo',
      category: 'Edit',
      when: hasDoc,
      run: () => ed().performRedo(),
    },
    {
      id: 'view.focusFiles',
      title: 'View: Focus File Explorer',
      category: 'View',
      run: () => ctx.workspace.focusFiles(),
    },
    {
      id: 'view.focusEditor',
      title: 'View: Focus Editor',
      category: 'View',
      when: hasDoc,
      run: () => ctx.workspace.focusEditor(),
    },
    {
      id: 'view.toggleTheme',
      title: 'View: Toggle Light/Dark Theme',
      category: 'View',
      run: () => ctx.theme.toggleDark(),
    },
    {
      id: 'go.top',
      title: 'Go: Top of File',
      category: 'Go',
      when: hasDoc,
      run: () => ed().gotoTop(),
    },
    {
      id: 'go.bottom',
      title: 'Go: Bottom of File',
      category: 'Go',
      when: hasDoc,
      run: () => ed().gotoBottom(),
    },
    {
      id: 'files.refresh',
      title: 'Files: Refresh Tree',
      category: 'Files',
      run: () => ctx.workspace.tree.refresh(),
    },
    {
      id: 'app.quit',
      title: 'Application: Quit',
      category: 'Application',
      run: () => ctx.quit(),
    },
  ]);
}
