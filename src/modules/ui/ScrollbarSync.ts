// The scrollbar geometry controller: each frame it derives every bar's track rect from the ACTUAL
// rendered layout and writes the bar's reported viewport/position, and it converges the panes' live
// viewport extents (heights/widths) after Yoga lays the frame out. RootView still CONSTRUCTS the bars
// and the split divider (their onChange handlers call trueScrollPosition + read applyingGeometry here);
// this controller owns the per-frame geometry math and the reported↔true scale map.
//
// invariant: A scrollbar track is derived per frame from its region rect (src/modules/ui/ui.invariants.md)
// invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
// invariant: A scrollable pane height is an input not an output (src/modules/ui/ui.invariants.md)
import { ScrollBarRenderable, parseColor, type BoxRenderable, type CliRenderer, type ColorInput, type OptimizedBuffer } from '@opentui/core';
import { Reactive } from 'ivue';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { EditorWrap } from '../editor/EditorWrap';
import { GitPaneRenderer, type GitPanelGeometry } from './GitPaneRenderer';
import { HitTransparentText } from './HitTransparentText';
import { Logging } from '../system/Logging';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { Theme } from '../theme/Theme';
import type { Palette } from '../theme/ThemePalettes';
import type { Tooltip } from './Tooltip';

// OpenTUI paints a horizontal slider as a full-cell rectangle. Terminal cells are ~2× as tall as wide,
// so a one-row bar reads ~2× as thick as a one-column vertical bar. Repaint the slider's exact thumb
// rectangle with half-height glyphs so one configured row carries ~one configured column of ink.
function paintAxisBalancedHorizontalScrollbar(
  scrollbar: ScrollBarRenderable,
  buffer: OptimizedBuffer,
  backgroundColor: ColorInput,
  trackColor: ColorInput,
  thumbColor: ColorInput,
): void {
  if (!scrollbar.visible) return;
  const slider = scrollbar.slider;
  const sliderGeometry = slider as unknown as { getThumbRect?: () => { x: number; y: number; width: number; height: number } };
  const thumbRectangle = sliderGeometry.getThumbRect?.();
  if (!thumbRectangle) return;
  const parsedBackgroundColor = parseColor(backgroundColor);
  const parsedTrackColor = parseColor(trackColor);
  const parsedThumbColor = parseColor(thumbColor);
  for (let row = slider.y; row < slider.y + slider.height; row += 1) {
    for (let column = slider.x; column < slider.x + slider.width; column += 1) {
      const insideThumb =
        column >= thumbRectangle.x && column < thumbRectangle.x + thumbRectangle.width &&
        row >= thumbRectangle.y && row < thumbRectangle.y + thumbRectangle.height;
      buffer.setCellWithAlphaBlending(column, row, insideThumb ? '▄' : '▂', insideThumb ? parsedThumbColor : parsedTrackColor, parsedBackgroundColor);
    }
  }
}

class AxisBalancedHorizontalScrollbarPaint extends HitTransparentText {
  constructor(
    renderer: CliRenderer,
    private readonly scrollbar: ScrollBarRenderable,
    private readonly palette: () => Palette,
    private readonly backgroundColor: () => ColorInput,
  ) {
    super(renderer, { id: `${scrollbar.id}-axis-balanced-paint`, content: ' ', position: 'absolute', left: 0, top: 0, width: 1, height: 1, zIndex: 100, selectable: false });
  }
  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    super.render(buffer, deltaTime);
    const palette = this.palette();
    paintAxisBalancedHorizontalScrollbar(this.scrollbar, buffer, this.backgroundColor(), palette.border, palette.accent);
  }
}

export interface ScrollbarSyncDeps {
  renderer: CliRenderer;
  workspaceSet: WorkspaceSet.Instance;
  theme: Theme.Instance;
  // Pane renderables the scroll regions are measured against.
  editorArea: BoxRenderable;
  codeBody: { x: number; y: number; width: number | string };
  sidebar: BoxRenderable;
  // The eight bars + the split divider (constructed by RootView; mutated here each frame).
  gitSplitDivider: BoxRenderable;
  tooltip: Tooltip.Instance;
  // Geometry accessors owned elsewhere.
  editorViewportHeight: () => number;
  editorViewportWidth: () => number;
  sidebarWidth: () => number;
  scrollbarThicknessCells: () => number;
  gitPanelGeometry: () => GitPanelGeometry;
  gitChangeRowsNow: () => readonly unknown[];
}

