// A workspace: one project root with its file tree, an editor, and which pane has focus.
// (Multi-workspace tabs + per-workspace snapshot restoration are layered on in M2 via
// WorkspaceManager; this is the single-workspace core.)
//
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { FileTree } from './FileTree';
import { Editor } from '../editor/Editor';
import { Files } from '../system/Files';

export type Focus = 'files' | 'editor';

class $Workspace {
  root = '';
  // invariant: Construction goes through overridable seams (project.invariants.md)
  tree = this.createTree();
  editor = this.createEditor();

  protected createTree() { return new FileTree.Class(); }
  protected createEditor() { return new Editor.Class(); }

  get focus() {
    return ref<Focus>('files');
  }
  get name() {
    return ref('');
  }

  open(root: string): void {
    this.root = root;
    this.name.value = Files.Class.basename(root) || root;
    this.tree.open(root);
    this.focus.value = 'files';
  }

  toggleFocus(): void {
    this.focus.value = this.focus.value === 'files' ? 'editor' : 'files';
  }

  focusEditor(): void {
    this.focus.value = 'editor';
  }
  focusFiles(): void {
    this.focus.value = 'files';
  }

  /** Activate the current tree selection: open a file (and focus editor) or toggle a dir. */
  activate(): { opened?: string } {
    const res = this.tree.activateSelected();
    if (res && 'openFile' in res) {
      this.editor.openFile(res.openFile);
      this.focus.value = 'editor';
      return { opened: res.openFile };
    }
    return {};
  }
}

export namespace Workspace {
  export const $Class = $Workspace;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
