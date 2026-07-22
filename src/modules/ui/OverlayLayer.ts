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
  private readonly tooltipText: HitTransparentText;

  constructor(private readonly deps: OverlayLayerDeps) {
    const { renderer, shortcutHelp, contextMenu } = deps;
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

    // Tooltip — display-only + hit-transparent.
    this.tooltipText = new HitTransparentText(renderer, {
      id: 'tooltip', content: '', position: 'absolute', visible: false, zIndex: 140, selectable: false,
    });
    root.add(this.tooltipText);
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

    // Find/replace bar overlay.
    this.findBarBox.visible = findBar.open.value;
    if (findBar.open.value) {
      const engine = findBar.engine;
      const replaceMode = findBar.mode.value === 'replace';
      const queryFocused = !(replaceMode && findBar.replaceFocused.value);
      const count = engine ? engine.matchCount : 0;
      const position = engine && engine.currentMatchIndex.value >= 0 ? engine.currentMatchIndex.value + 1 : 0;
      const counter = count > 0 ? `${position} of ${count}` : engine && engine.query.value ? 'no results' : '';
      this.findBarBox.title = replaceMode ? 'Find / Replace' : 'Find';
      this.findBarBox.borderColor = palette.borderActive;
      this.findBarBox.titleColor = palette.accent;
      this.findBarBox.backgroundColor = palette.panel;
      const lines: string[] = [];
      lines.push(`⌕ ${engine?.query.value ?? ''}${queryFocused ? '▏' : ''}   ${counter}`);
      if (replaceMode) lines.push(`⇄ ${engine?.replacement.value ?? ''}${queryFocused ? '' : '▏'}`);
      lines.push(replaceMode ? '↵ next · ⇧↵ prev · ⌃↵ replace · ⌃⇧↵ all · ⇥ field · esc' : '↵ next · ⇧↵ prev · esc close');
      this.findBarText.content = lines.join('\n');
      this.findBarText.fg = palette.fg;
    }

    // Quick-open (Ctrl+P) overlay.
    this.quickOpenBox.visible = quickOpen.open.value;
    if (quickOpen.open.value) {
      const openingWorkspace = quickOpen.mode.value === 'workspacePath';
      this.quickOpenBox.title = openingWorkspace ? 'Open Project Folder' : 'Go to File';
      this.quickOpenBox.borderColor = palette.borderActive;
      this.quickOpenBox.titleColor = palette.accent;
      this.quickOpenBox.backgroundColor = palette.panel;
      this.quickOpenInput.content = `${openingWorkspace ? '+' : theme.actionIcons.open} ${quickOpen.query.value}▏`;
      this.quickOpenInput.fg = palette.fg;
      const matches = quickOpen.matches.value.slice(0, 14);
      const selectedIndex = quickOpen.selectedIndex.value;
      this.quickOpenList.content = openingWorkspace
        ? quickOpen.errorMessage.value
          ? `  ${quickOpen.errorMessage.value}\n  Enter opens · Esc cancels`
          : '  Type an existing folder path\n  Enter opens · Esc cancels'
        : matches.length
          ? matches.map((match, index) => `${index === selectedIndex ? '›' : ' '} ${match.path}`).join('\n')
          : quickOpen.query.value
            ? '  (no matching files)'
            : '  (type to filter project files)';
      this.quickOpenList.fg = palette.dim;
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

    // Settings panel overlay.
    this.settingsBox.visible = settingsPanel.open.value;
    if (settingsPanel.open.value) {
      this.settingsBox.borderColor = palette.accent;
      this.settingsBox.titleColor = palette.accent;
      this.settingsBox.backgroundColor = palette.panel;
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
      this.settingsText.content = new StyledText(settingsChunks);
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
