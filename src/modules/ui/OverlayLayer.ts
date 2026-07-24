// The overlay layer: constructs and drives every modal/floating overlay that renders above the panes —
// the command palette, the find/replace bar, quick-open, the discard/close confirmation, the settings
// panel, the shortcut cheat-sheet (+ its modal backdrop), the context menu (+ its backdrop), and the
// tooltip. Each is a top-level absolute renderable projected from its own model every paint; RootView
// calls update(palette) once per frame and mount() at construction.
//
// invariant: Input overlays share one modal slot (src/modules/ui/ui.invariants.md)
// invariant: A context menu is modal and single-consumer (src/modules/ui/ui.invariants.md)
// invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
// invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
// invariant: Destructive working-tree operations require confirmation (src/modules/git/git.invariants.md)
import { BoxRenderable, TextRenderable, StyledText, fg, bg, bold, type TextChunk, type CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import { HitTransparentText } from './HitTransparentText';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Files } from '../system/Files';
import { QuickOpenRenderer } from './QuickOpenRenderer';
import { FindBarRenderer, type FindBarButtonZone, type FindBarButtonAction } from './FindBarRenderer';
import type { Palette } from '../theme/ThemePalettes';
import type { CommandRegistry } from '../commands/CommandRegistry';
import type { FindBar } from '../search/FindBar';
import type { QuickOpen } from '../search/QuickOpen';
import type { ContextMenu } from './ContextMenu';
import type { SettingsPanel } from '../settings/SettingsPanel';
import type { ShortcutHelp } from './ShortcutHelp';
import type { Tooltip } from './Tooltip';
import type { Theme } from '../theme/Theme';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';

/** A clickable settings widget: the text row + column range it occupies, the descriptor it edits, and
 *  what a click does. `select` just selects the row; `dec`/`inc` select then step/cycle/toggle it. */
interface SettingsWidgetZone {
  row: number;
  startColumn: number;
  endColumn: number;
  index: number;
  action: 'select' | 'dec' | 'inc';
}

export interface OverlayLayerDeps {
  renderer: CliRenderer;
  commands: CommandRegistry.Instance;
  findBar: FindBar.Instance;
  quickOpen: QuickOpen.Instance;
  contextMenu: ContextMenu.Instance;
  settingsPanel: SettingsPanel.Instance;
  shortcutHelp: ShortcutHelp.Instance;
  tooltip: Tooltip.Instance;
  theme: Theme.Instance;
  workspaceSet: WorkspaceSet.Instance;
  /** Activate the current quick-open selection (open the file / project folder + close the modal) — the
   *  SAME path the Enter key runs, so a click and Enter never diverge. */
  activateQuickOpen: () => void;
  /** Reveal the find bar's current match through the bound pane (the sole scroll/selection writer). */
  revealFindMatch: () => void;
}

class $OverlayLayer {
  private readonly commandPalette: BoxRenderable;
  private readonly commandPaletteInput: TextRenderable;
  private readonly commandPaletteList: TextRenderable;
  private readonly findBarBox: BoxRenderable;
  private readonly findBarText: TextRenderable;
  private readonly quickOpenBox: BoxRenderable;
  private readonly quickOpenInput: TextRenderable;
  private readonly quickOpenList: TextRenderable;
  private readonly confirmBox: BoxRenderable;
  private readonly confirmText: TextRenderable;
  private readonly settingsBox: BoxRenderable;
  private readonly settingsText: TextRenderable;
  private readonly shortcutHelpBackdrop: BoxRenderable;
  private readonly shortcutHelpBox: BoxRenderable;
  private readonly shortcutHelpText: TextRenderable;
  private readonly contextMenuBackdrop: BoxRenderable;
  private readonly contextMenuBox: BoxRenderable;
  private readonly contextMenuList: TextRenderable;
  private readonly tooltipText: HitTransparentText.Model;

  // Hit geometry the renderers drew this frame, read by the pointer handlers so a drawn cell and its
  // hit-rect never disagree (the one-geometry-source rule). Written in update(), read on mouse events.
  private findBarButtonZones: FindBarButtonZone[] = [];
  // Clickable widget zones the settings renderer drew this frame (one-geometry-source): each maps a
  // (row, column-range) to a descriptor index + an action, so a mouse click edits the setting like a UI
  // app — steppers for numbers, a toggle for booleans, arrows for enums.
  private settingsWidgetZones: SettingsWidgetZone[] = [];
  private quickOpenRowCount = 0;
  // The model index of the first row the quick-open list currently draws (its scroll window's top), so a
  // pointer hit-test maps a visible row back to the match it draws. 0 whenever the list is unscrolled.
  private quickOpenFirstVisible = 0;

