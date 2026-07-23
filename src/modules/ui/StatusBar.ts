// The status bar: a controller that OWNS its renderables (the bar box, the status text, and the
// clickable `?` shortcut-help button) plus the button's hover state and handlers. Extracted from
// RootView's closure as the first pane CONTROLLER (not just a renderer) — RootView constructs it,
// mounts `bar` into the layout column, and calls update() each frame.
//
// This is the Tooltip idiom (a Reactive class holding plain non-reactive fields) applied to a pane:
// the renderables and hover flag are plain fields; the class is instantiated `new StatusBar.Class(deps)`.
//
// invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import type { Palette } from '../theme/ThemePalettes';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { App } from '../app/App';
import type { ShortcutHelp } from './ShortcutHelp';
import type { OverlayCoordinator } from './OverlayCoordinator';
import type { KeybindingRegistry } from '../keybindings/KeybindingRegistry';
import type { Tooltip } from './Tooltip';
import type { Theme } from '../theme/Theme';
import type { SettingsPanel } from '../settings/SettingsPanel';

export interface StatusBarDeps {
  renderer: CliRenderer;
  workspaceSet: WorkspaceSet.Instance;
  app: App.Instance;
  shortcutHelp: ShortcutHelp.Instance;
  overlayCoordinator: OverlayCoordinator.Instance;
  keybindings: KeybindingRegistry.Instance;
  tooltip: Tooltip.Instance;
  /** For the settings (gear) glyph at the current glyph tier. */
  theme: Theme.Instance;
  /** The settings panel the gear button toggles (mirrors the shortcutHelp dep the `?` button uses). */
  settingsPanel: SettingsPanel.Instance;
}

