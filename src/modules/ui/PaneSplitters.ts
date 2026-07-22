// The pane-splitter controller: the two draggable dividers that resize panes — the sidebar↔editor
// width divider (a SplitterModel bound to settings.sidebarWidth) and the git changes↔log height
// divider (bound to the workspace's git split ratio). Both capture the drag target on mousedown so a
// 1-cell strip survives the drag, update LIVE on every tick, and persist exactly ONCE on release
// (a synchronous settings write at mouse-move frequency would stall the frame loop).
//
// RootView constructs the divider renderables and reads sidebarDividerActive() for the divider's
// hover/drag highlight; everything else about the drag lives here.
import type { BoxRenderable, CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import { SplitterModel } from '../layout/SplitterModel';
import type { Settings } from '../settings/Settings';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';

export interface PaneSplittersDeps {
  renderer: CliRenderer;
  settings: Settings.Instance;
  workspaceSet: WorkspaceSet.Instance;
  sidebar: BoxRenderable;
  sidebarDivider: BoxRenderable;
  gitSplitDivider: BoxRenderable;
}

// OpenTUI captures a drag target only on the FIRST drag event at the pointer's CURRENT cell, so a thin
// grab strip is abandoned the instant the pointer moves off it. Capturing on mousedown routes every
// later drag event to that renderable regardless of where the pointer travels.
function captureDragTarget(target: object): void {
  const withContext = target as { _ctx?: { setCapturedRenderable?: (renderable: unknown) => void } };
  withContext._ctx?.setCapturedRenderable?.(target);
}

class $PaneSplitters {
  private readonly sidebarSplitter: SplitterModel.Instance;
  private sidebarDividerHover = false;
  // OpenTUI fires BOTH drag-end AND up on release, so guard the persist with an active-drag flag —
  // otherwise the release saves twice (the invariant is exactly one persist per drag).
  private sidebarDragActive = false;
  private gitSplitDragActive = false;

  constructor(private readonly deps: PaneSplittersDeps) {
    const { settings } = deps;
    this.sidebarSplitter = new SplitterModel.Class({
      orientation: 'vertical',
      mode: 'cells',
      initialSize: settings.sidebarWidth.value,
      minimumSize: 18,
      maximumSize: 70,
      // LIVE update only; persist once on drag end (settings.save is a synchronous disk write).
      onSizeChange: (width) => {
        settings.sidebarWidth.value = Math.round(width);
      },
    });
    this.wireSidebarDivider();
    this.wireGitSplitDivider();
  }

  /** True while the sidebar divider is hovered or being dragged — RootView uses it for the highlight. */
  sidebarDividerActive(): boolean {
    return this.sidebarSplitter.dragging.value || this.sidebarDividerHover;
  }

  private wireSidebarDivider(): void {
    const { sidebarDivider, settings, renderer } = this.deps;
    sidebarDivider.onMouseDown = (event) => {
      captureDragTarget(sidebarDivider); // capture on down so a 1-cell divider survives the drag
      this.sidebarSplitter.size.value = settings.sidebarWidth.value; // anchor from the live width
      this.sidebarSplitter.beginDrag(event.x);
      this.sidebarDragActive = true;
      renderer.requestRender();
    };
    sidebarDivider.onMouseDrag = (event) => {
      this.sidebarSplitter.dragTo(event.x);
      renderer.requestRender();
    };
    const endSidebarDrag = (): void => {
      if (!this.sidebarDragActive) return;
      this.sidebarDragActive = false;
      this.sidebarSplitter.endDrag();
      settings.save(); // persist ONCE, on release — never per drag tick (sync disk write = frame stall)
      renderer.requestRender();
    };
    sidebarDivider.onMouseUp = endSidebarDrag;
    sidebarDivider.onMouseDragEnd = endSidebarDrag;
    sidebarDivider.onMouseMove = () => {
      if (!this.sidebarDividerHover) {
        this.sidebarDividerHover = true;
        renderer.requestRender();
      }
    };
    sidebarDivider.onMouseOut = () => {
      if (this.sidebarDividerHover) {
        this.sidebarDividerHover = false;
        renderer.requestRender();
      }
    };
  }

  private gitSplitRatioAtPointer(pointerScreenY: number): number {
    const { sidebar } = this.deps;
    const bodyTopScreenY = (sidebar.y as number) + 1; // +1 = sidebar top border
    const bodyHeight = Math.max(1, (sidebar.height as number) - 2);
    return (pointerScreenY - bodyTopScreenY) / bodyHeight;
  }

  private wireGitSplitDivider(): void {
    const { gitSplitDivider, workspaceSet, renderer } = this.deps;
    gitSplitDivider.onMouseDown = (event) => {
      captureDragTarget(gitSplitDivider);
      this.gitSplitDragActive = true;
      workspaceSet.active.setGitSplit(this.gitSplitRatioAtPointer(event.y));
      renderer.requestRender();
    };
    gitSplitDivider.onMouseDrag = (event) => {
      workspaceSet.active.setGitSplit(this.gitSplitRatioAtPointer(event.y));
      renderer.requestRender();
    };
    const endGitSplitDrag = (): void => {
      if (!this.gitSplitDragActive) return; // both drag-end + up fire on release; persist exactly once
      this.gitSplitDragActive = false;
      workspaceSet.active.persistGitSplit(); // persist ONCE on release — setGitSplit only updated memory
      renderer.requestRender();
    };
    gitSplitDivider.onMouseUp = endGitSplitDrag;
    gitSplitDivider.onMouseDragEnd = endGitSplitDrag;
  }
}

export namespace PaneSplitters {
  export const $Class = $PaneSplitters;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