  constructor(private readonly deps: OverlayLayerDeps) {
    const { renderer, shortcutHelp, contextMenu, quickOpen } = deps;
    const root = renderer.root;

    // Command palette — added last so it renders on top; shown only when open.
    this.commandPalette = new BoxRenderable(renderer, {
      id: 'palette', position: 'absolute', left: '20%', top: 2, width: '60%', border: true,
      borderStyle: 'rounded', title: 'Command Palette', flexDirection: 'column', visible: false, zIndex: 100,
    });
    this.commandPaletteInput = new TextRenderable(renderer, { id: 'palette-input', content: '' });
    this.commandPaletteList = new TextRenderable(renderer, { id: 'palette-list', content: '' });
    this.commandPalette.add(this.commandPaletteInput);
    this.commandPalette.add(this.commandPaletteList);
    root.add(this.commandPalette);

    // In-editor find/replace bar (Ctrl+F / Ctrl+H) — top-right overlay.
    this.findBarBox = new BoxRenderable(renderer, {
      id: 'find-bar', position: 'absolute', top: 1, left: '45%', width: '54%', border: true,
      borderStyle: 'rounded', title: 'Find', flexDirection: 'column', visible: false, zIndex: 100,
    });
    this.findBarText = new TextRenderable(renderer, { id: 'find-bar-text', content: '' });
    this.findBarBox.add(this.findBarText);
    root.add(this.findBarBox);

    // Quick-open (Ctrl+P): centered modal — query input + fuzzy-ranked project-file list.
    this.quickOpenBox = new BoxRenderable(renderer, {
      id: 'quick-open', position: 'absolute', left: '20%', top: 2, width: '60%', border: true,
      borderStyle: 'rounded', title: 'Go to File', flexDirection: 'column', visible: false, zIndex: 100,
    });
    this.quickOpenInput = new TextRenderable(renderer, { id: 'quick-open-input', content: '' });
    this.quickOpenList = new TextRenderable(renderer, { id: 'quick-open-list', content: '' });
    this.quickOpenBox.add(this.quickOpenInput);
    this.quickOpenBox.add(this.quickOpenList);
    root.add(this.quickOpenBox);

    // Destructive-action confirmation (discard / close-dirty-tab) — a small modal strip.
    this.confirmBox = new BoxRenderable(renderer, {
      id: 'confirm-discard', position: 'absolute', left: '20%', top: 4, width: '60%', border: true,
      borderStyle: 'rounded', title: 'Confirm', visible: false, zIndex: 120,
    });
    this.confirmText = new TextRenderable(renderer, { id: 'confirm-discard-text', content: '' });
    this.confirmBox.add(this.confirmText);
    root.add(this.confirmBox);

    // Settings panel (Ctrl+,) — overlay over the reactive settings store.
    this.settingsBox = new BoxRenderable(renderer, {
      id: 'settings-panel', position: 'absolute', left: '15%', top: 2, width: '70%', border: true,
      borderStyle: 'rounded', title: 'Settings', visible: false, zIndex: 122,
    });
    this.settingsText = new TextRenderable(renderer, { id: 'settings-panel-text', content: '' });
    this.settingsBox.add(this.settingsText);
    root.add(this.settingsBox);

    // Shortcut cheat-sheet (Shift+F1 / status-bar `?`) + invisible modal backdrop.
    this.shortcutHelpBackdrop = new BoxRenderable(renderer, {
      id: 'shortcut-help-backdrop', position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
      visible: false, zIndex: 118,
    });
    this.shortcutHelpBox = new BoxRenderable(renderer, {
      id: 'shortcut-help', position: 'absolute', left: '15%', top: 1, width: '70%', border: true,
      borderStyle: 'rounded', title: 'Keyboard Shortcuts', flexDirection: 'column', visible: false, zIndex: 120,
    });
    this.shortcutHelpText = new TextRenderable(renderer, { id: 'shortcut-help-text', content: '', selectable: false });
    this.shortcutHelpBox.add(this.shortcutHelpText);
    root.add(this.shortcutHelpBackdrop);
    root.add(this.shortcutHelpBox);
    this.shortcutHelpBackdrop.onMouseDown = () => shortcutHelp.close();

    // Context-menu modal layer (menu box + invisible full-screen backdrop beneath it).
    this.contextMenuBackdrop = new BoxRenderable(renderer, {
      id: 'context-menu-backdrop', position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
      visible: false, zIndex: 125,
    });
    this.contextMenuBox = new BoxRenderable(renderer, {
      id: 'context-menu', position: 'absolute', border: true, borderStyle: 'rounded', visible: false, zIndex: 130,
    });
    this.contextMenuList = new TextRenderable(renderer, { id: 'context-menu-list', content: '', selectable: false });
    this.contextMenuBox.add(this.contextMenuList);
    root.add(this.contextMenuBackdrop);
    root.add(this.contextMenuBox);
    this.contextMenuBackdrop.onMouseDown = () => contextMenu.close();
    const contextMenuItemAt = (screenY: number): number => screenY - (this.contextMenuBox.y + 1);
    this.contextMenuBox.onMouseMove = (event) => contextMenu.hover(contextMenuItemAt(event.y));
    this.contextMenuBox.onMouseOut = () => contextMenu.hover(-1);
    this.contextMenuBox.onMouseDown = (event) => contextMenu.runAt(contextMenuItemAt(event.y));

    // Quick-open results: hover highlights a row, click selects+opens it. The list scrolls a window over
    // the matches, so a pointer row is the offset from the list's own top PLUS the window's first-visible
    // model index — mapping the visible row back to the match it actually draws.
    // invariant: Search results are click-set and highlight-shown (src/modules/search/search.invariants.md)
    // invariant: The selected quick-open row is always visible (src/modules/search/search.invariants.md)
    const quickOpenRowAt = (screenY: number): number => screenY - this.quickOpenList.y;
    const quickOpenMatchAt = (row: number): number => this.quickOpenFirstVisible + row;
    this.quickOpenList.onMouseMove = (event) => {
      const row = quickOpenRowAt(event.y);
      quickOpen.setHoveredIndex(row >= 0 && row < this.quickOpenRowCount ? quickOpenMatchAt(row) : -1);
    };
    this.quickOpenList.onMouseOut = () => quickOpen.setHoveredIndex(-1);
    this.quickOpenList.onMouseDown = (event) => {
      const row = quickOpenRowAt(event.y);
      if (row < 0 || row >= this.quickOpenRowCount) return;
      quickOpen.setSelectedIndex(quickOpenMatchAt(row));
      // Files mode: a click opens the file. Path-navigator mode: a click DRILLS INTO the folder
      // (completes the path + re-lists); Enter opens the current path (activateQuickOpen).
      if (quickOpen.mode.value === 'workspacePath') quickOpen.navigateIntoSelected();
      else this.deps.activateQuickOpen();
    };

    // Find bar action buttons: hit-test the pointer against the zones the renderer drew this frame.
    // invariant: Find bar controls are mouse-clickable buttons (src/modules/search/search.invariants.md)
    this.findBarText.onMouseDown = (event) => {
      const localRow = event.y - this.findBarText.y;
      const localColumn = event.x - this.findBarText.x;
      const button = this.findBarButtonZones.find(
        (zone) => zone.row === localRow && localColumn >= zone.startColumn && localColumn < zone.endColumn,
      );
      if (button) this.runFindButton(button.action);
    };

    // Settings are editable by MOUSE, not just keyboard: click a row's label to select it, its [−]/[+]
    // steppers to change a number, its arrows to cycle an enum, or its toggle to flip a boolean. Hit-test
    // the pointer against the widget zones the renderer drew THIS frame (one geometry source).
    // invariant: Settings are editable by mouse per widget kind (src/modules/ui/ui.invariants.md)
    this.settingsText.onMouseDown = (event) => {
      const localRow = event.y - this.settingsText.y;
      const localColumn = event.x - this.settingsText.x;
      const zone = this.settingsWidgetZones.find(
        (candidate) => candidate.row === localRow && localColumn >= candidate.startColumn && localColumn < candidate.endColumn,
      );
      if (!zone) return;
      this.deps.settingsPanel.select(zone.index);
      if (zone.action === 'dec') this.deps.settingsPanel.adjust(-1);
      else if (zone.action === 'inc') this.deps.settingsPanel.adjust(1);
      this.deps.renderer.requestRender();
    };

    // Tooltip — display-only + hit-transparent.
    this.tooltipText = new HitTransparentText.Class(renderer, {
      id: 'tooltip', content: '', position: 'absolute', visible: false, zIndex: 140, selectable: false,
    });
    root.add(this.tooltipText);
  }

