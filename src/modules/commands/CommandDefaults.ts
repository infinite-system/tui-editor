// Default command set — the core is complete without plugins, so every essential action is
// registered here. Plugins (M7) contribute additional commands to the same registry.
//
// invariant: The core is complete without plugins (project.invariants.md)
import { Static } from '../system/Static';
import type { CommandRegistry } from './CommandRegistry';
import type { Workspace } from '../workspace/Workspace';
import type { Theme } from '../theme/Theme';

export interface CommandContext {
  workspace: Workspace.Instance;
  theme: Theme.Instance;
  quit: () => void;
  requestRender: () => void;
}

function $registerDefaultCommands(
  registry: CommandRegistry.Instance,
  context: CommandContext,
): void {
  const getEditor = () => context.workspace.editor;
  const hasDocument = () => context.workspace.editor.hasDocument.value;

  registry.registerAll([
    {
      id: 'file.save',
      title: 'File: Save',
      category: 'File',
      when: hasDocument,
      run: () => {
        getEditor().save();
      },
    },
    {
      id: 'edit.undo',
      title: 'Edit: Undo',
      category: 'Edit',
      when: hasDocument,
      run: () => getEditor().performUndo(),
    },
    {
      id: 'edit.redo',
      title: 'Edit: Redo',
      category: 'Edit',
      when: hasDocument,
      run: () => getEditor().performRedo(),
    },
    {
      id: 'view.focusFiles',
      title: 'View: Focus File Explorer',
      category: 'View',
      run: () => context.workspace.focusFiles(),
    },
    {
      id: 'view.focusEditor',
      title: 'View: Focus Editor',
      category: 'View',
      when: hasDocument,
      run: () => context.workspace.focusEditor(),
    },
    {
      id: 'view.toggleTheme',
      title: 'View: Toggle Light/Dark Theme',
      category: 'View',
      run: () => context.theme.toggleDark(),
    },
    {
      id: 'go.top',
      title: 'Go: Top of File',
      category: 'Go',
      when: hasDocument,
      run: () => getEditor().gotoTop(),
    },
    {
      id: 'go.bottom',
      title: 'Go: Bottom of File',
      category: 'Go',
      when: hasDocument,
      run: () => getEditor().gotoBottom(),
    },
    {
      id: 'files.refresh',
      title: 'Files: Refresh Tree',
      category: 'Files',
      run: () => context.workspace.tree.refresh(),
    },
    {
      id: 'app.quit',
      title: 'Application: Quit',
      category: 'Application',
      run: () => context.quit(),
    },
  ]);
}

class $CommandDefaults {
  static registerDefaultCommands = $registerDefaultCommands;
}

export namespace CommandDefaults {
  export const $Class = $CommandDefaults;
  export const Class = Static($CommandDefaults);
}
