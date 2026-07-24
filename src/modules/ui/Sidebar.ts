// The sidebar input controller: owns the sidebar's mouse behaviour for BOTH views it hosts — the file
// tree and the git panel. It wires the wheel/move/out/down handlers onto the sidebar renderable and
// holds the git hit-testers (row-at-point, action-button zones, context menu, range select).
//
// RootView keeps constructing the sidebar renderable, rendering its content (tree/git), and owning the
// pane geometry the hit-tests need (gitPanelGeometry, treeWindowTop, the current change rows) — those
// are passed in as accessors so this controller reads the SAME geometry the renderer wrote.
import type { BoxRenderable, CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import { ScrollGesture } from './ScrollGesture';
import type { GitPanelGeometry } from './GitPaneRenderer';
import type { ChangeRow, FileRow } from '../git/GitRows';
import type { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { Tooltip } from './Tooltip';
import type { OverlayCoordinator } from './OverlayCoordinator';
import type { Settings } from '../settings/Settings';

type GitActionButton = 'open' | 'discard' | 'stageToggle';

export interface SidebarDeps {
  renderer: CliRenderer;
  sidebar: BoxRenderable;
  workspaceSet: WorkspaceSet.Instance;
  tooltip: Tooltip.Instance;
  overlayCoordinator: OverlayCoordinator.Instance;
  contextMenu: ContextMenu.Instance;
  settings: Settings.Instance;
  /** The geometry the git renderer wrote this frame (hit-test source of truth). */
  gitPanelGeometry: () => GitPanelGeometry;
  /** First visible tree row index. */
  treeWindowTop: () => number;
  /** The current change-row model (headers + file rows), for hit-testing. */
  gitChangeRowsNow: () => ChangeRow[];
  sidebarWidth: () => number;
  scrollbarThicknessCells: () => number;
  gitActionAreaWidth: number;
}

class $Sidebar {
  constructor(private readonly deps: SidebarDeps) {
    this.wireHandlers();
  }

  // Map a sidebar-relative screen row to a git-panel target using the SAME geometry the renderer wrote.
  private gitRowAt(
    screenY: number,
  ): { region: 'changes' | 'log' | 'logHeader'; index: number } | null {
    const { sidebar, gitPanelGeometry } = this.deps;
    const geometry = gitPanelGeometry();
    const row = screenY - sidebar.y;
    if (row >= 2 && row < geometry.dividerRow) {
      return { region: 'changes', index: geometry.changesTop + (row - 2) };
    }
    if (row > geometry.dividerRow) {
      // A rendered branch-selector header takes the log region's first row; the flat list shifts
      // one row down. Without a commit log (logHeaderRow -1) the old direct mapping stands.
      if (geometry.logHeaderRow >= 0) {
        if (row === geometry.logHeaderRow) return { region: 'logHeader', index: 0 };
        return { region: 'log', index: geometry.logTop + (row - geometry.logHeaderRow - 1) };
      }
      return { region: 'log', index: geometry.logTop + (row - geometry.dividerRow - 1) };
    }
    return null;
  }

  // The git action-button hit zones (right-aligned ` o  d  ±` on a hovered/selected file row). ONE
  // definition shared by the click dispatch and the tooltip arming, so the tooltip always names
  // exactly what a click at that cell would do.
  private gitActionButtonAt(relativeX: number): GitActionButton | null {
    const innerWidth = this.deps.sidebarWidth() - 2;
    const actionAreaStart = Math.max(
      1,
      innerWidth - this.deps.scrollbarThicknessCells() - this.deps.gitActionAreaWidth,
    );
    if (relativeX >= actionAreaStart && relativeX < actionAreaStart + 2) return 'open';
    if (relativeX >= actionAreaStart + 2 && relativeX < actionAreaStart + 5) return 'discard';
    if (relativeX >= actionAreaStart + 5 && relativeX < actionAreaStart + 8) return 'stageToggle';
    return null;
  }

  // Right-click on a changes FILE row: normalize the selection (an unselected row becomes THE
  // selection; a selected row keeps the whole multi-selection) and open the context menu at the
  // pointer with the COLLECTIVE actions the selection's buckets support.
  private openChangesContextMenu(rowIndex: number, row: FileRow, rows: ChangeRow[], pointerX: number, pointerY: number): void {
    const { workspaceSet, overlayCoordinator, contextMenu, renderer } = this.deps;
    const gitPanel = workspaceSet.active.gitPanel;
    if (!gitPanel.selectedPaths.value.has(row.path)) gitPanel.replaceSelected([row.path]);
    gitPanel.setChangesSelection(rowIndex);
    const selectedFileRows = rows.filter(
      (candidate): candidate is FileRow =>
        candidate.kind === 'file' && gitPanel.selectedPaths.value.has(candidate.path),
    );
    const stageableCount = selectedFileRows.filter((fileRow) => fileRow.bucket !== 'staged').length;
    const unstageableCount = selectedFileRows.filter((fileRow) => fileRow.bucket === 'staged').length;
    const items: ContextMenuItem[] = [
      { id: 'git.stageSelected', label: `Stage (${stageableCount})`, enabled: stageableCount > 0 },
      { id: 'git.unstageSelected', label: `Unstage (${unstageableCount})`, enabled: unstageableCount > 0 },
      { id: 'git.discardSelected', label: `Discard… (${selectedFileRows.length})`, enabled: selectedFileRows.length > 0 },
      { id: 'git.openDiff', label: 'Open diff', enabled: selectedFileRows.length > 0 },
    ];
    const firstSelectedIndex = rows.findIndex(
      (candidate) => candidate.kind === 'file' && gitPanel.selectedPaths.value.has(candidate.path),
    );
    overlayCoordinator.openExclusiveOverlay('contextMenu', () =>
      contextMenu.openAt(items, pointerX, pointerY, { width: renderer.width, height: renderer.height }, (itemId) => {
        if (itemId === 'git.stageSelected') void workspaceSet.active.stageSelected();
        else if (itemId === 'git.unstageSelected') void workspaceSet.active.unstageSelected();
        else if (itemId === 'git.discardSelected') workspaceSet.active.requestDiscardSelected(); // y/N confirm
        else if (itemId === 'git.openDiff' && firstSelectedIndex >= 0) void workspaceSet.active.openChangeAtRow(firstSelectedIndex);
      }),
    );
  }

  // Click on the log's `history: <branch>` header: a modal branch menu (same ContextMenu machinery
  // as the changes right-click / tab-overflow dropdown — keyboard-navigable, Esc closes). The
  // VIEWED branch carries ●, the CHECKED-OUT branch ✓. Selecting re-sources the log VIEW only —
  // never a `git switch` (read-only viewer); picking the checked-out branch returns to HEAD-follow.
  // invariant: The log branch viewer is read-only (src/modules/git/git.invariants.md)
  private openLogBranchMenu(pointerX: number, pointerY: number): void {
    const { workspaceSet, overlayCoordinator, contextMenu, renderer } = this.deps;
    const activeWorkspace = workspaceSet.active;
    void activeWorkspace.localLogBranches().then((branchNames) => {
      if (branchNames.length === 0) return;
      const checkedOutBranch = activeWorkspace.git.value?.branch.value ?? '';
      const viewedBranch = activeWorkspace.commitLog.value?.branch.value ?? checkedOutBranch;
      const items: ContextMenuItem[] = branchNames.map((branchName) => ({
        id: `git.viewLogBranch:${branchName}`,
        label: `${branchName === viewedBranch ? '●' : ' '} ${branchName}${branchName === checkedOutBranch ? ' ✓' : ''}`,
        enabled: true,
      }));
      overlayCoordinator.openExclusiveOverlay('contextMenu', () =>
        contextMenu.openAt(
          items,
          pointerX,
          pointerY,
          { width: renderer.width, height: renderer.height },
          (itemIdentifier) => {
            const selectedBranch = itemIdentifier.slice('git.viewLogBranch:'.length);
            activeWorkspace.selectLogBranch(selectedBranch);
          },
        ),
      );
    });
  }

  // Shift+click: select the file rows in the range between the focused row and the clicked row
  // (headers in between are skipped), REPLACING the previous selection.
  private selectChangesRange(anchorIndex: number, targetIndex: number, rows: ChangeRow[]): void {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const paths: string[] = [];
    for (let rowIndex = start; rowIndex <= end; rowIndex++) {
      const row = rows[rowIndex];
      if (row?.kind === 'file') paths.push(row.path);
    }
    this.deps.workspaceSet.active.gitPanel.replaceSelected(paths);
  }

  private wireHandlers(): void {
    const { sidebar, workspaceSet, tooltip, settings } = this.deps;

    sidebar.onMouseScroll = (event) => {
      const direction = event.scroll?.direction;
      const step = ScrollGesture.Class.wheelStep(event, settings);
      const horizontal =
        direction === 'left' ||
        direction === 'right' ||
        ScrollGesture.Class.modifierHeld(event, settings.horizontalScrollModifier.value);
      const backward = direction === 'left' || direction === 'up';
      if (workspaceSet.active.sidebarView.value === 'git') {
        // Route by pointer position: wheel over the changes region scrolls it; over the log, the
        // momentum glide (same gesture, per-region window).
        const row = event.y - sidebar.y;
        if (row < this.deps.gitPanelGeometry().dividerRow) {
          if (horizontal) workspaceSet.active.impulseGitChangesHorizontalScroll((backward ? -1 : 1) * step);
          else workspaceSet.active.impulseGitChangesScroll((direction === 'up' ? -1 : 1) * step);
        } else {
          if (horizontal) workspaceSet.active.impulseGitLogHorizontalScroll((backward ? -1 : 1) * step);
          else workspaceSet.active.impulseGitLog((direction === 'up' ? -1 : 1) * step);
        }
      } else if (horizontal) workspaceSet.active.impulseTreeHorizontalScroll((backward ? -1 : 1) * step);
      else workspaceSet.active.impulseTreeScroll((direction === 'up' ? -1 : 1) * step);
    };

    sidebar.onMouseMove = (event) => {
      if (workspaceSet.active.sidebarView.value === 'git') {
        const hit = this.gitRowAt(event.y);
        const rows = this.deps.gitChangeRowsNow();
        workspaceSet.active.gitPanel.changesHovered.value =
          hit?.region === 'changes' && rows[hit.index]?.kind === 'file' ? hit.index : -1;
        workspaceSet.active.gitPanel.logHovered.value = hit?.region === 'log' ? hit.index : -1;
        // Tooltip: arm the dwell while the pointer rests on an action button of a file row
        // (hovering the row is what makes the buttons visible); anything else disarms.
        const hoveredRow = hit?.region === 'changes' ? rows[hit.index] : undefined;
        const button =
          hoveredRow?.kind === 'file' ? this.gitActionButtonAt(event.x - (sidebar.x + 1)) : null;
        if (button && hoveredRow?.kind === 'file') {
          const label =
            button === 'open'
              ? 'Open diff'
              : button === 'discard'
                ? 'Discard…'
                : hoveredRow.bucket === 'staged'
                  ? 'Unstage'
                  : 'Stage';
          tooltip.point(label, event.x, event.y); // anchor the pointed cell; view places above (auto-flip)
        } else {
          tooltip.clear();
        }
        return;
      }
      tooltip.clear();
      const rowIndex = this.deps.treeWindowTop() + (event.y - (sidebar.y + 1));
      workspaceSet.active.tree.hoveredIndex.value =
        rowIndex >= 0 && rowIndex < workspaceSet.active.tree.rows.length ? rowIndex : -1;
    };

    sidebar.onMouseOut = () => {
      workspaceSet.active.tree.hoveredIndex.value = -1;
      workspaceSet.active.gitPanel.changesHovered.value = -1;
      workspaceSet.active.gitPanel.logHovered.value = -1;
      tooltip.clear();
    };

    sidebar.onMouseDown = (event) => {
      if (workspaceSet.active.sidebarView.value === 'git') {
        workspaceSet.active.focusGit();
        const hit = this.gitRowAt(event.y);
        if (!hit) return;
        if (hit.region === 'logHeader') {
          this.openLogBranchMenu(event.x, event.y); // the read-only branch VIEWER's selector
          return;
        }
        if (hit.region === 'changes') {
          workspaceSet.active.haltGitChangesScroll();
          const rows = this.deps.gitChangeRowsNow();
          const row = rows[hit.index];
          if (row?.kind !== 'file') return;
          workspaceSet.active.gitPanel.region.value = 'changes';
          // Multi-select gestures come FIRST; plain left-click behavior below is unchanged.
          if (event.button === 2) {
            this.openChangesContextMenu(hit.index, row, rows, event.x, event.y); // right-click menu
            return;
          }
          if (event.modifiers.ctrl) {
            workspaceSet.active.gitPanel.toggleSelected(row.path); // toggle in/out of the selection; no menu
            return;
          }
          if (event.modifiers.shift) {
            this.selectChangesRange(workspaceSet.active.gitPanel.changesIndex.value, hit.index, rows); // range
            return;
          }
          const wasCurrent = workspaceSet.active.gitPanel.changesIndex.value === hit.index;
          workspaceSet.active.gitPanel.setChangesSelection(hit.index);
          const relativeX = event.x - (sidebar.x + 1);
          const actionButton = this.gitActionButtonAt(relativeX);
          const buttonsShowing = wasCurrent || workspaceSet.active.gitPanel.changesHovered.value === hit.index;
          if (relativeX === 1) {
            void workspaceSet.active.toggleStageAtRow(hit.index); // the single-glyph CHECKBOX cell is the staging control
          } else if (buttonsShowing && actionButton === 'open') {
            void workspaceSet.active.openChangeAtRow(hit.index); // [o]pen
          } else if (buttonsShowing && actionButton === 'discard') {
            workspaceSet.active.requestDiscardAtRow(hit.index); // [d]iscard — arms the y/N confirm
          } else if (buttonsShowing && actionButton === 'stageToggle') {
            void workspaceSet.active.toggleStageAtRow(hit.index); // [+/-] stage/unstage
          } else {
            void workspaceSet.active.openChangeAtRow(hit.index); // row body = select + OPEN (consistent with tree)
          }
        } else {
          workspaceSet.active.gitPanel.region.value = 'log';
          workspaceSet.active.gitPanel.setLogSelection(hit.index);
          // Row body = select + ACTIVATE (consistent with tree/changes): a commit header toggles its
          // inline expansion (lazy fetch); a file row opens that file's diff for that commit.
          workspaceSet.active.activateLogRow(hit.index);
        }
        return;
      }
      workspaceSet.active.focusFiles(); // click-to-focus
      workspaceSet.active.haltTreeScroll();
      const rowIndex = this.deps.treeWindowTop() + (event.y - (sidebar.y + 1)); // +1: sidebar top border
      if (rowIndex < 0 || rowIndex >= workspaceSet.active.tree.rows.length) return;
      // Single-click activation: one click selects AND opens the file / toggles the folder. setSelection
      // does NOT reveal/scroll, so clicking a visible row leaves the scroll position exactly where it is.
      workspaceSet.active.tree.setSelection(rowIndex);
      workspaceSet.active.activate();
    };
  }
}

export namespace Sidebar {
  export const $Class = $Sidebar;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
