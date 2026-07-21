// The root frame, rendered from workspace + theme state. A column of
// [ main row: files sidebar | editor ] over a status bar. `update()` re-syncs content from
// state after each input (one-way flow: state → view, never the reverse).
//
// invariant: ivue owns state and OpenTUI owns projection (project.invariants.md)
// invariant: The terminal shows a bounded viewport (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import {
  BoxRenderable,
  TextRenderable,
  StyledText,
  fg,
  bg,
  bold,
  ScrollBarRenderable,
  type TextChunk,
  type CliRenderer,
  type OptimizedBuffer,
} from '@opentui/core';
import type { Workspace } from '../workspace/Workspace';
import type { App } from '../app/App';
import type { Theme } from '../theme/Theme';
import type { CommandRegistry } from '../commands/CommandRegistry';
import type { Palette } from '../theme/ThemePalettes';
import { Highlighter, type Role } from '../syntax/Highlighter';
import { Files } from '../system/Files';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import { displayColumn, lineWidth, graphemeAtDisplayColumn, graphemeToU16 } from '../editor/editor.coordinates';
import { EditorWrap, type VisualRow } from '../editor/EditorWrap';
import { SelectableText } from './SelectableText';
import { GitRows, type ChangeRow, type FileRow } from '../git/GitRows';
import { GitLogRows } from '../git/GitLogRows';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import type { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { Tooltip } from './Tooltip';
import type { SettingsPanel } from '../settings/SettingsPanel';
import { SplitterModel } from '../layout/SplitterModel';
import { Logging } from '../system/Logging';

function roleColor(role: Role, palette: Palette): string {
  switch (role) {
    case 'keyword': return palette.keyword;
    case 'string': return palette.string;
    case 'number': return palette.number;
    case 'comment': return palette.comment;
    case 'func': return palette.func;
    case 'type': return palette.type;
    case 'operator': return palette.operator;
    case 'added': return palette.added;
    case 'removed': return palette.deleted;
    default: return palette.fg;
  }
}


export interface RootView {
  update(): void;
  editorViewportHeight(): number;
  editorViewportWidth(): number;
  /** Frame-tick hook: advance drag-edge auto-scroll; true while active (keep frames coming). */
  tickDragAutoScroll(dtSeconds: number): boolean;
  dispose(): void;
}

// The tooltip's renderable: NEVER stamped into the hit grid, so the pointer can never resolve to
// it — a click at the tooltip's cells hits whatever is beneath, exactly as if the tooltip did not
// exist. (OpenTUI stamps every rendered renderable into the hit grid inside Renderable.render;
// there is no opt-out option, so the stamp call is masked for the duration of this one render.)
// invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
class HitTransparentText extends TextRenderable {
  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    const context = this._ctx;
    const originalAddToHitGrid = context.addToHitGrid;
    context.addToHitGrid = () => {};
    try {
      super.render(buffer, deltaTime);
    } finally {
      context.addToHitGrid = originalAddToHitGrid;
    }
  }
}