class $ScrollbarSync {
  private readonly barScales = new Map<object, number>();
  private applying = false;

  // The eight thin scrollbars (OpenTUI ScrollBar: built-in draggable thumb + onChange). Each is a
  // 1-cell strip inside its pane's border; onChange writes the SAME model offset the wheel/keyboard
  // write (One-Writer). This controller OWNS them: it builds, mounts, and syncs them.
  private readonly editorVerticalBar: ScrollBarRenderable;
  private readonly editorHorizontalBar: ScrollBarRenderable;
  private readonly treeVerticalBar: ScrollBarRenderable;
  private readonly treeHorizontalBar: ScrollBarRenderable;
  private readonly changesVerticalBar: ScrollBarRenderable;
  private readonly changesHorizontalBar: ScrollBarRenderable;
  private readonly logVerticalBar: ScrollBarRenderable;
  private readonly logHorizontalBar: ScrollBarRenderable;

  constructor(private readonly deps: ScrollbarSyncDeps) {
    const { renderer, workspaceSet, editorArea, sidebar } = deps;
    const readPalette = () => deps.theme.palette;
    const makeBar = (
      id: string,
      orientation: 'vertical' | 'horizontal',
      onChange: (position: number) => void,
      trackOptions?: { backgroundColor: ColorInput; foregroundColor: ColorInput },
    ): ScrollBarRenderable =>
      new ScrollBarRenderable(renderer, {
        id,
        orientation,
        position: 'absolute',
        ...(orientation === 'vertical' ? { width: orientation === 'vertical' && id === 'editor-scrollbar-v' ? 1 : 2 } : { height: 1 }),
        showArrows: false,
        ...(trackOptions ? { trackOptions } : {}),
        onChange: (position) => {
          if (this.applying) return; // ignore our own per-frame scrollPosition sync (One-Writer)
          onChange(position);
        },
      });
    // Horizontal bars get an axis-balanced repaint (half-height glyphs) + a hover tooltip.
    const makeHorizontalPaint = (scrollbar: ScrollBarRenderable, backgroundColor: () => ColorInput): AxisBalancedHorizontalScrollbarPaint => {
      scrollbar.onMouseMove = (event) => deps.tooltip.point('Horizontal scroll — drag or Option+wheel', event.x, event.y);
      scrollbar.onMouseOut = () => deps.tooltip.clear();
      return new AxisBalancedHorizontalScrollbarPaint(renderer, scrollbar, readPalette, backgroundColor);
    };

    this.editorVerticalBar = makeBar('editor-scrollbar-v', 'vertical', (position) => {
      workspaceSet.active.editor.viewport.haltScrollMomentum();
      workspaceSet.active.editor.viewport.scrollTop.value = this.trueScrollPosition(this.editorVerticalBar, position);
    });
    this.editorHorizontalBar = makeBar('editor-scrollbar-h', 'horizontal', (position) => {
      workspaceSet.active.editor.viewport.haltScrollMomentum();
      workspaceSet.active.editor.viewport.scrollLeft.value = this.trueScrollPosition(this.editorHorizontalBar, position);
    }, { backgroundColor: readPalette().bg, foregroundColor: readPalette().accent });
    editorArea.add(this.editorVerticalBar);
    editorArea.add(this.editorHorizontalBar);
    editorArea.add(makeHorizontalPaint(this.editorHorizontalBar, () => readPalette().bg));

    this.changesVerticalBar = makeBar('git-changes-scrollbar-v', 'vertical', (position) => {
      workspaceSet.active.haltGitChangesScroll();
      workspaceSet.active.gitPanel.changesScrollTop.value = this.trueScrollPosition(this.changesVerticalBar, position);
    });
    this.changesHorizontalBar = makeBar('git-changes-scrollbar-h', 'horizontal', (position) => {
      workspaceSet.active.haltGitChangesHorizontalScroll();
      workspaceSet.active.gitPanel.changesScrollLeft.value = this.trueScrollPosition(this.changesHorizontalBar, position);
    }, { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent });
    this.logVerticalBar = makeBar('git-log-scrollbar-v', 'vertical', (position) => {
      workspaceSet.active.haltGitLogScroll();
      workspaceSet.active.gitPanel.logScrollTop.value = this.trueScrollPosition(this.logVerticalBar, position);
      workspaceSet.active.ensureLogWindow(workspaceSet.active.gitPanel.logScrollTop.value);
    });
    this.logHorizontalBar = makeBar('git-log-scrollbar-h', 'horizontal', (position) => {
      workspaceSet.active.haltGitLogHorizontalScroll();
      workspaceSet.active.gitPanel.logScrollLeft.value = this.trueScrollPosition(this.logHorizontalBar, position);
    }, { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent });
    this.treeVerticalBar = makeBar('tree-scrollbar-v', 'vertical', (position) => {
      workspaceSet.active.haltTreeScroll();
      workspaceSet.active.tree.scrollTop.value = this.trueScrollPosition(this.treeVerticalBar, position);
    });
    this.treeHorizontalBar = makeBar('tree-scrollbar-h', 'horizontal', (position) => {
      workspaceSet.active.haltTreeHorizontalScroll();
      workspaceSet.active.tree.scrollLeft.value = this.trueScrollPosition(this.treeHorizontalBar, position);
    }, { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent });
    sidebar.add(this.treeVerticalBar);
    sidebar.add(this.treeHorizontalBar);
    sidebar.add(this.changesVerticalBar);
    sidebar.add(this.changesHorizontalBar);
    sidebar.add(this.logVerticalBar);
    sidebar.add(this.logHorizontalBar);
    sidebar.add(makeHorizontalPaint(this.treeHorizontalBar, () => readPalette().panel));
    sidebar.add(makeHorizontalPaint(this.changesHorizontalBar, () => readPalette().panel));
    sidebar.add(makeHorizontalPaint(this.logHorizontalBar, () => readPalette().panel));
  }