class $StatusBar {
  /** The status-bar box; RootView mounts this into the layout column. */
  readonly bar: BoxRenderable;
  private readonly statusText: TextRenderable;
  private readonly shortcutHelpButton: TextRenderable;
  private readonly settingsButton: TextRenderable;
  private readonly clock: TextRenderable;
  private hover = false;
  private settingsHover = false;
  // The clock's single re-armed minute-boundary timer (NOT a per-second interval): the only periodic
  // wake at rest, once/min, so it forces the demand-driven loop to repaint the new minute without
  // turning idle into a busy loop.
  private clockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: StatusBarDeps) {
    const { renderer } = deps;
    this.bar = new BoxRenderable(renderer, {
      id: 'status-bar',
      width: '100%',
      height: 1,
      flexDirection: 'row',
    });
    this.statusText = new TextRenderable(renderer, { id: 'status-text', content: '' });
    this.bar.add(this.statusText);
    // Clickable shortcut-help affordance: a real hit-tested `?` cell span pinned to the RIGHT end of
    // the status bar (the spacer's flexGrow pushes it there). Click toggles the cheat-sheet through
    // the exclusive-overlay coordinator; hover shows a tooltip with the bound open chord.
    const spacer = new BoxRenderable(renderer, { id: 'status-spacer', flexGrow: 1, height: 1 });
    // Minute clock (HH:MM, local), left of the gear/`?` cluster at the right end. Display only.
    this.clock = new TextRenderable(renderer, {
      id: 'status-clock',
      content: ` ${this.formatClock()} `,
      height: 1,
      selectable: false,
    });
    // Settings (gear) affordance: a hit-tested single-cell glyph pinned to the right end, LEFT of the
    // `?` button. Click toggles the settings panel through the exclusive-overlay coordinator (the same
    // way `?` toggles the cheat-sheet); hover shows a tooltip with the bound open chord.
    this.settingsButton = new TextRenderable(renderer, {
      id: 'status-settings-button',
      content: ` ${deps.theme.settingsIcon} `,
      width: 3,
      height: 1,
      selectable: false,
    });
    this.shortcutHelpButton = new TextRenderable(renderer, {
      id: 'status-help-button',
      content: ' ? ',
      width: 3,
      height: 1,
      selectable: false, // a click must only toggle the sheet, never start a text selection
    });
    this.bar.add(spacer);
    this.bar.add(this.clock);
    this.bar.add(this.settingsButton);
    this.bar.add(this.shortcutHelpButton);
    // Arm the minute-boundary repaint and tear it down with the app (no leak past quit).
    this.scheduleClockTick();
    deps.app.onDispose(() => { if (this.clockTimer) clearTimeout(this.clockTimer); });
    this.settingsButton.onMouseDown = () => {
      this.toggleSettings();
      renderer.requestRender();
    };
    this.settingsButton.onMouseMove = (event) => {
      if (!this.settingsHover) {
        this.settingsHover = true;
        renderer.requestRender();
      }
      const openChordHint = deps.keybindings.bindingHint('settings.toggle', 'global');
      deps.tooltip.point(`Settings${openChordHint ? ` (${openChordHint})` : ''}`, event.x, event.y);
    };
    this.settingsButton.onMouseOut = () => {
      if (this.settingsHover) {
        this.settingsHover = false;
        renderer.requestRender();
      }
      deps.tooltip.clear();
    };
    this.shortcutHelpButton.onMouseDown = () => {
      this.toggle();
      renderer.requestRender();
    };
    this.shortcutHelpButton.onMouseMove = (event) => {
      if (!this.hover) {
        this.hover = true;
        renderer.requestRender();
      }
      const openChordHint = deps.keybindings.bindingHint('help.shortcuts', 'global');
      deps.tooltip.point(
        `Keyboard shortcuts${openChordHint ? ` (${openChordHint})` : ''}`,
        event.x,
        event.y,
      );
    };
    this.shortcutHelpButton.onMouseOut = () => {
      if (this.hover) {
        this.hover = false;
        renderer.requestRender();
      }
      deps.tooltip.clear();
    };
  }

  private toggle(): void {
    const { shortcutHelp, overlayCoordinator } = this.deps;
    if (shortcutHelp.open.value) shortcutHelp.close();
    else overlayCoordinator.openExclusiveOverlay('shortcutHelp', () => shortcutHelp.show());
  }

  /** Local time as HH:MM (minute granularity — never seconds; a seconds clock would repaint 60×/min). */
  private formatClock(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  /** Schedule ONE repaint at the next minute boundary, then re-arm. The +50ms guard lands safely past
   *  the boundary; unref() so the timer never blocks process exit (the renderer owns the event loop). */
  private scheduleClockTick(): void {
    const millisecondsToNextMinute = 60_000 - (Date.now() % 60_000) + 50;
    this.clockTimer = setTimeout(() => {
      this.clock.content = ` ${this.formatClock()} `;
      this.deps.renderer.requestRender();
      this.scheduleClockTick();
    }, millisecondsToNextMinute);
    (this.clockTimer as { unref?: () => void }).unref?.();
  }

  private toggleSettings(): void {
    const { settingsPanel, overlayCoordinator } = this.deps;
    if (settingsPanel.open.value) settingsPanel.close();
    else overlayCoordinator.openExclusiveOverlay('settingsPanel', () => settingsPanel.toggle());
  }

  private renderStatus(markdownPreviewFocused: boolean): string {
    const { workspaceSet, app } = this.deps;
    const editor = workspaceSet.active.editor;
    const parts: string[] = [` ${workspaceSet.active.name.value || '—'}`];
    if (editor.hasDocument.value) {
      parts.push(editor.title);
      parts.push(`Ln ${editor.cursor.line.value + 1}, Col ${editor.cursor.col.value + 1}`);
      parts.push(`${editor.document.lineCount} lines`);
    }
    // Focus indicator only for the NON-default panes; editing the source is the implicit state, so no
    // ever-present '[Editor Source]' label (it read as noise — it never told you anything new).
    const focusLabel =
      workspaceSet.active.focus.value === 'files'
        ? '[Files]'
        : markdownPreviewFocused
          ? '[Markdown Preview]'
          : null;
    if (focusLabel) parts.push(focusLabel);
    if (workspaceSet.active.focus.value === 'git')
      parts.push('checkbox/Space stage · row/o open · d discard');
    if (app.copyNotice.value) parts.push(app.copyNotice.value);
    parts.push(app.quitChordArmed.value ? 'Ctrl+X armed — Ctrl+C quits' : 'Ctrl+Q/F10 quit');
    return parts.join('  ·  ');
  }

  /** Re-sync the bar from the model each frame. `markdownPreviewFocused` is composer state RootView owns. */
  update(palette: Palette, markdownPreviewFocused: boolean): void {
    this.bar.backgroundColor = palette.statusBg;
    this.statusText.content = this.renderStatus(markdownPreviewFocused);
    this.statusText.fg = palette.dim;
    // The `?` help affordance brightens on hover and while its sheet is open.
    this.shortcutHelpButton.fg =
      this.hover || this.deps.shortcutHelp.open.value ? palette.accent : palette.dim;
    // The gear affordance mirrors it: current-tier glyph, brightening on hover / while settings is open.
    this.settingsButton.content = ` ${this.deps.theme.settingsIcon} `;
    this.settingsButton.fg =
      this.settingsHover || this.deps.settingsPanel.open.value ? palette.accent : palette.dim;
    // The clock (display only) refreshes on every repaint so it is correct after any wake; the
    // minute timer guarantees the wake at the boundary even while otherwise idle.
    this.clock.content = ` ${this.formatClock()} `;
    this.clock.fg = palette.dim;
  }
}

export namespace StatusBar {
  export const $Class = $StatusBar;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
