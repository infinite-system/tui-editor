// The VS-Code-style ACTIVITY BAR: a ~4-column vertical view-switcher pinned to the far left of the
// layout. One 4×2-cell button per view (a terminal cell is ~1:2 w:h, so 4w×2h reads visually square):
// a single centred glyph, a left accent bar `▎` on the ACTIVE item, an optional corner badge digit
// (git change count), and a hover tooltip carrying the view's name + its shortcut.
//
// This is a pane CONTROLLER in the StatusBar idiom — a Reactive class holding plain non-reactive
// renderable/hover fields: RootView constructs it, mounts `bar` at the far-left of the main row, and
// calls update() each frame. It OWNS no active-view state: the active view is Workspace.sidebarView
// (one ref per workspace, so exactly one item is active), which its click/keys switch through the
// single writer Workspace.showSidebarView. The bar only PROJECTS that state and routes the gesture.
//
// invariant: The active activity item determines the sidebar content (src/modules/ui/ui.invariants.md)
import { BoxRenderable, TextRenderable, StyledText, fg, type TextChunk, type CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import type { Palette } from '../theme/ThemePalettes';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { SidebarView } from '../workspace/Workspace';
import type { Theme } from '../theme/Theme';
import type { Tooltip } from './Tooltip';
import type { KeybindingRegistry } from '../keybindings/KeybindingRegistry';

/** One activity item: the view it switches to, its full name (tooltip), the keybinding action whose
 *  effective chord the tooltip advertises, and which glyph-table entry draws it. */
interface ActivityItem {
  view: SidebarView;
  label: string;
  action: string;
  glyph: (icons: Theme.Instance['activityIcons']) => string;
}

/** The bar's items, top to bottom (VS Code order: Explorer, Source Control, Extensions). */
const ACTIVITY_ITEMS: ActivityItem[] = [
  { view: 'files', label: 'Explorer', action: 'view.showFiles', glyph: (icons) => icons.files },
  { view: 'git', label: 'Source Control', action: 'view.showSourceControl', glyph: (icons) => icons.sourceControl },
  { view: 'extensions', label: 'Extensions', action: 'view.showExtensions', glyph: (icons) => icons.extensions },
];

/** Each button is 4 columns wide and 2 rows tall. */
const BUTTON_WIDTH = 4;
const BUTTON_ROWS = 2;

export interface ActivityBarDeps {
  renderer: CliRenderer;
  workspaceSet: WorkspaceSet.Instance;
  theme: Theme.Instance;
  tooltip: Tooltip.Instance;
  keybindings: KeybindingRegistry.Instance;
}

class $ActivityBar {
  /** The activity-bar box; RootView mounts this at the far-left of the main row. */
  readonly bar: BoxRenderable;
  private readonly body: TextRenderable;
  /** View-only hover state (which item the pointer rests on), plain field like StatusBar.hover. */
  private hoveredItemIndex = -1;

  constructor(private readonly deps: ActivityBarDeps) {
    const { renderer } = deps;
    this.bar = new BoxRenderable(renderer, {
      id: 'activity-bar',
      width: BUTTON_WIDTH,
      height: '100%',
      flexShrink: 0, // never let flex squeeze the 4-col bar away
      flexDirection: 'column',
    });
    this.body = new TextRenderable(renderer, {
      id: 'activity-bar-body',
      content: '',
      width: BUTTON_WIDTH,
      height: '100%',
      wrapMode: 'none',
      selectable: false, // a click only switches views, never starts a text selection
    });
    this.bar.add(this.body);
    this.wireHandlers();
  }

  /** The activity item under a screen row, or null (empty space below the last button). */
  private itemAtRow(screenY: number): { index: number; item: ActivityItem } | null {
    const index = Math.floor((screenY - this.bar.y) / BUTTON_ROWS);
    const item = ACTIVITY_ITEMS[index];
    return index >= 0 && item ? { index, item } : null;
  }

  private wireHandlers(): void {
    const { renderer, workspaceSet, tooltip, keybindings } = this.deps;

    this.bar.onMouseDown = (event) => {
      const hit = this.itemAtRow(event.y);
      if (!hit) return;
      // Switch through the single writer — the same path the Ctrl+Shift+E/G/X chords take.
      workspaceSet.active.showSidebarView(hit.item.view);
      tooltip.clear();
      renderer.requestRender();
    };

    this.bar.onMouseMove = (event) => {
      const hit = this.itemAtRow(event.y);
      const nextHovered = hit ? hit.index : -1;
      if (nextHovered !== this.hoveredItemIndex) {
        this.hoveredItemIndex = nextHovered;
        renderer.requestRender();
      }
      if (hit) {
        // Tooltip = full name + the view's EFFECTIVE shortcut, so the bar teaches its own keys.
        const chordHint = keybindings.bindingHint(hit.item.action, 'global');
        tooltip.point(chordHint ? `${hit.item.label} (${chordHint})` : hit.item.label, event.x, event.y);
      } else {
        tooltip.clear();
      }
    };

    this.bar.onMouseOut = () => {
      if (this.hoveredItemIndex !== -1) {
        this.hoveredItemIndex = -1;
        renderer.requestRender();
      }
      tooltip.clear();
    };
  }

  /** The git working-tree change count for the Source Control badge (0 hides the badge). */
  private gitChangedCount(): number {
    const repository = this.deps.workspaceSet.active.git.value;
    if (!repository) return 0;
    return repository.staged.value.length + repository.unstaged.value.length + repository.untracked.value.length;
  }

  /** Re-sync the bar from model state each frame. Realizes *Renderables hold no model state*: it
   *  reads sidebarView / git / theme / hover and writes only presentation. */
  update(palette: Palette): void {
    this.bar.backgroundColor = palette.panel;

    const icons = this.deps.theme.activityIcons;
    const activeView = this.deps.workspaceSet.active.sidebarView.value;
    const changedCount = this.gitChangedCount();

    const chunks: TextChunk[] = [];
    ACTIVITY_ITEMS.forEach((item, index) => {
      const isActive = activeView === item.view;
      const isHovered = this.hoveredItemIndex === index;
      const glyphColor = isActive ? palette.accent : isHovered ? palette.fg : palette.dim;
      // Top row (4 cols): ONLY the count/flag badge, at col 1 (one cell in from the edge) so it reads a
      // bit closer to the icon below — which is centred at col 2 — rather than jammed against the left
      // edge. Layout [pad][badge][pad][pad] = 4 cols. A placeholder row ABOVE the icon; today only
      // Source Control fills it (the working-tree change count).
      const badge = item.view === 'git' && changedCount > 0 ? (changedCount > 9 ? '+' : String(changedCount)) : ' ';
      chunks.push(fg(palette.fg)(' '));
      chunks.push(fg(palette.accent)(badge));
      chunks.push(fg(palette.fg)('  '));
      chunks.push(fg(palette.fg)('\n'));
      // Bottom row (4 cols): the active-item accent bar and the ICON on the SAME row (aligned) — accent
      // at the left edge (col 0, one cell per active item), then ` icon `. The accent reads as the
      // selection highlight for the icon, at the icon's level.
      chunks.push(fg(palette.accent)(isActive ? icons.accentBar : ' '));
      chunks.push(fg(glyphColor)(` ${item.glyph(icons)} `));
      if (index < ACTIVITY_ITEMS.length - 1) chunks.push(fg(palette.fg)('\n'));
    });
    this.body.content = new StyledText(chunks);
  }

  /** Show or hide the bar (the View: Toggle Activity Bar command). Collapsing the width to 0 returns
   *  the 4 columns to the sidebar/editor so hiding it truly reclaims the space, not just blanks it. */
  setVisible(visible: boolean): void {
    this.bar.visible = visible;
    this.bar.width = visible ? BUTTON_WIDTH : 0;
  }
}

export namespace ActivityBar {
  export const $Class = $ActivityBar;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