  /** True while applyBarGeometry is writing a bar's reported position — the bars' onChange handlers
   *  read this to ignore our own per-frame sync (One-Writer: only a real user drag writes the model). */
  get applyingGeometry(): boolean {
    return this.applying;
  }

  /** Map a bar's reported (min-thumb-clamped) onChange position back to the true model offset. */
  trueScrollPosition(bar: ScrollBarRenderable, reportedPosition: number): number {
    return Math.max(0, Math.round(reportedPosition * (this.barScales.get(bar) ?? 1)));
  }

  /** First visible tree row (the render window slides to keep the selection on screen); shared by the
   *  renderer and the mouse hit-test so clicks land on the row the user actually sees. */
  treeWindowTop(): number {
    return this.deps.workspaceSet.active.tree.windowTop();
  }

  private applyBarGeometry(
    bar: ScrollBarRenderable,
    orientation: 'vertical' | 'horizontal',
    region: { top: number; left: number; width: number; height: number },
    scroll: { scrollSize: number; viewportSize: number; scrollPosition: number },
  ): void {
    const geometry = ScrollbarGeometry.Class.scrollbarGeometry(orientation, region, scroll);
    if (!geometry) {
      // The ONE visibility rule for every bar: no scrollable range -> the bar does not exist.
      bar.visible = false;
      bar.scrollSize = 0;
      this.barScales.set(bar, 0);
      return;
    }
    bar.visible = true;
    const thickness = this.deps.scrollbarThicknessCells();
    bar.top = orientation === 'vertical' ? geometry.trackTop : geometry.trackTop - (thickness - 1);
    bar.left = orientation === 'vertical' ? geometry.trackLeft - (thickness - 1) : geometry.trackLeft;
    if (orientation === 'vertical') {
      bar.height = geometry.trackLength;
      bar.width = thickness;
    } else {
      bar.width = geometry.trackLength;
      bar.height = thickness;
    }
    const slider = (bar as unknown as { slider?: { width?: number; height?: number } }).slider;
    if (slider) {
      if (orientation === 'vertical') slider.width = thickness;
      else slider.height = thickness;
    }
    this.applying = true;
    try {
      bar.scrollSize = scroll.scrollSize;
      bar.viewportSize = geometry.reportedViewportSize;
      bar.scrollPosition = geometry.reportedPosition;
    } finally {
      this.applying = false;
    }
    this.barScales.set(bar, geometry.reportedToTrueScale);
    if (process.env.TUI_DEBUG_BARS === '1')
      Logging.Class.info(
        `bar ${bar.id}: thickness=${thickness} trackLeft=${geometry.trackLeft} -> left=${bar.left} top=${bar.top} laidX=${bar.x} laidY=${bar.y} laidW=${bar.width} laidH=${bar.height}`,
      );
  }

