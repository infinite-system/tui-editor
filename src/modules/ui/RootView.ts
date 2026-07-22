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
  parseColor,
  type TextChunk,
  type CliRenderer,
  type OptimizedBuffer,
  type ColorInput,
} from '@opentui/core';
import { Static } from 'ivue/extras';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { App } from '../app/App';
import type { Theme } from '../theme/Theme';
import type { CommandRegistry } from '../commands/CommandRegistry';
import type { Palette } from '../theme/ThemePalettes';
import { Files } from '../system/Files';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { TreePaneRenderer } from './TreePaneRenderer';
import { GitPaneRenderer } from './GitPaneRenderer';
import {
  TabBarRenderer,
  type TabBarSegment,
  type WorkspaceTabBarSegment,
} from './TabBarRenderer';
import { EditorPaneRenderer } from './EditorPaneRenderer';
import { EditorWrap, type VisualRow } from '../editor/EditorWrap';
import { DiffView } from '../diff/DiffView';
import { MarkdownSplitView } from '../markdown/MarkdownSplitView';
import { SelectableText } from './SelectableText';
import { SelectionDragBehavior } from './SelectionDragBehavior';
import { GitRows, type ChangeRow, type FileRow } from '../git/GitRows';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import type { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { OverlayCoordinator } from './OverlayCoordinator';
import type { ShortcutHelp } from './ShortcutHelp';
import type { Tooltip } from './Tooltip';
import type { SettingsPanel } from '../settings/SettingsPanel';
import type { ScrollModifier } from '../settings/Settings';
import type { FindBar, FindBarTarget } from '../search/FindBar';
import type { KeybindingRegistry } from '../keybindings/KeybindingRegistry';
import type { QuickOpen } from '../search/QuickOpen';
import { SplitterModel } from '../layout/SplitterModel';
import { Logging } from '../system/Logging';
import type { TabStrip } from './TabStrip';

// roleColor moved to EditorPaneRenderer with the editor render that used it.

/**
 * OpenTUI paints a horizontal slider as a full-cell rectangle. Terminal cells are roughly twice as
 * tall as they are wide, so a one-row bar reads about twice as thick as a one-column vertical bar.
 * Keep OpenTUI's native slider for hit-testing and drag math, then repaint its exact thumb rectangle
 * with half-height glyphs: one configured row now carries about one configured column of visual ink.
 */
function paintAxisBalancedHorizontalScrollbar(
  scrollbar: ScrollBarRenderable,
  buffer: OptimizedBuffer,
  backgroundColor: ColorInput,
  trackColor: ColorInput,
  thumbColor: ColorInput,
): void {
  if (!scrollbar.visible) return;
  const slider = scrollbar.slider;
  const sliderGeometry = slider as unknown as {
    getThumbRect?: () => { x: number; y: number; width: number; height: number };
  };
  const thumbRectangle = sliderGeometry.getThumbRect?.();
  if (!thumbRectangle) return;
  const parsedBackgroundColor = parseColor(backgroundColor);
  const parsedTrackColor = parseColor(trackColor);
  const parsedThumbColor = parseColor(thumbColor);
  for (let row = slider.y; row < slider.y + slider.height; row += 1) {
    for (let column = slider.x; column < slider.x + slider.width; column += 1) {
      const insideThumb =
        column >= thumbRectangle.x &&
        column < thumbRectangle.x + thumbRectangle.width &&
        row >= thumbRectangle.y &&
        row < thumbRectangle.y + thumbRectangle.height;
      buffer.setCellWithAlphaBlending(
        column,
        row,
        insideThumb ? '▄' : '▂',
        insideThumb ? parsedThumbColor : parsedTrackColor,
        parsedBackgroundColor,
      );
    }
  }
}


export interface RootView {
  update(): void;
  editorViewportHeight(): number;
  editorViewportWidth(): number;
  /** Frame-tick hook: advance drag-edge auto-scroll; true while active (keep frames coming). */
  tickDragAutoScroll(dtSeconds: number): boolean;
  /** Frame-tick hook: advance the open diff's scroll-momentum glide; true while moving. */
  tickDiffMomentum(dtSeconds: number): boolean;
  /** The live DiffView instance when a diff is open, else null (for keyboard routing). */
  activeDiffView(): DiffView.Instance | null;
  /** Frame-tick hook for Markdown preview momentum, drag selection, and async parse landing. */
  tickMarkdownPreview(dtSeconds: number): boolean;
  activeMarkdownSplitView(): MarkdownSplitView.Instance | null;
  findTarget(): FindBarTarget | null;
  /** Rows the shortcut cheat-sheet can show at once (scroll actions clamp against this). */
  shortcutHelpViewportRows(): number;
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

class AxisBalancedHorizontalScrollbarPaint extends HitTransparentText {
  constructor(
    renderer: CliRenderer,
    private readonly scrollbar: ScrollBarRenderable,
    private readonly palette: () => Palette,
    private readonly backgroundColor: () => ColorInput,
  ) {
    super(renderer, {
      id: `${scrollbar.id}-axis-balanced-paint`,
      content: ' ',
      position: 'absolute',
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      zIndex: 100,
      selectable: false,
    });
  }

  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    super.render(buffer, deltaTime);
    const palette = this.palette();
    paintAxisBalancedHorizontalScrollbar(
      this.scrollbar,
      buffer,
      this.backgroundColor(),
      palette.border,
      palette.accent,
    );
  }
}

function $buildRootView(
  renderer: CliRenderer,
  workspaceSet: WorkspaceSet.Instance,
  bufferTabStrip: TabStrip.Instance,
  workspaceTabStrip: TabStrip.Instance,
  theme: Theme.Instance,
  keybindings: KeybindingRegistry.Instance,
  commands: CommandRegistry.Instance,
  app: App.Instance,
  contextMenu: ContextMenu.Instance,
  tooltip: Tooltip.Instance,
  settingsPanel: SettingsPanel.Instance,
  findBar: FindBar.Instance,
  quickOpen: QuickOpen.Instance,
  shortcutHelp: ShortcutHelp.Instance,
  overlayCoordinator: OverlayCoordinator.Instance,
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
    // LIVE update only — update the reactive value on every drag tick so the resize is smooth, but do
    // NOT persist here: settings.save() is a SYNCHRONOUS disk write, and calling it at mouse-move
    // frequency stalls the event loop (app-wide lag). Persist ONCE on drag end (endSidebarDrag).
    onSizeChange: (width) => {
      settings.sidebarWidth.value = Math.round(width);
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

  // The project-layer tab strip is ONE renderable + ONE TabStrip model. The setting moves that same
  // strip between the horizontal top slot and the vertical left slot; it never duplicates state.
  const workspaceTabBar = new TextRenderable(renderer, {
    id: 'workspace-tab-strip',
    content: '',
    width: '100%',
    height: 1,
    wrapMode: 'none',
  });
  if (settings.workspaceTabPosition.value === 'left') {
    workspaceTabBar.width = 22;
    workspaceTabBar.height = '100%';
  }

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
  // A definite-size host for the rich DiffView, swapped IN PLACE of editorArea (add/remove, not runtime
  // flex toggling — OpenTUI doesn't re-lay-out on a runtime flexGrow/height change). flexGrow:1 mirrors
  // editorArea, so the DiffView (height:100%) inside gets a real box. Not added until a diff opens.
  const diffContainer = new BoxRenderable(renderer, {
    id: 'diff-container',
    flexGrow: 1,
    width: '100%',
    flexDirection: 'column',
  });
  const markdownContainer = new BoxRenderable(renderer, {
    id: 'markdown-container',
    flexGrow: 1,
    width: '100%',
    flexDirection: 'column',
  });

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
  // OpenTUI fires BOTH drag-end AND up on release, so guard the persist with an active-drag flag —
  // otherwise the release saves twice (still a per-drag write, but the invariant is exactly one).
  let sidebarDragActive = false;
  sidebarDivider.onMouseDown = (event) => {
    captureDragTarget(sidebarDivider); // capture on down so a 1-cell divider survives the drag
    sidebarSplitter.size.value = settings.sidebarWidth.value; // anchor from the live width
    sidebarSplitter.beginDrag(event.x);
    sidebarDragActive = true;
    renderer.requestRender();
  };
  sidebarDivider.onMouseDrag = (event) => {
    sidebarSplitter.dragTo(event.x);
    renderer.requestRender();
  };
  const endSidebarDrag = (): void => {
    if (!sidebarDragActive) return;
    sidebarDragActive = false;
    sidebarSplitter.endDrag();
    settings.save(); // persist ONCE, on release — never per drag tick (sync disk write = frame stall)
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
  // Clickable shortcut-help affordance: a real hit-tested `?` cell span pinned to the RIGHT end of
  // the status bar (the spacer's flexGrow pushes it there). Click toggles the cheat-sheet through
  // the exclusive-overlay coordinator; hover shows a tooltip with the bound open chord.
  // invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
  const statusSpacer = new BoxRenderable(renderer, {
    id: 'status-spacer',
    flexGrow: 1,
    height: 1,
  });
  const shortcutHelpButton = new TextRenderable(renderer, {
    id: 'status-help-button',
    content: ' ? ',
    width: 3,
    height: 1,
    selectable: false, // a click must only toggle the sheet, never start a text selection
  });
  statusBar.add(statusSpacer);
  statusBar.add(shortcutHelpButton);
  let shortcutHelpButtonHover = false;
  const toggleShortcutHelp = (): void => {
    if (shortcutHelp.open.value) shortcutHelp.close();
    else overlayCoordinator.openExclusiveOverlay('shortcutHelp', () => shortcutHelp.show());
  };
  shortcutHelpButton.onMouseDown = () => {
    toggleShortcutHelp();
    renderer.requestRender();
  };
  shortcutHelpButton.onMouseMove = (event) => {
    if (!shortcutHelpButtonHover) {
      shortcutHelpButtonHover = true;
      renderer.requestRender();
    }
    const openChordHint = keybindings.bindingHint('help.shortcuts', 'global');
    tooltip.point(
      `Keyboard shortcuts${openChordHint ? ` (${openChordHint})` : ''}`,
      event.x,
      event.y,
    );
  };
  shortcutHelpButton.onMouseOut = () => {
    if (shortcutHelpButtonHover) {
      shortcutHelpButtonHover = false;
      renderer.requestRender();
    }
    tooltip.clear();
  };

  if (settings.workspaceTabPosition.value === 'left') {
    mainRow.add(workspaceTabBar, 0);
  } else {
    column.add(workspaceTabBar);
  }
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

  // In-editor find/replace bar (Ctrl+F / Ctrl+H) — a top-right overlay (VS Code placement), shown while
  // findBar.open. One text block: the query line with the N-of-M counter, plus a replacement line in
  // replace mode, plus a key hint. Content is projected from the FindBar model each paint.
  const findBarBox = new BoxRenderable(renderer, {
    id: 'find-bar',
    position: 'absolute',
    top: 1,
    left: '45%',
    width: '54%',
    border: true,
    borderStyle: 'rounded',
    title: 'Find',
    flexDirection: 'column',
    visible: false,
    zIndex: 100,
  });
  const findBarText = new TextRenderable(renderer, { id: 'find-bar-text', content: '' });
  findBarBox.add(findBarText);
  root.add(findBarBox);

  // Quick-open (Ctrl+P): a centered modal — a query input + the fuzzy-ranked project-file list. Mirrors
  // the command palette; content projected from the QuickOpen model each paint.
  const quickOpenBox = new BoxRenderable(renderer, {
    id: 'quick-open',
    position: 'absolute',
    left: '20%',
    top: 2,
    width: '60%',
    border: true,
    borderStyle: 'rounded',
    title: 'Go to File',
    flexDirection: 'column',
    visible: false,
    zIndex: 100,
  });
  const quickOpenInput = new TextRenderable(renderer, { id: 'quick-open-input', content: '' });
  const quickOpenList = new TextRenderable(renderer, { id: 'quick-open-list', content: '' });
  quickOpenBox.add(quickOpenInput);
  quickOpenBox.add(quickOpenList);
  root.add(quickOpenBox);

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

  // Shortcut cheat-sheet overlay (Shift+F1 / the status-bar `?`). A centered modal listing the
  // registry's effective bindings grouped by category; scrollable; Esc or the same chord closes.
  // The invisible backdrop makes it modal the same way the context menu is: while open, every
  // pointer cell resolves to the sheet or the backdrop (whose only behavior is to close the sheet),
  // so "clicking outside closes it" holds by construction.
  // invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
  // invariant: Input overlays share one modal slot (src/modules/ui/ui.invariants.md)
  const shortcutHelpBackdrop = new BoxRenderable(renderer, {
    id: 'shortcut-help-backdrop',
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    visible: false,
    zIndex: 118,
  });
  const shortcutHelpBox = new BoxRenderable(renderer, {
    id: 'shortcut-help',
    position: 'absolute',
    left: '15%',
    top: 1,
    width: '70%',
    border: true,
    borderStyle: 'rounded',
    title: 'Keyboard Shortcuts',
    flexDirection: 'column',
    visible: false,
    zIndex: 120,
  });
  const shortcutHelpText = new TextRenderable(renderer, {
    id: 'shortcut-help-text',
    content: '',
    selectable: false,
  });
  shortcutHelpBox.add(shortcutHelpText);
  root.add(shortcutHelpBackdrop);
  root.add(shortcutHelpBox);
  shortcutHelpBackdrop.onMouseDown = () => shortcutHelp.close();
  // The sheet's interior height: box height minus the borders and the one hint line at the top.
  const shortcutHelpBoxHeight = (): number => Math.max(6, renderer.height - 3);
  const shortcutHelpViewportRows = (): number => Math.max(1, shortcutHelpBoxHeight() - 3);

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
  // ONE configured thickness for every pane and axis. Vertical bars use that many columns; horizontal
  // bars use that many rows painted with half-height glyphs, compensating for the terminal cell's
  // roughly 2:1 height:width aspect ratio. The setting therefore changes visual thickness uniformly.
  const scrollbarThicknessCells = (): number => Math.max(1, Math.round(settings.scrollbarThickness.value));
  // True while applyBarGeometry is ASSIGNING scrollPosition: the widget fires onChange for
  // programmatic writes too, and treating those as user thumb-drags halted the momentum glide on
  // every paint (the 'wheel not smooth since scrollbars' regression). onChange handlers must act
  // only on USER-initiated changes — a real thumb drag then halts momentum and adopts authority.
  let applyingBarGeometry = false;
  const createAxisBalancedHorizontalPaint = (
    scrollbar: ScrollBarRenderable,
    backgroundColor: () => ColorInput,
  ): HitTransparentText => {
    scrollbar.onMouseMove = (event) => {
      tooltip.point('Horizontal scroll — drag or Option+wheel', event.x, event.y);
    };
    scrollbar.onMouseOut = () => tooltip.clear();
    return new AxisBalancedHorizontalScrollbarPaint(renderer, scrollbar, readPalette, backgroundColor);
  };

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
      workspaceSet.active.editor.viewport.haltScrollMomentum(); // real thumb drag adopts authority
      workspaceSet.active.editor.viewport.scrollTop.value = trueScrollPosition(editorVerticalBar, position);
    },
  });
  const editorHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'editor-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    height: 1,
    showArrows: false,
    trackOptions: { backgroundColor: readPalette().bg, foregroundColor: readPalette().accent },
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.editor.viewport.haltScrollMomentum(); // real thumb drag adopts authority
      workspaceSet.active.editor.viewport.scrollLeft.value = trueScrollPosition(editorHorizontalBar, position);
    },
  });
  const editorHorizontalBarPaint = createAxisBalancedHorizontalPaint(
    editorHorizontalBar,
    () => readPalette().bg,
  );
  editorArea.add(editorVerticalBar);
  editorArea.add(editorHorizontalBar);
  editorArea.add(editorHorizontalBarPaint);
  const changesVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'git-changes-scrollbar-v',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.haltGitChangesScroll(); // real thumb drag adopts authority
      workspaceSet.active.gitPanel.changesScrollTop.value = trueScrollPosition(changesVerticalBar, position);
    },
  });
  const changesHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'git-changes-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    height: 1,
    showArrows: false,
    trackOptions: { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent },
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.haltGitChangesHorizontalScroll();
      workspaceSet.active.gitPanel.changesScrollLeft.value = trueScrollPosition(changesHorizontalBar, position);
    },
  });
  const changesHorizontalBarPaint = createAxisBalancedHorizontalPaint(
    changesHorizontalBar,
    () => readPalette().panel,
  );
  const logVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'git-log-scrollbar-v',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return; // ignore our own per-frame scrollPosition sync (One-Writer)
      workspaceSet.active.haltGitLogScroll(); // a real thumb drag adopts authority
      workspaceSet.active.gitPanel.logScrollTop.value = trueScrollPosition(logVerticalBar, position);
      workspaceSet.active.ensureLogWindow(workspaceSet.active.gitPanel.logScrollTop.value);
    },
  });
  const logHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'git-log-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    height: 1,
    showArrows: false,
    trackOptions: { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent },
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.haltGitLogHorizontalScroll();
      workspaceSet.active.gitPanel.logScrollLeft.value = trueScrollPosition(logHorizontalBar, position);
    },
  });
  const logHorizontalBarPaint = createAxisBalancedHorizontalPaint(
    logHorizontalBar,
    () => readPalette().panel,
  );
  // File-tree vertical scrollbar (files view). The tree owns an independent scrollTop; a thumb drag
  // adopts authority (halts the wheel-momentum) and writes the offset, the same One-Writer pattern.
  const treeVerticalBar = new ScrollBarRenderable(renderer, {
    id: 'tree-scrollbar-v',
    orientation: 'vertical',
    position: 'absolute',
    width: 2,
    showArrows: false,
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.haltTreeScroll();
      workspaceSet.active.tree.scrollTop.value = trueScrollPosition(treeVerticalBar, position);
    },
  });
  const treeHorizontalBar = new ScrollBarRenderable(renderer, {
    id: 'tree-scrollbar-h',
    orientation: 'horizontal',
    position: 'absolute',
    height: 1,
    showArrows: false,
    trackOptions: { backgroundColor: readPalette().panel, foregroundColor: readPalette().accent },
    onChange: (position) => {
      if (applyingBarGeometry) return;
      workspaceSet.active.haltTreeHorizontalScroll();
      workspaceSet.active.tree.scrollLeft.value = trueScrollPosition(treeHorizontalBar, position);
    },
  });
  const treeHorizontalBarPaint = createAxisBalancedHorizontalPaint(
    treeHorizontalBar,
    () => readPalette().panel,
  );
  sidebar.add(treeVerticalBar);
  sidebar.add(treeHorizontalBar);
  sidebar.add(changesVerticalBar);
  sidebar.add(changesHorizontalBar);
  sidebar.add(logVerticalBar);
  sidebar.add(logHorizontalBar);
  sidebar.add(treeHorizontalBarPaint);
  sidebar.add(changesHorizontalBarPaint);
  sidebar.add(logHorizontalBarPaint);

  // Draggable git changes↔log divider: a 1-row grab strip over the divider glyph row (git view only).
  // Dragging sets settings.gitSplitRatio LIVE via workspaceSet.active.setGitSplit — the SAME persisted value the
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
  let gitSplitDragActive = false;
  gitSplitDivider.onMouseDown = (event) => {
    captureDragTarget(gitSplitDivider);
    gitSplitDragActive = true;
    workspaceSet.active.setGitSplit(gitSplitRatioAtPointer(event.y));
    renderer.requestRender();
  };
  gitSplitDivider.onMouseDrag = (event) => {
    workspaceSet.active.setGitSplit(gitSplitRatioAtPointer(event.y));
    renderer.requestRender();
  };
  const endGitSplitDrag = (): void => {
    if (!gitSplitDragActive) return; // both drag-end + up fire on release; persist exactly once
    gitSplitDragActive = false;
    workspaceSet.active.persistGitSplit(); // persist ONCE on release — setGitSplit only updated memory per tick
    renderer.requestRender();
  };
  gitSplitDivider.onMouseUp = endGitSplitDrag;
  gitSplitDivider.onMouseDragEnd = endGitSplitDrag;

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
    // The frame tick publishes live viewport geometry; the window top is the model offset (NOT
    // derived from the selection index, which used to snap the list on every click/open).
    return workspaceSet.active.tree.windowTop();
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
    // The ScrollBar CONTAINER resizes with bar.width/height, but its inner SliderRenderable (the painted
    // track+thumb) does NOT stretch to fill it — it keeps its own cross-axis size, so a thicker container
    // just shifts the same-width slider inward (reads as "the bar MOVED"). Drive the slider's cross-axis
    // explicitly so the painted bar is actually `thickness` cells wide.
    const slider = (bar as unknown as { slider?: { width?: number; height?: number } }).slider;
    if (slider) {
      if (orientation === 'vertical') slider.width = thickness;
      else slider.height = thickness;
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
        `bar ${bar.id}: thickness=${thickness} trackLeft=${geometry.trackLeft} -> left=${bar.left} top=${bar.top} laidX=${bar.x} laidY=${bar.y} laidW=${bar.width} laidH=${bar.height}`,
      );
  }

  /** Grapheme-safe window over display columns; never splits a wide glyph at either edge. */
  // displayColumnWindow / padToDisplayWidth now live on EditorCoordinates (the display-column-math
  // capability) so every pane renderer shares one horizontal-windowing primitive. Local aliases keep
  // the call sites terse.
  const displayColumnWindow = EditorCoordinates.Class.displayColumnWindow;
  const padToDisplayWidth = EditorCoordinates.Class.padToDisplayWidth;

  // The git row formatters (changeRowText/commitLogRowText) and content-width helpers now live on
  // GitPaneRenderer with the git-pane render itself; RootView calls the width helpers for scrollbar
  // geometry (below) and delegates the render (renderGitPanel).
  const gitActionAreaWidth = 9;

  /**
   * Converge layout-derived pane inputs AFTER Yoga has laid out the frame. This is deliberately
   * outside update(): render stays model -> view only, while each pane model owns its live extent.
   */
  function syncPaneViewportGeometry(): boolean {
    let changed = false;
    const sidebarInnerWidth = Math.max(1, sidebarWidth() - 2);
    const treeViewportHeight = Math.max(1, (sidebar.height as number) - 2);
    const treeViewportWidth = Math.max(1, sidebarInnerWidth - scrollbarThicknessCells());
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
    // Full pane width (minus the scrollbar). The action area is reserved ONLY on the active row (which
    // paints buttons) — non-active rows use the full width, so filenames are not clipped 9 cells short.
    const changesViewportWidth = Math.max(
      1,
      sidebarInnerWidth - scrollbarThicknessCells(),
    );
    const changesContentWidth = gitAvailable
      ? GitPaneRenderer.Class.changesContentWidth(gitChangeRowsNow(), theme.checkboxIcons)
      : 0;
    const changesViewportHeight = Math.max(1, gitPanelGeometry.changesRows);
    const logViewportHeight = Math.max(1, gitPanelGeometry.logRows);
    if (
      workspaceSet.active.gitPanel.changesViewportHeight.value !== changesViewportHeight ||
      workspaceSet.active.gitPanel.logViewportHeight.value !== logViewportHeight
    ) {
      workspaceSet.active.gitPanel.setVerticalViewportHeights(
        changesViewportHeight,
        logViewportHeight,
      );
      changed = true;
    }
    if (
      workspaceSet.active.gitPanel.changesViewportWidth.value !== changesViewportWidth ||
      workspaceSet.active.gitPanel.changesContentWidth.value !== changesContentWidth
    ) {
      workspaceSet.active.gitPanel.setChangesHorizontalExtent(changesContentWidth, changesViewportWidth);
      changed = true;
    }
    const logViewportWidth = Math.max(1, sidebarInnerWidth - scrollbarThicknessCells());
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

  function syncScrollbars(): void {
    const editor = workspaceSet.active.editor;
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
      // Wrap mode: the extent is the WRAPPED visual-row count (a logical line count under-reports it —
      // the "scrollbar wrong" bug); scrollTop is already a visual-row offset, so it maps 1:1.
      scrollSize: editorVisible
        ? editor.wordWrap.value
          ? EditorWrap.Class.totalVisualRows(editor.document, editor.wrapWidth())
          : editor.document.lineCount
        : 0,
      viewportSize: viewportHeight,
      scrollPosition: editor.viewport.scrollTop.value,
    });
    // Wrap mode has NO horizontal scroll axis: scrollSize 0 routes through the ONE visibility
    // rule (no scrollable range -> the bar does not exist), so the h-bar hides itself.
    let widestVisibleLineWidth = 0;
    if (editorVisible && !editor.wordWrap.value) {
      const firstVisibleLine = editor.viewport.scrollTop.value;
      for (const line of editor.document.slice(firstVisibleLine, viewportHeight)) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, EditorCoordinates.Class.lineWidth(line));
      }
    }
      applyBarGeometry(editorHorizontalBar, 'horizontal', editorRegion, {
        scrollSize: widestVisibleLineWidth,
        viewportSize: viewportWidth,
        scrollPosition: editor.viewport.scrollLeft.value,
      });

    // File-tree scrollbar (files view): the whole sidebar body is the tree list. scrollSize 0 in git
    // view routes through the visibility rule so the bar hides when the tree isn't showing.
    const filesVisible = workspaceSet.active.sidebarView.value !== 'git';
    const sidebarInnerWidthFiles = sidebarWidth() - 2;
    const treeViewportHeight = Math.max(1, (sidebar.height as number) - 2);
    applyBarGeometry(
      treeVerticalBar,
      'vertical',
      { top: 0, left: 0, width: sidebarInnerWidthFiles, height: treeViewportHeight },
      {
        scrollSize: filesVisible ? workspaceSet.active.tree.rows.length : 0,
        viewportSize: treeViewportHeight,
        scrollPosition: workspaceSet.active.tree.scrollTop.value,
      },
    );
    const treeViewportWidth = workspaceSet.active.tree.viewportWidth.value;
    applyBarGeometry(
      treeHorizontalBar,
      'horizontal',
      { top: 0, left: 0, width: sidebarInnerWidthFiles, height: treeViewportHeight },
      {
        scrollSize: filesVisible ? workspaceSet.active.tree.contentWidth : 0,
        viewportSize: treeViewportWidth,
        scrollPosition: workspaceSet.active.tree.scrollLeft.value,
      },
    );

    // Git regions, in the sidebar's content box: branch row 0; changes rows 1..; divider;
    // log rows below — offsets RECOMPUTED from the rendered geometry each frame (splitRatio and
    // the changes count move them).
    const gitVisible = workspaceSet.active.sidebarView.value === 'git' && workspaceSet.active.git.value !== null;
    const sidebarInnerWidth = sidebarWidth() - 2;
    const changesRegion = { top: 1, left: 0, width: sidebarInnerWidth, height: Math.max(1, gitPanelGeometry.changesRows) };
    applyBarGeometry(changesVerticalBar, 'vertical', changesRegion, {
      scrollSize: gitVisible ? gitChangeRowsNow().length : 0,
      viewportSize: gitPanelGeometry.changesRows,
      scrollPosition: workspaceSet.active.gitPanel.changesScrollTop.value,
    });
    const changesViewportWidth = workspaceSet.active.gitPanel.changesViewportWidth.value;
    applyBarGeometry(changesHorizontalBar, 'horizontal', changesRegion, {
      scrollSize: gitVisible ? workspaceSet.active.gitPanel.changesContentWidth.value : 0,
      viewportSize: changesViewportWidth,
      scrollPosition: workspaceSet.active.gitPanel.changesScrollLeft.value,
    });
    // Flat-row total: commit count PLUS the rows contributed by expanded commits (inline expansion).
    const logFlatEnd = workspaceSet.active.logFlatEnd();
    const logRegion = {
      top: gitPanelGeometry.dividerRow, // content-relative first log row (screen divider + 1)
      left: 0,
      width: sidebarInnerWidth,
      height: Math.max(1, gitPanelGeometry.logRows),
    };
    applyBarGeometry(logVerticalBar, 'vertical', logRegion, {
      // Unknown history length: a rolling virtual size keeps the thumb draggable; it refines once
      // the end is discovered (a short page sets knownEnd).
      scrollSize: gitVisible
        ? Number.isFinite(logFlatEnd)
          ? logFlatEnd
          : workspaceSet.active.gitPanel.logScrollTop.value + gitPanelGeometry.logRows * 4
        : 0,
      viewportSize: gitPanelGeometry.logRows,
      scrollPosition: workspaceSet.active.gitPanel.logScrollTop.value,
    });
    const logViewportWidth = workspaceSet.active.gitPanel.logViewportWidth.value;
    applyBarGeometry(logHorizontalBar, 'horizontal', logRegion, {
      scrollSize: gitVisible ? workspaceSet.active.gitPanel.logContentWidth.value : 0,
      viewportSize: logViewportWidth,
      scrollPosition: workspaceSet.active.gitPanel.logScrollLeft.value,
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
    // The file-tree pane render lives in TreePaneRenderer; RootView supplies palette + geometry and
    // the model, and mounts the result into sidebarBody. (Behaviour unchanged — same window, same
    // selection/hover intensities.)
    const innerWidth = sidebarWidth() - 2;
    return TreePaneRenderer.Class.render({
      tree: workspaceSet.active.tree,
      filesFocused: workspaceSet.active.focus.value === 'files',
      palette: readPalette(),
      icon: (name, isDirectory, expanded) => theme.icon(name, isDirectory, expanded),
      height: Math.max(1, (sidebar.height as number) - 2),
      innerWidth,
      viewportWidth: Math.max(1, innerWidth - scrollbarThicknessCells()),
      windowTop: treeWindowTop(),
    });
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
  const gutterWidth = () => String(workspaceSet.active.editor.document.lineCount).length + 1 + 2;

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
    const lineText = workspaceSet.active.editor.document.line(line);
    const segments = EditorWrap.Class.wrapLine(lineText, workspaceSet.active.editor.wrapWidth());
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
    return { rowIndex, column: EditorCoordinates.Class.displayColumn(lineText, column) - (segment?.startDisplayColumn ?? 0) };
  }

  // Workspace/project tabs and editor/buffer tabs are separate layers backed by the SAME TabStrip
  // capability. The workspace strip changes orientation; the buffer strip remains horizontal.
  // WorkspaceTabBarSegment / TabBarSegment types now live on TabBarRenderer (imported above).
  let workspaceTabBarSegments: WorkspaceTabBarSegment[] = [];
  let workspaceTabBarHover: { kind: 'tab' | 'close' | 'panBackward' | 'panForward' | 'add'; workspaceIndex: number } | null = null;
  let lastRevealedWorkspaceIndex = -1;
  let workspaceTabBarMountedPosition: 'top' | 'left' = settings.workspaceTabPosition.value;

  function synchronizeWorkspaceTabMount(): void {
    const position = settings.workspaceTabPosition.value;
    if (position === workspaceTabBarMountedPosition) return;
    if (position === 'left') {
      column.remove(workspaceTabBar);
      mainRow.add(workspaceTabBar, 0);
      workspaceTabBar.width = 22;
      workspaceTabBar.height = '100%';
    } else {
      mainRow.remove(workspaceTabBar);
      column.add(workspaceTabBar, 0);
      workspaceTabBar.width = '100%';
      workspaceTabBar.height = 1;
    }
    workspaceTabBarMountedPosition = position;
  }

  function renderWorkspaceTabBar(): StyledText {
    // Delegates to TabBarRenderer; RootView keeps the persistent reveal index + hit-test segments and
    // supplies the interaction state. Behaviour identical (horizontal + vertical orientations).
    const result = TabBarRenderer.Class.renderWorkspace({
      strip: workspaceTabStrip,
      palette: readPalette(),
      hover: workspaceTabBarHover,
      lastRevealedIndex: lastRevealedWorkspaceIndex,
      barWidthValue: Number(workspaceTabBar.width),
      barHeightValue: Number(workspaceTabBar.height),
      rendererWidth: renderer.width,
      rendererHeight: renderer.height,
    });
    workspaceTabBarSegments = result.segments;
    lastRevealedWorkspaceIndex = result.revealedIndex;
    return result.text;
  }

  function workspaceTabBarSegmentAt(primaryCoordinate: number): WorkspaceTabBarSegment | null {
    return workspaceTabBarSegments.find(
      (segment) => primaryCoordinate >= segment.primaryStart && primaryCoordinate < segment.primaryEnd,
    ) ?? null;
  }

  workspaceTabBar.onMouseDown = (event) => {
    tooltip.clear();
    const vertical = workspaceTabStrip.orientation.value === 'vertical';
    const primaryCoordinate = vertical ? event.y - Number(workspaceTabBar.y) : event.x - Number(workspaceTabBar.x);
    const crossAxisCoordinate = vertical ? event.x - Number(workspaceTabBar.x) : event.y - Number(workspaceTabBar.y);
    const segment = workspaceTabBarSegmentAt(primaryCoordinate);
    if (!segment) return;
    if (segment.kind === 'tab') {
      const closeHit = vertical
        ? crossAxisCoordinate === segment.closeCrossAxisCoordinate
        : primaryCoordinate === segment.closePrimaryCoordinate;
      if (closeHit && workspaceSet.count > 1) workspaceSet.close(segment.workspaceIndex);
      else workspaceSet.activate(segment.workspaceIndex);
    } else if (segment.kind === 'panBackward') {
      workspaceTabStrip.pan(-1);
    } else if (segment.kind === 'panForward') {
      workspaceTabStrip.pan(1);
    } else {
      overlayCoordinator.openExclusiveOverlay('quickOpen', () => quickOpen.showWorkspacePath());
    }
    renderer.requestRender();
  };
  workspaceTabBar.onMouseMove = (event) => {
    const vertical = workspaceTabStrip.orientation.value === 'vertical';
    const primaryCoordinate = vertical ? event.y - Number(workspaceTabBar.y) : event.x - Number(workspaceTabBar.x);
    const crossAxisCoordinate = vertical ? event.x - Number(workspaceTabBar.x) : event.y - Number(workspaceTabBar.y);
    const segment = workspaceTabBarSegmentAt(primaryCoordinate);
    let nextHover: typeof workspaceTabBarHover = null;
    if (segment?.kind === 'tab') {
      const closeHit = vertical
        ? crossAxisCoordinate === segment.closeCrossAxisCoordinate
        : primaryCoordinate === segment.closePrimaryCoordinate;
      nextHover = { kind: closeHit ? 'close' : 'tab', workspaceIndex: segment.workspaceIndex };
      const workspaceTab = workspaceSet.tabs()[segment.workspaceIndex];
      tooltip.point(
        closeHit
          ? 'Close project (Ctrl+Shift+W)'
          : `Switch project: ${workspaceTab?.name ?? ''} (Ctrl+Shift+PageUp/PageDown)`,
        event.x,
        event.y,
      );
    } else if (segment) {
      nextHover = { kind: segment.kind, workspaceIndex: -1 };
      tooltip.point(
        segment.kind === 'add'
          ? 'Open project folder (Ctrl+Shift+O)'
          : 'Pan project tabs without switching',
        event.x,
        event.y,
      );
    } else {
      tooltip.clear();
    }
    if (JSON.stringify(nextHover) !== JSON.stringify(workspaceTabBarHover)) {
      workspaceTabBarHover = nextHover;
      renderer.requestRender();
    }
  };
  workspaceTabBar.onMouseOut = () => {
    workspaceTabBarHover = null;
    tooltip.clear();
    renderer.requestRender();
  };

  // The editor tab bar. ONE geometry source: a layout pass produces positioned SEGMENTS that BOTH the
  // renderer and the click/hover hit-test consume — so a drawn cell and its hit-rect can never
  // disagree (the arrows-not-clickable bug was exactly that mismatch). Tabs fill from the left; the
  // overflow arrows pin to the RIGHT edge. Three visual states per target: idle → hover → pressed.
  let tabBarSegments: TabBarSegment[] = [];
  // Hover/press state (view-only), driven by tab-bar mouse move/press.
  let tabBarHover: { kind: 'tab' | 'close' | 'previewToggle' | 'arrowLeft' | 'arrowRight' | 'badge'; index: number } | null = null;
  let tabBarArrowPressed: 'arrowLeft' | 'arrowRight' | null = null;
  let tabBarPreviewPressed = false;
  let tabBarClosePressed: number | null = null; // index of the tab whose ✕ is being pressed
  // The strip's VIEWPORT PAN offset (first visible tab), INDEPENDENT of the active tab — the overflow
  // arrows drive this and never change which buffer is active (VS Code's ‹ › pan the strip only).
  // Changing the active tab (click / Ctrl+PageUp-Down) auto-reveals it, but panning does not snap back.
  let lastRevealedActiveIndex = -1;

  function renderTabBar(): StyledText {
    // Delegates to TabBarRenderer; RootView keeps the persistent reveal index + hit-test segments and
    // supplies the interaction (hover/pressed) state and the markdown-preview action inputs.
    const result = TabBarRenderer.Class.renderBuffer({
      strip: bufferTabStrip,
      palette: readPalette(),
      barWidth: tabBar.width as number,
      hover: tabBarHover,
      closePressed: tabBarClosePressed,
      previewPressed: tabBarPreviewPressed,
      arrowPressed: tabBarArrowPressed,
      lastRevealedIndex: lastRevealedActiveIndex,
      activeFileIsMarkdown: workspaceSet.active.activeFileIsMarkdown,
      showingMarkdownPreview: workspaceSet.active.showingMarkdownPreview,
      previewIcon: theme.actionIcons.preview,
    });
    tabBarSegments = result.segments;
    lastRevealedActiveIndex = result.revealedIndex;
    return result.text;
  }

  // Resolve a local column to a tab-bar segment (shared by click + hover — one geometry source).
  function tabBarSegmentAt(localColumn: number): TabBarSegment | null {
    return tabBarSegments.find((segment) => localColumn >= segment.start && localColumn < segment.end) ?? null;
  }

  // The arrows PAN the strip viewport only — they never change the active buffer (the render clamps
  // the offset, so panning past an end is a no-op and the arrow reads as disabled there).
  function scrollTabsLeft(): void {
    if (bufferTabStrip.scrollOffset.value > 0) {
      bufferTabStrip.pan(-1);
      renderer.requestRender();
    }
  }
  function scrollTabsRight(): void {
    bufferTabStrip.pan(1); // clamped to maxScrollOffset in renderTabBar
    renderer.requestRender();
  }

  // Clicking the count badge opens a dropdown of ALL open buffers (VS Code's overflow menu) — reusing
  // the ContextMenu machinery (modal, keyboard-navigable, Esc to close). Selecting a row jumps to it.
  function openTabDropdown(anchorColumn: number): void {
    const items = workspaceSet.active.buffers.tabs().map((tab, index) => ({
      id: String(index),
      label: `${tab.active ? '●' : ' '} ${Files.Class.basename(tab.path)}${tab.dirty ? '  ✕' : ''}`,
      enabled: true,
    }));
    overlayCoordinator.openExclusiveOverlay('contextMenu', () =>
      contextMenu.openAt(
        items,
        (tabBar.x as number) + anchorColumn,
        (tabBar.y as number) + 1,
        { width: renderer.width, height: renderer.height },
        (itemId) => workspaceSet.active.activateTab(Number(itemId)),
      ),
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
        workspaceSet.active.requestCloseTab(segment.index);
      } else workspaceSet.active.activateTab(segment.index);
    } else if (segment.kind === 'badge') {
      openTabDropdown(segment.start);
    } else if (segment.kind === 'previewToggle') {
      tabBarPreviewPressed = true;
      workspaceSet.active.toggleMarkdownPreview();
      renderer.requestRender();
    } else {
      tabBarArrowPressed = segment.kind; // pressed colour shows until release
      if (segment.kind === 'arrowLeft') scrollTabsLeft();
      else scrollTabsRight();
      renderer.requestRender();
    }
  };
  tabBar.onMouseUp = () => {
    if (tabBarArrowPressed || tabBarPreviewPressed || tabBarClosePressed !== null) {
      tabBarArrowPressed = null;
      tabBarPreviewPressed = false;
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
    if (segment?.kind === 'previewToggle') {
      const bindingHint = keybindings.bindingHint('markdown.togglePreview', 'editor');
      tooltip.point(
        `Toggle Markdown preview${bindingHint ? ` (${bindingHint})` : ''}`,
        event.x,
        event.y,
      );
    } else if (segment?.kind === 'arrowLeft' || segment?.kind === 'arrowRight') {
      tooltip.point('Pan file tabs without switching', event.x, event.y);
    } else if (segment?.kind === 'badge') {
      tooltip.point('Show all open files', event.x, event.y);
    } else {
      tooltip.clear();
    }
    if (JSON.stringify(next) !== JSON.stringify(tabBarHover)) {
      tabBarHover = next;
      renderer.requestRender();
    }
  };
  tabBar.onMouseOut = () => {
    if (tabBarHover || tabBarArrowPressed || tabBarPreviewPressed || tabBarClosePressed !== null) {
      tabBarHover = null;
      tabBarArrowPressed = null;
      tabBarPreviewPressed = false;
      tabBarClosePressed = null;
      tooltip.clear();
      renderer.requestRender();
    }
  };

  // Builds the visible window as two aligned StyledTexts — the gutter (line numbers + current-line
  // marker) and the code (syntax colors only, NO gutter). Only the visible lines are tokenized
  // (flyweight). Returns null for the empty state.
  function renderEditor(): { gutter: StyledText; code: StyledText } | null {
    // Delegates to EditorPaneRenderer; RootView stores the returned wrap-row window (the caret block,
    // applySelection, and the hit-test read it). null (diff shown / no document) leaves it untouched,
    // exactly as before. Behaviour identical.
    const result = EditorPaneRenderer.Class.render({
      workspace: workspaceSet.active,
      palette: readPalette(),
      viewportHeight: editorViewportHeight(),
      viewportWidth: editorViewportWidth(),
      findEngineFor: (documentPath) => findBar.engineFor(`source:${documentPath}`),
    });
    if (!result) return null;
    wrapRowsWindow = result.wrapRowsWindow;
    return { gutter: result.gutter, code: result.code };
  }

  // Drive OpenTUI's native selection on the code renderable from the model selection, mapped into
  // code-local coords (x = display column, y = visible-line index). Clamps to the visible window.
  // invariant: The selected range renders with a background (ui.invariants.md)
  function applySelection(): void {
    const editor = workspaceSet.active.editor;
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
    const anchorX = selection.start.line >= top ? EditorCoordinates.Class.displayColumn(editor.document.line(selection.start.line), selection.start.col) : 0;
    const focusY = Math.min(viewportHeight - 1, selection.end.line - top);
    const focusX =
      selection.end.line < top + viewportHeight
        ? EditorCoordinates.Class.displayColumn(editor.document.line(selection.end.line), selection.end.col)
        : EditorCoordinates.Class.lineWidth(editor.document.line(Math.min(top + viewportHeight - 1, editor.document.lineCount - 1)));
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
    // The git-pane render lives in GitPaneRenderer; RootView supplies palette + geometry + the theme
    // icon sets and the active workspace, then applies the geometry the renderer returns (it is the
    // hit-testers' source of truth). Behaviour identical.
    const innerWidth = sidebarWidth() - 2;
    const result = GitPaneRenderer.Class.render({
      workspace: workspaceSet.active,
      palette: readPalette(),
      innerWidth,
      bodyHeight: Math.max(1, (sidebar.height as number) - 2),
      scrollbarThickness: scrollbarThicknessCells(),
      gitActionAreaWidth,
      actionIcons: theme.actionIcons,
      checkboxIcons: theme.checkboxIcons,
    });
    gitPanelGeometry = result.geometry;
    return result.text;
  }

  function renderStatus(): string {
    const editor = workspaceSet.active.editor;
    const parts: string[] = [` ${workspaceSet.active.name.value || '—'}`];
    if (editor.hasDocument.value) {
      parts.push(editor.title);
      parts.push(`Ln ${editor.cursor.line.value + 1}, Col ${editor.cursor.col.value + 1}`);
      parts.push(`${editor.document.lineCount} lines`);
    }
    parts.push(
      workspaceSet.active.focus.value === 'files'
        ? '[Files]'
        : activeMarkdownSplitView?.previewFocused
          ? '[Markdown Preview]'
          : '[Editor Source]',
    );
    if (workspaceSet.active.focus.value === 'git')
      parts.push('checkbox/Space stage · row/o open · d discard');
    if (app.copyNotice.value) parts.push(app.copyNotice.value);
    parts.push(
      app.quitChordArmed.value ? 'Ctrl+X armed — Ctrl+C quits' : 'Ctrl+Q/F10 quit',
    );
    return parts.join('  ·  ');
  }

  // The rich side-by-side DiffView overlays the editor area when a git diff is open (mirrors the old
  // showingDiff overlay, but the DiffView renderable replaces the unified-text diffEditor). DiffView has
  // no re-open, so it is reconstructed whenever the diff request's token changes; disposed when cleared.
  let activeDiffView: DiffView.Instance | null = null;
  let shownDiffIdentifier = '';
  let activeMarkdownSplitView: MarkdownSplitView.Instance | null = null;
  let shownMarkdownIdentifier = '';
  let mountedEditorContent: 'editor' | 'diff' | 'markdown' | null = 'editor';
  let lastDiffLaidHeight = -1;

  function unmountEditorContent(): void {
    if (mountedEditorContent === 'editor') editorColumn.remove(editorArea);
    else if (mountedEditorContent === 'diff') editorColumn.remove(diffContainer);
    else if (mountedEditorContent === 'markdown') editorColumn.remove(markdownContainer);
    mountedEditorContent = null;
  }

  function mountEditorContent(content: 'editor' | 'diff' | 'markdown'): void {
    if (mountedEditorContent === content) return;
    unmountEditorContent();
    if (content === 'editor') editorColumn.add(editorArea);
    else if (content === 'diff') editorColumn.add(diffContainer);
    else editorColumn.add(markdownContainer);
    mountedEditorContent = content;
  }

  function syncDiffView(): void {
    // invariant: A Markdown file offers a live source preview split (src/modules/markdown/markdown.invariants.md)
    const request = workspaceSet.active.diffRequest.value;
    const diffIdentifier = `${workspaceSet.active.root}:${request?.token ?? 'none'}`;
    if (diffIdentifier !== shownDiffIdentifier) {
      shownDiffIdentifier = diffIdentifier;
      lastDiffLaidHeight = -1; // the frame loop re-renders once the new instance has a laid-out height
      if (activeDiffView) {
        activeDiffView.dispose();
        activeDiffView = null;
      }
      if (request) {
        activeDiffView = new DiffView.Class(renderer, theme, {
          previousVersionText: request.previousVersionText,
          currentVersionText: request.currentVersionText,
          previousVersionPath: request.previousVersionPath,
          currentVersionPath: request.currentVersionPath,
          parentRenderable: diffContainer, // definite-size host (added below in place of editorArea)
          onOpenFull: () => {
            // Git diff requests carry workspace-relative paths. Resolve through the existing
            // confinement seam before promoting the working side to a real editable tab.
            const currentWorkingPath = Files.Class.confineToRoot(workspaceSet.active.root, request.currentVersionPath);
            if (currentWorkingPath) workspaceSet.active.openFileInTab(currentWorkingPath);
          },
          onNextChange: () => renderer.requestRender(),
          onPrevChange: () => renderer.requestRender(),
        });
        activeDiffView.attachSettings(settings); // live scroll physics, same as the editor
        activeDiffView.attachFindBar(findBar, diffIdentifier);
      }
    }
    const diffActive = activeDiffView !== null && workspaceSet.active.showingDiff.value;
    const markdownIdentifier = workspaceSet.active.showingMarkdownPreview
      ? `${workspaceSet.active.root}:${workspaceSet.active.editor.document.path}`
      : '';

    if (diffActive) {
      if (activeMarkdownSplitView) {
        if (mountedEditorContent === 'markdown') unmountEditorContent();
        activeMarkdownSplitView.dispose();
        activeMarkdownSplitView = null;
        shownMarkdownIdentifier = '';
      }
      mountEditorContent('diff');
    } else if (markdownIdentifier) {
      if (shownMarkdownIdentifier !== markdownIdentifier || !activeMarkdownSplitView) {
        if (activeMarkdownSplitView) {
          if (mountedEditorContent === 'markdown') unmountEditorContent();
          activeMarkdownSplitView.dispose();
        }
        shownMarkdownIdentifier = markdownIdentifier;
        unmountEditorContent();
        activeMarkdownSplitView = new MarkdownSplitView.Class(renderer, theme, {
          source: workspaceSet.active.editor.document,
          sourcePath: workspaceSet.active.editor.document.path,
          sourceRenderable: editorArea,
          parentRenderable: markdownContainer,
          settings,
          findBar,
          resolveReference: (reference) => workspaceSet.active.resolveFileReference(reference),
          openReference: (path) => workspaceSet.active.openFileInTab(path),
          showReferenceTooltip: (path, screenColumn, screenRow) => {
            const label = Files.Class.relative(workspaceSet.active.root, path);
            const bindingHint = keybindings.bindingHint('markdown.openHoveredReference', 'editor');
            tooltip.point(
              `Open ${label} (Ctrl/Cmd+click${bindingHint ? ` · ${bindingHint}` : ''})`,
              screenColumn,
              screenRow,
            );
          },
          clearReferenceTooltip: () => tooltip.clear(),
        });
      }
      mountEditorContent('markdown');
      activeMarkdownSplitView.update();
    } else {
      if (activeMarkdownSplitView) {
        if (mountedEditorContent === 'markdown') unmountEditorContent();
        activeMarkdownSplitView.dispose();
        activeMarkdownSplitView = null;
        shownMarkdownIdentifier = '';
      }
      mountEditorContent('editor');
    }
    // NOTE: the DiffView's first paint at its real laid-out height is driven from the FRAME LOOP
    // (tickDiffMomentum), NOT here — syncDiffView runs in the reactive paint (fires only on signal
    // changes), which happens BEFORE OpenTUI lays out the freshly-swapped container, so root height is
    // still 0 here. The frame loop re-checks the laid-out height each frame and repaints when it changes.
  }

  function findTarget(): FindBarTarget | null {
    // invariant: Markdown panes keep independent find state (src/modules/markdown/markdown.invariants.md)
    // invariant: Diff panes keep independent find state (src/modules/diff/diff.invariants.md)
    if (workspaceSet.active.showingDiff.value && activeDiffView) {
      return activeDiffView.findTarget();
    }
    if (activeMarkdownSplitView?.previewFocused) {
      return activeMarkdownSplitView.findTarget();
    }
    const editor = workspaceSet.active.editor;
    if (!editor.hasDocument.value) return null;
    return {
      identifier: `source:${editor.document.path}`,
      document: editor.document,
      replaceAllowed: !editor.readOnly.value,
      revealMatch: (match) => {
        activeMarkdownSplitView?.focusSource();
        editor.placeCursor(match.line, match.endColumn);
        editor.cursor.anchor.value = { line: match.line, col: match.startColumn };
        editor.revealCursor();
      },
    };
  }

  function update(): void {
    const palette = readPalette();
    synchronizeWorkspaceTabMount();
    syncDiffView();
    column.backgroundColor = palette.bg;
    const gitView = workspaceSet.active.sidebarView.value === 'git';
    sidebar.width = sidebarWidth(); // live width from the draggable splitter (persisted to settings)
    sidebar.backgroundColor = palette.panel;
    sidebar.borderColor = workspaceSet.active.focus.value === 'files' || gitView ? palette.borderActive : palette.border;
    // Divider: brighten while hovered or dragging so it reads as a grab handle.
    sidebarDivider.backgroundColor =
      sidebarSplitter.dragging.value || sidebarDividerHover ? palette.accent : palette.border;
    sidebar.titleColor = workspaceSet.active.focus.value === 'files' || gitView ? palette.accent : palette.dim;
    sidebar.title = gitView ? 'Git' : 'Files';
    editorArea.backgroundColor = palette.bg;
    const sourcePaneFocused = workspaceSet.active.focus.value === 'editor' &&
      !(activeMarkdownSplitView?.previewFocused ?? false);
    editorArea.borderColor = sourcePaneFocused ? palette.borderActive : palette.border;
    editorArea.title = workspaceSet.active.editor.hasDocument.value ? workspaceSet.active.editor.title : 'Editor';
    editorArea.titleColor = sourcePaneFocused ? palette.accent : palette.dim;
    tabBar.content = renderTabBar();
    workspaceTabBar.content = renderWorkspaceTabBar();
    workspaceTabBar.fg = palette.fg;
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
    // The `?` help affordance brightens on hover and while its sheet is open.
    shortcutHelpButton.fg =
      shortcutHelpButtonHover || shortcutHelp.open.value ? palette.accent : palette.dim;

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

    // Find/replace bar overlay.
    findBarBox.visible = findBar.open.value;
    if (findBar.open.value) {
      const engine = findBar.engine;
      const replaceMode = findBar.mode.value === 'replace';
      const queryFocused = !(replaceMode && findBar.replaceFocused.value);
      const count = engine ? engine.matchCount : 0;
      const position = engine && engine.currentMatchIndex.value >= 0 ? engine.currentMatchIndex.value + 1 : 0;
      const counter = count > 0 ? `${position} of ${count}` : engine && engine.query.value ? 'no results' : '';
      findBarBox.title = replaceMode ? 'Find / Replace' : 'Find';
      findBarBox.borderColor = palette.borderActive;
      findBarBox.titleColor = palette.accent;
      findBarBox.backgroundColor = palette.panel;
      const lines: string[] = [];
      lines.push(`⌕ ${engine?.query.value ?? ''}${queryFocused ? '▏' : ''}   ${counter}`);
      if (replaceMode) lines.push(`⇄ ${engine?.replacement.value ?? ''}${queryFocused ? '' : '▏'}`);
      lines.push(replaceMode ? '↵ next · ⇧↵ prev · ⌃↵ replace · ⌃⇧↵ all · ⇥ field · esc' : '↵ next · ⇧↵ prev · esc close');
      findBarText.content = lines.join('\n');
      findBarText.fg = palette.fg;
    }

    // Quick-open (Ctrl+P) overlay.
    quickOpenBox.visible = quickOpen.open.value;
    if (quickOpen.open.value) {
      const openingWorkspace = quickOpen.mode.value === 'workspacePath';
      quickOpenBox.title = openingWorkspace ? 'Open Project Folder' : 'Go to File';
      quickOpenBox.borderColor = palette.borderActive;
      quickOpenBox.titleColor = palette.accent;
      quickOpenBox.backgroundColor = palette.panel;
      quickOpenInput.content = `${openingWorkspace ? '+' : theme.actionIcons.open} ${quickOpen.query.value}▏`;
      quickOpenInput.fg = palette.fg;
      const matches = quickOpen.matches.value.slice(0, 14);
      const selectedIndex = quickOpen.selectedIndex.value;
      quickOpenList.content = openingWorkspace
        ? quickOpen.errorMessage.value
          ? `  ${quickOpen.errorMessage.value}\n  Enter opens · Esc cancels`
          : '  Type an existing folder path\n  Enter opens · Esc cancels'
        : matches.length
          ? matches.map((match, index) => `${index === selectedIndex ? '›' : ' '} ${match.path}`).join('\n')
          : quickOpen.query.value
            ? '  (no matching files)'
            : '  (type to filter project files)';
      quickOpenList.fg = palette.dim;
    }

    const pendingDiscard = workspaceSet.active.gitPanel.confirmDiscard.value;
    const pendingCloseTabIndex = workspaceSet.active.pendingCloseTabIndex.value;
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
      const tabPath = workspaceSet.active.buffers.tabs()[pendingCloseTabIndex]?.path ?? '';
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

    // Shortcut cheat-sheet overlay — every row projected from the ShortcutHelp model, whose chords
    // come from KeybindingRegistry.effectiveBindings (never a hand-written list).
    // invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
    shortcutHelpBackdrop.visible = shortcutHelp.open.value;
    shortcutHelpBox.visible = shortcutHelp.open.value;
    if (shortcutHelp.open.value) {
      shortcutHelpBox.height = shortcutHelpBoxHeight();
      shortcutHelpBox.borderColor = palette.borderActive;
      shortcutHelpBox.titleColor = palette.accent;
      shortcutHelpBox.backgroundColor = palette.panel;
      const sheetRows = shortcutHelp.rows();
      const sheetViewportRows = shortcutHelpViewportRows();
      const sheetMaximumScrollTop = Math.max(0, sheetRows.length - sheetViewportRows);
      // Read-only clamp for this paint; the model clamps its own writes in scrollBy.
      const sheetScrollTop = Math.min(shortcutHelp.scrollTop.value, sheetMaximumScrollTop);
      const sheetVisibleRows = sheetRows.slice(sheetScrollTop, sheetScrollTop + sheetViewportRows);
      const chordColumnWidth = sheetRows.reduce(
        (widestWidth, sheetRow) => Math.max(widestWidth, sheetRow.chordLabel.length),
        0,
      );
      const sheetScrollHint =
        sheetRows.length > sheetViewportRows
          ? `   ${sheetScrollTop + 1}-${Math.min(sheetScrollTop + sheetViewportRows, sheetRows.length)} of ${sheetRows.length}`
          : '';
      const sheetChunks: TextChunk[] = [];
      sheetChunks.push(fg(palette.dim)(`  ↑/↓ scroll · Esc close${sheetScrollHint}\n`));
      sheetVisibleRows.forEach((sheetRow, sheetRowIndex) => {
        const lineBreak = sheetRowIndex < sheetVisibleRows.length - 1 ? '\n' : '';
        if (sheetRow.kind === 'category') {
          sheetChunks.push(bold(fg(palette.accent)(` ${sheetRow.label}${lineBreak}`)));
        } else {
          sheetChunks.push(
            fg(palette.accent)(`   ${sheetRow.chordLabel.padEnd(chordColumnWidth, ' ')}`),
          );
          sheetChunks.push(fg(palette.fg)(`  ${sheetRow.label}${lineBreak}`));
        }
      });
      shortcutHelpText.content = new StyledText(sheetChunks);
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
      const tooltipWidth = EditorCoordinates.Class.lineWidth(tooltipLabel);
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
    const editor = workspaceSet.active.editor;
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
        editor.hasDocument.value && workspaceSet.active.focus.value === 'editor' && !activeMarkdownSplitView?.previewFocused && !open
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
      EditorCoordinates.Class.displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) >=
        editor.viewport.scrollLeft.value &&
      EditorCoordinates.Class.displayColumn(editor.document.line(Math.min(cursorLine, editor.document.lineCount - 1)), editor.cursor.col.value) <
        editor.viewport.scrollLeft.value + editorViewportWidth();
    if (editor.hasDocument.value && workspaceSet.active.focus.value === 'editor' && !activeMarkdownSplitView?.previewFocused && !open && cursorLine >= scrollTop && cursorLine < scrollTop + viewportHeight && caretVisibleHorizontally) {
      const cursorDisplayColumn = EditorCoordinates.Class.displayColumn(editor.document.line(cursorLine), editor.cursor.col.value);
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
    const direction = event.scroll?.direction;
    const step = wheelStep(event);
    const horizontal =
      direction === 'left' ||
      direction === 'right' ||
      scrollModifierHeld(event, settings.horizontalScrollModifier.value);
    const backward = direction === 'left' || direction === 'up';
    if (workspaceSet.active.sidebarView.value === 'git') {
      // Route by pointer position: wheel over the changes region scrolls it; over the log, the
      // momentum glide (same gesture, per-region window).
      const row = event.y - sidebar.y;
      if (row < gitPanelGeometry.dividerRow) {
        if (horizontal) workspaceSet.active.impulseGitChangesHorizontalScroll((backward ? -1 : 1) * step);
        else workspaceSet.active.impulseGitChangesScroll((direction === 'up' ? -1 : 1) * step);
      } else {
        if (horizontal) workspaceSet.active.impulseGitLogHorizontalScroll((backward ? -1 : 1) * step);
        else workspaceSet.active.impulseGitLog((direction === 'up' ? -1 : 1) * step);
      }
    } else if (horizontal) workspaceSet.active.impulseTreeHorizontalScroll((backward ? -1 : 1) * step);
    else workspaceSet.active.impulseTreeScroll((direction === 'up' ? -1 : 1) * step);
  };
  // Vertical scroll of the editor window. Wrap mode: scrollTop stays a LOGICAL line index, but
  // tall (wrapped) lines mean the logical clamp `lineCount - height` could strand tail rows below
  // the fold — so the clamp relaxes to let the LAST line reach the top of the window.
  // Wrap-mode vertical wheel + drag-edge auto-scroll step directly (rows), NOT through the momentum
  // regime: wrap mode's scroll bound is lineCount-1 (a wrapped line occupies many visual rows), which
  // the momentum regime's scrollBy clamp (lineCount - height) does not model. Non-wrap wheel goes
  // through momentum (impulse) below.
  // Is the configured scroll modifier held on this wheel event? 'none' is never held (the control is
  // off, not misleading). Single source: the modifier comes from Settings, never hardcoded.
  const scrollModifierHeld = (event: { modifiers: { alt: boolean; shift: boolean; ctrl: boolean } }, modifier: ScrollModifier): boolean => {
    switch (modifier) {
      case 'alt':
        return event.modifiers.alt;
      case 'shift':
        return event.modifiers.shift;
      case 'ctrl':
        return event.modifiers.ctrl;
      default:
        return false; // 'none'
    }
  };
  // Rows per wheel notch = settings.linesPerNotch (was a hardcoded 3), multiplied by the fast-scroll
  // factor when the fast-scroll modifier is held (settings.fastScrollMultiplier; modifier defaults to
  // 'none' = off). One expression feeds BOTH the wrap-mode direct step and the momentum impulse.
  const wheelStep = (event: { modifiers: { alt: boolean; shift: boolean; ctrl: boolean } }): number => {
    const notch = Math.max(1, Math.round(settings.linesPerNotch.value));
    const fast = scrollModifierHeld(event, settings.fastScrollModifier.value)
      ? Math.max(1, Math.round(settings.fastScrollMultiplier.value))
      : 1;
    return notch * fast;
  };
  const scrollEditorVertically = (delta: number): void => {
    const editor = workspaceSet.active.editor;
    const editorViewport = editor.viewport;
    if (editor.wordWrap.value) {
      // scrollTop is a VISUAL-row offset; clamp to the wrapped extent so the last visual row is reachable.
      const maxTop = Math.max(0, EditorWrap.Class.totalVisualRows(editor.document, editor.wrapWidth()) - editorViewport.height.value);
      editorViewport.scrollTop.value = Math.max(0, Math.min(editorViewport.scrollTop.value + delta, maxTop));
    } else {
      editorViewport.scrollBy(delta, editor.document.lineCount);
    }
  };
  editorArea.onMouseScroll = (event) => {
    if (!workspaceSet.active.editor.hasDocument.value) return;
    // Horizontal scroll arrives by SEVERAL terminal-dependent encodings; route them ALL to columns:
    //   - native horizontal wheel / tilt: SGR 66/67 -> direction left/right (trackpad two-finger swipe;
    //     Option+wheel on the user's terminal arrives as 74/75 = 66/67 + Meta, also direction left/right);
    //   - a VERTICAL wheel with a modifier: Option/Alt (+8 -> 72/73) is the user-facing path that
    //     survives real terminals; Shift (+4 -> 68/69) is a bonus (most terminals swallow it).
    // Delivery of any given modifier is terminal-dependent — supporting all of them is the robust fix.
    const direction = event.scroll?.direction;
    const step = wheelStep(event);
    if (workspaceSet.active.editor.wordWrap.value) {
      // Wrap mode: ONE scroll axis (horizontal gestures route to the vertical window, scrollLeft inert),
      // fed through the SAME momentum engine as non-wrap so a wheel notch GLIDES then decays — scrollTop
      // is in visual rows, so the glide is smooth over wrapped rows (not jumpy by logical line).
      const backward = direction === 'left' || direction === 'up';
      workspaceSet.active.impulseEditorVerticalScroll((backward ? -1 : 1) * step);
    } else {
      // The horizontal modifier is configurable (settings.horizontalScrollModifier, default 'alt' = the
      // Option-wheel path that survives real terminals); native left/right direction is always horizontal.
      const modifierHorizontal = scrollModifierHeld(event, settings.horizontalScrollModifier.value);
      const horizontal = direction === 'left' || direction === 'right' || modifierHorizontal;
      if (horizontal) {
        const backward = direction === 'left' || direction === 'up';
        workspaceSet.active.impulseEditorHorizontalScroll((backward ? -1 : 1) * step);
      } else {
        workspaceSet.active.impulseEditorVerticalScroll((direction === 'up' ? -1 : 1) * step);
      }
    }
  };

  // Mouse selection drives the MODEL (cursor + anchor) — the single writer; the native highlight
  // is then applied FROM the model by applySelection() each paint, so it persists across repaints
  // and Ctrl+C copies exactly what is highlighted.
  // invariant: The selected range renders with a background (ui.invariants.md)
  const documentPositionAtCell = (cellX: number, cellY: number): { line: number; column: number } | null => {
    if (!workspaceSet.active.editor.hasDocument.value) return null;
    if (workspaceSet.active.editor.wordWrap.value) {
      // Wrap mode: a viewport row is a VISUAL row — resolve it through the rendered window, then
      // hit-test the display column WITHIN that row's segment (clamped into the segment so a
      // click past a wrapped row's end lands on its last grapheme, not the next row's first).
      if (wrapRowsWindow.length === 0) return null;
      const rowIndex = Math.max(0, Math.min(cellY - codeBody.y, wrapRowsWindow.length - 1));
      const row = wrapRowsWindow[rowIndex];
      if (!row) return null;
      const lineText = workspaceSet.active.editor.document.line(row.lineIndex);
      const segments = EditorWrap.Class.wrapLine(lineText, workspaceSet.active.editor.wrapWidth());
      const lastSegmentOfLine = row.segmentIndex === segments.length - 1;
      const hitColumn = EditorCoordinates.Class.graphemeAtDisplayColumn(
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
        workspaceSet.active.editor.viewport.scrollTop.value + (cellY - codeBody.y),
        workspaceSet.active.editor.document.lineCount - 1,
      ),
    );
    const column = EditorCoordinates.Class.graphemeAtDisplayColumn(
      workspaceSet.active.editor.document.line(line),
      workspaceSet.active.editor.viewport.scrollLeft.value + (cellX - codeBody.x),
    );
    return { line, column };
  };
  // One shared drag/autoscroll behavior serves this editor and DiffView. The hosts differ only in
  // coordinate mapping and scroll storage; pointer lifecycle, edge zones, rate, and re-extension are
  // identical. invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  const editorSelectionDragBehavior = new SelectionDragBehavior({
    viewportRectangle: () => ({
      leftColumn: codeBody.x,
      rightColumn: codeBody.x + Math.max(1, editorViewportWidth()) - 1,
      topRow: codeBody.y,
      bottomRow: codeBody.y + Math.max(1, editorViewportHeight()) - 1,
    }),
    positionAtCell: documentPositionAtCell,
    horizontalScrollPosition: () => workspaceSet.active.editor.viewport.scrollLeft.value,
    horizontalScrollingEnabled: () => !workspaceSet.active.editor.wordWrap.value,
    beginSelection: (position) => {
      workspaceSet.active.focusEditor();
      workspaceSet.active.editor.placeCursor(position.line, position.column);
      workspaceSet.active.editor.cursor.setAnchorHere();
    },
    extendSelection: (position, pointerDisplayColumn) => {
      // Direct Cursor.set preserves the pointer's display-column goal while short lines clamp the
      // landing column; placeCursor would reveal/yank the viewport during a diagonal drag.
      workspaceSet.active.editor.cursor.set(position.line, position.column, pointerDisplayColumn);
    },
    finishSelection: () => {
      if (!workspaceSet.active.editor.cursor.hasSelection) workspaceSet.active.editor.cursor.clearSelection();
    },
    scrollColumns: (columnDelta) => {
      const topLineIndex = workspaceSet.active.editor.viewport.scrollTop.value;
      let widestVisibleLineWidth = 0;
      for (const line of workspaceSet.active.editor.document.slice(topLineIndex, editorViewportHeight())) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, EditorCoordinates.Class.lineWidth(line));
      }
      workspaceSet.active.editor.viewport.scrollByColumns(columnDelta, widestVisibleLineWidth);
    },
    scrollRows: scrollEditorVertically,
    haltCompetingScroll: () => workspaceSet.active.editor.viewport.haltScrollMomentum(),
  });

  codeBody.onMouseDown = (event) => {
    activeMarkdownSplitView?.focusSource();
    if (process.env.TUI_DEBUG_MOUSE === '1') {
      Logging.Class.info(`mouseDown (${event.x},${event.y}) hit=${JSON.stringify(documentPositionAtCell(event.x, event.y))}`);
    }
    // Ctrl/Cmd+click on a symbol = go to definition (VS Code style). OpenTUI exposes terminal
    // Meta/Super mouse modifiers through the SGR alt bit, so ctrl OR alt covers Ctrl-click and
    // terminal Cmd/Meta-click without a second path (same rule as the Markdown reference click).
    // The event is consumed here — it never doubles as a selection begin.
    // invariant: A definition gesture jumps to the declaration (src/modules/lsp/lsp.invariants.md)
    if (event.button === 0 && (event.modifiers.ctrl || event.modifiers.alt)) {
      const definitionPosition = documentPositionAtCell(event.x, event.y);
      if (definitionPosition) {
        workspaceSet.active.focusEditor();
        void workspaceSet.active.goToDefinition(definitionPosition);
        return;
      }
    }
    editorSelectionDragBehavior.begin(event.x, event.y);
  };
  codeBody.onMouseDrag = (event) => {
    if (process.env.TUI_DEBUG_MOUSE === '1') {
      Logging.Class.info(`mouseDrag (${event.x},${event.y}) hit=${JSON.stringify(documentPositionAtCell(event.x, event.y))}`);
    }
    editorSelectionDragBehavior.drag(event.x, event.y);
  };
  codeBody.onMouseUp = () => editorSelectionDragBehavior.end();
  codeBody.onMouseDragEnd = () => editorSelectionDragBehavior.end();

  function tickDragAutoScroll(deltaTimeSeconds: number): boolean {
    // This hook already runs after each Yoga layout. Converge every sidebar pane's live geometry here
    // too; returning true for the one changed frame guarantees a repaint, then quiescence resumes.
    const paneViewportGeometryChanged = syncPaneViewportGeometry();
    return editorSelectionDragBehavior.tick(deltaTimeSeconds) || paneViewportGeometryChanged;
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
    const git = workspaceSet.active.git.value;
    return git ? GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
  };
  // The git action-button hit zones (right-aligned ` o  d  ±` on a hovered/selected file row).
  // ONE definition shared by the click dispatch and the tooltip arming, so the tooltip always
  // names exactly what a click at that cell would do.
  type GitActionButton = 'open' | 'discard' | 'stageToggle';
  const gitActionButtonAt = (relativeX: number): GitActionButton | null => {
    const innerWidth = sidebarWidth() - 2;
    const actionAreaStart = Math.max(
      1,
      innerWidth - scrollbarThicknessCells() - gitActionAreaWidth,
    );
    if (relativeX >= actionAreaStart && relativeX < actionAreaStart + 2) return 'open';
    if (relativeX >= actionAreaStart + 2 && relativeX < actionAreaStart + 5) return 'discard';
    if (relativeX >= actionAreaStart + 5 && relativeX < actionAreaStart + 8) return 'stageToggle';
    return null;
  };

  sidebar.onMouseMove = (event) => {
    if (workspaceSet.active.sidebarView.value === 'git') {
      const hit = gitRowAt(event.y);
      const rows = gitChangeRowsNow();
      workspaceSet.active.gitPanel.changesHovered.value =
        hit?.region === 'changes' && rows[hit.index]?.kind === 'file' ? hit.index : -1;
      workspaceSet.active.gitPanel.logHovered.value = hit?.region === 'log' ? hit.index : -1;
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
    workspaceSet.active.tree.hoveredIndex.value =
      rowIndex >= 0 && rowIndex < workspaceSet.active.tree.rows.length ? rowIndex : -1;
  };
  sidebar.onMouseOut = () => {
    workspaceSet.active.tree.hoveredIndex.value = -1;
    workspaceSet.active.gitPanel.changesHovered.value = -1;
    workspaceSet.active.gitPanel.logHovered.value = -1;
    tooltip.clear();
  };

  // Right-click on a changes FILE row: normalize the selection (an unselected row becomes THE
  // selection; a selected row keeps the whole multi-selection) and open the context menu at the
  // pointer with the COLLECTIVE actions the selection's buckets support.
  const openChangesContextMenu = (rowIndex: number, row: FileRow, rows: ChangeRow[], pointerX: number, pointerY: number): void => {
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
    workspaceSet.active.gitPanel.replaceSelected(paths);
  };

  sidebar.onMouseDown = (event) => {
    if (workspaceSet.active.sidebarView.value === 'git') {
      workspaceSet.active.focusGit();
      const hit = gitRowAt(event.y);
      if (!hit) return;
      if (hit.region === 'changes') {
        workspaceSet.active.haltGitChangesScroll();
        const rows = gitChangeRowsNow();
        const row = rows[hit.index];
        if (row?.kind !== 'file') return;
        workspaceSet.active.gitPanel.region.value = 'changes';
        // Multi-select gestures come FIRST; plain left-click behavior below is unchanged.
        if (event.button === 2) {
          openChangesContextMenu(hit.index, row, rows, event.x, event.y); // right-click menu
          return;
        }
        if (event.modifiers.ctrl) {
          workspaceSet.active.gitPanel.toggleSelected(row.path); // toggle in/out of the selection; no menu
          return;
        }
        if (event.modifiers.shift) {
          selectChangesRange(workspaceSet.active.gitPanel.changesIndex.value, hit.index, rows); // range
          return;
        }
        const wasCurrent = workspaceSet.active.gitPanel.changesIndex.value === hit.index;
        workspaceSet.active.gitPanel.setChangesSelection(hit.index);
        const relativeX = event.x - (sidebar.x + 1);
        const actionButton = gitActionButtonAt(relativeX);
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
    const rowIndex = treeWindowTop() + (event.y - (sidebar.y + 1)); // +1: sidebar top border
    if (rowIndex < 0 || rowIndex >= workspaceSet.active.tree.rows.length) return;
    // Single-click activation: one click selects AND opens the file / toggles the folder. setSelection
    // does NOT reveal/scroll, so clicking a visible row leaves the scroll position exactly where it is.
    workspaceSet.active.tree.setSelection(rowIndex);
    workspaceSet.active.activate();
  };

  update();

  return {
    update,
    editorViewportHeight,
    editorViewportWidth,
    tickDragAutoScroll,
    // Frame-loop hook (runs every frame with FRESH layout, unlike the reactive paint): advance the diff's
    // momentum glide AND repaint the diff once its container has laid out to full height (root height goes
    // 0 -> real a frame or two after the container swap). Repaint-on-height-change keeps frames live until
    // the layout settles, then stops (returns momentum-moving) so idle-quiescence holds.
    tickDiffMomentum(dtSeconds: number): boolean {
      if (!activeDiffView) return false;
      let live = activeDiffView.tickScrollMomentum(dtSeconds);
      const laidHeight = Number(activeDiffView.rootRenderable.height) || 0;
      if (laidHeight !== lastDiffLaidHeight) {
        lastDiffLaidHeight = laidHeight;
        activeDiffView.update(); // now at the real height -> renders the full window
        live = true; // keep frames coming until the height stabilizes
      }
      return live;
    },
    tickMarkdownPreview(dtSeconds: number): boolean {
      return activeMarkdownSplitView?.tick(dtSeconds) ?? false;
    },
    activeDiffView: () => activeDiffView,
    activeMarkdownSplitView: () => activeMarkdownSplitView,
    findTarget,
    shortcutHelpViewportRows,
    dispose() {
      try {
        activeMarkdownSplitView?.dispose();
        activeDiffView?.dispose();
        root.remove(column);
        column.destroyRecursively();
      } catch {
        /* ignore */
      }
    },
  };
}

// invariant: Construction goes through overridable seams (project.invariants.md)
class $RootView {
  static buildRootView = $buildRootView;
}

export namespace RootView {
  export const $Class = $RootView;
  export const Class = Static($RootView);
}
