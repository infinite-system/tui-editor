// The git pane renderer: branch header + changes region (top) + commit-log region (bottom), built
// from the shared GitRows/GitLogRows models and windowed to the sidebar. Extracted from RootView's
// closure so the git pane's rendering lives with its own contracts (smoke-git-watch, the git-rows
// cases in smoke-selection) instead of inside the god-view.
//
// RootView still owns the sidebar renderable, the scrollbar geometry, and the hit-testers. This
// renderer is a pure Static capability: render() RETURNS the pane geometry (changesTop/dividerRow/…)
// rather than mutating closure state, and RootView applies it — so nothing here holds state. The two
// content-width helpers are exposed because RootView's scrollbar-geometry sync needs them too.
//
// invariant: Renderables hold no model state (src/modules/ui/ui.invariants.md)
// invariant: Commit expansion is lazy and windowed (src/modules/git/git.invariants.md)
// invariant: Selection is item-anchored, click-set, keyboard-moved, and stays (src/modules/ui/ui.invariants.md)
import { StyledText, fg, bg, bold, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { GitRows, type ChangeRow } from '../git/GitRows';
import { GitLogRows, type CommitLogRow } from '../git/GitLogRows';
import type { Palette } from '../theme/ThemePalettes';
import type { ActionIconSet, CheckboxIconSet } from '../theme/ThemeIcons';
import type { Workspace } from '../workspace/Workspace';

/** Sidebar-relative geometry the hit-testers and scrollbars read; produced by render(). */
export interface GitPanelGeometry {
  changesTop: number;
  changesRows: number;
  dividerRow: number;
  logTop: number;
  logRows: number;
}

export interface GitPaneRenderContext {
  /** The active workspace (git repo, git-panel view state, commit log/expansion, focus, split). */
  workspace: Workspace.Instance;
  palette: Palette;
  /** Pane inner width (sidebar width minus the box border). */
  innerWidth: number;
  /** Sidebar body height (sidebar height minus the box border). */
  bodyHeight: number;
  /** Scrollbar column thickness in cells. */
  scrollbarThickness: number;
  /** Cells reserved on the active row for the action buttons (open/discard/stage). */
  gitActionAreaWidth: number;
  actionIcons: ActionIconSet;
  checkboxIcons: CheckboxIconSet;
}

const displayColumnWindow = EditorCoordinates.Class.displayColumnWindow;
const padToDisplayWidth = EditorCoordinates.Class.padToDisplayWidth;

/** One changes-region row as plain text (checkbox glyph depends on the theme's staged/unstaged set). */
function changeRowText(row: ChangeRow, checkboxIcons: CheckboxIconSet): string {
  if (row.kind === 'header') return ` ${row.label} (${row.count})`;
  if (row.kind === 'placeholder') return `  ${row.label}`;
  const checkbox = row.bucket === 'staged' ? checkboxIcons.checked : checkboxIcons.unchecked;
  return ` ${checkbox} ${row.glyph} ${row.path}`;
}

/** One commit-log row as plain text (commit header with chevron, loading placeholder, or file row). */
function commitLogRowText(row: CommitLogRow): string {
  if (row.kind === 'commit') {
    const chevron = row.expanded ? '▾' : '▸';
    return row.record ? ` ${chevron} ${row.record.shortSha} ${row.record.subject}` : ' …';
  }
  if (row.kind === 'loading') return '      …loading';
  return `    ${row.glyph} ${row.path}`;
}

/** Widest changes row (for the horizontal scrollbar extent). Called by RootView's geometry sync. */
function $changesContentWidth(rows: readonly ChangeRow[], checkboxIcons: CheckboxIconSet): number {
  return rows.reduce(
    (widestWidth, row) => Math.max(widestWidth, EditorCoordinates.Class.lineWidth(changeRowText(row, checkboxIcons))),
    0,
  );
}

/** Longest retained log row: sparse commit cache + bounded expanded-file set, never full history. */
function $logContentWidth(workspace: Workspace.Instance): number {
  let widestWidth = 0;
  for (const record of workspace.commitLog.value?.cache.value.values() ?? []) {
    widestWidth = Math.max(
      widestWidth,
      EditorCoordinates.Class.lineWidth(` ▸ ${record.shortSha} ${record.subject}`),
    );
  }
  for (const expansion of workspace.commitExpansion.value?.entries.value ?? []) {
    for (const file of expansion.files ?? []) {
      widestWidth = Math.max(
        widestWidth,
        EditorCoordinates.Class.lineWidth(`    ${file.status} ${file.path}`),
      );
    }
  }
  return widestWidth;
}

function $renderGitPanel(context: GitPaneRenderContext): { text: StyledText; geometry: GitPanelGeometry } {
  const { workspace, palette, innerWidth, bodyHeight, scrollbarThickness, gitActionAreaWidth, actionIcons, checkboxIcons } = context;
  const emptyGeometry: GitPanelGeometry = { changesTop: 0, changesRows: 0, dividerRow: 0, logTop: 0, logRows: 0 };
  const chunks: TextChunk[] = [];
  const pushRow = (
    text: string,
    color: string,
    options: {
      background?: string | null;
      bold?: boolean;
      newline?: boolean;
      scrollLeft?: number;
      viewportWidth?: number;
    } = {},
  ) => {
    const viewportWidth = Math.max(1, Math.min(innerWidth, options.viewportWidth ?? innerWidth));
    let label = displayColumnWindow(text, options.scrollLeft ?? 0, viewportWidth);
    label = padToDisplayWidth(label, viewportWidth);
    label = padToDisplayWidth(label, innerWidth);
    let chunk = fg(color)(label);
    if (options.bold) chunk = bold(chunk);
    if (options.background) chunk = bg(options.background)(chunk);
    chunks.push(chunk);
    if (options.newline !== false) chunks.push(fg(palette.fg)('\n'));
  };
  const git = workspace.git.value;
  const gitPanel = workspace.gitPanel;
  const active = workspace.focus.value === 'git';
  if (!git) return { text: new StyledText([fg(palette.dim)('  no repository')]), geometry: emptyGeometry };

  const changesViewportWidth = Math.max(1, innerWidth - scrollbarThickness);
  // The active (hovered/selected) row paints action buttons on its right, so its NAME clips further.
  const changesActiveNameWidth = Math.max(1, changesViewportWidth - gitActionAreaWidth);
  const logViewportWidth = Math.max(1, innerWidth - scrollbarThickness);
  pushRow(` ${git.branch.value || '(no branch)'}  ${git.head.value.slice(0, 7)}`, palette.accent);
  if (git.error.value) {
    pushRow(`  ${git.error.value}`, palette.deleted);
    return { text: new StyledText(chunks), geometry: emptyGeometry };
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
      pushRow(changeRowText(row, checkboxIcons), palette.dim, {
        bold: true,
        scrollLeft: gitPanel.changesScrollLeft.value,
        viewportWidth: changesViewportWidth,
      });
    } else if (row.kind === 'placeholder') {
      pushRow(changeRowText(row, checkboxIcons), palette.dim, {
        scrollLeft: gitPanel.changesScrollLeft.value,
        viewportWidth: changesViewportWidth,
      });
    } else {
      const selected = rowIndex === gitPanel.changesIndex.value;
      const selectionFocused = active && gitPanel.region.value === 'changes';
      const hovered = rowIndex === gitPanel.changesHovered.value;
      // Multi-selected rows (Ctrl/Shift-click, right-click) share the hover token — a lower
      // intensity than the focused row's `selection` bg — until the palette grows a third token.
      const multiSelected = gitPanel.selectedPaths.value.has(row.path);
      const background = selected
        ? selectionFocused
          ? palette.selection
          : palette.cursorLine
        : multiSelected || hovered
          ? palette.cursorLine
          : null;
      // ` ☑ M path…            o d ±` — ONE-glyph staging checkbox (theme ladder; click toggles);
      // the git-status letter (M/D/?) stays separate; action buttons appear on hover/selection.
      const label = changeRowText(row, checkboxIcons);
      if ((selected && selectionFocused) || hovered) {
        // Action buttons: real glyphs from the theme icon ladder (nerd → unicode → ascii letter),
        // each theme-COLOURED and each ONE cell so the hit-zone columns (gitActionButtonAt) align:
        // ` <open>  <discard>  <stage|unstage>` = 8 cells. Rendered as separate chunks so each
        // button carries its own colour (open = accent, discard = deleted/red, stage = added/green,
        // unstage = dim), then a trailing cell pads the row to innerWidth.
        const staged = row.bucket === 'staged';
        const stageGlyph = staged ? actionIcons.unstage : actionIcons.stage;
        const stageColor = staged ? palette.dim : palette.added;
        const pathText = padToDisplayWidth(
          displayColumnWindow(label, gitPanel.changesScrollLeft.value, changesActiveNameWidth),
          changesActiveNameWidth,
        );
        const paint = (text: string, color: string) =>
          background ? bg(background)(fg(color)(text)) : fg(color)(text);
        chunks.push(paint(pathText, glyphColor(row.glyph)));
        chunks.push(paint(` ${actionIcons.open}`, palette.accent));
        chunks.push(paint(`  ${actionIcons.discard}`, palette.deleted));
        chunks.push(paint(`  ${stageGlyph}`, stageColor));
        chunks.push(paint(' ', palette.fg));
        chunks.push(paint(' '.repeat(scrollbarThickness), palette.fg));
        chunks.push(fg(palette.fg)('\n'));
      } else {
        pushRow(label, glyphColor(row.glyph), {
          background,
          scrollLeft: gitPanel.changesScrollLeft.value,
          viewportWidth: changesViewportWidth,
        });
      }
    }
  });
  const changesRendered = Math.min(changeRows.length - changesTop, changesVisible);
  for (let filler = changesRendered; filler < changesVisible; filler++) pushRow('', palette.fg);

  pushRow('─'.repeat(innerWidth), palette.border);

  // Commit log region (bottom) — virtualized over FLAT rows (inline commit expansion): an expanded
  // commit is its header plus indented file rows (or a loading row while its lazy fetch is in
  // flight). The SAME pure row model serves the renderer here and the hit-tester/keyboard, windowed
  // by logScrollTop; only the visible commits' records (and the bounded expanded set) are consulted.
  const logHeight = Math.max(1, bodyHeight - topHeight - 1);
  const commitLog = workspace.commitLog.value;
  if (commitLog) {
    const flatTop = gitPanel.logScrollTop.value;
    const expandedEntries = workspace.commitExpansion.value?.entries.value ?? [];
    // O(window): at most logHeight commit records cover the flat window (expansion only DECREASES
    // how many commits fit on screen).
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
      const selected = flatIndex === gitPanel.logIndex.value;
      const selectionFocused = active && gitPanel.region.value === 'log';
      const hovered = flatIndex === gitPanel.logHovered.value;
      const background = selected
        ? selectionFocused
          ? palette.selection
          : palette.cursorLine
        : hovered
          ? palette.cursorLine
          : null;
      const newline = index < flatRows.length - 1;
      if (row.kind === 'commit') {
        pushRow(commitLogRowText(row), row.record ? palette.fg : palette.dim, {
          background,
          newline,
          scrollLeft: gitPanel.logScrollLeft.value,
          viewportWidth: logViewportWidth,
        });
      } else if (row.kind === 'loading') {
        pushRow(commitLogRowText(row), palette.dim, {
          background,
          newline,
          scrollLeft: gitPanel.logScrollLeft.value,
          viewportWidth: logViewportWidth,
        });
      } else {
        pushRow(commitLogRowText(row), glyphColor(row.glyph), {
          background,
          newline,
          scrollLeft: gitPanel.logScrollLeft.value,
          viewportWidth: logViewportWidth,
        });
      }
    });
  }

  // Geometry for the hit-testers (sidebar-relative rows; +1 = sidebar top border, +1 branch row).
  const geometry: GitPanelGeometry = {
    changesTop,
    changesRows: changesVisible,
    dividerRow: 1 + 1 + changesVisible,
    logTop: gitPanel.logScrollTop.value,
    logRows: logHeight,
  };
  return { text: new StyledText(chunks), geometry };
}

class $GitPaneRenderer {
  static changesContentWidth = $changesContentWidth;
  static logContentWidth = $logContentWidth;
  static render = $renderGitPanel;
}

export namespace GitPaneRenderer {
  export const $Class = $GitPaneRenderer;
  export const Class = Static($GitPaneRenderer);
}