  /** Converge layout-derived pane inputs AFTER Yoga has laid out the frame (each pane model owns its
   *  live extent). Returns true when any extent changed (the caller repaints once, then quiesces). */
  syncPaneViewportGeometry(): boolean {
    const { workspaceSet, theme } = this.deps;
    let changed = false;
    const sidebarInnerWidth = Math.max(1, this.deps.sidebarWidth() - 2);
    const treeViewportHeight = Math.max(1, (this.deps.sidebar.height as number) - 2);
    const treeViewportWidth = Math.max(1, sidebarInnerWidth - this.deps.scrollbarThicknessCells());
    if (workspaceSet.active.tree.viewportHeight.value !== treeViewportHeight) {
      workspaceSet.active.tree.viewportHeight.value = treeViewportHeight;
      changed = true;
    }
    if (workspaceSet.active.tree.viewportWidth.value !== treeViewportWidth) {
      workspaceSet.active.tree.viewportWidth.value = treeViewportWidth;
      changed = true;
    }
    workspaceSet.active.tree.clampHorizontalScroll();

    const gitAvailable = workspaceSet.active.git.value !== null;
    const changesViewportWidth = Math.max(1, sidebarInnerWidth - this.deps.scrollbarThicknessCells());
    const changesContentWidth = gitAvailable
      ? GitPaneRenderer.Class.changesContentWidth(this.deps.gitChangeRowsNow() as never, theme.checkboxIcons)
      : 0;
    const geometry = this.deps.gitPanelGeometry();
    const changesViewportHeight = Math.max(1, geometry.changesRows);
    const logViewportHeight = Math.max(1, geometry.logRows);
    if (
      workspaceSet.active.gitPanel.changesViewportHeight.value !== changesViewportHeight ||
      workspaceSet.active.gitPanel.logViewportHeight.value !== logViewportHeight
    ) {
      workspaceSet.active.gitPanel.setVerticalViewportHeights(changesViewportHeight, logViewportHeight);
      changed = true;
    }
    if (
      workspaceSet.active.gitPanel.changesViewportWidth.value !== changesViewportWidth ||
      workspaceSet.active.gitPanel.changesContentWidth.value !== changesContentWidth
    ) {
      workspaceSet.active.gitPanel.setChangesHorizontalExtent(changesContentWidth, changesViewportWidth);
      changed = true;
    }
    const logViewportWidth = Math.max(1, sidebarInnerWidth - this.deps.scrollbarThicknessCells());
    const logContentWidth = gitAvailable ? GitPaneRenderer.Class.logContentWidth(workspaceSet.active) : 0;
    if (
      workspaceSet.active.gitPanel.logViewportWidth.value !== logViewportWidth ||
      workspaceSet.active.gitPanel.logContentWidth.value !== logContentWidth
    ) {
      workspaceSet.active.gitPanel.setLogHorizontalExtent(logContentWidth, logViewportWidth);
      changed = true;
    }
    return changed;
  }

