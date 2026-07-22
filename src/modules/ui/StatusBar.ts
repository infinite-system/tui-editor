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

export interface StatusBarDeps {
  renderer: CliRenderer;
  workspaceSet: WorkspaceSet.Instance;
  app: App.Instance;
  shortcutHelp: ShortcutHelp.Instance;
  overlayCoordinator: OverlayCoordinator.Instance;
  keybindings: KeybindingRegistry.Instance;
  tooltip: Tooltip.Instance;
}

class $StatusBar {
  /** The status-bar box; RootView mounts this into the layout column. */
  readonly bar: BoxRenderable;
  private readonly statusText: TextRenderable;
  private readonly shortcutHelpButton: TextRenderable;
  private hover = false;

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
    this.shortcutHelpButton = new TextRenderable(renderer, {
      id: 'status-help-button',
      content: ' ? ',
      width: 3,
      height: 1,
      selectable: false, // a click must only toggle the sheet, never start a text selection
    });
    this.bar.add(spacer);
    this.bar.add(this.shortcutHelpButton);
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

  private renderStatus(markdownPreviewFocused: boolean): string {
    const { workspaceSet, app } = this.deps;
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
        : markdownPreviewFocused
          ? '[Markdown Preview]'
          : '[Editor Source]',
    );
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
  }
}

export namespace StatusBar {
  export const $Class = $StatusBar;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
