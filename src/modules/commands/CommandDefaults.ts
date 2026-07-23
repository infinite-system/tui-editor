// Default command set — the core is complete without plugins, so every essential action is
// registered here. Plugins (M7) contribute additional commands to the same registry.
//
// invariant: The core is complete without plugins (project.invariants.md)
import { Static } from 'ivue/extras';
import type { CommandRegistry } from './CommandRegistry';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { Theme } from '../theme/Theme';

export interface CommandContext {
  workspaceSet: WorkspaceSet.Instance;
  theme: Theme.Instance;
  openWorkspaceFolder: () => void;
  quit: () => void;
  requestRender: () => void;
  hasOpenDiff: () => boolean;
  nextDiffChange: () => void;
  previousDiffChange: () => void;
  toggleMarkdownPreview: () => void;
  hasHoveredMarkdownReference: () => boolean;
  openHoveredMarkdownReference: () => void;
  openShortcutHelp: () => void;
}

// Manifest first — the capability's surface reads at the top of the file; implementations follow.
// The `$` impls below are FUNCTION DECLARATIONS (hoisted + initialized before this class statement
// runs), so the static fields bind the real functions despite appearing above them.
class $CommandDefaults {
  static registerDefaultCommands = $registerDefaultCommands;
}

export namespace CommandDefaults {
  export const $Class = $CommandDefaults;
  export const Class = Static($CommandDefaults);
}

function $registerDefaultCommands(
  registry: CommandRegistry.Instance,
  context: CommandContext,
): void {
  const getEditor = () => context.workspaceSet.active.editor;
  const hasDocument = () => context.workspaceSet.active.editor.hasDocument.value;

  registry.registerAll([
    {
      id: 'workspace.openFolder',
      title: 'Workspace: Open Folder',
      category: 'Workspace',
      run: context.openWorkspaceFolder,
    },
    {
      id: 'workspace.close',
      title: 'Workspace: Close Project',
      category: 'Workspace',
      when: () => context.workspaceSet.count > 1,
      run: () => context.workspaceSet.closeActive(),
    },
    {
      id: 'workspace.next',
      title: 'Workspace: Next Project',
      category: 'Workspace',
      when: () => context.workspaceSet.count > 1,
      run: () => context.workspaceSet.cycle(1),
    },
    {
      id: 'workspace.previous',
      title: 'Workspace: Previous Project',
      category: 'Workspace',
      when: () => context.workspaceSet.count > 1,
      run: () => context.workspaceSet.cycle(-1),
    },
    {
      id: 'file.save',
      title: 'File: Save',
      category: 'File',
      when: hasDocument,
      run: () => {
        context.workspaceSet.active.saveActiveFile();
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
      id: 'edit.deletePreviousWord',
      title: 'Edit: Delete Previous Word',
      category: 'Edit',
      when: hasDocument,
      run: () => getEditor().deletePreviousWord(),
    },
    {
      id: 'view.focusFiles',
      title: 'View: Focus File Explorer',
      category: 'View',
      run: () => context.workspaceSet.active.focusFiles(),
    },
    {
      id: 'view.focusEditor',
      title: 'View: Focus Editor',
      category: 'View',
      when: hasDocument,
      run: () => context.workspaceSet.active.focusEditor(),
    },
    // Activity-bar view switchers, palette-discoverable (same single writer as the bar + its chords).
    {
      id: 'view.showFiles',
      title: 'View: Show Explorer',
      category: 'View',
      run: () => context.workspaceSet.active.showSidebarView('files'),
    },
    {
      id: 'view.showSourceControl',
      title: 'View: Show Source Control',
      category: 'View',
      run: () => context.workspaceSet.active.showSidebarView('git'),
    },
    {
      id: 'view.showExtensions',
      title: 'View: Show Extensions',
      category: 'View',
      run: () => context.workspaceSet.active.showSidebarView('extensions'),
    },
    {
      id: 'view.toggleTheme',
      title: 'View: Toggle Light/Dark Theme',
      category: 'View',
      run: () => context.theme.toggleDark(),
    },
    {
      id: 'view.toggleWordWrap',
      title: 'View: Toggle Word Wrap',
      category: 'View',
      when: hasDocument,
      run: () => getEditor().toggleWordWrap(),
    },
    {
      id: 'markdown.togglePreview',
      title: 'Markdown: Toggle Preview',
      category: 'Markdown',
      when: () => context.workspaceSet.active.activeFileIsMarkdown,
      run: context.toggleMarkdownPreview,
    },
    {
      id: 'markdown.openHoveredReference',
      title: 'Markdown: Open Hovered File Reference',
      category: 'Markdown',
      when: context.hasHoveredMarkdownReference,
      run: context.openHoveredMarkdownReference,
    },
    {
      id: 'go.definition',
      title: 'Go: Definition',
      category: 'Go',
      when: hasDocument,
      run: () => void context.workspaceSet.active.goToDefinition(),
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
      id: 'diff.previousChange',
      title: 'Diff: Previous Change',
      category: 'Diff',
      when: context.hasOpenDiff,
      run: context.previousDiffChange,
    },
    {
      id: 'diff.nextChange',
      title: 'Diff: Next Change',
      category: 'Diff',
      when: context.hasOpenDiff,
      run: context.nextDiffChange,
    },
    {
      id: 'files.refresh',
      title: 'Files: Refresh Tree',
      category: 'Files',
      run: () => context.workspaceSet.active.tree.refresh(),
    },
    {
      id: 'help.shortcuts',
      title: 'Help: Keyboard Shortcuts',
      category: 'Help',
      run: context.openShortcutHelp,
    },
    {
      id: 'app.quit',
      title: 'Application: Quit',
      category: 'Application',
      run: () => context.quit(),
    },
  ]);
}