  /** Dispatch a find-bar button click to the same FindBar action its keyboard chord runs. */
  private runFindButton(action: FindBarButtonAction): void {
    const { findBar, revealFindMatch } = this.deps;
    switch (action) {
      case 'previous':
        findBar.previous();
        revealFindMatch();
        break;
      case 'next':
        findBar.next();
        revealFindMatch();
        break;
      case 'toggleCase':
        findBar.toggleCaseSensitive();
        revealFindMatch();
        break;
      case 'replace':
        findBar.replaceCurrent();
        revealFindMatch();
        break;
      case 'replaceAll':
        findBar.replaceAll();
        revealFindMatch();
        break;
      case 'toggleMode':
        findBar.switchMode();
        break;
    }
  }

  private shortcutHelpBoxHeight(): number {
    return Math.max(6, this.deps.renderer.height - 3);
  }
  /** Visible rows in the cheat-sheet (box height minus borders + hint line); read by the scroll model. */
  shortcutHelpViewportRows(): number {
    return Math.max(1, this.shortcutHelpBoxHeight() - 3);
  }

  update(palette: Palette): void {
    const { commands, findBar, quickOpen, workspaceSet, settingsPanel, shortcutHelp, contextMenu, tooltip, theme, renderer } = this.deps;

    // Palette overlay.
    const open = commands.open.value;
    this.commandPalette.visible = open;
    if (open) {
      this.commandPalette.borderColor = palette.borderActive;
      this.commandPalette.titleColor = palette.accent;
      this.commandPalette.backgroundColor = palette.panel;
      this.commandPaletteInput.content = `> ${commands.query.value}▏`;
      this.commandPaletteInput.fg = palette.fg;
      const items = commands.filtered.slice(0, 12);
      const selectedIndex = commands.selectedIndex.value;
      this.commandPaletteList.content = items.length
        ? items.map((command, index) => `${index === selectedIndex ? '›' : ' '} ${command.title}`).join('\n')
        : '  (no matching commands)';
      this.commandPaletteList.fg = palette.dim;
    }

    // Find/replace bar overlay. The renderer draws the query/replacement lines plus the clickable
    // button row and hands back the button hit-zones the pointer handler reads.
    this.findBarBox.visible = findBar.open.value;
    if (findBar.open.value) {
      const replaceMode = findBar.mode.value === 'replace';
      this.findBarBox.title = replaceMode ? 'Find / Replace' : 'Find';
      this.findBarBox.borderColor = palette.borderActive;
      this.findBarBox.titleColor = palette.accent;
      this.findBarBox.backgroundColor = palette.panel;
      const findResult = FindBarRenderer.Class.render({ findBar, palette, findIcons: theme.findIcons });
      this.findBarText.content = findResult.text;
      this.findBarButtonZones = findResult.buttons;
    } else {
      this.findBarButtonZones = [];
    }

    // Quick-open (Ctrl+P) overlay.
    this.quickOpenBox.visible = quickOpen.open.value;
    if (quickOpen.open.value) {
      const openingWorkspace = quickOpen.mode.value === 'workspacePath';
      this.quickOpenBox.title = openingWorkspace ? 'Open Project Folder' : 'Go to File';
      this.quickOpenBox.borderColor = palette.borderActive;
      this.quickOpenBox.titleColor = palette.accent;
      this.quickOpenBox.backgroundColor = palette.panel;
      // In the path navigator, flag an un-openable current path with a live warning glyph (⚠ ladder,
      // theme warning colour) — a valid/openable path shows none.
      // invariant: An un-openable open-project path is flagged live (src/modules/search/search.invariants.md)
      const showPathAlert = openingWorkspace && !quickOpen.workspacePathOpenable.value;
      const inputPrefix = `${openingWorkspace ? '+' : theme.actionIcons.open} ${quickOpen.query.value}▏`;
      const inputChunks: TextChunk[] = [fg(palette.fg)(inputPrefix)];
      if (showPathAlert) inputChunks.push(fg(palette.warning)(`  ${theme.alertIcon}`));
      this.quickOpenInput.content = new StyledText(inputChunks);
      // The result list renders through the renderer: row-background selection/hover (no arrow marker),
      // and it reports the hit-testable row count for the pointer handler.
      const quickOpenResult = QuickOpenRenderer.Class.render({
        quickOpen,
        palette,
        innerWidth: Math.max(1, Math.floor((renderer.width * 0.6)) - 2),
        maxRows: 14,
      });
      this.quickOpenList.content = quickOpenResult.text;
      this.quickOpenRowCount = quickOpenResult.rowCount;
      this.quickOpenFirstVisible = quickOpenResult.firstVisible;
    } else {
      this.quickOpenRowCount = 0;
      this.quickOpenFirstVisible = 0;
    }

    // Confirmation overlay (discard changes / close a dirty tab).
    const pendingDiscard = workspaceSet.active.gitPanel.confirmDiscard.value;
    const pendingCloseTabIndex = workspaceSet.active.pendingCloseTabIndex.value;
    this.confirmBox.visible = pendingDiscard !== null || pendingCloseTabIndex >= 0;
    if (pendingDiscard) {
      this.confirmBox.borderColor = palette.deleted;
      this.confirmBox.titleColor = palette.deleted;
      this.confirmBox.backgroundColor = palette.panel;
      this.confirmText.content =
        pendingDiscard.paths.length === 1
          ? ` Discard changes to ${pendingDiscard.paths[0]}?  [y/N]`
          : ` Discard changes to ${pendingDiscard.paths.length} files (${pendingDiscard.paths.join(', ').slice(0, 60)}…)?  [y/N]`;
      this.confirmText.fg = palette.fg;
    } else if (pendingCloseTabIndex >= 0) {
      const tabPath = workspaceSet.active.buffers.tabs()[pendingCloseTabIndex]?.path ?? '';
      this.confirmBox.borderColor = palette.warning;
      this.confirmBox.titleColor = palette.warning;
      this.confirmBox.backgroundColor = palette.panel;
      this.confirmText.content = ` Close ${Files.Class.basename(tabPath)} with unsaved changes?  [y/N]`;
      this.confirmText.fg = palette.fg;
    }

    // Settings panel overlay — sectioned, with a clickable widget per row (steppers / toggle / arrows).
    this.settingsBox.visible = settingsPanel.open.value;
    if (settingsPanel.open.value) {
      this.settingsBox.borderColor = palette.accent;
      this.settingsBox.titleColor = palette.accent;
      this.settingsBox.backgroundColor = palette.panel;
      const settingsChunks: TextChunk[] = [];
      const zones: SettingsWidgetZone[] = [];
      let textRow = 0; // the current 0-based row within settingsText, tracked as newlines are emitted

      const emitLine = (chunk: TextChunk): void => {
        settingsChunks.push(chunk);
        textRow += 1; // each header/blank line carries exactly one trailing newline
      };
      emitLine(fg(palette.dim)('  up/down select · click [-]/[+], < >, or the toggle · Esc close (saved live)\n'));

      const settingsRows = settingsPanel.rows();
      const labelWidth = settingsRows.reduce((widest, row) => Math.max(widest, row.label.length), 0);
      let lastSection = '';
      for (const row of settingsRows) {
        if (row.section !== lastSection) {
          emitLine(fg(palette.dim)('\n')); // a blank spacer row before each section
          emitLine(bold(fg(palette.accent)(`  ${row.section}\n`)));
          lastSection = row.section;
        }
        // One setting row: [marker+label = the 'select' zone] then a per-kind widget. A running column
        // counter keeps every zone's hit-rect aligned with the exact cells drawn.
        let column = 0;
        const emit = (text: string, color: string, action?: SettingsWidgetZone['action']): void => {
          settingsChunks.push(row.selected ? bg(palette.selection)(fg(color)(text)) : fg(color)(text));
          if (action) zones.push({ row: textRow, startColumn: column, endColumn: column + text.length, index: row.index, action });
          column += text.length;
        };
        const marker = row.selected ? '›' : ' ';
        emit(` ${marker} ${row.label.padEnd(labelWidth, ' ')}   `, palette.fg, 'select');
        const value = row.valueText;
        // ASCII widget glyphs so a driving test can locate them in the framebuffer (box-drawing/unicode
        // is remapped to astral cells) and column math stays 1:1.
        if (row.kind === 'number') {
          emit('[-]', palette.accent, 'dec');
          emit(` ${value} `, palette.accent);
          emit('[+]', palette.accent, 'inc');
        } else if (row.kind === 'boolean') {
          emit(`[ ${value} ]`, palette.accent, 'inc'); // click toggles either way
        } else {
          emit('<', palette.accent, 'dec');
          emit(` ${value} `, palette.accent);
          emit('>', palette.accent, 'inc');
        }
        settingsChunks.push(fg(palette.fg)('\n'));
        textRow += 1;
      }
      this.settingsText.content = new StyledText(settingsChunks);
      this.settingsWidgetZones = zones;
    } else {
      this.settingsWidgetZones = [];
    }

    // Shortcut cheat-sheet overlay.
    this.shortcutHelpBackdrop.visible = shortcutHelp.open.value;
    this.shortcutHelpBox.visible = shortcutHelp.open.value;
    if (shortcutHelp.open.value) {
      this.shortcutHelpBox.height = this.shortcutHelpBoxHeight();
      this.shortcutHelpBox.borderColor = palette.borderActive;
      this.shortcutHelpBox.titleColor = palette.accent;
      this.shortcutHelpBox.backgroundColor = palette.panel;
      const sheetRows = shortcutHelp.rows();
      const sheetViewportRows = this.shortcutHelpViewportRows();
      const sheetMaximumScrollTop = Math.max(0, sheetRows.length - sheetViewportRows);
      const sheetScrollTop = Math.min(shortcutHelp.scrollTop.value, sheetMaximumScrollTop);
      const sheetVisibleRows = sheetRows.slice(sheetScrollTop, sheetScrollTop + sheetViewportRows);
      const chordColumnWidth = sheetRows.reduce((widestWidth, sheetRow) => Math.max(widestWidth, sheetRow.chordLabel.length), 0);
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
          sheetChunks.push(fg(palette.accent)(`   ${sheetRow.chordLabel.padEnd(chordColumnWidth, ' ')}`));
          sheetChunks.push(fg(palette.fg)(`  ${sheetRow.label}${lineBreak}`));
        }
      });
      this.shortcutHelpText.content = new StyledText(sheetChunks);
    }

    // Context menu overlay (+ modal backdrop).
    const menuOpen = contextMenu.open.value;
    this.contextMenuBackdrop.visible = menuOpen;
    this.contextMenuBox.visible = menuOpen;
    if (menuOpen) {
      this.contextMenuBox.left = contextMenu.anchorX.value;
      this.contextMenuBox.top = contextMenu.anchorY.value;
      this.contextMenuBox.width = contextMenu.width;
      this.contextMenuBox.height = contextMenu.height;
      this.contextMenuBox.backgroundColor = palette.panel;
      this.contextMenuBox.borderColor = palette.borderActive;
      const rowWidth = contextMenu.width - 2;
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
      this.contextMenuList.content = new StyledText(menuChunks);
    }

    // Tooltip overlay — display-only; clamped so it stays on screen.
    this.tooltipText.visible = tooltip.visible.value;
    if (tooltip.visible.value) {
      const tooltipLabel = ` ${tooltip.text.value} `;
      const tooltipWidth = EditorCoordinates.Class.lineWidth(tooltipLabel);
      const centeredLeft = tooltip.anchorX.value - Math.floor(tooltipWidth / 2);
      this.tooltipText.left = Math.max(0, Math.min(centeredLeft, renderer.width - tooltipWidth));
      const anchorY = tooltip.anchorY.value;
      const roomAbove = anchorY - 1 >= 0;
      const placeAbove = tooltip.placement.value === 'above' || (tooltip.placement.value === 'auto' && roomAbove);
      const desiredTop = placeAbove ? anchorY - 1 : anchorY + 1;
      this.tooltipText.top = Math.max(0, Math.min(desiredTop, renderer.height - 1));
      this.tooltipText.content = new StyledText([bg(palette.selection)(fg(palette.fg)(tooltipLabel))]);
    }
  }
}

export namespace OverlayLayer {
  export const $Class = $OverlayLayer;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