export function buildRootView(
  renderer: CliRenderer,
  workspace: Workspace.Instance,
  theme: Theme.Instance,
  commands: CommandRegistry.Instance,
  app: App.Instance,
  contextMenu: ContextMenu.Instance,
  tooltip: Tooltip.Instance,
  settingsPanel: SettingsPanel.Instance,
): RootView {
  const root = renderer.root;
  const readPalette = () => theme.palette;
  const settings = settingsPanel.settings;

  // OpenTUI captures a drag target only on the FIRST drag event, resolved at the pointer's CURRENT
  // cell — so a thin (1-cell) grab strip is abandoned the instant the pointer moves off it and
  // onMouseDrag never fires. Grabbing the capture explicitly on mousedown (via the same `_ctx` mouse
  // context the tooltip masks addToHitGrid through) routes EVERY subsequent drag to that renderable
  // regardless of where the pointer travels — the robust pattern for any thin divider/thumb. OpenTUI
  // releases the capture itself on the up event (firing drag-end), so no manual clear is needed.
  const captureDragTarget = (target: object): void => {
    const withContext = target as {
      _ctx?: { setCapturedRenderable?: (renderable: unknown) => void };
    };
    withContext._ctx?.setCapturedRenderable?.(target);
  };

  // Sidebar↔editor width divider: a vertical SplitterModel in CELLS whose size IS the sidebar width,
  // bound to settings.sidebarWidth so a drag persists + live-applies. onSizeChange writes the setting.
  const sidebarSplitter = new SplitterModel.Class({
    orientation: 'vertical',
    mode: 'cells',
    initialSize: settings.sidebarWidth.value,
    minimumSize: 18,
    maximumSize: 70,
    onSizeChange: (width) => {
      settings.sidebarWidth.value = Math.round(width);
      settings.save();
    },
  });
  // settings.sidebarWidth is the SINGLE source of truth: the settings panel AND the drag both write
  // it, and the layout reads it here — so changing it in Ctrl+, resizes live, and dragging persists.
  const sidebarWidth = (): number => Math.round(settings.sidebarWidth.value);

  const column = new BoxRenderable(renderer, {
    id: 'root-column',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: readPalette().bg,
  });

  const mainRow = new BoxRenderable(renderer, {
    id: 'main-row',
    flexDirection: 'row',
    flexGrow: 1,
    width: '100%',
  });

  const sidebar = new BoxRenderable(renderer, {
    id: 'sidebar',
    width: sidebarWidth(),
    height: '100%',
    border: true,
    borderStyle: 'rounded',
    title: 'Files',
    backgroundColor: readPalette().panel,
  });
  const sidebarBody = new TextRenderable(renderer, { id: 'sidebar-body', content: '' });
  sidebar.add(sidebarBody);

  // The editor column stacks a 1-row TAB BAR above the bordered editor area. Wrapping (rather than
  // adding the tab bar INSIDE editorArea) leaves editorArea's border, gutter/code layout, scrollbar
  // geometry, and layout-anchored caret coords (codeBody.x/y) completely unchanged.
  const editorColumn = new BoxRenderable(renderer, {
    id: 'editor-column',
    flexGrow: 1,
    height: '100%',
    flexDirection: 'column',
  });
  const tabBar = new TextRenderable(renderer, { id: 'editor-tab-bar', content: '', height: 1, width: '100%' });
  const editorArea = new BoxRenderable(renderer, {
    id: 'editor-area',
    flexGrow: 1,
    width: '100%',
    border: true,
    borderStyle: 'rounded',
    flexDirection: 'row',
    title: 'Editor',
  });
  // Gutter (line numbers + current-line marker) and code are SEPARATE renderables so the code
  // buffer holds only code — OpenTUI's native selection then never shades the gutter on a
  // multi-line span, and code-local selection coords are pure display columns.
  const gutterBody = new TextRenderable(renderer, { id: 'editor-gutter', content: '' });
  const codeBody = new SelectableText(renderer, {
    id: 'editor-code',
    content: '',
    // selectable:false — OpenTUI's OWN mouse-drag selection is a second writer of selection state
    // that the model never sees: its highlight appeared on drag, then the next paint's
    // applySelection() (reading the EMPTY model selection) wiped it — the human-QA
    // "selection appears then disappears" bug. The model is the one writer; mouse events below
    // drive cursor+anchor, and the native selection is only ever set programmatically from them.
    selectable: false,
    flexGrow: 1,
    // The RENDERABLE never soft-wraps — the renderable wrapping text itself would desync the
    // gutter and every row-based mapping (caret Y, selection rows, click hit-testing). Word wrap
    // is a MODE handled ABOVE this layer: wrap-OFF renders one file line per visual row (long
    // lines clip; horizontal scroll covers the rest); wrap-ON feeds pre-wrapped SEGMENT rows from
    // the pure mapping layer (EditorWrap.ts), so this stays 'none' in both modes.
    // invariant: One file line is one visual row when word wrap is off (ui.invariants.md)
    wrapMode: 'none',
  });
  editorArea.add(gutterBody);
  editorArea.add(codeBody);
  editorColumn.add(tabBar);
  editorColumn.add(editorArea);

  // Draggable sidebar↔editor divider (1-cell bar). onMouseDrag fires globally while the button is
  // held (even off the bar), so a drag resizes smoothly; the model clamps to [min,max] + persists.
  const sidebarDivider = new BoxRenderable(renderer, {
    id: 'sidebar-divider',
    width: 1,
    height: '100%',
    flexShrink: 0, // keep the 1-cell grab column (flex must not squeeze it to zero)
    backgroundColor: readPalette().border, // a visible bg also puts it in the mouse hit grid
  });
  let sidebarDividerHover = false;
  sidebarDivider.onMouseDown = (event) => {
    captureDragTarget(sidebarDivider); // capture on down so a 1-cell divider survives the drag
    sidebarSplitter.size.value = settings.sidebarWidth.value; // anchor from the live width
    sidebarSplitter.beginDrag(event.x);
    renderer.requestRender();
  };
  sidebarDivider.onMouseDrag = (event) => {
    sidebarSplitter.dragTo(event.x);
    renderer.requestRender();
  };
  const endSidebarDrag = (): void => {
    sidebarSplitter.endDrag();
    renderer.requestRender();
  };
  sidebarDivider.onMouseUp = endSidebarDrag;
  sidebarDivider.onMouseDragEnd = endSidebarDrag;
  sidebarDivider.onMouseMove = () => {
    if (!sidebarDividerHover) {
      sidebarDividerHover = true;
      renderer.requestRender();
    }
  };
  sidebarDivider.onMouseOut = () => {
    if (sidebarDividerHover) {
      sidebarDividerHover = false;
      renderer.requestRender();
    }
  };

  mainRow.add(sidebar);
  mainRow.add(sidebarDivider);
  mainRow.add(editorColumn);

  const statusBar = new BoxRenderable(renderer, {
    id: 'status-bar',
    width: '100%',
    height: 1,
    flexDirection: 'row',
    backgroundColor: readPalette().statusBg,
  });
  const statusText = new TextRenderable(renderer, { id: 'status-text', content: '' });
  statusBar.add(statusText);

  column.add(mainRow);
  column.add(statusBar);
  root.add(column);

  // Command palette overlay — added last so it renders on top; shown only when open.
  const commandPalette = new BoxRenderable(renderer, {
    id: 'palette',
    position: 'absolute',
    left: '20%',
    top: 2,
    width: '60%',
    border: true,
    borderStyle: 'rounded',
    title: 'Command Palette',
    flexDirection: 'column',
    visible: false,
    zIndex: 100,
  });
  const commandPaletteInput = new TextRenderable(renderer, { id: 'palette-input', content: '' });
  const commandPaletteList = new TextRenderable(renderer, { id: 'palette-list', content: '' });
  commandPalette.add(commandPaletteInput);
  commandPalette.add(commandPaletteList);
  root.add(commandPalette);

  // Destructive-action confirmation (discard) — a small modal strip; y confirms, anything else
  // cancels. invariant: Destructive working-tree operations require confirmation (src/modules/git/git.invariants.md)
  const confirmBox = new BoxRenderable(renderer, {
    id: 'confirm-discard',
    position: 'absolute',
    left: '20%',
    top: 4,
    width: '60%',
    border: true,
    borderStyle: 'rounded',
    title: 'Confirm',
    visible: false,
    zIndex: 120,
  });
  const confirmText = new TextRenderable(renderer, { id: 'confirm-discard-text', content: '' });
  confirmBox.add(confirmText);
  root.add(confirmBox);

  // Settings panel (Ctrl+,) — an overlay pane over the reactive settings store. ↑/↓ select, ←/→ change.
  const settingsBox = new BoxRenderable(renderer, {
    id: 'settings-panel',
    position: 'absolute',
    left: '15%',
    top: 2,
    width: '70%',
    border: true,
    borderStyle: 'rounded',
    title: 'Settings',
    visible: false,
    zIndex: 122,
  });
  const settingsText = new TextRenderable(renderer, { id: 'settings-panel-text', content: '' });
  settingsBox.add(settingsText);
  root.add(settingsBox);

  // Context-menu modal layer. The BACKDROP is an invisible (transparent, borderless) full-screen
  // box just beneath the menu: OpenTUI stamps the hit grid in render order (zIndex ascending), so
  // while the menu is open EVERY pointer cell resolves to either the menu box (above) or this
  // backdrop — the panes beneath are unreachable by construction. The backdrop's only behavior is
  // to close the menu; the click it consumed acts on nothing else.
  // invariant: A context menu is modal and single-consumer (src/modules/ui/ui.invariants.md)
  const contextMenuBackdrop = new BoxRenderable(renderer, {
    id: 'context-menu-backdrop',
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    visible: false,
    zIndex: 125,
  });
  const contextMenuBox = new BoxRenderable(renderer, {
    id: 'context-menu',
    position: 'absolute',
    border: true,
    borderStyle: 'rounded',
    visible: false,
    zIndex: 130,
  });
  // selectable:false — a click on the menu must ONLY run the item: OpenTUI text is selectable by
  // default, and a default-selectable menu list starts a native text selection on click, which
  // then swallows the NEXT ctrl+click as a selection-extend (verified live).
  const contextMenuList = new TextRenderable(renderer, { id: 'context-menu-list', content: '', selectable: false });
  contextMenuBox.add(contextMenuList);
  root.add(contextMenuBackdrop);
  root.add(contextMenuBox);

  contextMenuBackdrop.onMouseDown = () => contextMenu.close();
  // Screen row -> item index (the +1 skips the top border); out-of-range rows resolve to no item.
  const contextMenuItemAt = (screenY: number): number => screenY - (contextMenuBox.y + 1);
  contextMenuBox.onMouseMove = (event) => contextMenu.hover(contextMenuItemAt(event.y));
  contextMenuBox.onMouseOut = () => contextMenu.hover(-1);
  contextMenuBox.onMouseDown = (event) => contextMenu.runAt(contextMenuItemAt(event.y));

  // Tooltip overlay: display-only and hit-transparent (see HitTransparentText above) — it can
  // never receive or consume a pointer event.
  // invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
  const tooltipText = new HitTransparentText(renderer, {
    id: 'tooltip',
    content: '',
    position: 'absolute',
    visible: false,
    zIndex: 140,
    selectable: false, // display-only in every sense
  });
  root.add(tooltipText);


  // Scale map (reported->true position per bar) + intended thickness (cells; NEVER read back from
  // layout — pre-layout reads return 0).
  const barScales = new Map<object, number>();
  // UNIFIED thickness: every scrollbar (both axes, every pane) is the SAME cell count, read LIVE from
  // settings.scrollbarThickness so a change applies to all bars at once (one source of truth — the
  // scrollbarThickness applied-effect test asserts the rendered bar occupies exactly this many cells).
  const scrollbarThicknessCells = (): number => Math.max(1, Math.round(settings.scrollbarThickness.value));
  // True while applyBarGeometry is ASSIGNING scrollPosition: the widget fires onChange for
  // programmatic writes too, and treating those as user thumb-drags halted the momentum glide on
  // every paint (the 'wheel not smooth since scrollbars' regression). onChange handlers must act
  // only on USER-initiated changes — a real thumb drag then halts momentum and adopts authority.
  let applyingBarGeometry = false;

  // Thin draggable scrollbars (OpenTUI ScrollBar: built-in draggable thumb + onChange). Each bar
  // is a 1-cell strip INSIDE its pane's border; onChange writes the SAME model offset the wheel
  // and keyboard write (One-Writer: the newest input wins; momentum halts on thumb drags).
  const editorVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'editor-scrollbar-v',
    orientation: 'vertical',
    position: 'absolute',
    width: 1,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspace.editor.viewport.haltScrollMomentum(); // real thumb drag adopts authority
      workspace.editor.viewport.scrollTop.value = trueScrollPosition(editorVerticalBar, position);
    },
  });
  const editorHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'editor-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    height: 1,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspace.editor.viewport.haltScrollMomentum(); // real thumb drag adopts authority
      workspace.editor.viewport.scrollLeft.value = trueScrollPosition(editorHorizontalBar, position);
    },
  });
  editorArea.add(editorVerticalBar);
  editorArea.add(editorHorizontalBar);
  const changesBar = new ScrollBarRenderable(renderer, {
    id: 'git-changes-scrollbar',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspace.haltGitChangesScroll(); // real thumb drag adopts authority
      workspace.gitPanel.changesScrollTop.value = trueScrollPosition(changesBar, position);
    },
  });
  const logBar = new ScrollBarRenderable(renderer, {
    id: 'git-log-scrollbar',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return; // ignore our own per-frame scrollPosition sync (One-Writer)
      workspace.haltGitLogScroll(); // a real thumb drag adopts authority
      workspace.gitPanel.logScrollTop.value = trueScrollPosition(logBar, position);
      workspace.ensureLogWindow(workspace.gitPanel.logScrollTop.value);
    },
  });
  // File-tree vertical scrollbar (files view). The tree owns an independent scrollTop; a thumb drag
  // adopts authority (halts the wheel-momentum) and writes the offset, the same One-Writer pattern.
  const treeVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'tree-scrollbar',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspace.haltTreeScroll();
      workspace.tree.scrollTop.value = trueScrollPosition(treeVerticalBar, position);
    },
  });
  sidebar.add(treeVerticalBar);
  sidebar.add(changesBar);
  sidebar.add(logBar);

  // Draggable git changes↔log divider: a 1-row grab strip over the divider glyph row (git view only).
  // Dragging sets settings.gitSplitRatio LIVE via workspace.setGitSplit — the SAME persisted value the
  // settings panel writes (single source). Capture-on-mousedown (captureDragTarget) so this thin strip
  // survives the drag exactly like the sidebar divider; the ratio is the pointer's row within the
  // sidebar body, so it tracks the cursor directly.
  const gitSplitDivider = new BoxRenderable(renderer, {
    id: 'git-split-divider',
    position: 'absolute',
    height: 1,
    backgroundColor: readPalette().border,
    visible: false,
  });
  sidebar.add(gitSplitDivider);
  const gitSplitRatioAtPointer = (pointerScreenY: number): number => {
    const bodyTopScreenY = (sidebar.y as number) + 1; // +1 = sidebar top border
    const bodyHeight = Math.max(1, (sidebar.height as number) - 2);
    return (pointerScreenY - bodyTopScreenY) / bodyHeight;
  };
  gitSplitDivider.onMouseDown = (event) => {
    captureDragTarget(gitSplitDivider);
    workspace.setGitSplit(gitSplitRatioAtPointer(event.y));
    renderer.requestRender();
  };
  gitSplitDivider.onMouseDrag = (event) => {
    workspace.setGitSplit(gitSplitRatioAtPointer(event.y));
    renderer.requestRender();
  };

  // Interior height of a bordered box = box height - 2 (top+bottom border).
  // invariant: A scrollable pane height is an input not an output (ui.invariants.md)
  const editorViewportHeight = () => Math.max(1, (editorArea.height as number) - 2);
  // Layout-anchored (never hand-derived): the code renderable's own laid-out width, minus the one
  // column the overlay vertical scrollbar occupies — so the final column of a line is always
  // reachable and visible at max scrollLeft.
  const editorViewportWidth = () => {
    const laidOut = codeBody.width as number;
    if (laidOut && laidOut > 1) return Math.max(1, laidOut - 1);
    return Math.max(1, (editorArea.width as number) - 2 - 6);
  };

  // First visible tree row (the render window slides to keep the selection on screen); shared by
  // the renderer and the mouse hit-test so clicks land on the row the user actually sees.
  function treeWindowTop(): number {
    // Publish the live viewport height so the model can clamp its independent scroll offset + reveal
    // the selection minimally; the window top is that offset (NOT derived from the selection index,
    // which used to snap the list to the selection on every click/open).
    const height = Math.max(1, (sidebar.height as number) - 2);
    workspace.tree.viewportHeight.value = height;
    return workspace.tree.windowTop();
  }

  // Every bar's placement + mapping comes from the ONE geometry source (scrollbar-geometry.ts):
  // regions are derived per frame from the ACTUAL rendered layout; the returned reported values
  // keep the min-thumb, and the stored scale maps onChange positions back to the true range.
  // invariant: A scrollbar track is derived per frame from its region rect (ui.invariants.md)
  function trueScrollPosition(bar: ScrollBarRenderable, reportedPosition: number): number {
    return Math.max(0, Math.round(reportedPosition * (barScales.get(bar) ?? 1)));
  }
  function applyBarGeometry(
    bar: ScrollBarRenderable,
    orientation: 'vertical' | 'horizontal',
    region: { top: number; left: number; width: number; height: number },
    scroll: { scrollSize: number; viewportSize: number; scrollPosition: number },
  ): void {
    const geometry = ScrollbarGeometry.Class.scrollbarGeometry(orientation, region, scroll);
    if (!geometry) {
      // The ONE visibility rule for every bar: no scrollable range -> the bar does not exist
      // (track AND thumb render nothing). Explicit, never left to widget heuristics.
      bar.visible = false;
      bar.scrollSize = 0;
      barScales.set(bar, 0);
      return;
    }
    bar.visible = true;
    // A bar thicker than 1 cell grows INWARD from the region edge (never over the border). Thickness is
    // read live + UNIFORM across every bar, and the cross-axis size is set here every frame so a
    // settings change resizes all bars without reconstruction.
    const thickness = scrollbarThicknessCells();
    bar.top = orientation === 'vertical' ? geometry.trackTop : geometry.trackTop - (thickness - 1);
    bar.left = orientation === 'vertical' ? geometry.trackLeft - (thickness - 1) : geometry.trackLeft;
    if (orientation === 'vertical') {
      bar.height = geometry.trackLength;
      bar.width = thickness;
    } else {
      bar.width = geometry.trackLength;
      bar.height = thickness;
    }
    applyingBarGeometry = true;
    try {
      bar.scrollSize = scroll.scrollSize;
      bar.viewportSize = geometry.reportedViewportSize;
      bar.scrollPosition = geometry.reportedPosition;
    } finally {
      applyingBarGeometry = false;
    }
    barScales.set(bar, geometry.reportedToTrueScale);
    if (process.env.TUI_DEBUG_BARS === '1')
      Logging.Class.info(
        `bar ${bar.id}: thickness=${thickness} trackLeft=${geometry.trackLeft} -> left=${bar.left} top=${bar.top} laidX=${bar.x} laidY=${bar.y}`,
      );
  }

  function syncScrollbars(): void {
    const editor = workspace.editor;
    const editorVisible = editor.hasDocument.value;
    const viewportHeight = editorViewportHeight();
    const viewportWidth = editorViewportWidth();
    // The editor's scroll region = the CODE area's content rect, in editorArea's content box.
    const editorRegion = {
      top: 0,
      left: Math.max(0, codeBody.x - (editorArea.x + 1)),
      width: Math.max(1, (codeBody.width as number) || viewportWidth + 1),
      height: viewportHeight,
    };
    applyBarGeometry(editorVerticalBar, 'vertical', editorRegion, {
      scrollSize: editorVisible ? editor.document.lineCount : 0,
      viewportSize: viewportHeight,
      scrollPosition: editor.viewport.scrollTop.value,
    });
    // Wrap mode has NO horizontal scroll axis: scrollSize 0 routes through the ONE visibility
    // rule (no scrollable range -> the bar does not exist), so the h-bar hides itself.
    let widestVisibleLineWidth = 0;
    if (editorVisible && !editor.wordWrap.value) {
      const firstVisibleLine = editor.viewport.scrollTop.value;
      for (const line of editor.document.slice(firstVisibleLine, viewportHeight)) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, lineWidth(line));
      }
    }
      applyBarGeometry(editorHorizontalBar, 'horizontal', editorRegion, {
        scrollSize: widestVisibleLineWidth,
        viewportSize: viewportWidth,
        scrollPosition: editor.viewport.scrollLeft.value,
      });

    // File-tree scrollbar (files view): the whole sidebar body is the tree list. scrollSize 0 in git
    // view routes through the visibility rule so the bar hides when the tree isn't showing.
    const filesVisible = workspace.sidebarView.value !== 'git';
    const sidebarInnerWidthFiles = sidebarWidth() - 2;
    const treeViewportHeight = Math.max(1, (sidebar.height as number) - 2);
    applyBarGeometry(
      treeVerticalBar,
      'vertical',
      { top: 0, left: 0, width: sidebarInnerWidthFiles, height: treeViewportHeight },
      {
        scrollSize: filesVisible ? workspace.tree.rows.length : 0,
        viewportSize: treeViewportHeight,
        scrollPosition: workspace.tree.scrollTop.value,
      },
    );

    // Git regions, in the sidebar's content box: branch row 0; changes rows 1..; divider;
    // log rows below — offsets RECOMPUTED from the rendered geometry each frame (splitRatio and
    // the changes count move them).
    const gitVisible = workspace.sidebarView.value === 'git' && workspace.git.value !== null;
    const sidebarInnerWidth = sidebarWidth() - 2;
    const changesRegion = { top: 1, left: 0, width: sidebarInnerWidth, height: Math.max(1, gitPanelGeometry.changesRows) };
    applyBarGeometry(changesBar, 'vertical', changesRegion, {
      scrollSize: gitVisible ? gitChangeRowsNow().length : 0,
      viewportSize: gitPanelGeometry.changesRows,
      scrollPosition: workspace.gitPanel.changesScrollTop.value,
    });
    // Flat-row total: commit count PLUS the rows contributed by expanded commits (inline expansion).
    const logFlatEnd = workspace.logFlatEnd();
    const logRegion = {
      top: gitPanelGeometry.dividerRow, // content-relative first log row (screen divider + 1)
      left: 0,
      width: sidebarInnerWidth,
      height: Math.max(1, gitPanelGeometry.logRows),
    };
    applyBarGeometry(logBar, 'vertical', logRegion, {
      // Unknown history length: a rolling virtual size keeps the thumb draggable; it refines once
      // the end is discovered (a short page sets knownEnd).
      scrollSize: gitVisible
        ? Number.isFinite(logFlatEnd)
          ? logFlatEnd
          : workspace.gitPanel.logScrollTop.value + gitPanelGeometry.logRows * 4
        : 0,
      viewportSize: gitPanelGeometry.logRows,
      scrollPosition: workspace.gitPanel.logScrollTop.value,
    });

    // Git changes↔log divider grab strip: over the divider GLYPH row (dividerRow is the first LOG row,
    // so the glyph is one above), spanning the sidebar body width. Only in git view.
    if (gitVisible) {
      gitSplitDivider.visible = true;
      gitSplitDivider.top = Math.max(1, gitPanelGeometry.dividerRow - 1);
      gitSplitDivider.left = 0;
      gitSplitDivider.width = sidebarInnerWidth;
    } else {
      gitSplitDivider.visible = false;
    }
  }

  function renderTree(): StyledText {
    // invariant: Renderables hold no model state (ui.invariants.md)
    // invariant: Only the visible window is rendered (ui.invariants.md)
    const palette = readPalette();
    const rows = workspace.tree.rows;
    const selectedIndex = workspace.tree.selectedIndex.value;
    const hoveredIndex = workspace.tree.hoveredIndex.value;
    const height = Math.max(1, (sidebar.height as number) - 2);
    const innerWidth = sidebarWidth() - 2;
    // Flyweight: only render the visible window around the selection.
    const top = treeWindowTop();
    const visible = rows.slice(top, top + height);
    const chunks: TextChunk[] = [];
    visible.forEach((row, visibleIndex) => {
      const rowIndex = top + visibleIndex;
      const selected = rowIndex === selectedIndex && workspace.focus.value === 'files';
      const hovered = rowIndex === hoveredIndex;
      const marker = selected ? '›' : ' ';
      const indent = '  '.repeat(row.depth);
      const icon = theme.icon(row.name, row.isDir, row.expanded);
      let label = `${marker}${indent}${icon} ${row.name}`;
      if (label.length > innerWidth) label = label.slice(0, innerWidth);
      // Pad to the pane's inner width so the row highlight spans the full row (VS Code-style).
      label = label.padEnd(innerWidth, ' ');
      // Two intensities: selection (stronger) over hover (subtle); bg is the primary signal.
      const rowBackground = selected ? palette.selection : hovered ? palette.cursorLine : null;
      const styled = fg(selected ? palette.accent : palette.fg)(label);
      chunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
      if (visibleIndex < visible.length - 1) chunks.push(fg(palette.fg)('\n'));
    });
    return new StyledText(chunks);
  }

  const EMPTY_STATE = [
    '',
    '   Fable — a terminal code workspace',
    '',
    '   ↑/↓  navigate files      Enter  open / expand',
    '   Tab  switch pane         Ctrl+P command palette',
    '   Ctrl+Q or F10  quit   (VS Code: Ctrl+X then Ctrl+C)',
    '',
  ].join('\n');

  // Gutter width in cells for the current document: "NN " (line number + space) + 1 marker cell.
  const gutterWidth = () => String(workspace.editor.document.lineCount).length + 1 + 2;

  // Wrap-mode view geometry of the last-rendered frame: the visual rows the window showed, written
  // by renderEditor and read by the caret block, applySelection, and the mouse hit-test — so all
  // consumers agree on what is where (same pattern as gitPanelGeometry). Presentation state only.
  // Empty when wrap is off.
  let wrapRowsWindow: VisualRow[] = [];

  // Map a document position to its wrap-mode viewport cell: the window row index and the visual
  // column WITHIN that row. 'before'/'after' = off-window on that side.
  function wrapVisualPosition(
    line: number,
    column: number,
  ): { rowIndex: number; column: number } | 'before' | 'after' {
    const firstRow = wrapRowsWindow[0];
    const lastRow = wrapRowsWindow[wrapRowsWindow.length - 1];
    if (!firstRow || !lastRow) return 'before';
    const lineText = workspace.editor.document.line(line);
    const segments = EditorWrap.Class.wrapLine(lineText, workspace.editor.wrapWidth());
    const segmentIndex = EditorWrap.Class.segmentIndexForCursor(segments, column);
    if (line < firstRow.lineIndex || (line === firstRow.lineIndex && segmentIndex < firstRow.segmentIndex))
      return 'before';
    if (line > lastRow.lineIndex || (line === lastRow.lineIndex && segmentIndex > lastRow.segmentIndex))
      return 'after';
    const rowIndex = wrapRowsWindow.findIndex(
      (row) => row.lineIndex === line && row.segmentIndex === segmentIndex,
    );
    if (rowIndex < 0) return 'after';
    const segment = segments[segmentIndex];
    return { rowIndex, column: displayColumn(lineText, column) - (segment?.startDisplayColumn ?? 0) };
  }

  // The editor tab bar. ONE geometry source: a layout pass produces positioned SEGMENTS that BOTH the
  // renderer and the click/hover hit-test consume — so a drawn cell and its hit-rect can never
  // disagree (the arrows-not-clickable bug was exactly that mismatch). Tabs fill from the left; the
  // overflow arrows pin to the RIGHT edge. Three visual states per target: idle → hover → pressed.
  type TabBarSegment =
    | { kind: 'tab'; index: number; start: number; end: number; closeColumn: number }
    | { kind: 'arrowLeft' | 'arrowRight' | 'badge'; start: number; end: number };
  let tabBarSegments: TabBarSegment[] = [];
  // Hover/press state (view-only), driven by tab-bar mouse move/press.
  let tabBarHover: { kind: 'tab' | 'close' | 'arrowLeft' | 'arrowRight' | 'badge'; index: number } | null = null;
  let tabBarArrowPressed: 'arrowLeft' | 'arrowRight' | null = null;
  let tabBarClosePressed: number | null = null; // index of the tab whose ✕ is being pressed
  // The strip's VIEWPORT PAN offset (first visible tab), INDEPENDENT of the active tab — the overflow
  // arrows drive this and never change which buffer is active (VS Code's ‹ › pan the strip only).
  // Changing the active tab (click / Ctrl+PageUp-Down) auto-reveals it, but panning does not snap back.
  let tabStripScrollOffset = 0;
  let lastRevealedActiveIndex = -1;

  function renderTabBar(): StyledText {
    const palette = readPalette();
    const tabs = workspace.buffers.tabs();
    tabBarSegments = [];
    if (tabs.length === 0) return new StyledText([fg(palette.dim)('  no open files')]);
    const barWidth = Math.max(1, tabBar.width as number);

    // Each tab lays out as ` name <dirty> ✕ ` — the ✕ has a space BEFORE and AFTER so it is never
    // flush against the tab edge, and the padding is identical regardless of label length.
    const measured = tabs.map((tab) => {
      const name = Files.Class.basename(tab.path);
      const labelWidth = 1 + lineWidth(name) + 1 + 1 + 1; // ' ' + name + ' ' + dirtyGlyph + ' '
      return { tab, name, labelWidth, width: labelWidth + 2 }; // + '✕' + trailing ' '
    });
    const totalWidth = measured.reduce((sum, entry) => sum + entry.width, 0);

    // Right controls, pinned to the edge: a clickable ` active/total ` COUNT BADGE (always), and when
    // the strip overflows, an ellipsis "more" marker + two padded 3-cell ARROWS. Reserve their width.
    const total = tabs.length;
    const activeIndex = tabs.findIndex((tab) => tab.active);
    const badgeText = ` ${activeIndex + 1}/${total} `;
    const badgeWidth = lineWidth(badgeText);
    const arrowCellWidth = 3; // ' « ' / ' » ' — padded so the hit target is easy to click
    const overflow = totalWidth + badgeWidth > barWidth;
    const rightControlsWidth = badgeWidth + (overflow ? 1 /* ellipsis */ + arrowCellWidth * 2 : 0);
    const tabsAreaWidth = Math.max(1, barWidth - rightControlsWidth);

    // How many whole tabs fit when rendering forward from a given start index.
    const windowEndFrom = (start: number): number => {
      let used = 0;
      let end = start;
      for (let index = start; index < total; index += 1) {
        const entry = measured[index];
        if (!entry || used + entry.width > tabsAreaWidth) break;
        used += entry.width;
        end = index + 1;
      }
      return Math.max(end, start + 1); // always show at least one tab
    };
    // Largest pan offset that still fills the strip to the last tab (so we never pan past the end).
    let maxScrollOffset = 0;
    if (overflow) {
      let used = 0;
      maxScrollOffset = total;
      for (let index = total - 1; index >= 0; index -= 1) {
        const entry = measured[index];
        if (!entry || used + entry.width > tabsAreaWidth) break;
        used += entry.width;
        maxScrollOffset = index;
      }
    }
    // Clamp the user's pan; then reveal the active tab ONLY when it actually changed (click / cycle) —
    // panning with the arrows leaves the active tab where it is, even if it scrolls out of view.
    tabStripScrollOffset = Math.max(0, Math.min(tabStripScrollOffset, maxScrollOffset));
    if (activeIndex >= 0 && activeIndex !== lastRevealedActiveIndex) {
      if (activeIndex < tabStripScrollOffset || activeIndex >= windowEndFrom(tabStripScrollOffset)) {
        tabStripScrollOffset = Math.min(activeIndex, maxScrollOffset);
      }
      lastRevealedActiveIndex = activeIndex;
    }
    const startIndex = overflow ? tabStripScrollOffset : 0;

    const chunks: TextChunk[] = [];
    let column = 0;
    let endIndex = startIndex;
    for (let index = startIndex; index < measured.length; index += 1) {
      const entry = measured[index];
      if (!entry || column + entry.width > tabsAreaWidth) break;
      const isActive = entry.tab.active;
      const isTabHover = tabBarHover?.kind === 'tab' && tabBarHover.index === index;
      const isCloseHover = tabBarHover?.kind === 'close' && tabBarHover.index === index;
      const rowBackground = isActive ? palette.selection : isTabHover ? palette.cursorLine : null;
      const labelColor = isActive ? palette.fg : palette.dim;
      const paint = (text: string, color: string) =>
        rowBackground ? bg(rowBackground)(fg(color)(text)) : fg(color)(text);
      const start = column;
      chunks.push(paint(` ${entry.name} `, labelColor));
      chunks.push(paint(entry.tab.dirty ? '●' : ' ', isActive ? palette.warning : palette.accent));
      chunks.push(paint(' ', labelColor));
      column += entry.labelWidth;
      const closeColumn = column;
      // The ✕ is an INDEPENDENTLY-stated target on EVERY tab (including active): idle → hover (bright
      // error ✕ that pops even over the active tab's selection bg) → pressed (inverted: bg over error).
      const isClosePressed = tabBarClosePressed === index;
      const closeColor = isClosePressed ? palette.bg : isCloseHover ? palette.error : labelColor;
      const closeBackground = isClosePressed ? palette.error : rowBackground;
      chunks.push(closeBackground ? bg(closeBackground)(fg(closeColor)('✕')) : fg(closeColor)('✕'));
      column += 1;
      chunks.push(paint(' ', labelColor)); // trailing pad — ✕ never touches the edge
      column += 1;
      tabBarSegments.push({ kind: 'tab', index, start, end: column, closeColumn });
      endIndex = index + 1;
    }

    // Fill the gap between the last tab and the right controls.
    while (column < tabsAreaWidth) {
      chunks.push(fg(palette.fg)(' '));
      column += 1;
    }

    if (overflow) {
      const moreLeft = startIndex > 0;
      const moreRight = endIndex < total;
      // "More →" cutoff affordance: a bright ellipsis at the edge where tabs continue (so a clean cut
      // never reads as "no more tabs"); dim when there is nothing more that way.
      chunks.push(fg(moreRight ? palette.accent : palette.border)(moreRight ? '…' : ' '));
      column += 1;
      // Bigger, easy-to-hit arrows: a bolder glyph in a padded 3-cell hit target. BRIGHT (fg/accent)
      // only when more tabs exist that direction; DIM (border) at the end — so "more exists" reads.
      const paintArrow = (which: 'arrowLeft' | 'arrowRight', enabled: boolean, glyph: string): void => {
        const pressed = tabBarArrowPressed === which && enabled;
        const hover = tabBarHover?.kind === which && enabled;
        const color = !enabled ? palette.border : pressed ? palette.accent : hover ? palette.accent : palette.fg;
        const background = pressed ? palette.selection : hover ? palette.cursorLine : null;
        const paintCell = (text: string) => (background ? bg(background)(fg(color)(text)) : fg(color)(text));
        const start = column;
        chunks.push(paintCell(` ${glyph} `)); // 3-cell padded hit target
        column += arrowCellWidth;
        tabBarSegments.push({ kind: which, start, end: column });
      };
      paintArrow('arrowLeft', moreLeft, '«');
      paintArrow('arrowRight', moreRight, '»');
    }

    // COUNT BADGE ` active/total ` — always shown, pinned right; click opens the all-buffers dropdown.
    const badgeHover = tabBarHover?.kind === 'badge';
    const badgeStart = column;
    chunks.push(
      badgeHover
        ? bg(palette.cursorLine)(fg(palette.accent)(badgeText))
        : fg(palette.accent)(badgeText),
    );
    column += badgeWidth;
    tabBarSegments.push({ kind: 'badge', start: badgeStart, end: column });
    return new StyledText(chunks);
  }

  // Resolve a local column to a tab-bar segment (shared by click + hover — one geometry source).
  function tabBarSegmentAt(localColumn: number): TabBarSegment | null {
    return tabBarSegments.find((segment) => localColumn >= segment.start && localColumn < segment.end) ?? null;
  }

  // The arrows PAN the strip viewport only — they never change the active buffer (the render clamps
  // the offset, so panning past an end is a no-op and the arrow reads as disabled there).
  function scrollTabsLeft(): void {
    if (tabStripScrollOffset > 0) {
      tabStripScrollOffset -= 1;
      renderer.requestRender();
    }
  }
  function scrollTabsRight(): void {
    tabStripScrollOffset += 1; // clamped to maxScrollOffset in renderTabBar
    renderer.requestRender();
  }

  // Clicking the count badge opens a dropdown of ALL open buffers (VS Code's overflow menu) — reusing
  // the ContextMenu machinery (modal, keyboard-navigable, Esc to close). Selecting a row jumps to it.
  function openTabDropdown(anchorColumn: number): void {
    const items = workspace.buffers.tabs().map((tab, index) => ({
      id: String(index),
      label: `${tab.active ? '●' : ' '} ${Files.Class.basename(tab.path)}${tab.dirty ? '  ✕' : ''}`,
      enabled: true,
    }));
    contextMenu.openAt(
      items,
      (tabBar.x as number) + anchorColumn,
      (tabBar.y as number) + 1,
      { width: renderer.width, height: renderer.height },
      (itemId) => workspace.activateTab(Number(itemId)),
    );
  }

  tabBar.onMouseDown = (event) => {
    tooltip.clear();
    const localColumn = event.x - (tabBar.x as number);
    const segment = tabBarSegmentAt(localColumn);
    if (!segment) return;
    if (segment.kind === 'tab') {
      if (localColumn === segment.closeColumn) {
        tabBarClosePressed = segment.index; // show the pressed ✕ before the close/confirm
        renderer.requestRender();
        workspace.requestCloseTab(segment.index);
      } else workspace.activateTab(segment.index);
    } else if (segment.kind === 'badge') {
      openTabDropdown(segment.start);
    } else {
      tabBarArrowPressed = segment.kind; // pressed colour shows until release
      if (segment.kind === 'arrowLeft') scrollTabsLeft();
      else scrollTabsRight();
      renderer.requestRender();
    }
  };
  tabBar.onMouseUp = () => {
    if (tabBarArrowPressed || tabBarClosePressed !== null) {
      tabBarArrowPressed = null;
      tabBarClosePressed = null;
      renderer.requestRender();
    }
  };
  tabBar.onMouseMove = (event) => {
    const localColumn = event.x - (tabBar.x as number);
    const segment = tabBarSegmentAt(localColumn);
    let next: typeof tabBarHover = null;
    if (segment?.kind === 'tab') {
      next = { kind: localColumn === segment.closeColumn ? 'close' : 'tab', index: segment.index };
    } else if (segment) {
      next = { kind: segment.kind, index: -1 };
    }
    if (JSON.stringify(next) !== JSON.stringify(tabBarHover)) {
      tabBarHover = next;
      renderer.requestRender();
    }
  };
  tabBar.onMouseOut = () => {
    if (tabBarHover || tabBarArrowPressed || tabBarClosePressed !== null) {
      tabBarHover = null;
      tabBarArrowPressed = null;
      tabBarClosePressed = null;
      renderer.requestRender();
    }
  };

  // Builds the visible window as two aligned StyledTexts — the gutter (line numbers + current-line
  // marker) and the code (syntax colors only, NO gutter). Only the visible lines are tokenized
  // (flyweight). Returns null for the empty state.
  function renderEditor(): { gutter: StyledText; code: StyledText } | null {
    const editor = workspace.editor;
    if (!editor.hasDocument.value) return null;
    const palette = readPalette();
    const language = LanguageRegistry.Class.forPath(editor.document.path);
    const height = editorViewportHeight();
    const top = editor.viewport.scrollTop.value;
    const visibleLines = editor.document.slice(top, height);
    const lineNumberWidth = String(editor.document.lineCount).length + 1;
    const currentLineIndex = editor.cursor.line.value;
    const focused = workspace.focus.value === 'editor';
    const gutterChunks: TextChunk[] = [];
    const codeChunks: TextChunk[] = [];
    const pushCodeChunks = (windowText: string): void => {
      if (editor.document.binary.value || language === 'plain') {
        codeChunks.push(fg(palette.fg)(windowText));
      } else {
        for (const span of Highlighter.Class.highlightLine(windowText, language)) {
          codeChunks.push(fg(roleColor(span.role, palette))(span.text));
        }
      }
    };
    if (editor.wordWrap.value) {
      // WRAP MODE: iterate VISUAL rows from the pure mapping layer — a long line contributes
      // multiple rows; the gutter numbers only a line's FIRST visual row (continuation rows are
      // blank, VS Code-style); each row's code is the segment's grapheme-safe slice. The window
      // walk is O(window) — the file is never materialized.
      // invariant: Word wrap is a pure view mapping (src/modules/editor/editor.invariants.md)
      wrapRowsWindow = EditorWrap.Class.visualRowsForWindow(editor.document, top, editor.wrapWidth(), height);
      wrapRowsWindow.forEach((row, rowIndex) => {
        const isCurrentLine = row.lineIndex === currentLineIndex;
        if (row.firstOfLine) {
          const lineNumberText = String(row.lineIndex + 1).padStart(lineNumberWidth, ' ');
          gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
          gutterChunks.push(fg(palette.accent)(isCurrentLine && focused ? '▏' : ' '));
        } else {
          gutterChunks.push(fg(palette.dim)(' '.repeat(lineNumberWidth + 2)));
        }
        const lineText = editor.document.line(row.lineIndex);
        pushCodeChunks(
          lineText.slice(
            graphemeToU16(lineText, row.segment.startGrapheme),
            graphemeToU16(lineText, row.segment.endGrapheme),
          ),
        );
        if (rowIndex < wrapRowsWindow.length - 1) {
          gutterChunks.push(fg(palette.fg)('\n'));
          codeChunks.push(fg(palette.fg)('\n'));
        }
      });
      return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks) };
    }
    wrapRowsWindow = [];
    // COLUMN virtualization (the horizontal twin of the line flyweight): each visible line is
    // sliced to the visible display-column window BEFORE tokenizing, so per-frame cost tracks
    // visible columns — never total line length (50k-char lines render at normal speed).
    // Trade-off: tokens start at the slice, so left-context-sensitive highlighting can differ at
    // the boundary (documented in the contract).
    // invariant: Cost tracks the actively observed set (project.invariants.md)
    const scrollLeft = editor.viewport.scrollLeft.value;
    const viewportWidth = editorViewportWidth();
    visibleLines.forEach((text, visibleIndex) => {
      const lineNumber = top + visibleIndex;
      const isCurrentLine = lineNumber === currentLineIndex;
      const lineNumberText = String(lineNumber + 1).padStart(lineNumberWidth, ' ');
      gutterChunks.push(fg(isCurrentLine ? palette.accent : palette.dim)(`${lineNumberText} `));
      gutterChunks.push(fg(palette.accent)(isCurrentLine && focused ? '▏' : ' '));
      let windowText = text;
      if (scrollLeft > 0 || text.length > viewportWidth) { // O(1) test; a needless slice is harmless
        let startGrapheme = graphemeAtDisplayColumn(text, scrollLeft);
        if (displayColumn(text, startGrapheme) < scrollLeft) startGrapheme += 1; // never split a straddling wide glyph
        const endGrapheme = graphemeAtDisplayColumn(text, scrollLeft + viewportWidth) + 1;
        windowText = text.slice(graphemeToU16(text, startGrapheme), graphemeToU16(text, endGrapheme));
      }
      pushCodeChunks(windowText);
      if (visibleIndex < visibleLines.length - 1) {
        gutterChunks.push(fg(palette.fg)('\n'));
        codeChunks.push(fg(palette.fg)('\n'));
      }
    });
    return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks) };
  }

  // Drive OpenTUI's native selection on the code renderable from the model selection, mapped into
  // code-local coords (x = display column, y = visible-line index). Clamps to the visible window.
  // invariant: The selected range renders with a background (ui.invariants.md)
  function applySelection(): void {
    const editor = workspace.editor;
    const selection = editor.hasDocument.value ? editor.cursor.selectionRange() : null;
    const top = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    if (editor.wordWrap.value) {
      // Wrap mode: the native selection coords are viewport-local VISUAL rows — map both ends
      // through the ONE logical↔visual layer, clamping off-window ends to the window edges.
      if (!selection || wrapRowsWindow.length === 0) {
        codeBody.clearSelectionRange();
        return;
      }
      const startPosition = wrapVisualPosition(selection.start.line, selection.start.col);
      const endPosition = wrapVisualPosition(selection.end.line, selection.end.col);
      if (startPosition === 'after' || endPosition === 'before') {
        codeBody.clearSelectionRange();
        return;
      }
      const anchorCell = startPosition === 'before' ? { rowIndex: 0, column: 0 } : startPosition;
      const focusCell =
        endPosition === 'after'
          ? { rowIndex: wrapRowsWindow.length - 1, column: editorViewportWidth() }
          : endPosition;
      codeBody.setSelectionRange(
        Math.max(0, anchorCell.column),
        anchorCell.rowIndex,
        Math.max(0, focusCell.column),
        focusCell.rowIndex,
      );
      return;
    }
    if (!selection || selection.end.line < top || selection.start.line >= top + viewportHeight) {
      codeBody.clearSelectionRange();
      return;
    }
    const selectionScrollLeft = editor.viewport.scrollLeft.value;
    const anchorY = Math.max(0, selection.start.line - top);
    const anchorX = selection.start.line >= top ? displayColumn(editor.document.line(selection.start.line), selection.start.col) : 0;
    const focusY = Math.min(viewportHeight - 1, selection.end.line - top);
    const focusX =
      selection.end.line < top + viewportHeight
        ? displayColumn(editor.document.line(selection.end.line), selection.end.col)
        : lineWidth(editor.document.line(Math.min(top + viewportHeight - 1, editor.document.lineCount - 1)));
    codeBody.setSelectionRange(
      Math.max(0, anchorX - selectionScrollLeft),
      anchorY,
      Math.max(0, focusX - selectionScrollLeft),
      focusY,
    );
  }

  // The git sidebar: a changes region (staged/unstaged/untracked + branch header) over a
  // VIRTUALIZED commit log (only the visible window is materialized, via CommitLog.rows). Split by
  // gitPanel.splitRatio. Keyboard-driven for now; mouse + drill-down + drag layer on next.
  // invariant: Cost tracks the actively observed set (project.invariants.md)
  // Layout geometry of the last-rendered git panel, for mouse hit-testing — the renderer writes
  // it, the click/hover/wheel handlers read it, so both always agree on what is where.
  let gitPanelGeometry = {
    changesTop: 0, // first screen row (sidebar-relative, border-inclusive) of the changes list
    changesRows: 0, // visible change rows
    dividerRow: 0,
    logTop: 0,
    logRows: 0,
  };

  function renderGitPanel(): StyledText {
    const palette = readPalette();
    const innerWidth = sidebarWidth() - 2;
    const chunks: TextChunk[] = [];
    const pushRow = (
      text: string,
      color: string,
      options: { background?: string | null; bold?: boolean; newline?: boolean } = {},
    ) => {
      let label = text.length > innerWidth ? text.slice(0, innerWidth) : text;
      label = label.padEnd(innerWidth, ' ');
      let chunk = fg(color)(label);
      if (options.bold) chunk = bold(chunk);
      if (options.background) chunk = bg(options.background)(chunk);
      chunks.push(chunk);
      if (options.newline !== false) chunks.push(fg(palette.fg)('\n'));
    };
    const git = workspace.git.value;
    const gitPanel = workspace.gitPanel;
    const active = workspace.focus.value === 'git';
    if (!git) return new StyledText([fg(palette.dim)('  no repository')]);

    const bodyHeight = Math.max(1, (sidebar.height as number) - 2);
    pushRow(` ${git.branch.value || '(no branch)'}  ${git.head.value.slice(0, 7)}`, palette.accent);
    if (git.error.value) {
      pushRow(`  ${git.error.value}`, palette.deleted);
      return new StyledText(chunks);
    }

    // Changes region (top): headers + glyphed file rows from the SHARED row model, windowed.
    const changeRows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const topHeight = Math.max(2, Math.floor(bodyHeight * workspace.gitSplitRatio));
    const changesVisible = topHeight - 1;
    const changesTop = Math.min(
      gitPanel.changesScrollTop.value,
      Math.max(0, changeRows.length - changesVisible),
    );
    const glyphColor = (glyph: string): string =>
      glyph === 'A' ? palette.added : glyph === 'D' ? palette.deleted : glyph === '?' ? palette.dim : palette.modified;
    changeRows.slice(changesTop, changesTop + changesVisible).forEach((row, visibleIndex) => {
      const rowIndex = changesTop + visibleIndex;
      if (row.kind === 'header') {
        pushRow(` ${row.label} (${row.count})`, palette.dim, { bold: true });
      } else if (row.kind === 'placeholder') {
        pushRow(`  ${row.label}`, palette.dim);
      } else {
        const selected = active && gitPanel.region.value === 'changes' && rowIndex === gitPanel.changesIndex.value;
        const hovered = rowIndex === gitPanel.changesHovered.value;
        // Multi-selected rows (Ctrl/Shift-click, right-click) share the hover token — a lower
        // intensity than the focused row's `selection` bg — until the palette grows a third token.
        const multiSelected = gitPanel.selectedPaths.value.has(row.path);
        const background = selected ? palette.selection : multiSelected || hovered ? palette.cursorLine : null;
        // ` ☑ M path…            o d ±` — ONE-glyph staging checkbox (theme ladder; click toggles);
        // the git-status letter (M/D/?) stays separate; action buttons appear on hover/selection.
        const checkbox = row.bucket === 'staged' ? theme.checkboxIcons.checked : theme.checkboxIcons.unchecked;
        const label = ` ${checkbox} ${row.glyph} ${row.path}`;
        if (selected || hovered) {
          // Action buttons: real glyphs from the theme icon ladder (nerd → unicode → ascii letter),
          // each theme-COLOURED and each ONE cell so the hit-zone columns (gitActionButtonAt) align:
          // ` <open>  <discard>  <stage|unstage>` = 8 cells. Rendered as separate chunks so each
          // button carries its own colour (open = accent, discard = deleted/red, stage = added/green,
          // unstage = dim), then a trailing cell pads the row to innerWidth.
          const actionIcons = theme.actionIcons;
          const staged = row.bucket === 'staged';
          const stageGlyph = staged ? actionIcons.unstage : actionIcons.stage;
          const stageColor = staged ? palette.dim : palette.added;
          const buttonCells = 8;
          const pathWidth = innerWidth - buttonCells - 1;
          const pathText = label.length > pathWidth ? label.slice(0, pathWidth) : label.padEnd(pathWidth, ' ');
          const paint = (text: string, color: string) =>
            background ? bg(background)(fg(color)(text)) : fg(color)(text);
          chunks.push(paint(pathText, glyphColor(row.glyph)));
          chunks.push(paint(` ${actionIcons.open}`, palette.accent));
          chunks.push(paint(`  ${actionIcons.discard}`, palette.deleted));
          chunks.push(paint(`  ${stageGlyph}`, stageColor));
          chunks.push(paint(' ', palette.fg)); // pad the final cell to innerWidth
          chunks.push(fg(palette.fg)('\n'));
        } else {
          pushRow(label, glyphColor(row.glyph), { background });
        }
      }
    });
    const changesRendered = Math.min(changeRows.length - changesTop, changesVisible);
    for (let filler = changesRendered; filler < changesVisible; filler++) pushRow('', palette.fg);

    pushRow('─'.repeat(innerWidth), palette.border);

    // Commit log region (bottom) — virtualized over FLAT rows (inline commit expansion): an
    // expanded commit is its header plus indented file rows (or a loading row while its lazy fetch
    // is in flight). The SAME pure row model (git.log-rows.ts) serves the renderer here and the
    // hit-tester/keyboard (Workspace.logRowAt), windowed by logScrollTop; only the visible
    // commits' records (and the bounded expanded set) are consulted.
    // invariant: Commit expansion is lazy and windowed (src/modules/git/git.invariants.md)
    const logHeight = Math.max(1, bodyHeight - topHeight - 1);
    const commitLog = workspace.commitLog.value;
    if (commitLog) {
      const flatTop = gitPanel.logScrollTop.value;
      const expandedEntries = workspace.commitExpansion.value?.entries.value ?? [];
      // O(window): at most logHeight commit records cover the flat window (expansion only
      // DECREASES how many commits fit on screen).
      const firstCommitIndex = GitLogRows.Class.commitIndexAtFlatRow(expandedEntries, flatTop);
      const windowRecords = commitLog.rows(firstCommitIndex, logHeight);
      const flatRows = GitLogRows.Class.commitLogRows(
        flatTop,
        logHeight,
        expandedEntries,
        (commitIndex) => windowRecords[commitIndex - firstCommitIndex],
        commitLog.knownEnd.value,
      );
      flatRows.forEach((row, index) => {
        const flatIndex = flatTop + index;
        const selected = active && gitPanel.region.value === 'log' && flatIndex === gitPanel.logIndex.value;
        const hovered = flatIndex === gitPanel.logHovered.value;
        const background = selected ? palette.selection : hovered ? palette.cursorLine : null;
        const newline = index < flatRows.length - 1;
        if (row.kind === 'commit') {
          const chevron = row.expanded ? '▾' : '▸';
          if (row.record)
            pushRow(` ${chevron} ${row.record.shortSha} ${row.record.subject}`, palette.fg, { background, newline });
          else pushRow(' …', palette.dim, { background, newline });
        } else if (row.kind === 'loading') {
          pushRow('      …loading', palette.dim, { background, newline });
        } else {
          pushRow(`    ${row.glyph} ${row.path}`, glyphColor(row.glyph), { background, newline });
        }
      });
    }

    // Geometry for the hit-testers (sidebar-relative rows; +1 = sidebar top border, +1 branch row).
    gitPanelGeometry = {
      changesTop,
      changesRows: changesVisible,
      dividerRow: 1 + 1 + changesVisible,
      logTop: gitPanel.logScrollTop.value,
      logRows: logHeight,
    };
    return new StyledText(chunks);
  }

  function renderStatus(): string {
    const editor = workspace.editor;
    const parts: string[] = [` ${workspace.name.value || '—'}`];
    if (editor.hasDocument.value) {
      parts.push(editor.title);
      parts.push(`Ln ${editor.cursor.line.value + 1}, Col ${editor.cursor.col.value + 1}`);
      parts.push(`${editor.document.lineCount} lines`);
    }
    parts.push(workspace.focus.value === 'files' ? '[Files]' : '[Editor]');
    if (workspace.focus.value === 'git')
      parts.push('checkbox/Space stage · row/o open · d discard');
    if (app.copyNotice.value) parts.push(app.copyNotice.value);
    parts.push(
      app.quitChordArmed.value ? 'Ctrl+X armed — Ctrl+C quits' : 'Ctrl+Q/F10 quit',
    );
    return parts.join('  ·  ');
  }

  function update(): void {
    const palette = readPalette();
    column.backgroundColor = palette.bg;
    const gitView = workspace.sidebarView.value === 'git';
    sidebar.width = sidebarWidth(); // live width from the draggable splitter (persisted to settings)
    sidebar.backgroundColor = palette.panel;
    sidebar.borderColor = workspace.focus.value === 'files' || gitView ? palette.borderActive : palette.border;
    // Divider: brighten while hovered or dragging so it reads as a grab handle.
    sidebarDivider.backgroundColor =
      sidebarSplitter.dragging.value || sidebarDividerHover ? palette.accent : palette.border;
    sidebar.titleColor = workspace.focus.value === 'files' || gitView ? palette.accent : palette.dim;
    sidebar.title = gitView ? 'Git' : 'Files';
    editorArea.backgroundColor = palette.bg;
    editorArea.borderColor = workspace.focus.value === 'editor' ? palette.borderActive : palette.border;
    editorArea.title = workspace.editor.hasDocument.value ? workspace.editor.title : 'Editor';
    editorArea.titleColor = workspace.focus.value === 'editor' ? palette.accent : palette.dim;
    tabBar.content = renderTabBar();
    statusBar.backgroundColor = palette.statusBg;

    sidebarBody.content = gitView ? renderGitPanel() : renderTree();
    sidebarBody.fg = palette.fg;
    const rendered = renderEditor();
    if (rendered) {
      gutterBody.width = gutterWidth();
      gutterBody.content = rendered.gutter;
      codeBody.content = rendered.code;
    } else {
      gutterBody.width = 0;
      gutterBody.content = '';
      codeBody.content = EMPTY_STATE;
    }
    codeBody.fg = palette.fg;
    codeBody.selectionBg = palette.selection;
    applySelection(); // after content is set, so selection maps onto the current buffer
    statusText.content = renderStatus();
    statusText.fg = palette.dim;

    // Palette overlay.
    const open = commands.open.value;
    commandPalette.visible = open;
    if (open) {
      commandPalette.borderColor = palette.borderActive;
      commandPalette.titleColor = palette.accent;
      commandPalette.backgroundColor = palette.panel;
      commandPaletteInput.content = `> ${commands.query.value}▏`;
      commandPaletteInput.fg = palette.fg;
      const items = commands.filtered.slice(0, 12);
      const selectedIndex = commands.selectedIndex.value;
      commandPaletteList.content = items.length
        ? items
            .map((command, index) => `${index === selectedIndex ? '›' : ' '} ${command.title}`)
            .join('\n')
        : '  (no matching commands)';
      commandPaletteList.fg = palette.dim;
    }

    const pendingDiscard = workspace.gitPanel.confirmDiscard.value;
    const pendingCloseTabIndex = workspace.pendingCloseTabIndex.value;
    confirmBox.visible = pendingDiscard !== null || pendingCloseTabIndex >= 0;
    if (pendingDiscard) {
      confirmBox.borderColor = palette.deleted;
      confirmBox.titleColor = palette.deleted;
      confirmBox.backgroundColor = palette.panel;
      confirmText.content =
        pendingDiscard.paths.length === 1
          ? ` Discard changes to ${pendingDiscard.paths[0]}?  [y/N]`
          : ` Discard changes to ${pendingDiscard.paths.length} files (${pendingDiscard.paths.join(', ').slice(0, 60)}…)?  [y/N]`;
      confirmText.fg = palette.fg;
    } else if (pendingCloseTabIndex >= 0) {
      // Same modal, for closing a tab with unsaved edits.
      const tabPath = workspace.buffers.tabs()[pendingCloseTabIndex]?.path ?? '';
      confirmBox.borderColor = palette.warning;
      confirmBox.titleColor = palette.warning;
      confirmBox.backgroundColor = palette.panel;
      confirmText.content = ` Close ${Files.Class.basename(tabPath)} with unsaved changes?  [y/N]`;
      confirmText.fg = palette.fg;
    }

    // Settings panel overlay — projected from the SettingsPanel model (↑/↓ select, ←/→ change).
    settingsBox.visible = settingsPanel.open.value;
    if (settingsPanel.open.value) {
      settingsBox.borderColor = palette.accent;
      settingsBox.titleColor = palette.accent;
      settingsBox.backgroundColor = palette.panel;
      const settingsChunks: TextChunk[] = [];
      settingsChunks.push(fg(palette.dim)('  ↑/↓ select   ←/→ change   Esc close   (saved live)\n\n'));
      const settingsRows = settingsPanel.rows();
      const labelWidth = settingsRows.reduce((widest, row) => Math.max(widest, row.label.length), 0);
      settingsRows.forEach((row) => {
        const marker = row.selected ? '›' : ' ';
        const labelText = ` ${marker} ${row.label.padEnd(labelWidth, ' ')}   `;
        const valueText = `${row.valueText}\n`;
        if (row.selected) {
          settingsChunks.push(bg(palette.selection)(fg(palette.fg)(labelText)));
          settingsChunks.push(bg(palette.selection)(fg(palette.accent)(valueText)));
        } else {
          settingsChunks.push(fg(palette.fg)(labelText));
          settingsChunks.push(fg(palette.dim)(valueText));
        }
      });
      settingsText.content = new StyledText(settingsChunks);
    }

    // Context menu overlay (+ its modal backdrop) — projected purely from the ContextMenu model.
    const menuOpen = contextMenu.open.value;
    contextMenuBackdrop.visible = menuOpen;
    contextMenuBox.visible = menuOpen;
    if (menuOpen) {
      contextMenuBox.left = contextMenu.anchorX.value;
      contextMenuBox.top = contextMenu.anchorY.value;
      contextMenuBox.width = contextMenu.width;
      contextMenuBox.height = contextMenu.height;
      contextMenuBox.backgroundColor = palette.panel;
      contextMenuBox.borderColor = palette.borderActive;
      const rowWidth = contextMenu.width - 2; // interior width between the borders
      const menuChunks: TextChunk[] = [];
      contextMenu.items.value.forEach((item, index) => {
        const label = ` ${item.label}`.padEnd(rowWidth, ' ').slice(0, rowWidth);
        const rowBackground =
          index === contextMenu.selectedIndex.value
            ? palette.selection
            : index === contextMenu.hoveredIndex.value
              ? palette.cursorLine
              : null;
        const styled = fg(item.enabled ? palette.fg : palette.dim)(label);
        menuChunks.push(rowBackground ? bg(rowBackground)(styled) : styled);
        if (index < contextMenu.items.value.length - 1) menuChunks.push(fg(palette.fg)('\n'));
      });
      contextMenuList.content = new StyledText(menuChunks);
    }

    // Tooltip overlay — display-only; clamped so it stays on screen.
    tooltipText.visible = tooltip.visible.value;
    if (tooltip.visible.value) {
      const tooltipLabel = ` ${tooltip.text.value} `;
      // CENTER the tooltip horizontally over the anchor cell (its midpoint aligns to the cursor
      // column), then clamp so it never overflows the canvas (the scrollbar-geometry lesson).
      const tooltipWidth = lineWidth(tooltipLabel);
      const centeredLeft = tooltip.anchorX.value - Math.floor(tooltipWidth / 2);
      tooltipText.left = Math.max(0, Math.min(centeredLeft, renderer.width - tooltipWidth));
      // Vertical: default ABOVE the anchor row (so it does not cover the pointed-at row); flip BELOW
      // only when there is no room above (near the top edge). Explicit 'below' forces below.
      const anchorY = tooltip.anchorY.value;
      const roomAbove = anchorY - 1 >= 0;
      const placeAbove = tooltip.placement.value === 'above' || (tooltip.placement.value === 'auto' && roomAbove);
      const desiredTop = placeAbove ? anchorY - 1 : anchorY + 1;
      tooltipText.top = Math.max(0, Math.min(desiredTop, renderer.height - 1));
      tooltipText.content = new StyledText([bg(palette.selection)(fg(palette.fg)(tooltipLabel))]);
    }

    syncScrollbars();

    // Native terminal caret at the cursor's DISPLAY column (tab/wide aware). Shown only when the
    // editor is focused, has a document, no palette overlay, and the cursor line is on screen.
    // invariant: The caret renders at the cursor display column (ui.invariants.md)
    const editor = workspace.editor;
    const scrollTop = editor.viewport.scrollTop.value;
    const viewportHeight = editorViewportHeight();
    const cursorLine = editor.cursor.line.value;
    if (editor.wordWrap.value) {
      // Wrap mode: the caret cell comes from the SAME logical↔visual mapping the render used —
      // no scrollLeft subtraction (horizontal scroll is inert); the visual-row offset replaces
      // the logical-row offset. Same 1-based ANSI +1 as the wrap-off path; still verified against
      // tmux's own #{cursor_x},#{cursor_y}.
      // invariant: The caret renders at the cursor display column (ui.invariants.md)
      const caretPosition =
        editor.hasDocument.value && workspace.focus.value === 'editor' && !open
          ? wrapVisualPosition(cursorLine, editor.cursor.col.value)
          : null;
      if (caretPosition && typeof caretPosition === 'object') {
        const caretCellX = codeBody.x + caretPosition.column;
        const caretCellY = codeBody.y + caretPosition.rowIndex;
        renderer.setCursorPosition(caretCellX + 1, caretCellY + 1, true);
      } else {
        renderer.setCursorPosition(0, 0, false);
      }
      return;
    }
    const caretVisibleHorizontally =
      displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) >=
        editor.viewport.scrollLeft.value &&
      displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) <
        editor.viewport.scrollLeft.value + editorViewportWidth();
    if (editor.hasDocument.value && workspace.focus.value === 'editor' && !open && cursorLine >= scrollTop && cursorLine < scrollTop + viewportHeight && caretVisibleHorizontally) {
      const cursorDisplayColumn = displayColumn(editor.document.line(cursorLine), editor.cursor.col.value);
      // Anchor the caret to the code renderable's ACTUAL laid-out screen cell (codeBody.x/y from
      // yoga), not hand-derived layout constants — the constants drifted from the real layout (the
      // human-QA off-by-one) and would break again when the sidebar becomes draggable.
      const caretScrollLeft = editor.viewport.scrollLeft.value;
      const caretCellX = codeBody.x + (cursorDisplayColumn - caretScrollLeft);
      const caretCellY = codeBody.y + (cursorLine - scrollTop);
      // The native terminal cursor is 1-BASED (ANSI CUP): +1 on both axes — OpenTUI's own
      // renderCursor does `screenX + visualCol + 1`.
      renderer.setCursorPosition(caretCellX + 1, caretCellY + 1, true);
    } else {
      renderer.setCursorPosition(0, 0, false);
    }
  }

  // Mouse wheel, POSITION-ROUTED: OpenTUI hit-tests the pointer to the pane under it and calls its
  // onMouseScroll (events bubble to the box). Each scrollable pane mutates only its own window
  // (scrollTop / selection), never materializing the whole list — the frame effect observes those
  // signals and repaints. invariant: Cost tracks the actively observed set (project.invariants.md)
  sidebar.onMouseScroll = (event) => {
    if (workspace.sidebarView.value === 'git') {
      // Route by pointer position: wheel over the changes region scrolls it; over the log, the
      // momentum glide (same gesture, per-region window).
      const row = event.y - sidebar.y;
      if (row < gitPanelGeometry.dividerRow) {
        workspace.impulseGitChangesScroll(event.scroll?.direction === 'up' ? -1 : 1);
      } else {
        workspace.impulseGitLog(event.scroll?.direction === 'up' ? -1 : 1);
      }
    } else workspace.impulseTreeScroll(event.scroll?.direction === 'up' ? -1 : 1);
  };
  // Vertical scroll of the editor window. Wrap mode: scrollTop stays a LOGICAL line index, but
  // tall (wrapped) lines mean the logical clamp `lineCount - height` could strand tail rows below
  // the fold — so the clamp relaxes to let the LAST line reach the top of the window.
  // Wrap-mode vertical wheel + drag-edge auto-scroll step directly (rows), NOT through the momentum
  // regime: wrap mode's scroll bound is lineCount-1 (a wrapped line occupies many visual rows), which
  // the momentum regime's scrollBy clamp (lineCount - height) does not model. Non-wrap wheel goes
  // through momentum (impulse) below.
  const WHEEL_STEP = 3;
  const scrollEditorVertically = (delta: number): void => {
    const editorViewport = workspace.editor.viewport;
    if (workspace.editor.wordWrap.value) {
      const maxTop = Math.max(0, workspace.editor.document.lineCount - 1);
      editorViewport.scrollTop.value = Math.max(
        0,
        Math.min(editorViewport.scrollTop.value + delta, maxTop),
      );
    } else {
      editorViewport.scrollBy(delta, workspace.editor.document.lineCount);
    }
  };
  editorArea.onMouseScroll = (event) => {
    if (!workspace.editor.hasDocument.value) return;
    // Horizontal scroll arrives by SEVERAL terminal-dependent encodings; route them ALL to columns:
    //   - native horizontal wheel / tilt: SGR 66/67 -> direction left/right (trackpad two-finger swipe;
    //     Option+wheel on the user's terminal arrives as 74/75 = 66/67 + Meta, also direction left/right);
    //   - a VERTICAL wheel with a modifier: Option/Alt (+8 -> 72/73) is the user-facing path that
    //     survives real terminals; Shift (+4 -> 68/69) is a bonus (most terminals swallow it).
    // Delivery of any given modifier is terminal-dependent — supporting all of them is the robust fix.
    const direction = event.scroll?.direction;
    if (workspace.editor.wordWrap.value) {
      // Wrap mode: ONE scroll axis — horizontal gestures route to the vertical window and
      // scrollLeft stays 0 (inert).
      const backward = direction === 'left' || direction === 'up';
      scrollEditorVertically((backward ? -1 : 1) * WHEEL_STEP);
      return;
    }
    const modifierHorizontal = event.modifiers.alt || event.modifiers.shift; // Option maps to alt
    const horizontal = direction === 'left' || direction === 'right' || modifierHorizontal;
    if (horizontal) {
      const backward = direction === 'left' || direction === 'up';
      workspace.impulseEditorHorizontalScroll(backward ? -1 : 1);
    } else {
      workspace.impulseEditorVerticalScroll(direction === 'up' ? -1 : 1);
    }
  };

  // Mouse selection drives the MODEL (cursor + anchor) — the single writer; the native highlight
  // is then applied FROM the model by applySelection() each paint, so it persists across repaints
  // and Ctrl+C copies exactly what is highlighted.
  // invariant: The selected range renders with a background (ui.invariants.md)
  const documentPositionAtCell = (cellX: number, cellY: number): { line: number; column: number } | null => {
    if (!workspace.editor.hasDocument.value) return null;
    if (workspace.editor.wordWrap.value) {
      // Wrap mode: a viewport row is a VISUAL row — resolve it through the rendered window, then
      // hit-test the display column WITHIN that row's segment (clamped into the segment so a
      // click past a wrapped row's end lands on its last grapheme, not the next row's first).
      if (wrapRowsWindow.length === 0) return null;
      const rowIndex = Math.max(0, Math.min(cellY - codeBody.y, wrapRowsWindow.length - 1));
      const row = wrapRowsWindow[rowIndex];
      if (!row) return null;
      const lineText = workspace.editor.document.line(row.lineIndex);
      const segments = EditorWrap.Class.wrapLine(lineText, workspace.editor.wrapWidth());
      const lastSegmentOfLine = row.segmentIndex === segments.length - 1;
      const hitColumn = graphemeAtDisplayColumn(
        lineText,
        row.segment.startDisplayColumn + Math.max(0, cellX - codeBody.x),
      );
      const maxColumn = lastSegmentOfLine
        ? row.segment.endGrapheme
        : Math.max(row.segment.startGrapheme, row.segment.endGrapheme - 1);
      return {
        line: row.lineIndex,
        column: Math.max(row.segment.startGrapheme, Math.min(hitColumn, maxColumn)),
      };
    }
    const line = Math.max(
      0,
      Math.min(
        workspace.editor.viewport.scrollTop.value + (cellY - codeBody.y),
        workspace.editor.document.lineCount - 1,
      ),
    );
    const column = graphemeAtDisplayColumn(
      workspace.editor.document.line(line),
      workspace.editor.viewport.scrollLeft.value + (cellX - codeBody.x),
    );
    return { line, column };
  };
  // Live drag tracking for edge auto-scroll: while a selection drag holds at/past a pane edge,
  // the frame tick scrolls the viewport and extends the selection to the newly revealed cells.
  let selectionDrag: { pointerX: number; pointerY: number } | null = null;

  codeBody.onMouseDown = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDown (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    workspace.focusEditor(); // click-to-focus
    workspace.editor.placeCursor(hit.line, hit.column);
    workspace.editor.cursor.setAnchorHere(); // anchor at the press; dragging extends from here
    selectionDrag = { pointerX: event.x, pointerY: event.y };
  };
  codeBody.onMouseDrag = (event) => {
    const hit = documentPositionAtCell(event.x, event.y);
    if (process.env.TUI_DEBUG_MOUSE === '1') Logging.Class.info(`mouseDrag (${event.x},${event.y}) hit=${JSON.stringify(hit)}`);
    if (!hit) return;
    // The drag version of goal-column: the drag tracks the POINTER's display column. The cursor
    // clamps to each line's length (selection end = min(pointer, lineLength)), but the GOAL stays
    // at the pointer, and scrollLeft NEVER follows an intermediate short line's clamp — no
    // backward yank while sweeping diagonally across mixed-length lines (placeCursor's
    // auto-hscroll is exactly what must NOT run here).
    const pointerDisplayColumn =
      workspace.editor.viewport.scrollLeft.value + (event.x - codeBody.x);
    workspace.editor.cursor.set(hit.line, hit.column, Math.max(0, pointerDisplayColumn));
    if (selectionDrag) {
      selectionDrag.pointerX = event.x;
      selectionDrag.pointerY = event.y;
    }
  };
  const endSelectionDrag = (): void => {
    selectionDrag = null;
    // A plain click (no drag) leaves anchor == cursor: clear it so no empty selection lingers.
    if (!workspace.editor.cursor.hasSelection) workspace.editor.cursor.clearSelection();
  };
  codeBody.onMouseUp = endSelectionDrag;
  codeBody.onMouseDragEnd = endSelectionDrag;

  // Edge auto-scroll: called from the app frame tick with real dt. While the held pointer sits in
  // the one-cell edge zone (or beyond the pane), scroll that axis — rate grows with overshoot —
  // and re-extend the selection to the cell now under the pointer. The drag is the ONE scroll
  // writer while active. Returns whether an auto-scroll is in progress (keeps frames coming).
  // invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  let edgeScrollRemainder = { x: 0, y: 0 };
  function tickDragAutoScroll(dtSeconds: number): boolean {
    if (!selectionDrag || !workspace.editor.hasDocument.value) return false;
    const leftEdge = codeBody.x;
    const rightEdge = codeBody.x + Math.max(1, editorViewportWidth()) - 1;
    const topEdge = codeBody.y;
    const bottomEdge = codeBody.y + Math.max(1, editorViewportHeight()) - 1;
    const overshootX =
      selectionDrag.pointerX >= rightEdge
        ? selectionDrag.pointerX - rightEdge + 1
        : selectionDrag.pointerX <= leftEdge
          ? selectionDrag.pointerX - leftEdge - 1
          : 0;
    const overshootY =
      selectionDrag.pointerY >= bottomEdge
        ? selectionDrag.pointerY - bottomEdge + 1
        : selectionDrag.pointerY <= topEdge
          ? selectionDrag.pointerY - topEdge - 1
          : 0;
    if (overshootX === 0 && overshootY === 0) {
      edgeScrollRemainder = { x: 0, y: 0 };
      return false;
    }
    // Base 25 cells/sec, growing with how far past the edge the pointer sits (capped).
    const rate = (overshoot: number): number =>
      Math.sign(overshoot) * Math.min(120, 25 + 18 * (Math.abs(overshoot) - 1));
    edgeScrollRemainder.x += overshootX === 0 ? 0 : rate(overshootX) * dtSeconds;
    edgeScrollRemainder.y += overshootY === 0 ? 0 : rate(overshootY) * dtSeconds;
    const stepX = Math.trunc(edgeScrollRemainder.x);
    const stepY = Math.trunc(edgeScrollRemainder.y);
    edgeScrollRemainder.x -= stepX;
    edgeScrollRemainder.y -= stepY;
    if (stepX !== 0 && !workspace.editor.wordWrap.value) {
      // (wrap mode: horizontal scroll is inert — the X edge never scrolls)
      const top = workspace.editor.viewport.scrollTop.value;
      let widestVisible = 0;
      for (const line of workspace.editor.document.slice(top, editorViewportHeight())) {
        widestVisible = Math.max(widestVisible, lineWidth(line));
      }
      workspace.editor.viewport.scrollByColumns(stepX, widestVisible);
    }
    if (stepY !== 0) {
      scrollEditorVertically(stepY);
    }
    // Extend the selection to the cell under the (edge-clamped) pointer in the NEW window.
    const clampedX = Math.max(leftEdge, Math.min(selectionDrag.pointerX, rightEdge));
    const clampedY = Math.max(topEdge, Math.min(selectionDrag.pointerY, bottomEdge));
    const hit = documentPositionAtCell(clampedX, clampedY);
    if (hit) {
      // Anchor fixed; goal = the pointer's display column in the ADVANCED window, so short lines
      // under the sweep never pull the goal (or the window) back.
      const pointerDisplayColumn =
        workspace.editor.viewport.scrollLeft.value + (clampedX - codeBody.x);
      workspace.editor.cursor.set(hit.line, hit.column, Math.max(0, pointerDisplayColumn));
    }
    return true;
  }

  // Sidebar clicks: focus follows the click (files or git view), and a click on a tree row SELECTS
  // it — clicking the already-selected row ACTIVATES it (open file / toggle folder). Keyboard
  // parity holds: everything here is also reachable via arrows/Enter.
  // Hover highlight (enhancement only — selection/activation stay on click/keys). The hovered row
  // is model view-state so the frame effect repaints when it changes; cost is one marker cell.
  // Map a sidebar-relative screen row to a git-panel target using the SAME geometry the renderer
  // wrote (changes row / divider / log row).
  const gitRowAt = (screenY: number): { region: 'changes' | 'log'; index: number } | null => {
    const row = screenY - sidebar.y;
    if (row >= 2 && row < gitPanelGeometry.dividerRow) {
      return { region: 'changes', index: gitPanelGeometry.changesTop + (row - 2) };
    }
    if (row > gitPanelGeometry.dividerRow) {
      return { region: 'log', index: gitPanelGeometry.logTop + (row - gitPanelGeometry.dividerRow - 1) };
    }
    return null;
  };
  const gitChangeRowsNow = () => {
    const git = workspace.git.value;
    return git ? GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
  };
  // The git action-button hit zones (right-aligned ` o  d  ±` on a hovered/selected file row).
  // ONE definition shared by the click dispatch and the tooltip arming, so the tooltip always
  // names exactly what a click at that cell would do.
  type GitActionButton = 'open' | 'discard' | 'stageToggle';
  const gitActionButtonAt = (relativeX: number): GitActionButton | null => {
    const innerWidth = sidebarWidth() - 2;
    if (relativeX >= innerWidth - 8 && relativeX <= innerWidth - 7) return 'open';
    if (relativeX >= innerWidth - 5 && relativeX <= innerWidth - 4) return 'discard';
    if (relativeX >= innerWidth - 2) return 'stageToggle';
    return null;
  };

  sidebar.onMouseMove = (event) => {
    if (workspace.sidebarView.value === 'git') {
      const hit = gitRowAt(event.y);
      const rows = gitChangeRowsNow();
      workspace.gitPanel.changesHovered.value =
        hit?.region === 'changes' && rows[hit.index]?.kind === 'file' ? hit.index : -1;
      workspace.gitPanel.logHovered.value = hit?.region === 'log' ? hit.index : -1;
      // Tooltip: arm the dwell while the pointer rests on an action button of a file row
      // (hovering the row is what makes the buttons visible); anything else disarms.
      const hoveredRow = hit?.region === 'changes' ? rows[hit.index] : undefined;
      const button =
        hoveredRow?.kind === 'file' ? gitActionButtonAt(event.x - (sidebar.x + 1)) : null;
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
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1));
    workspace.tree.hoveredIndex.value =
      rowIndex >= 0 && rowIndex < workspace.tree.rows.length ? rowIndex : -1;
  };
  sidebar.onMouseOut = () => {
    workspace.tree.hoveredIndex.value = -1;
    workspace.gitPanel.changesHovered.value = -1;
    workspace.gitPanel.logHovered.value = -1;
    tooltip.clear();
  };

  // Right-click on a changes FILE row: normalize the selection (an unselected row becomes THE
  // selection; a selected row keeps the whole multi-selection) and open the context menu at the
  // pointer with the COLLECTIVE actions the selection's buckets support.
  const openChangesContextMenu = (rowIndex: number, row: FileRow, rows: ChangeRow[], pointerX: number, pointerY: number): void => {
    const gitPanel = workspace.gitPanel;
    if (!gitPanel.selectedPaths.value.has(row.path)) gitPanel.replaceSelected([row.path]);
    gitPanel.changesIndex.value = rowIndex;
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
    contextMenu.openAt(items, pointerX, pointerY, { width: renderer.width, height: renderer.height }, (itemId) => {
      if (itemId === 'git.stageSelected') void workspace.stageSelected();
      else if (itemId === 'git.unstageSelected') void workspace.unstageSelected();
      else if (itemId === 'git.discardSelected') workspace.requestDiscardSelected(); // y/N confirm
      else if (itemId === 'git.openDiff' && firstSelectedIndex >= 0) void workspace.openChangeAtRow(firstSelectedIndex);
    });
  };

  // Shift+click: select the file rows in the range between the focused row and the clicked row
  // (headers in between are skipped), REPLACING the previous selection.
  const selectChangesRange = (anchorIndex: number, targetIndex: number, rows: ChangeRow[]): void => {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const paths: string[] = [];
    for (let rowIndex = start; rowIndex <= end; rowIndex++) {
      const row = rows[rowIndex];
      if (row?.kind === 'file') paths.push(row.path);
    }
    workspace.gitPanel.replaceSelected(paths);
  };

  sidebar.onMouseDown = (event) => {
    if (workspace.sidebarView.value === 'git') {
      workspace.focusGit();
      const hit = gitRowAt(event.y);
      if (!hit) return;
      if (hit.region === 'changes') {
        workspace.haltGitChangesScroll();
        const rows = gitChangeRowsNow();
        const row = rows[hit.index];
        if (row?.kind !== 'file') return;
        workspace.gitPanel.region.value = 'changes';
        // Multi-select gestures come FIRST; plain left-click behavior below is unchanged.
        if (event.button === 2) {
          openChangesContextMenu(hit.index, row, rows, event.x, event.y); // right-click menu
          return;
        }
        if (event.modifiers.ctrl) {
          workspace.gitPanel.toggleSelected(row.path); // toggle in/out of the selection; no menu
          return;
        }
        if (event.modifiers.shift) {
          selectChangesRange(workspace.gitPanel.changesIndex.value, hit.index, rows); // range
          return;
        }
        const wasCurrent = workspace.gitPanel.changesIndex.value === hit.index;
        workspace.gitPanel.changesIndex.value = hit.index;
        const relativeX = event.x - (sidebar.x + 1);
        const actionButton = gitActionButtonAt(relativeX);
        const buttonsShowing = wasCurrent || workspace.gitPanel.changesHovered.value === hit.index;
        if (relativeX === 1) {
          void workspace.toggleStageAtRow(hit.index); // the single-glyph CHECKBOX cell is the staging control
        } else if (buttonsShowing && actionButton === 'open') {
          void workspace.openChangeAtRow(hit.index); // [o]pen
        } else if (buttonsShowing && actionButton === 'discard') {
          workspace.requestDiscardAtRow(hit.index); // [d]iscard — arms the y/N confirm
        } else if (buttonsShowing && actionButton === 'stageToggle') {
          void workspace.toggleStageAtRow(hit.index); // [+/-] stage/unstage
        } else {
          void workspace.openChangeAtRow(hit.index); // row body = select + OPEN (consistent with tree)
        }
      } else {
        workspace.gitPanel.region.value = 'log';
        workspace.gitPanel.logIndex.value = hit.index;
        // Row body = select + ACTIVATE (consistent with tree/changes): a commit header toggles its
        // inline expansion (lazy fetch); a file row opens that file's diff for that commit.
        workspace.activateLogRow(hit.index);
      }
      return;
    }
    workspace.focusFiles(); // click-to-focus
    workspace.haltTreeScroll();
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1)); // +1: sidebar top border
    if (rowIndex < 0 || rowIndex >= workspace.tree.rows.length) return;
    // Single-click activation: one click selects AND opens the file / toggles the folder. setSelection
    // does NOT reveal/scroll, so clicking a visible row leaves the scroll position exactly where it is.
    workspace.tree.setSelection(rowIndex);
    workspace.activate();
  };

  update();

  return {
    update,
    editorViewportHeight,
    editorViewportWidth,
    tickDragAutoScroll,
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