  /** Place + scale every bar from the current rendered layout (the per-frame geometry sync). */
  syncScrollbars(): void {
    const { workspaceSet, editorArea, codeBody, sidebar, gitSplitDivider } = this.deps;
    const editor = workspaceSet.active.editor;
    const editorVisible = editor.hasDocument.value;
    const viewportHeight = this.deps.editorViewportHeight();
    const viewportWidth = this.deps.editorViewportWidth();
    const editorRegion = {
      top: 0,
      left: Math.max(0, codeBody.x - (editorArea.x + 1)),
      width: Math.max(1, (codeBody.width as number) || viewportWidth + 1),
      height: viewportHeight,
    };
    this.applyBarGeometry(this.editorVerticalBar, 'vertical', editorRegion, {
      scrollSize: editorVisible
        ? editor.wordWrap.value
          ? EditorWrap.Class.totalVisualRows(editor.document, editor.wrapWidth())
          : editor.document.lineCount
        : 0,
      viewportSize: viewportHeight,
      scrollPosition: editor.viewport.scrollTop.value,
    });
    let widestVisibleLineWidth = 0;
    if (editorVisible && !editor.wordWrap.value) {
      const firstVisibleLine = editor.viewport.scrollTop.value;
      for (const line of editor.document.slice(firstVisibleLine, viewportHeight)) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, EditorCoordinates.Class.lineWidth(line));
      }
    }
    this.applyBarGeometry(this.editorHorizontalBar, 'horizontal', editorRegion, {
      scrollSize: widestVisibleLineWidth,
      viewportSize: viewportWidth,
      scrollPosition: editor.viewport.scrollLeft.value,
    });

    const filesVisible = workspaceSet.active.sidebarView.value !== 'git';
    const sidebarInnerWidthFiles = this.deps.sidebarWidth() - 2;
    const treeViewportHeight = Math.max(1, (sidebar.height as number) - 2);
    this.applyBarGeometry(
      this.treeVerticalBar,
      'vertical',
      { top: 0, left: 0, width: sidebarInnerWidthFiles, height: treeViewportHeight },
      {
        scrollSize: filesVisible ? workspaceSet.active.tree.rows.length : 0,
        viewportSize: treeViewportHeight,
        scrollPosition: workspaceSet.active.tree.scrollTop.value,
      },
    );
    const treeViewportWidth = workspaceSet.active.tree.viewportWidth.value;
    this.applyBarGeometry(
      this.treeHorizontalBar,
      'horizontal',
      { top: 0, left: 0, width: sidebarInnerWidthFiles, height: treeViewportHeight },
      {
        scrollSize: filesVisible ? workspaceSet.active.tree.contentWidth : 0,
        viewportSize: treeViewportWidth,
        scrollPosition: workspaceSet.active.tree.scrollLeft.value,
      },
    );

    const gitVisible = workspaceSet.active.sidebarView.value === 'git' && workspaceSet.active.git.value !== null;
    const sidebarInnerWidth = this.deps.sidebarWidth() - 2;
    const geometry = this.deps.gitPanelGeometry();
    const changesRegion = { top: 1, left: 0, width: sidebarInnerWidth, height: Math.max(1, geometry.changesRows) };
    this.applyBarGeometry(this.changesVerticalBar, 'vertical', changesRegion, {
      scrollSize: gitVisible ? this.deps.gitChangeRowsNow().length : 0,
      viewportSize: geometry.changesRows,
      scrollPosition: workspaceSet.active.gitPanel.changesScrollTop.value,
    });
    const changesViewportWidth = workspaceSet.active.gitPanel.changesViewportWidth.value;
    this.applyBarGeometry(this.changesHorizontalBar, 'horizontal', changesRegion, {
      scrollSize: gitVisible ? workspaceSet.active.gitPanel.changesContentWidth.value : 0,
      viewportSize: changesViewportWidth,
      scrollPosition: workspaceSet.active.gitPanel.changesScrollLeft.value,
    });
    const logFlatEnd = workspaceSet.active.logFlatEnd();
    const logRegion = {
      top: geometry.dividerRow,
      left: 0,
      width: sidebarInnerWidth,
      height: Math.max(1, geometry.logRows),
    };
    this.applyBarGeometry(this.logVerticalBar, 'vertical', logRegion, {
      scrollSize: gitVisible
        ? Number.isFinite(logFlatEnd)
          ? logFlatEnd
          : workspaceSet.active.gitPanel.logScrollTop.value + geometry.logRows * 4
        : 0,
      viewportSize: geometry.logRows,
      scrollPosition: workspaceSet.active.gitPanel.logScrollTop.value,
    });
    const logViewportWidth = workspaceSet.active.gitPanel.logViewportWidth.value;
    this.applyBarGeometry(this.logHorizontalBar, 'horizontal', logRegion, {
      scrollSize: gitVisible ? workspaceSet.active.gitPanel.logContentWidth.value : 0,
      viewportSize: logViewportWidth,
      scrollPosition: workspaceSet.active.gitPanel.logScrollLeft.value,
    });

    if (gitVisible) {
      gitSplitDivider.visible = true;
      gitSplitDivider.top = Math.max(1, geometry.dividerRow - 1);
      gitSplitDivider.left = 0;
      gitSplitDivider.width = sidebarInnerWidth;
    } else {
      gitSplitDivider.visible = false;
    }
  }
}

export namespace ScrollbarSync {
  export const $Class = $ScrollbarSync;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
