import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { Workspace } from './Workspace';
import type { Settings } from '../settings/Settings';

export interface WorkspaceSetOptions {
  createWorkspace?: () => Workspace.Instance;
}

export interface WorkspaceTab {
  root: string;
  name: string;
  /** Second tab line: the linked-worktree name when the root is one, else the checked-out branch. */
  detail: string;
  active: boolean;
}

/** The project-layer workspace set. Each entry preserves its own editor/tree state while cold. */
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
class $WorkspaceSet {
  constructor(
    private readonly settings: Settings.Instance,
    private readonly options: WorkspaceSetOptions = {},
  ) {}

  get entries() {
    return shallowRef<Workspace.Instance[]>([]);
  }

  get activeWorkspaceIndex() {
    return ref(-1);
  }

  get count(): number {
    return this.entries.value.length;
  }

  get active(): Workspace.Instance {
    const workspace = this.entries.value[this.activeWorkspaceIndex.value];
    if (!workspace) throw new Error('WorkspaceSet has no active workspace');
    return workspace;
  }

  get liveGitWatcherCount(): number {
    return this.entries.value.filter((workspace) => workspace.hasLiveGitWatcher).length;
  }

  tabs(): WorkspaceTab[] {
    const activeWorkspaceIndex = this.activeWorkspaceIndex.value;
    return this.entries.value.map((workspace, workspaceIndex) => ({
      root: workspace.root,
      name: workspace.name.value,
      detail: workspace.tabDetail,
      active: workspaceIndex === activeWorkspaceIndex,
    }));
  }

  /** Open a project root as a workspace, or focus its existing tab when already open. */
  open(root: string): number {
    const existingWorkspaceIndex = this.entries.value.findIndex(
      (workspace) => workspace.root === root,
    );
    if (existingWorkspaceIndex >= 0) {
      this.activate(existingWorkspaceIndex);
      return existingWorkspaceIndex;
    }

    if (this.activeWorkspaceIndex.value >= 0) {
      this.active.suspendOwnedResources();
    }
    const workspace = this.createWorkspace();
    workspace.attachSettings(this.settings);
    workspace.open(root);
    this.entries.value = [...this.entries.value, workspace];
    this.activeWorkspaceIndex.value = this.entries.value.length - 1;
    return this.activeWorkspaceIndex.value;
  }

  /** Switch project layers without retaining a live watcher for the workspace left behind. */
  activate(workspaceIndex: number): void {
    if (
      workspaceIndex < 0 ||
      workspaceIndex >= this.entries.value.length ||
      workspaceIndex === this.activeWorkspaceIndex.value
    ) {
      return;
    }
    if (this.activeWorkspaceIndex.value >= 0) this.active.suspendOwnedResources();
    this.activeWorkspaceIndex.value = workspaceIndex;
    this.active.resumeOwnedResources();
  }

  cycle(workspaceDelta: number): void {
    if (this.count === 0) return;
    const nextWorkspaceIndex =
      ((this.activeWorkspaceIndex.value + workspaceDelta) % this.count + this.count) % this.count;
    this.activate(nextWorkspaceIndex);
  }

  /** Close one project. The final workspace stays open so every live view retains a valid root. */
  close(workspaceIndex: number): boolean {
    if (this.count <= 1) return false;
    const workspace = this.entries.value[workspaceIndex];
    if (!workspace) return false;
    const closingActiveWorkspace = workspaceIndex === this.activeWorkspaceIndex.value;
    workspace.dispose();
    this.entries.value = this.entries.value.filter(
      (_workspace, candidateWorkspaceIndex) => candidateWorkspaceIndex !== workspaceIndex,
    );

    if (closingActiveWorkspace) {
      this.activeWorkspaceIndex.value = Math.min(workspaceIndex, this.entries.value.length - 1);
      this.active.resumeOwnedResources();
    } else if (workspaceIndex < this.activeWorkspaceIndex.value) {
      this.activeWorkspaceIndex.value -= 1;
    }
    return true;
  }

  closeActive(): boolean {
    return this.close(this.activeWorkspaceIndex.value);
  }

  dispose(): void {
    for (const workspace of this.entries.value) workspace.dispose();
    this.entries.value = [];
    this.activeWorkspaceIndex.value = -1;
  }

  protected createWorkspace(): Workspace.Instance {
    return this.options.createWorkspace?.() ?? new Workspace.Class();
  }
}

export namespace WorkspaceSet {
  export const $Class = $WorkspaceSet;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
