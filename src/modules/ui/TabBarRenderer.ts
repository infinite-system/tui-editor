// The tab-strip renderers: the workspace/project tab bar (horizontal or vertical) and the buffer
// tab bar, each turning a TabStrip model + the current interaction state into a StyledText plus the
// hit-test SEGMENTS and the reveal bookkeeping. Extracted from RootView's closure so the tab strips
// render with their own contract (smoke-tabs, smoke-workspace-tabs) instead of inside the god-view.
//
// These paint interaction state (hover/pressed) and remember which tab they last auto-revealed, so
// the context carries that state IN and each render returns the fresh segments + revealed index OUT;
// RootView owns the persistent fields and the hit-testers (which read the returned segments). The
// renderer stays a pure Static capability — no closure capture, no state held here.
//
// invariant: Renderables hold no model state (src/modules/ui/ui.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import type { Palette } from '../theme/ThemePalettes';
import type { TabStrip } from './TabStrip';
import { Breadcrumb } from './Breadcrumb';

// Project name / branch on a workspace tab are capped so one long name cannot swallow the strip; the
// cut is marked with an ellipsis rather than a silent hard truncation.
const WORKSPACE_TAB_MAX_LABEL_WIDTH = 18;
function ellipsize(text: string, width: number): string {
  if (width <= 0) return '';
  if (EditorCoordinates.Class.lineWidth(text) <= width) return text.padEnd(width, ' ');
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

export type WorkspaceTabBarSegment = {
  kind: 'tab' | 'panBackward' | 'panForward' | 'add';
  workspaceIndex: number;
  primaryStart: number;
  primaryEnd: number;
  closePrimaryCoordinate?: number;
  closeCrossAxisCoordinate?: number;
};

export type WorkspaceTabBarHover =
  | { kind: 'tab' | 'close' | 'panBackward' | 'panForward' | 'add'; workspaceIndex: number }
  | null;

export type TabBarSegment =
  | { kind: 'tab'; index: number; start: number; end: number; closeColumn: number }
  | { kind: 'previewToggle' | 'arrowLeft' | 'arrowRight' | 'badge'; start: number; end: number };

export type TabBarHover =
  | { kind: 'tab' | 'close' | 'previewToggle' | 'arrowLeft' | 'arrowRight' | 'badge'; index: number }
  | null;

export interface WorkspaceTabBarRenderContext {
  strip: TabStrip.Instance;
  palette: Palette;
  hover: WorkspaceTabBarHover;
  /** The reveal index remembered across renders (in); the renderer returns the updated value (out). */
  lastRevealedIndex: number;
  /** Number(workspaceTabBar.width) — may be NaN when the renderable width is a percentage string. */
  barWidthValue: number;
  barHeightValue: number;
  rendererWidth: number;
  rendererHeight: number;
}

export interface BufferTabBarRenderContext {
  strip: TabStrip.Instance;
  palette: Palette;
  barWidth: number;
  /** Active workspace root — the breadcrumb renders each tab's path relative to it. */
  projectRoot: string;
  /** Tier-aware powerline separator glyph drawn between crumbs/tabs (nerd  → unicode ❯ → ascii >). */
  separatorGlyph: string;
  hover: TabBarHover;
  closePressed: number | null;
  previewPressed: boolean;
  arrowPressed: 'arrowLeft' | 'arrowRight' | null;
  lastRevealedIndex: number;
  activeFileIsMarkdown: boolean;
  showingMarkdownPreview: boolean;
  previewIcon: string;
}

export interface WorkspaceTabBarRender {
  text: StyledText;
  segments: WorkspaceTabBarSegment[];
  revealedIndex: number;
}

export interface BufferTabBarRender {
  text: StyledText;
  segments: TabBarSegment[];
  revealedIndex: number;
}

function $renderWorkspaceTabBar(context: WorkspaceTabBarRenderContext): WorkspaceTabBarRender {
  const { strip, palette, hover } = context;
  const orientation = strip.orientation.value;
  const workspaceTabs = strip.items;
  const segments: WorkspaceTabBarSegment[] = [];
  const chunks: TextChunk[] = [];
  const activeWorkspaceIndex = strip.activeIndex;
  let revealedIndex = context.lastRevealedIndex;

  if (orientation === 'vertical') {
    const barWidth = 22;
    const barHeight = Math.max(4, context.barHeightValue || context.rendererHeight - 1);
    const visibleWorkspaceCount = Math.max(1, barHeight - 3);
    const maximumScrollOffset = Math.max(0, workspaceTabs.length - visibleWorkspaceCount);
    strip.clampScrollOffset(maximumScrollOffset);
    if (activeWorkspaceIndex >= 0 && activeWorkspaceIndex !== revealedIndex) {
      if (
        activeWorkspaceIndex < strip.scrollOffset.value ||
        activeWorkspaceIndex >= strip.scrollOffset.value + visibleWorkspaceCount
      ) {
        strip.scrollOffset.value = Math.min(activeWorkspaceIndex, maximumScrollOffset);
      }
      revealedIndex = activeWorkspaceIndex;
    }
    const startWorkspaceIndex = strip.scrollOffset.value;
    const endWorkspaceIndex = Math.min(
      workspaceTabs.length,
      startWorkspaceIndex + visibleWorkspaceCount,
    );
    let rowIndex = 0;
    for (let workspaceIndex = startWorkspaceIndex; workspaceIndex < endWorkspaceIndex; workspaceIndex += 1) {
      const workspaceTab = workspaceTabs[workspaceIndex]!;
      const hovered = hover?.workspaceIndex === workspaceIndex;
      const closeHovered = hovered && hover?.kind === 'close';
      const rowBackground = workspaceTab.active ? palette.selection : hovered ? palette.cursorLine : null;
      const labelWidth = barWidth - 5;
      const label = workspaceTab.label.slice(0, labelWidth).padEnd(labelWidth, ' ');
      const closeGlyph = workspaceTabs.length > 1 ? '✕' : ' ';
      const rowText = ` ${workspaceTab.active ? '●' : ' '} ${label}${closeGlyph} `;
      const styledRow = fg(closeHovered ? palette.error : workspaceTab.active ? palette.fg : palette.dim)(rowText);
      chunks.push(rowBackground ? bg(rowBackground)(styledRow) : styledRow);
      chunks.push(fg(palette.fg)('\n'));
      segments.push({
        kind: 'tab',
        workspaceIndex,
        primaryStart: rowIndex,
        primaryEnd: rowIndex + 1,
        closeCrossAxisCoordinate: barWidth - 2,
      });
      rowIndex += 1;
    }
    while (rowIndex < visibleWorkspaceCount) {
      chunks.push(fg(palette.fg)(`${' '.repeat(barWidth)}\n`));
      rowIndex += 1;
    }
    const controlRows: Array<{ kind: 'panBackward' | 'panForward' | 'add'; label: string }> = [
      { kind: 'panBackward', label: ' ↑ Previous tabs' },
      { kind: 'panForward', label: ' ↓ More tabs' },
      { kind: 'add', label: ' + Add project' },
    ];
    controlRows.forEach((control, controlIndex) => {
      const hovered = hover?.kind === control.kind;
      const enabled =
        control.kind === 'add' ||
        (control.kind === 'panBackward'
          ? strip.scrollOffset.value > 0
          : strip.scrollOffset.value < maximumScrollOffset);
      const text = control.label.padEnd(barWidth, ' ').slice(0, barWidth);
      const styled = fg(enabled ? palette.accent : palette.border)(text);
      chunks.push(hovered ? bg(palette.cursorLine)(styled) : styled);
      if (controlIndex < controlRows.length - 1) chunks.push(fg(palette.fg)('\n'));
      segments.push({
        kind: control.kind,
        workspaceIndex: -1,
        primaryStart: visibleWorkspaceCount + controlIndex,
        primaryEnd: visibleWorkspaceCount + controlIndex + 1,
      });
    });
    return { text: new StyledText(chunks), segments, revealedIndex };
  }

  // Horizontal (top) strip: each project tab is TWO rows — row 0 is ` ● name ✕ ` and row 1 is the
  // worktree/branch detail indented under the name. Segments stay COLUMN spans (both rows of a tab
  // share the same x-span), and the close ✕ lives on row 0 only (TabBar checks the cross axis).
  const barWidth = Math.max(1, context.barWidthValue || context.rendererWidth);
  const controlsText = ' ‹  ›  + ';
  const controlsWidth = EditorCoordinates.Class.lineWidth(controlsText);
  const availableTabsWidth = Math.max(1, barWidth - controlsWidth);
  const measuredWorkspaceTabs = workspaceTabs.map((workspaceTab) => ({
    workspaceTab,
    width: Math.min(
      availableTabsWidth,
      Math.min(
        WORKSPACE_TAB_MAX_LABEL_WIDTH,
        Math.max(
          EditorCoordinates.Class.lineWidth(workspaceTab.label),
          EditorCoordinates.Class.lineWidth(workspaceTab.detailLabel ?? ''),
        ),
      ) + 6,
    ),
  }));
  const maximumScrollOffset = Math.max(0, measuredWorkspaceTabs.length - 1);
  strip.clampScrollOffset(maximumScrollOffset);
  let startWorkspaceIndex = strip.scrollOffset.value;
  const visibleEndFrom = (startIndex: number): number => {
    let usedWidth = 0;
    let endIndex = startIndex;
    for (let workspaceIndex = startIndex; workspaceIndex < measuredWorkspaceTabs.length; workspaceIndex += 1) {
      const measuredWorkspaceTab = measuredWorkspaceTabs[workspaceIndex]!;
      if (usedWidth + measuredWorkspaceTab.width > availableTabsWidth) break;
      usedWidth += measuredWorkspaceTab.width;
      endIndex = workspaceIndex + 1;
    }
    return Math.max(endIndex, startIndex + 1);
  };
  if (activeWorkspaceIndex >= 0 && activeWorkspaceIndex !== revealedIndex) {
    if (activeWorkspaceIndex < startWorkspaceIndex || activeWorkspaceIndex >= visibleEndFrom(startWorkspaceIndex)) {
      strip.scrollOffset.value = activeWorkspaceIndex;
      startWorkspaceIndex = activeWorkspaceIndex;
    }
    revealedIndex = activeWorkspaceIndex;
  }
  let columnIndex = 0;
  const endWorkspaceIndex = visibleEndFrom(startWorkspaceIndex);
  for (let workspaceIndex = startWorkspaceIndex; workspaceIndex < endWorkspaceIndex; workspaceIndex += 1) {
    const measuredWorkspaceTab = measuredWorkspaceTabs[workspaceIndex]!;
    const workspaceTab = measuredWorkspaceTab.workspaceTab;
    const hovered = hover?.workspaceIndex === workspaceIndex;
    const closeHovered = hovered && hover?.kind === 'close';
    const rowBackground = workspaceTab.active ? palette.selection : hovered ? palette.cursorLine : null;
    const maximumLabelWidth = Math.max(1, measuredWorkspaceTab.width - 6);
    const label = ellipsize(workspaceTab.label, maximumLabelWidth);
    const tabText = ` ${workspaceTab.active ? '●' : ' '} ${label} `;
    const styledTab = fg(workspaceTab.active ? palette.fg : palette.dim)(tabText);
    chunks.push(rowBackground ? bg(rowBackground)(styledTab) : styledTab);
    const closePrimaryCoordinate = columnIndex + EditorCoordinates.Class.lineWidth(tabText);
    const closeGlyph = workspaceTabs.length > 1 ? '✕' : ' ';
    chunks.push(
      rowBackground
        ? bg(rowBackground)(fg(closeHovered ? palette.error : palette.dim)(closeGlyph))
        : fg(closeHovered ? palette.error : palette.dim)(closeGlyph),
    );
    chunks.push(rowBackground ? bg(rowBackground)(fg(palette.dim)(' ')) : fg(palette.dim)(' '));
    segments.push({
      kind: 'tab',
      workspaceIndex,
      primaryStart: columnIndex,
      primaryEnd: columnIndex + measuredWorkspaceTab.width,
      closePrimaryCoordinate,
    });
    columnIndex += measuredWorkspaceTab.width;
  }
  while (columnIndex < availableTabsWidth) {
    chunks.push(fg(palette.fg)(' '));
    columnIndex += 1;
  }
  const controls: Array<{ kind: 'panBackward' | 'panForward' | 'add'; text: string }> = [
    { kind: 'panBackward', text: ' ‹ ' },
    { kind: 'panForward', text: ' › ' },
    { kind: 'add', text: ' + ' },
  ];
  controls.forEach((control) => {
    const startColumn = columnIndex;
    const hovered = hover?.kind === control.kind;
    const styled = fg(control.kind === 'add' ? palette.accent : palette.fg)(control.text);
    chunks.push(hovered ? bg(palette.cursorLine)(styled) : styled);
    columnIndex += EditorCoordinates.Class.lineWidth(control.text);
    segments.push({
      kind: control.kind,
      workspaceIndex: -1,
      primaryStart: startColumn,
      primaryEnd: columnIndex,
    });
  });
  // Second row: the worktree/branch detail under each visible tab, sharing the tab's background so
  // the two rows read as one tab. The controls have no second row — plain background fills it.
  chunks.push(fg(palette.fg)('\n'));
  let detailColumnIndex = 0;
  for (let workspaceIndex = startWorkspaceIndex; workspaceIndex < endWorkspaceIndex; workspaceIndex += 1) {
    const measuredWorkspaceTab = measuredWorkspaceTabs[workspaceIndex]!;
    const workspaceTab = measuredWorkspaceTab.workspaceTab;
    const hovered = hover?.workspaceIndex === workspaceIndex;
    const rowBackground = workspaceTab.active ? palette.selection : hovered ? palette.cursorLine : null;
    const maximumDetailWidth = Math.max(1, measuredWorkspaceTab.width - 6);
    const detailLabel = ellipsize(workspaceTab.detailLabel ?? '', maximumDetailWidth);
    const detailText = `   ${detailLabel}   `;
    const styledDetail = fg(workspaceTab.active ? palette.fg : palette.dim)(detailText);
    chunks.push(rowBackground ? bg(rowBackground)(styledDetail) : styledDetail);
    detailColumnIndex += measuredWorkspaceTab.width;
  }
  while (detailColumnIndex < barWidth) {
    chunks.push(fg(palette.fg)(' '));
    detailColumnIndex += 1;
  }
  return { text: new StyledText(chunks), segments, revealedIndex };
}

function $renderBufferTabBar(context: BufferTabBarRenderContext): BufferTabBarRender {
  const { strip, palette, hover } = context;
  const tabs = strip.items;
  const segments: TabBarSegment[] = [];
  let revealedIndex = context.lastRevealedIndex;
  if (tabs.length === 0) return { text: new StyledText([fg(palette.dim)('  no open files')]), segments, revealedIndex };
  const barWidth = Math.max(1, context.barWidth);

  // Each tab lays out as ` filename <dirty> ✕ ` — the ✕ has a space BEFORE and AFTER so it is never
  // flush against the tab edge, and the padding is identical regardless of label length. The tab shows
  // just the FILENAME; the active file's full path renders in the breadcrumb bar BELOW the strip
  // (renderBreadcrumbBar), VS Code-style — so tabs stay compact (many fit) while the path is always
  // legible for the file you're editing.
  const measured = tabs.map((tab) => {
    const name = tab.identifier.split('/').filter(Boolean).pop() ?? tab.identifier;
    const labelWidth = 1 + EditorCoordinates.Class.lineWidth(name) + 1 + 1 + 1; // ' ' + name + ' ' + dirtyGlyph + ' '
    return { tab, name, labelWidth, width: labelWidth + 2 }; // + '✕' + trailing ' '
  });
  const totalWidth = measured.reduce((sum, entry) => sum + entry.width, 0);

  // Right controls, pinned to the edge: a clickable ` active/total ` COUNT BADGE (always), and when
  // the strip overflows, an ellipsis "more" marker + two padded 3-cell ARROWS. Reserve their width.
  const total = tabs.length;
  const activeIndex = tabs.findIndex((tab) => tab.active);
  const badgeText = ` ${activeIndex + 1}/${total} `;
  const badgeWidth = EditorCoordinates.Class.lineWidth(badgeText);
  const arrowCellWidth = 3; // ' « ' / ' » ' — padded so the hit target is easy to click
  const previewToggleWidth = context.activeFileIsMarkdown ? 3 : 0;
  const overflow = totalWidth + badgeWidth + previewToggleWidth > barWidth;
  const rightControlsWidth = badgeWidth + previewToggleWidth + (overflow ? 1 /* ellipsis */ + arrowCellWidth * 2 : 0);
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
  strip.clampScrollOffset(maxScrollOffset);
  if (activeIndex >= 0 && activeIndex !== revealedIndex) {
    if (activeIndex < strip.scrollOffset.value || activeIndex >= windowEndFrom(strip.scrollOffset.value)) {
      strip.scrollOffset.value = Math.min(activeIndex, maxScrollOffset);
    }
    revealedIndex = activeIndex;
  }
  const startIndex = overflow ? strip.scrollOffset.value : 0;

  const chunks: TextChunk[] = [];
  let column = 0;
  let endIndex = startIndex;
  for (let index = startIndex; index < measured.length; index += 1) {
    const entry = measured[index];
    // A 1-cell gap sets every tab apart — the first off the splitter, the rest off the prior tab's
    // trailing ✕. NO powerline separator between tabs (the ✕ + gap is the divider; an arrow between
    // tabs read as clutter). The gap is in the fit check so a tab never half-renders past the edge.
    const leadWidth = 1;
    if (!entry || column + leadWidth + entry.width > tabsAreaWidth) break;
    chunks.push(fg(palette.fg)(' '));
    column += leadWidth;
    const isActive = entry.tab.active;
    const isTabHover = hover?.kind === 'tab' && hover.index === index;
    const isCloseHover = hover?.kind === 'close' && hover.index === index;
    const rowBackground = isActive ? palette.selection : isTabHover ? palette.cursorLine : null;
    // The FIRST buffer tab (index 0) takes a distinct accent tint when idle so it reads as the anchor
    // tab; the active tab always wins with the bright fg.
    const labelColor = isActive ? palette.fg : index === 0 ? palette.accent : palette.dim;
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
    const isClosePressed = context.closePressed === index;
    const closeColor = isClosePressed ? palette.bg : isCloseHover ? palette.error : labelColor;
    const closeBackground = isClosePressed ? palette.error : rowBackground;
    chunks.push(closeBackground ? bg(closeBackground)(fg(closeColor)('✕')) : fg(closeColor)('✕'));
    column += 1;
    chunks.push(paint(' ', labelColor)); // trailing pad — ✕ never touches the edge
    column += 1;
    segments.push({ kind: 'tab', index, start, end: column, closeColumn });
    endIndex = index + 1;
  }

  // Fill the gap between the last tab and the right controls.
  while (column < tabsAreaWidth) {
    chunks.push(fg(palette.fg)(' '));
    column += 1;
  }

  let moreLeft = false;
  let moreRight = false;
  if (overflow) {
    moreLeft = startIndex > 0;
    moreRight = endIndex < total;
    // "More →" cutoff affordance: a bright ellipsis at the edge where tabs continue (so a clean cut
    // never reads as "no more tabs"); dim when there is nothing more that way.
    chunks.push(fg(moreRight ? palette.accent : palette.border)(moreRight ? '…' : ' '));
    column += 1;
  }

  // Extensible right-side action cluster: Markdown preview is the first action and sits BEFORE the
  // strip-pan arrows exactly where future editor-view actions can join it.
  if (context.activeFileIsMarkdown) {
    const start = column;
    const active = context.showingMarkdownPreview;
    const hovered = hover?.kind === 'previewToggle';
    const background = context.previewPressed
      ? palette.accent
      : active
        ? palette.selection
        : hovered
          ? palette.cursorLine
          : null;
    const color = context.previewPressed ? palette.bg : active || hovered ? palette.accent : palette.fg;
    const label = ` ${context.previewIcon} `;
    chunks.push(background ? bg(background)(fg(color)(label)) : fg(color)(label));
    column += previewToggleWidth;
    segments.push({ kind: 'previewToggle', start, end: column });
  }

  if (overflow) {
    // Bigger, easy-to-hit arrows: a bolder glyph in a padded 3-cell hit target. BRIGHT (fg/accent)
    // only when more tabs exist that direction; DIM (border) at the end — so "more exists" reads.
    const paintArrow = (which: 'arrowLeft' | 'arrowRight', enabled: boolean, glyph: string): void => {
      const pressed = context.arrowPressed === which && enabled;
      const hoverArrow = hover?.kind === which && enabled;
      const color = !enabled ? palette.border : pressed ? palette.accent : hoverArrow ? palette.accent : palette.fg;
      const background = pressed ? palette.selection : hoverArrow ? palette.cursorLine : null;
      const paintCell = (text: string) => (background ? bg(background)(fg(color)(text)) : fg(color)(text));
      const start = column;
      chunks.push(paintCell(` ${glyph} `)); // 3-cell padded hit target
      column += arrowCellWidth;
      segments.push({ kind: which, start, end: column });
    };
    paintArrow('arrowLeft', moreLeft, '«');
    paintArrow('arrowRight', moreRight, '»');
  }

  // COUNT BADGE ` active/total ` — always shown, pinned right; click opens the all-buffers dropdown.
  const badgeHover = hover?.kind === 'badge';
  const badgeStart = column;
  chunks.push(
    badgeHover
      ? bg(palette.cursorLine)(fg(palette.accent)(badgeText))
      : fg(palette.accent)(badgeText),
  );
  column += badgeWidth;
  segments.push({ kind: 'badge', start: badgeStart, end: column });
  return { text: new StyledText(chunks), segments, revealedIndex };
}

export interface BreadcrumbBarRenderContext {
  strip: TabStrip.Instance;
  palette: Palette;
  barWidth: number;
  /** Active workspace root — the breadcrumb is the active file's path relative to it. */
  projectRoot: string;
  /** Whether the back (‹) button is live (there is an older location to return to). */
  canGoBack: boolean;
  /** Whether the forward (›) button is live (there is a newer location to return to). */
  canGoForward: boolean;
}

// Breadcrumb history-nav button geometry (VS Code's Go Back / Go Forward): the ‹ and › glyphs sit at
// these LOCAL columns of the breadcrumb bar, ahead of the first crumb. ONE source shared by the
// renderer below and the hit-tester, so a click always resolves to the glyph it points at.
const BREADCRUMB_BACK_COLUMN = 1; // ‹
const BREADCRUMB_FORWARD_COLUMN = 3; // ›
const BREADCRUMB_NAV_PREFIX_WIDTH = 5; // ' ‹ › ' rendered before the first crumb

/** Which history-nav button (if any) a breadcrumb-bar click at `localColumn` lands on. The back
 *  glyph owns its cell and the pad before it; the forward glyph the same — forgiving click targets
 *  that never overlap the crumbs. */
function $breadcrumbNavButtonAt(localColumn: number): 'back' | 'forward' | null {
  if (localColumn === BREADCRUMB_BACK_COLUMN || localColumn === BREADCRUMB_BACK_COLUMN - 1) return 'back';
  if (localColumn === BREADCRUMB_FORWARD_COLUMN || localColumn === BREADCRUMB_FORWARD_COLUMN - 1) return 'forward';
  return null;
}

// The breadcrumb bar that sits UNDER the buffer-tab strip (VS Code parity): the ACTIVE file's full
// path as `project › dir › file`, dim for the leading path and bright for the filename, collapsing
// leading crumbs to `…` only when the whole path exceeds the bar width. Empty when no file is open.
// This is where the path lives now — the tabs themselves show just the filename, so they stay compact.
function $renderBreadcrumbBar(context: BreadcrumbBarRenderContext): StyledText {
  const { strip, palette, projectRoot, canGoBack, canGoForward } = context;
  const activeTab = strip.items.find((tab) => tab.active);
  if (!activeTab) return new StyledText([fg(palette.dim)('')]);
  const barWidth = Math.max(1, context.barWidth);
  const crumbs = Breadcrumb.Class.fitBreadcrumb(
    Breadcrumb.Class.breadcrumbSegments(activeTab.identifier, projectRoot),
    Math.max(1, barWidth - BREADCRUMB_NAV_PREFIX_WIDTH - 1), // reserve the nav-button prefix + a trailing pad
    3, // ' › ' separator width
  );
  // History nav buttons (‹ ›) ahead of the path: accent when a move is available, dim at an end.
  // The column geometry is shared with $breadcrumbNavButtonAt so clicks land on the glyph.
  const chunks: TextChunk[] = [
    fg(palette.fg)(' '),
    fg(canGoBack ? palette.accent : palette.dim)('‹'),
    fg(palette.fg)(' '),
    fg(canGoForward ? palette.accent : palette.dim)('›'),
    fg(palette.fg)(' '),
  ];
  crumbs.forEach((crumb, index) => {
    const isFilename = index === crumbs.length - 1;
    chunks.push(fg(isFilename ? palette.fg : palette.dim)(crumb));
    if (!isFilename) chunks.push(fg(palette.border)(' › '));
  });
  return new StyledText(chunks);
}

class $TabBarRenderer {
  static renderWorkspace = $renderWorkspaceTabBar;
  static renderBuffer = $renderBufferTabBar;
  static renderBreadcrumb = $renderBreadcrumbBar;
  static breadcrumbNavButtonAt = $breadcrumbNavButtonAt;
}

export namespace TabBarRenderer {
  export const $Class = $TabBarRenderer;
  export const Class = Static($TabBarRenderer);
}
