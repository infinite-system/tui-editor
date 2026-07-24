// Standalone side-by-side diff projection. The reviewer supplies callbacks and may mount this under
// any renderable; RootView and tab ownership deliberately remain outside this module.
//
// The shared scroll-coordinate methods are intentionally independent of diff row semantics. They
// are the extraction seam for a future generic synchronized split pane; this module does not build
// that abstraction prematurely.
//
// invariant: Both panes share every aligned row (src/modules/diff/diff.invariants.md)
// invariant: Diff rendering stays viewport bounded (src/modules/diff/diff.invariants.md)
// invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
// invariant: A scrollbar track is derived per frame from its region rect (src/modules/ui/ui.invariants.md)

import {
  BoxRenderable,
  ScrollBarRenderable,
  StyledText,
  TextRenderable,
  bg,
  dim,
  fg,
  type BoxOptions,
  type CliRenderer,
  type Renderable,
  type ScrollBarOptions,
  type TextChunk,
  type TextOptions,
} from '@opentui/core';
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Editor } from '../editor/Editor';
import { SplitterModel } from '../layout/SplitterModel';
import { Highlighter, type LangId, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import type { Theme } from '../theme/Theme';
import type { Palette } from '../theme/ThemePalettes';
import { ScrollbarGeometry, type BarGeometry } from '../ui/ScrollbarGeometry';
import { SelectableText } from '../ui/SelectableText';
import { SelectionDragBehavior, type SelectionDragPosition } from '../ui/SelectionDragBehavior';
import {
  Momentum,
  AT_REST,
  DEFAULT_MOMENTUM,
  VERTICAL_MOMENTUM,
  type ScrollMomentum,
  type MomentumOptions,
} from '../system/Momentum';
import type { Settings } from '../settings/Settings';
import type { FindBar, FindBarTarget } from '../search/FindBar';
import type { FindInBufferMatch } from '../search/FindInBuffer';
import {
  DiffAlignment,
  type AlignedRow,
  type AlignedRowKind,
  type DiffAlignmentResult,
} from './DiffAlignment';

export interface DiffViewCallbacks {
  onOpenFull?: () => void;
  onNextChange?: (changeNumber: number, totalChanges: number, alignedRowIndex: number) => void;
  onPrevChange?: (changeNumber: number, totalChanges: number, alignedRowIndex: number) => void;
}

export interface DiffViewOptions extends DiffViewCallbacks {
  previousVersionText: string;
  currentVersionText: string;
  previousVersionPath?: string;
  currentVersionPath?: string;
  parentRenderable?: Renderable;
}

interface HeaderSegment {
  kind: 'openFull' | 'nextChange' | 'previousChange';
  startColumn: number;
  endColumnExclusive: number;
}

interface RenderedDiffPane {
  gutter: StyledText;
  code: StyledText;
}

interface DiffPaneRenderables {
  pane: BoxRenderable;
  title: TextRenderable;
  content: BoxRenderable;
  gutter: TextRenderable;
  code: SelectableText.Model;
}

/** The bright accent for a changed row's GUTTER MARKER (line number tint) — the same hues the git
 *  panel uses for add/modify/delete. Distinct from the row's background fill below. */
function changedRowColor(kind: AlignedRowKind, palette: Palette): string | null {
  switch (kind) {
    case 'added': return palette.added;
    case 'deleted': return palette.deleted;
    case 'modified': return palette.modified;
    case 'equal': return null;
  }
}

/** The muted BACKGROUND fill for a changed row — theme-fitting (not the neon accent), so code text on
 *  top stays legible on a near-black editor. Null for unchanged rows (no fill). */
function changedRowBackground(kind: AlignedRowKind, palette: Palette): string | null {
  switch (kind) {
    case 'added': return palette.diffAddedBg;
    case 'deleted': return palette.diffDeletedBg;
    case 'modified': return palette.diffModifiedBg;
    case 'equal': return null;
  }
}

function syntaxRoleColor(role: Role, palette: Palette): string {
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
    case 'variable': return palette.variable;
    case 'text': return palette.fg;
  }
  return palette.fg;
}

class $DiffView {
  /** Project existing change blocks into one kind per overview-track row without recomputing a diff. */
  static overviewKinds(
    alignment: DiffAlignmentResult,
    trackHeight: number,
  ): Array<AlignedRowKind | null> {
    const normalizedTrackHeight = Math.max(0, Math.floor(trackHeight));
    const totalAlignedRows = alignment.alignedRows.length;
    if (normalizedTrackHeight === 0 || totalAlignedRows === 0) return [];
    return Array.from({ length: normalizedTrackHeight }, (_unused, trackRowIndex) => {
      const bandStartAlignedRow = trackRowIndex / normalizedTrackHeight * totalAlignedRows;
      const bandEndAlignedRow = (trackRowIndex + 1) / normalizedTrackHeight * totalAlignedRows;
      const overlappingChangeBlock = alignment.changeBlocks.find(
        (changeBlock) =>
          changeBlock.startAlignedRowIndex < bandEndAlignedRow &&
          changeBlock.endAlignedRowIndexExclusive > bandStartAlignedRow,
      );
      if (!overlappingChangeBlock) return null;
      return alignment.alignedRows[overlappingChangeBlock.startAlignedRowIndex]?.kind ?? null;
    });
  }

  readonly alignment: DiffAlignmentResult;
  readonly previousVersionLines: readonly string[];
  readonly currentVersionLines: readonly string[];
  readonly rootRenderable: BoxRenderable;
  private readonly headerRenderable: TextRenderable;
  private readonly bodyRenderable: BoxRenderable;
  private readonly previousPaneRenderables: DiffPaneRenderables;
  private readonly currentPaneRenderables: DiffPaneRenderables;
  private readonly paneDividerRenderable: BoxRenderable;
  private readonly paneSplitter: SplitterModel.Instance;
  private readonly overviewRulerRenderable: TextRenderable;
  private readonly verticalScrollbarRenderable: ScrollBarRenderable;
  private readonly horizontalScrollbarRenderable: ScrollBarRenderable;
  private readonly previousSelectionDragBehavior: SelectionDragBehavior.Model;
  private readonly currentSelectionDragBehavior: SelectionDragBehavior.Model;
  // Presentation geometry only. Projection and hit-testing share these values, but update() does
  // not mutate reactive model state and therefore cannot create a render-invalidation loop.
  private headerSegments: HeaderSegment[] = [];
  private isApplyingScrollbarGeometry = false;
  private verticalReportedToTrueScale = 1;
  private horizontalReportedToTrueScale = 1;
  private paneDividerHovered = false;
  private paneDividerDragActive = false;
  private activeSelectionSide: 'previous' | 'current' | null = null;
  private selectionEditor: Editor.Instance | null = null;
  private readonly previousFindEditor: Editor.Instance;
  private readonly currentFindEditor: Editor.Instance;
  private focusedFindSide: 'previous' | 'current' = 'current';
  private findBarSource: FindBar.Instance | null = null;
  private findIdentifier = 'diff';

  get alignedRowScrollOffset() {
    return ref(0);
  }
  get horizontalScrollOffset() {
    return ref(0);
  }
  get verticalScrollMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  get horizontalScrollMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  get activeChangeBlockNumber() {
    return ref(this.alignment.changeBlocks.length > 0 ? 1 : 0);
  }
  get selectionRevision() {
    return ref(0);
  }

  // Live scroll physics: like Workspace, the vertical momentum reads its ceiling/gain/friction from the
  // Settings store when attached, so the diff pane's fling obeys the same Ctrl+, tuning as the editor
  // (no restart). Unattached (tests) falls back to the tuned VERTICAL_MOMENTUM default. Horizontal stays
  // DEFAULT_MOMENTUM (a short-throw axis, not user-tuned).
  private settingsSource: Settings.Instance | null = null;
  attachSettings(settings: Settings.Instance): void {
    this.settingsSource = settings;
    this.paneSplitter.size.value = settings.diffSplitRatio.value;
    this.update();
  }
  private get verticalMomentum(): MomentumOptions {
    const settings = this.settingsSource;
    if (!settings) return VERTICAL_MOMENTUM;
    return {
      impulse: settings.scrollAccelGain.value,
      max: settings.verticalFlingCeiling.value,
      decayPerSec: settings.scrollFriction.value,
      stopVelocity: VERTICAL_MOMENTUM.stopVelocity,
    };
  }
  constructor(
    public readonly renderer: CliRenderer,
    public readonly theme: Theme.Instance,
    public readonly options: DiffViewOptions,
  ) {
    this.alignment = DiffAlignment.Class.align(options.previousVersionText, options.currentVersionText);
    this.previousVersionLines = DiffAlignment.Class.splitLines(options.previousVersionText);
    this.currentVersionLines = DiffAlignment.Class.splitLines(options.currentVersionText);
    this.previousFindEditor = this.createFindEditor(
      options.previousVersionPath ?? 'previous version',
      options.previousVersionText,
    );
    this.currentFindEditor = this.createFindEditor(
      options.currentVersionPath ?? 'current version',
      options.currentVersionText,
    );
    this.rootRenderable = this.createBoxRenderable({
      id: 'diff-view',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    });
    this.headerRenderable = this.createTextRenderable({ id: 'diff-toolbar', height: 1, width: '100%', content: '' });
    this.bodyRenderable = this.createBoxRenderable({
      id: 'diff-body',
      flexGrow: 1,
      width: '100%',
      flexDirection: 'row',
      overflow: 'hidden',
    });
    this.previousPaneRenderables = this.createPaneRenderables('previous');
    this.currentPaneRenderables = this.createPaneRenderables('current');
    this.paneSplitter = new SplitterModel.Class({
      orientation: 'vertical',
      mode: 'ratio',
      initialSize: 0.5,
      minimumSize: 0.15,
      maximumSize: 0.85,
      onSizeChange: (ratio) => {
        if (this.settingsSource) this.settingsSource.diffSplitRatio.value = ratio;
        this.update();
      },
    });
    this.paneDividerRenderable = this.createBoxRenderable({
      id: 'diff-pane-divider',
      width: 1,
      height: '100%',
      flexShrink: 0,
    });
    this.overviewRulerRenderable = this.createTextRenderable({
      id: 'diff-overview-ruler',
      content: '',
      position: 'absolute',
      width: 1,
      wrapMode: 'none',
      selectable: false,
    });
    this.verticalScrollbarRenderable = this.createScrollBarRenderable({
      id: 'diff-scrollbar-vertical',
      orientation: 'vertical',
      position: 'absolute',
      width: 1,
      showArrows: false,
      onChange: (reportedPosition) => this.onVerticalScrollbarChanged(reportedPosition),
    });
    this.horizontalScrollbarRenderable = this.createScrollBarRenderable({
      id: 'diff-scrollbar-horizontal',
      orientation: 'horizontal',
      position: 'absolute',
      height: 1,
      showArrows: false,
      onChange: (reportedPosition) => this.onHorizontalScrollbarChanged(reportedPosition),
    });

    this.headerRenderable.onMouseDown = (event) => this.onHeaderMouseDown(event.x);
    this.bodyRenderable.onMouseScroll = (event) =>
      this.onBodyMouseScroll(event.scroll?.direction, event.modifiers.alt || event.modifiers.shift);
    this.paneDividerRenderable.onMouseDown = (event) => this.beginPaneDividerDrag(event.x);
    this.paneDividerRenderable.onMouseDrag = (event) => this.continuePaneDividerDrag(event.x);
    this.paneDividerRenderable.onMouseUp = () => this.endPaneDividerDrag();
    this.paneDividerRenderable.onMouseDragEnd = () => this.endPaneDividerDrag();
    this.paneDividerRenderable.onMouseMove = () => {
      if (this.paneDividerHovered) return;
      this.paneDividerHovered = true;
      this.update();
    };
    this.paneDividerRenderable.onMouseOut = () => {
      if (!this.paneDividerHovered) return;
      this.paneDividerHovered = false;
      this.update();
    };
    this.previousSelectionDragBehavior = this.createSelectionDragBehavior('previous');
    this.currentSelectionDragBehavior = this.createSelectionDragBehavior('current');
    this.bindPaneSelectionEvents('previous');
    this.bindPaneSelectionEvents('current');
    this.rootRenderable.add(this.headerRenderable);
    this.bodyRenderable.add(this.previousPaneRenderables.pane);
    this.bodyRenderable.add(this.paneDividerRenderable);
    this.bodyRenderable.add(this.currentPaneRenderables.pane);
    this.bodyRenderable.add(this.overviewRulerRenderable);
    this.bodyRenderable.add(this.verticalScrollbarRenderable);
    this.bodyRenderable.add(this.horizontalScrollbarRenderable);
    this.rootRenderable.add(this.bodyRenderable);
    (options.parentRenderable ?? renderer.root).add(this.rootRenderable);
    this.update();
  }

  // --- owned-resource seams ---

  createBoxRenderable(options: BoxOptions): BoxRenderable {
    return new BoxRenderable(this.renderer, options);
  }

  createTextRenderable(options: TextOptions): TextRenderable {
    return new TextRenderable(this.renderer, options);
  }

  createScrollBarRenderable(options: ScrollBarOptions): ScrollBarRenderable {
    return new ScrollBarRenderable(this.renderer, options);
  }

  createFindEditor(path: string, text: string): Editor.Instance {
    const editor = new Editor.Class();
    editor.openDiff(path, text);
    return editor;
  }

  attachFindBar(findBar: FindBar.Instance, identifier: string): void {
    this.findBarSource = findBar;
    this.findIdentifier = identifier;
    this.update();
  }

  findTarget(): FindBarTarget {
    // invariant: Diff panes keep independent find state (src/modules/diff/diff.invariants.md)
    const side = this.focusedFindSide;
    const editor = side === 'previous' ? this.previousFindEditor : this.currentFindEditor;
    return {
      identifier: this.findTargetIdentifier(side),
      document: editor.document,
      replaceAllowed: false,
      revealMatch: (match) => this.revealFindMatch(side, match),
    };
  }

  createPaneRenderables(side: 'previous' | 'current'): DiffPaneRenderables {
    const pane = this.createBoxRenderable({
      id: `diff-${side}-pane`,
      width: '50%',
      height: '100%',
      flexDirection: 'column',
      overflow: 'hidden',
      flexShrink: 0,
    });
    const title = this.createTextRenderable({ id: `diff-${side}-title`, width: '100%', height: 1, content: '' });
    const content = this.createBoxRenderable({
      id: `diff-${side}-content`,
      width: '100%',
      flexGrow: 1,
      flexDirection: 'row',
      overflow: 'hidden',
    });
    const gutter = this.createTextRenderable({
      id: `diff-${side}-gutter`,
      content: '',
      wrapMode: 'none',
      selectable: false,
    });
    const code = new SelectableText.Class(this.renderer, {
      id: `diff-${side}-code`,
      content: '',
      wrapMode: 'none',
      selectable: false,
      flexGrow: 1,
      overflow: 'hidden',
    });
    content.add(gutter);
    content.add(code);
    pane.add(title);
    pane.add(content);
    return { pane, title, content, gutter, code };
  }

  // --- shared synchronized-scroll substrate ---

  setSharedScrollCoordinate(alignedRowIndex: number, displayColumnIndex: number): void {
    this.haltScrollMomentum();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(alignedRowIndex);
    this.horizontalScrollOffset.value = this.clampHorizontalOffset(displayColumnIndex);
    this.synchronizeActiveChangeBlockNumber();
    this.update();
  }

  impulseVerticalScroll(deltaRows: number): void {
    this.verticalScrollMomentum.value = Momentum.Class.addImpulse(
      this.verticalScrollMomentum.value,
      deltaRows,
      this.verticalMomentum,
    );
  }

  impulseHorizontalScroll(deltaColumns: number): void {
    this.horizontalScrollMomentum.value = Momentum.Class.addImpulse(
      this.horizontalScrollMomentum.value,
      deltaColumns,
      DEFAULT_MOMENTUM,
    );
  }

  tickScrollMomentum(deltaTimeSeconds: number): boolean {
    const verticalStep = Momentum.Class.stepMomentum(this.verticalScrollMomentum.value, deltaTimeSeconds, this.verticalMomentum);
    const horizontalStep = Momentum.Class.stepMomentum(this.horizontalScrollMomentum.value, deltaTimeSeconds, DEFAULT_MOMENTUM);
    this.verticalScrollMomentum.value = verticalStep.momentum;
    this.horizontalScrollMomentum.value = horizontalStep.momentum;
    if (verticalStep.rows !== 0) {
      this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(
        this.alignedRowScrollOffset.value + verticalStep.rows,
      );
      this.synchronizeActiveChangeBlockNumber();
    }
    if (horizontalStep.rows !== 0) {
      this.horizontalScrollOffset.value = this.clampHorizontalOffset(
        this.horizontalScrollOffset.value + horizontalStep.rows,
      );
    }
    const selectionAutoscrolling =
      this.previousSelectionDragBehavior.tick(deltaTimeSeconds) ||
      this.currentSelectionDragBehavior.tick(deltaTimeSeconds);
    if (verticalStep.rows !== 0 || horizontalStep.rows !== 0 || selectionAutoscrolling) this.update();
    return (
      Momentum.Class.isMoving(verticalStep.momentum) ||
      Momentum.Class.isMoving(horizontalStep.momentum) ||
      selectionAutoscrolling
    );
  }

  moveByKeyboardAlignedRows(deltaRows: number): void {
    this.verticalScrollMomentum.value = Momentum.Class.halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(this.alignedRowScrollOffset.value + deltaRows);
    this.synchronizeActiveChangeBlockNumber();
    this.update();
  }

  moveByKeyboardColumns(deltaColumns: number): void {
    this.horizontalScrollMomentum.value = Momentum.Class.halt();
    this.horizontalScrollOffset.value = this.clampHorizontalOffset(this.horizontalScrollOffset.value + deltaColumns);
    this.update();
  }

  pageByKeyboard(direction: -1 | 1): void {
    this.moveByKeyboardAlignedRows(direction * this.viewportAlignedRowCount());
  }

  haltScrollMomentum(): void {
    this.verticalScrollMomentum.value = Momentum.Class.halt();
    this.horizontalScrollMomentum.value = Momentum.Class.halt();
  }

  // --- toolbar actions and callback seams ---

  openFull(): void {
    this.options.onOpenFull?.();
  }

  jumpToNextChange(): void {
    const nextAlignedRowIndex = DiffAlignment.Class.nextChangeBlockStart(
      this.alignment.changeBlocks,
      this.alignedRowScrollOffset.value,
    ) ?? this.alignment.changeBlocks[0]?.startAlignedRowIndex ?? null;
    if (nextAlignedRowIndex === null) return;
    this.verticalScrollMomentum.value = Momentum.Class.halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(nextAlignedRowIndex);
    this.activeChangeBlockNumber.value =
      this.changeBlockNumberAt(nextAlignedRowIndex) ?? 0;
    this.update();
    this.options.onNextChange?.(
      this.activeChangeBlockNumber.value,
      this.alignment.changeBlocks.length,
      nextAlignedRowIndex,
    );
  }

  jumpToPreviousChange(): void {
    const previousAlignedRowIndex = DiffAlignment.Class.previousChangeBlockStart(
      this.alignment.changeBlocks,
      this.alignedRowScrollOffset.value,
    ) ?? this.alignment.changeBlocks[this.alignment.changeBlocks.length - 1]?.startAlignedRowIndex ?? null;
    if (previousAlignedRowIndex === null) return;
    this.verticalScrollMomentum.value = Momentum.Class.halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(previousAlignedRowIndex);
    this.activeChangeBlockNumber.value =
      this.changeBlockNumberAt(previousAlignedRowIndex) ?? 0;
    this.update();
    this.options.onPrevChange?.(
      this.activeChangeBlockNumber.value,
      this.alignment.changeBlocks.length,
      previousAlignedRowIndex,
    );
  }

  // --- projection ---

  update(): void {
    const palette = this.theme.palette;
    this.synchronizePaneSplitGeometry();
    this.rootRenderable.backgroundColor = palette.bg;
    this.headerRenderable.bg = palette.statusBg;
    this.bodyRenderable.backgroundColor = palette.bg;
    this.paneDividerRenderable.backgroundColor =
      this.paneSplitter.dragging.value || this.paneDividerHovered ? palette.accent : palette.border;
    this.previousPaneRenderables.title.bg = palette.panel;
    this.currentPaneRenderables.title.bg = palette.panel;
    // invariant: Base and current stay unambiguous (src/modules/diff/diff.invariants.md)
    this.previousPaneRenderables.title.content = new StyledText([
      fg(palette.dim)(` Base (HEAD) — ${this.options.previousVersionPath ?? 'previous version'}`),
    ]);
    this.currentPaneRenderables.title.content = new StyledText([
      fg(palette.accent)(` Current (working) — ${this.options.currentVersionPath ?? 'current version'}`),
    ]);
    this.headerRenderable.content = this.renderHeader(palette);

    const previousRenderedPane = this.renderPane('previous', palette);
    const currentRenderedPane = this.renderPane('current', palette);
    this.previousPaneRenderables.gutter.content = previousRenderedPane.gutter;
    this.previousPaneRenderables.code.content = previousRenderedPane.code;
    this.currentPaneRenderables.gutter.content = currentRenderedPane.gutter;
    this.currentPaneRenderables.code.content = currentRenderedPane.code;
    this.previousPaneRenderables.gutter.fg = palette.dim;
    this.previousPaneRenderables.code.fg = palette.fg;
    this.currentPaneRenderables.gutter.fg = palette.dim;
    this.currentPaneRenderables.code.fg = palette.fg;
    this.previousPaneRenderables.code.selectionBg = palette.selection;
    this.currentPaneRenderables.code.selectionBg = palette.selection;
    this.applyPaneSelection('previous');
    this.applyPaneSelection('current');
    this.synchronizeScrollbars(palette);
    this.renderer.requestRender();
  }

  renderHeader(palette: Palette): StyledText {
    // invariant: Base and current stay unambiguous (src/modules/diff/diff.invariants.md)
    const actionIcons = this.theme.actionIcons;
    const openLabel = ` ${actionIcons.open} Open current `;
    const previousLabel = ` ${actionIcons.unstage} Previous `;
    const nextLabel = ` ${actionIcons.stage} Next `;
    const changeCounter = `${this.activeChangeBlockNumber.value} of ${this.alignment.changeBlocks.length} changes`;
    const headerSegments: HeaderSegment[] = [];
    let nextColumn = 0;
    const appendSegment = (kind: HeaderSegment['kind'], label: string, color: string): TextChunk => {
      const startColumn = nextColumn;
      nextColumn += label.length;
      headerSegments.push({ kind, startColumn, endColumnExclusive: nextColumn });
      return fg(color)(label);
    };
    const chunks: TextChunk[] = [
      appendSegment('previousChange', previousLabel, palette.dim),
      appendSegment('nextChange', nextLabel, palette.dim),
      fg(palette.fg)(` ${changeCounter}`),
    ];
    nextColumn += ` ${changeCounter}`.length;
    const headerWidth = Math.max(1, Number(this.headerRenderable.width) || Number(this.bodyRenderable.width) || 80);
    const laidOutCurrentPaneStart = Number(this.currentPaneRenderables.pane.x) - Number(this.bodyRenderable.x);
    const ratioCurrentPaneStart = this.previousPaneWidth() + 1;
    const currentPaneStart = laidOutCurrentPaneStart > 0 ? laidOutCurrentPaneStart : ratioCurrentPaneStart;
    const openSegmentStart = Math.max(nextColumn, currentPaneStart, headerWidth - openLabel.length - 2);
    if (openSegmentStart > nextColumn) {
      chunks.push(fg(palette.statusBg)(' '.repeat(openSegmentStart - nextColumn)));
      nextColumn = openSegmentStart;
    }
    chunks.push(appendSegment('openFull', openLabel, palette.accent));
    this.headerSegments = headerSegments;
    return new StyledText(chunks);
  }

  renderPane(side: 'previous' | 'current', palette: Palette): RenderedDiffPane {
    // invariant: Diff rendering stays viewport bounded (src/modules/diff/diff.invariants.md)
    const firstAlignedRowIndex = this.alignedRowScrollOffset.value;
    const visibleAlignedRows = this.alignment.alignedRows.slice(
      firstAlignedRowIndex,
      firstAlignedRowIndex + this.viewportAlignedRowCount(),
    );
    const gutterWidth = this.gutterWidth(side);
    const codeViewportWidth = this.codeViewportWidth(side);
    const language = this.languageForSide(side);
    const gutterChunks: TextChunk[] = [];
    const codeChunks: TextChunk[] = [];

    visibleAlignedRows.forEach((alignedRow, visibleAlignedRowIndex) => {
      const lineNumber = side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber;
      const isFillerRow = lineNumber === null;
      // Marker = bright accent for the gutter line-number tint; background = the muted row fill.
      const rowMarkerColor = changedRowColor(alignedRow.kind, palette);
      const rowBackgroundColor = changedRowBackground(alignedRow.kind, palette);
      const gutterText = isFillerRow
        ? ' '.repeat(gutterWidth)
        : `${String(lineNumber).padStart(gutterWidth - 1, ' ')} `;
      const gutterChunk = fg(isFillerRow ? palette.dim : rowMarkerColor ?? palette.dim)(gutterText);
      gutterChunks.push(
        isFillerRow
          ? dim(rowBackgroundColor ? bg(rowBackgroundColor)(gutterChunk) : gutterChunk)
          : rowBackgroundColor
            ? bg(rowBackgroundColor)(gutterChunk)
            : gutterChunk,
      );

      // Unified-diff prefix in the first code column: '+' added, '-' removed, ' ' otherwise. A
      // modified row shows '-' on the previous (old) side and '+' on the current (new) side. One cell
      // is reserved for it so every row's code aligns.
      const diffPrefix = isFillerRow
        ? ' '
        : alignedRow.kind === 'added'
          ? '+'
          : alignedRow.kind === 'deleted'
            ? '-'
            : alignedRow.kind === 'modified'
              ? side === 'previous' ? '-' : '+'
              : ' ';
      const prefixChunk = fg(rowMarkerColor ?? palette.dim)(diffPrefix);
      codeChunks.push(rowBackgroundColor ? bg(rowBackgroundColor)(prefixChunk) : prefixChunk);
      const codeContentWidth = Math.max(1, codeViewportWidth - 1);

      if (isFillerRow) {
        const fillerChunk = dim(fg(palette.dim)(' '.repeat(codeContentWidth)));
        codeChunks.push(rowBackgroundColor ? bg(rowBackgroundColor)(fillerChunk) : fillerChunk);
      } else {
        const sourceLine = this.lineForSide(side, lineNumber);
        const visibleLineWindow = this.sliceLineWindowDetails(sourceLine, codeContentWidth);
        const visibleLine = visibleLineWindow.text;
        const lineChunks = this.highlightLine(
          visibleLine,
          language,
          palette,
          rowBackgroundColor,
          side,
          lineNumber - 1,
          visibleLineWindow.startGrapheme,
        );
        codeChunks.push(...lineChunks);
        const remainingColumns = Math.max(0, codeContentWidth - EditorCoordinates.Class.lineWidth(visibleLine));
        if (remainingColumns > 0) {
          const paddingChunk = fg(palette.fg)(' '.repeat(remainingColumns));
          codeChunks.push(rowBackgroundColor ? bg(rowBackgroundColor)(paddingChunk) : paddingChunk);
        }
      }

      if (visibleAlignedRowIndex < visibleAlignedRows.length - 1) {
        gutterChunks.push(fg(palette.fg)('\n'));
        codeChunks.push(fg(palette.fg)('\n'));
      }
    });
    return { gutter: new StyledText(gutterChunks), code: new StyledText(codeChunks) };
  }

  highlightLine(
    visibleLine: string,
    language: LangId,
    palette: Palette,
    rowBackgroundColor: string | null,
    side?: 'previous' | 'current',
    lineIndex?: number,
    visibleStartGrapheme = 0,
  ): TextChunk[] {
    // This is the same viewport-local LanguageRegistry + Highlighter seam used by the editor. A
    // future Tree-sitter provider upgrades LanguageRegistry without a second diff rendering path.
    const findEngine = side ? this.findBarSource?.engineFor(this.findTargetIdentifier(side)) : null;
    const lineMatches = lineIndex === undefined
      ? []
      : findEngine?.matches.value.filter((match) => match.line === lineIndex) ?? [];
    const visibleGraphemeCount = EditorCoordinates.Class.graphemeCount(visibleLine);
    const boundaries = new Set<number>([0, visibleGraphemeCount]);
    for (const match of lineMatches) {
      boundaries.add(Math.max(0, Math.min(visibleGraphemeCount, match.startColumn - visibleStartGrapheme)));
      boundaries.add(Math.max(0, Math.min(visibleGraphemeCount, match.endColumn - visibleStartGrapheme)));
    }
    const orderedBoundaries = [...boundaries].sort((first, second) => first - second);
    const chunks: TextChunk[] = [];
    for (let boundaryIndex = 0; boundaryIndex < orderedBoundaries.length - 1; boundaryIndex += 1) {
      const segmentStart = orderedBoundaries[boundaryIndex]!;
      const segmentEnd = orderedBoundaries[boundaryIndex + 1]!;
      if (segmentEnd <= segmentStart) continue;
      const segmentText = visibleLine.slice(
        EditorCoordinates.Class.graphemeToU16(visibleLine, segmentStart),
        EditorCoordinates.Class.graphemeToU16(visibleLine, segmentEnd),
      );
      const findHighlighted = lineMatches.some(
        (match) =>
          match.startColumn < visibleStartGrapheme + segmentEnd &&
          match.endColumn > visibleStartGrapheme + segmentStart,
      );
      for (const highlightedSpan of Highlighter.Class.highlightLine(segmentText, language)) {
        let syntaxChunk = fg(syntaxRoleColor(highlightedSpan.role, palette))(highlightedSpan.text);
        if (findHighlighted) syntaxChunk = bg(palette.cursorLine)(syntaxChunk);
        else if (rowBackgroundColor) syntaxChunk = bg(rowBackgroundColor)(syntaxChunk);
        chunks.push(syntaxChunk);
      }
    }
    return chunks;
  }

  sliceLineWindow(sourceLine: string, codeViewportWidth: number): string {
    return this.sliceLineWindowDetails(sourceLine, codeViewportWidth).text;
  }

  private sliceLineWindowDetails(
    sourceLine: string,
    codeViewportWidth: number,
  ): { text: string; startGrapheme: number } {
    const horizontalScrollOffset = this.horizontalScrollOffset.value;
    if (horizontalScrollOffset === 0 && sourceLine.length <= codeViewportWidth) {
      return { text: sourceLine, startGrapheme: 0 };
    }
    let startGraphemeIndex = EditorCoordinates.Class.graphemeAtDisplayColumn(sourceLine, horizontalScrollOffset);
    if (EditorCoordinates.Class.displayColumn(sourceLine, startGraphemeIndex) < horizontalScrollOffset) startGraphemeIndex++;
    const endGraphemeIndex =
      EditorCoordinates.Class.graphemeAtDisplayColumn(sourceLine, horizontalScrollOffset + codeViewportWidth) + 1;
    return {
      text: sourceLine.slice(
        EditorCoordinates.Class.graphemeToU16(sourceLine, startGraphemeIndex),
        EditorCoordinates.Class.graphemeToU16(sourceLine, endGraphemeIndex),
      ),
      startGrapheme: startGraphemeIndex,
    };
  }

  synchronizeScrollbars(palette: Palette): void {
    const bodyWidth = Math.max(1, Number(this.bodyRenderable.width) || 1);
    const bodyHeight = Math.max(1, Number(this.bodyRenderable.height) || 1);
    const region = { top: 0, left: 0, width: bodyWidth, height: bodyHeight };
    const verticalGeometry = ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, {
      scrollSize: this.alignment.alignedRows.length,
      viewportSize: this.viewportAlignedRowCount(),
      scrollPosition: this.alignedRowScrollOffset.value,
    });
    this.applyScrollbarGeometry(
      this.verticalScrollbarRenderable,
      'vertical',
      verticalGeometry,
      this.alignment.alignedRows.length,
    );
    this.synchronizeOverviewRuler(verticalGeometry, palette);
    this.applyScrollbarGeometry(
      this.horizontalScrollbarRenderable,
      'horizontal',
      ScrollbarGeometry.Class.scrollbarGeometry('horizontal', region, {
        scrollSize: this.widestVisibleLineWidth(),
        viewportSize: this.sharedCodeViewportWidth(),
        scrollPosition: this.horizontalScrollOffset.value,
      }),
      this.widestVisibleLineWidth(),
    );
  }

  private synchronizeOverviewRuler(verticalGeometry: BarGeometry | null, palette: Palette): void {
    // invariant: The overview ruler locates every change block (src/modules/diff/diff.invariants.md)
    if (!verticalGeometry) {
      this.overviewRulerRenderable.visible = false;
      this.overviewRulerRenderable.content = '';
      return;
    }
    this.overviewRulerRenderable.visible = true;
    this.overviewRulerRenderable.top = verticalGeometry.trackTop;
    this.overviewRulerRenderable.left = Math.max(0, verticalGeometry.trackLeft - 1);
    this.overviewRulerRenderable.height = verticalGeometry.trackLength;
    const overviewKinds = $DiffView.overviewKinds(this.alignment, verticalGeometry.trackLength);
    const overviewChunks: TextChunk[] = [];
    overviewKinds.forEach((kind, trackRowIndex) => {
      const color = kind ? changedRowColor(kind, palette) : null;
      overviewChunks.push(bg(color ?? palette.panel)(fg(color ?? palette.panel)(' ')));
      if (trackRowIndex < overviewKinds.length - 1) overviewChunks.push(fg(palette.panel)('\n'));
    });
    this.overviewRulerRenderable.content = new StyledText(overviewChunks);
  }

  applyScrollbarGeometry(
    scrollbarRenderable: ScrollBarRenderable,
    orientation: 'vertical' | 'horizontal',
    geometry: BarGeometry | null,
    scrollSize: number,
  ): void {
    if (!geometry) {
      scrollbarRenderable.visible = false;
      scrollbarRenderable.scrollSize = 0;
      if (orientation === 'vertical') this.verticalReportedToTrueScale = 0;
      else this.horizontalReportedToTrueScale = 0;
      return;
    }
    scrollbarRenderable.visible = true;
    scrollbarRenderable.top = geometry.trackTop;
    scrollbarRenderable.left = geometry.trackLeft;
    if (orientation === 'vertical') scrollbarRenderable.height = geometry.trackLength;
    else scrollbarRenderable.width = geometry.trackLength;
    this.isApplyingScrollbarGeometry = true;
    try {
      scrollbarRenderable.scrollSize = scrollSize;
      scrollbarRenderable.viewportSize = geometry.reportedViewportSize;
      scrollbarRenderable.scrollPosition = geometry.reportedPosition;
    } finally {
      this.isApplyingScrollbarGeometry = false;
    }
    if (orientation === 'vertical') this.verticalReportedToTrueScale = geometry.reportedToTrueScale;
    else this.horizontalReportedToTrueScale = geometry.reportedToTrueScale;
  }

  // --- draggable persisted pane split ---

  private paneExtentWidth(): number {
    // One divider cell plus one overview-ruler cell and one vertical-scrollbar cell are outside the
    // two pane widths. The ruler and scrollbar are absolute, but reserving them keeps current text
    // from rendering beneath the scroll axis.
    //
    // On the FIRST frame Yoga has not measured the flex-sized bodyRenderable yet, so its `.width` is 0.
    // Falling back to a hardcoded 80 there sized both panes to ~80/actual (≈60%) until the next frame
    // corrected it. Instead fall back to the DEFINITE-size parent host (diffContainer, laid out before
    // the diff opened) — then the renderer width — so the extent is correct on frame 1.
    const measuredBodyWidth = Number(this.bodyRenderable.width) || 0;
    const parentHost = this.options.parentRenderable ?? this.renderer.root;
    const extentWidth =
      measuredBodyWidth || Number(parentHost.width) || Number(this.renderer.width) || 80;
    return Math.max(2, extentWidth - 3);
  }

  private paneSplitRatio(): number {
    const ratio = this.settingsSource?.diffSplitRatio.value ?? this.paneSplitter.size.value;
    return Math.max(0.15, Math.min(0.85, ratio));
  }

  private previousPaneWidth(): number {
    return Math.max(1, Math.round(this.paneExtentWidth() * this.paneSplitRatio()));
  }

  private synchronizePaneSplitGeometry(): void {
    // invariant: The diff pane split stays draggable and persistent (src/modules/diff/diff.invariants.md)
    const previousPaneWidth = this.previousPaneWidth();
    this.previousPaneRenderables.pane.width = previousPaneWidth;
    this.currentPaneRenderables.pane.width = Math.max(1, this.paneExtentWidth() - previousPaneWidth);
    this.paneSplitter.setExtentCells(this.paneExtentWidth());
  }

  private captureDragTarget(target: object): void {
    const renderableWithContext = target as {
      _ctx?: { setCapturedRenderable?: (renderable: unknown) => void };
    };
    renderableWithContext._ctx?.setCapturedRenderable?.(target);
  }

  private beginPaneDividerDrag(screenColumn: number): void {
    this.captureDragTarget(this.paneDividerRenderable);
    this.paneSplitter.size.value = this.paneSplitRatio();
    this.paneSplitter.setExtentCells(this.paneExtentWidth());
    this.paneSplitter.beginDrag(screenColumn);
    this.paneDividerDragActive = true;
    this.update();
  }

  private continuePaneDividerDrag(screenColumn: number): void {
    this.paneSplitter.dragTo(screenColumn);
    this.update();
  }

  private endPaneDividerDrag(): void {
    if (!this.paneDividerDragActive) return;
    this.paneDividerDragActive = false;
    this.paneSplitter.endDrag();
    this.settingsSource?.save();
    this.update();
  }

  // --- editor-parity selection and drag autoscroll ---

  private paneRenderables(side: 'previous' | 'current'): DiffPaneRenderables {
    return side === 'previous' ? this.previousPaneRenderables : this.currentPaneRenderables;
  }

  private createSelectionDragBehavior(side: 'previous' | 'current'): SelectionDragBehavior.Model {
    // invariant: Diff selection reuses editor drag behavior (src/modules/diff/diff.invariants.md)
    return new SelectionDragBehavior.Class({
      viewportRectangle: () => {
        const codeRenderable = this.paneRenderables(side).code;
        return {
          leftColumn: codeRenderable.x,
          rightColumn: codeRenderable.x + Math.max(1, this.codeViewportWidth(side)) - 1,
          topRow: codeRenderable.y,
          bottomRow: codeRenderable.y + Math.max(1, this.viewportAlignedRowCount()) - 1,
        };
      },
      positionAtCell: (screenColumn, screenRow) => this.selectionPositionAtCell(side, screenColumn, screenRow),
      horizontalScrollPosition: () => this.horizontalScrollOffset.value,
      horizontalScrollingEnabled: () => true,
      lineGraphemeCount: (lineIndex) =>
        this.selectionEditor ? EditorCoordinates.Class.graphemeCount(this.selectionEditor.document.line(lineIndex)) : 0,
      beginSelection: (position, pointerDisplayColumn) => {
        this.activateSelection(side, position, pointerDisplayColumn);
      },
      extendSelection: (position, pointerDisplayColumn) => {
        if (this.activeSelectionSide !== side || !this.selectionEditor) return;
        this.selectionEditor.cursor.set(position.line, position.column, pointerDisplayColumn);
        this.selectionRevision.value += 1;
        this.update();
      },
      finishSelection: () => {
        if (this.activeSelectionSide !== side || !this.selectionEditor) return;
        if (!this.selectionEditor.cursor.hasSelection) this.selectionEditor.cursor.clearSelection();
        this.selectionRevision.value += 1;
        this.update();
      },
      scrollColumns: (columnDelta) => {
        this.horizontalScrollOffset.value = this.clampHorizontalOffset(
          this.horizontalScrollOffset.value + columnDelta,
        );
      },
      scrollRows: (rowDelta) => {
        this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(
          this.alignedRowScrollOffset.value + rowDelta,
        );
        this.synchronizeActiveChangeBlockNumber();
      },
      haltCompetingScroll: () => this.haltScrollMomentum(),
    });
  }

  private bindPaneSelectionEvents(side: 'previous' | 'current'): void {
    const codeRenderable = this.paneRenderables(side).code;
    const selectionDragBehavior = side === 'previous'
      ? this.previousSelectionDragBehavior
      : this.currentSelectionDragBehavior;
    codeRenderable.onMouseDown = (event) => selectionDragBehavior.begin(event.x, event.y);
    codeRenderable.onMouseDrag = (event) => selectionDragBehavior.drag(event.x, event.y);
    codeRenderable.onMouseUp = () => selectionDragBehavior.end();
    codeRenderable.onMouseDragEnd = () => selectionDragBehavior.end();
  }

  private selectionPositionAtCell(
    side: 'previous' | 'current',
    screenColumn: number,
    screenRow: number,
  ): SelectionDragPosition | null {
    const codeRenderable = this.paneRenderables(side).code;
    const visibleRowIndex = Math.max(
      0,
      Math.min(screenRow - codeRenderable.y, this.viewportAlignedRowCount() - 1),
    );
    const alignedRowIndex = Math.max(
      0,
      Math.min(
        this.alignedRowScrollOffset.value + visibleRowIndex,
        this.alignment.alignedRows.length - 1,
      ),
    );
    const lineNumber = this.nearestLineNumber(side, alignedRowIndex);
    if (lineNumber === null) return null;
    const sourceLine = this.lineForSide(side, lineNumber);
    // The first code cell is the unified-diff prefix (+/-/space), so the code content starts one cell
    // right of the renderable — subtract that prefix column when mapping the pointer to a source column.
    const displayColumn =
      this.horizontalScrollOffset.value + Math.max(0, screenColumn - codeRenderable.x - 1);
    return {
      line: lineNumber - 1,
      column: EditorCoordinates.Class.graphemeAtDisplayColumn(sourceLine, displayColumn),
    };
  }

  private nearestLineNumber(side: 'previous' | 'current', alignedRowIndex: number): number | null {
    const lineNumberAt = (candidateAlignedRowIndex: number): number | null => {
      const alignedRow = this.alignment.alignedRows[candidateAlignedRowIndex];
      if (!alignedRow) return null;
      return side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber;
    };
    const directLineNumber = lineNumberAt(alignedRowIndex);
    if (directLineNumber !== null) return directLineNumber;
    for (let distance = 1; distance < this.alignment.alignedRows.length; distance += 1) {
      const precedingLineNumber = lineNumberAt(alignedRowIndex - distance);
      if (precedingLineNumber !== null) return precedingLineNumber;
      const followingLineNumber = lineNumberAt(alignedRowIndex + distance);
      if (followingLineNumber !== null) return followingLineNumber;
    }
    return null;
  }

  private activateSelection(
    side: 'previous' | 'current',
    position: SelectionDragPosition,
    pointerDisplayColumn: number,
  ): void {
    this.focusedFindSide = side;
    if (side === 'previous') this.currentSelectionDragBehavior.end();
    else this.previousSelectionDragBehavior.end();
    this.selectionEditor?.dispose();
    this.selectionEditor = new Editor.Class();
    const versionText = side === 'previous' ? this.options.previousVersionText : this.options.currentVersionText;
    const versionPath = side === 'previous' ? this.options.previousVersionPath : this.options.currentVersionPath;
    this.selectionEditor.openDiff(versionPath ?? `${side} version`, versionText);
    this.activeSelectionSide = side;
    this.selectionEditor.cursor.set(position.line, position.column, pointerDisplayColumn);
    this.selectionEditor.cursor.setAnchorHere();
    this.selectionRevision.value += 1;
    this.update();
  }

  private findTargetIdentifier(side: 'previous' | 'current'): string {
    return `${this.findIdentifier}:${side}`;
  }

  private revealFindMatch(side: 'previous' | 'current', match: FindInBufferMatch): void {
    this.focusedFindSide = side;
    const matchingAlignedRowIndex = this.alignment.alignedRows.findIndex((alignedRow) => {
      const lineNumber = side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber;
      return lineNumber === match.line + 1;
    });
    if (matchingAlignedRowIndex >= 0) {
      this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(matchingAlignedRowIndex);
    }
    this.activateSelection(side, { line: match.line, column: match.endColumn }, match.endColumn);
    if (this.selectionEditor) {
      this.selectionEditor.cursor.anchor.value = { line: match.line, col: match.startColumn };
    }
    this.selectionRevision.value += 1;
    this.update();
  }

  selectionCharacterCount(): number {
    void this.selectionRevision.value;
    return this.selectionEditor?.selectionText().length ?? 0;
  }

  selectionRange(): {
    side: 'previous' | 'current';
    start: { line: number; col: number };
    end: { line: number; col: number };
  } | null {
    void this.selectionRevision.value;
    const range = this.selectionEditor?.cursor.selectionRange();
    if (!range || !this.activeSelectionSide) return null;
    return { side: this.activeSelectionSide, start: range.start, end: range.end };
  }

  async copySelection(): Promise<number> {
    return this.selectionEditor?.copySelection() ?? 0;
  }

  private applyPaneSelection(side: 'previous' | 'current'): void {
    const codeRenderable = this.paneRenderables(side).code;
    const selectionRange = this.selectionEditor?.cursor.selectionRange();
    if (this.activeSelectionSide !== side || !selectionRange) {
      codeRenderable.clearSelectionRange();
      return;
    }
    const inclusiveEndLine = selectionRange.end.col === 0 && selectionRange.end.line > selectionRange.start.line
      ? selectionRange.end.line - 1
      : selectionRange.end.line;
    const visibleAlignedRows = this.alignment.alignedRows.slice(
      this.alignedRowScrollOffset.value,
      this.alignedRowScrollOffset.value + this.viewportAlignedRowCount(),
    );
    const selectedVisibleRows = visibleAlignedRows
      .map((alignedRow, visibleRowIndex) => ({
        visibleRowIndex,
        lineNumber: side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber,
      }))
      .filter(
        (entry): entry is { visibleRowIndex: number; lineNumber: number } =>
          entry.lineNumber !== null &&
          entry.lineNumber - 1 >= selectionRange.start.line &&
          entry.lineNumber - 1 <= inclusiveEndLine,
      );
    const firstSelectedVisibleRow = selectedVisibleRows[0];
    const lastSelectedVisibleRow = selectedVisibleRows[selectedVisibleRows.length - 1];
    if (!firstSelectedVisibleRow || !lastSelectedVisibleRow) {
      codeRenderable.clearSelectionRange();
      return;
    }
    const viewportWidth = this.codeViewportWidth(side);
    const firstLineIndex = firstSelectedVisibleRow.lineNumber - 1;
    const lastLineIndex = lastSelectedVisibleRow.lineNumber - 1;
    const startDisplayColumn = firstLineIndex === selectionRange.start.line
      ? EditorCoordinates.Class.displayColumn(
          this.lineForSide(side, firstSelectedVisibleRow.lineNumber),
          selectionRange.start.col,
        ) - this.horizontalScrollOffset.value
      : 0;
    const endDisplayColumn = lastLineIndex === selectionRange.end.line
      ? EditorCoordinates.Class.displayColumn(
          this.lineForSide(side, lastSelectedVisibleRow.lineNumber),
          selectionRange.end.col,
        ) - this.horizontalScrollOffset.value
      : viewportWidth;
    // Shift the highlight right by the unified-diff prefix column so it lands over the code, not the
    // +/- marker (mirrors the -1 the pointer hit-test applies).
    const diffPrefixColumns = 1;
    codeRenderable.setSelectionRange(
      diffPrefixColumns + Math.max(0, Math.min(startDisplayColumn, viewportWidth - diffPrefixColumns)),
      firstSelectedVisibleRow.visibleRowIndex,
      diffPrefixColumns + Math.max(0, Math.min(endDisplayColumn, viewportWidth - diffPrefixColumns)),
      lastSelectedVisibleRow.visibleRowIndex,
    );
  }

  // --- input normalization ---

  onHeaderMouseDown(screenColumn: number): void {
    const localColumn = screenColumn - this.headerRenderable.x;
    const headerSegment = this.headerSegments.find(
      (segment) => localColumn >= segment.startColumn && localColumn < segment.endColumnExclusive,
    );
    if (headerSegment?.kind === 'openFull') this.openFull();
    else if (headerSegment?.kind === 'nextChange') this.jumpToNextChange();
    else if (headerSegment?.kind === 'previousChange') this.jumpToPreviousChange();
  }

  onBodyMouseScroll(
    direction: 'up' | 'down' | 'left' | 'right' | undefined,
    isHorizontalModifierPressed: boolean,
  ): void {
    const isHorizontalDirection = direction === 'left' || direction === 'right' || isHorizontalModifierPressed;
    if (isHorizontalDirection) {
      this.impulseHorizontalScroll(direction === 'left' || direction === 'up' ? -1 : 1);
    } else {
      this.impulseVerticalScroll(direction === 'up' ? -1 : 1);
    }
  }

  onVerticalScrollbarChanged(reportedPosition: number): void {
    if (this.isApplyingScrollbarGeometry) return;
    this.verticalScrollMomentum.value = Momentum.Class.halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(
      Math.round(reportedPosition * this.verticalReportedToTrueScale),
    );
    this.synchronizeActiveChangeBlockNumber();
    this.update();
  }

  onHorizontalScrollbarChanged(reportedPosition: number): void {
    if (this.isApplyingScrollbarGeometry) return;
    this.horizontalScrollMomentum.value = Momentum.Class.halt();
    this.horizontalScrollOffset.value = this.clampHorizontalOffset(
      Math.round(reportedPosition * this.horizontalReportedToTrueScale),
    );
    this.update();
  }

  // --- derived geometry and data ---

  viewportAlignedRowCount(): number {
    const bodyHeight = Number(this.bodyRenderable.height) || Number(this.rootRenderable.height) - 1;
    return Math.max(1, bodyHeight - 2);
  }

  codeViewportWidth(side: 'previous' | 'current'): number {
    const laidOutCodeWidth = Number(this.paneRenderables(side).code.width) || 0;
    if (laidOutCodeWidth > 1) return Math.max(1, laidOutCodeWidth - 1);
    const fallbackPaneWidth = side === 'previous'
      ? this.previousPaneWidth()
      : this.paneExtentWidth() - this.previousPaneWidth();
    return Math.max(1, fallbackPaneWidth - this.gutterWidth(side));
  }

  sharedCodeViewportWidth(): number {
    return Math.min(this.codeViewportWidth('previous'), this.codeViewportWidth('current'));
  }

  gutterWidth(side: 'previous' | 'current'): number {
    const lineCount = side === 'previous' ? this.previousVersionLines.length : this.currentVersionLines.length;
    return Math.max(2, String(Math.max(1, lineCount)).length + 1);
  }

  lineForSide(side: 'previous' | 'current', lineNumber: number): string {
    const lines = side === 'previous' ? this.previousVersionLines : this.currentVersionLines;
    return lines[lineNumber - 1] ?? '';
  }

  languageForSide(side: 'previous' | 'current'): LangId {
    const path = side === 'previous' ? this.options.previousVersionPath : this.options.currentVersionPath;
    return LanguageRegistry.Class.forPath(path ?? 'diff.txt');
  }

  widestVisibleLineWidth(): number {
    const visibleAlignedRows = this.alignment.alignedRows.slice(
      this.alignedRowScrollOffset.value,
      this.alignedRowScrollOffset.value + this.viewportAlignedRowCount(),
    );
    let widestLineWidth = 0;
    for (const alignedRow of visibleAlignedRows) {
      widestLineWidth = Math.max(
        widestLineWidth,
        this.lineWidthForAlignedRow(alignedRow, 'previous'),
        this.lineWidthForAlignedRow(alignedRow, 'current'),
      );
    }
    return widestLineWidth;
  }

  lineWidthForAlignedRow(alignedRow: AlignedRow, side: 'previous' | 'current'): number {
    const lineNumber = side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber;
    return lineNumber === null ? 0 : EditorCoordinates.Class.lineWidth(this.lineForSide(side, lineNumber));
  }

  clampAlignedRowOffset(alignedRowIndex: number): number {
    const maximumAlignedRowOffset = Math.max(
      0,
      this.alignment.alignedRows.length - this.viewportAlignedRowCount(),
    );
    return Math.max(0, Math.min(Math.round(alignedRowIndex), maximumAlignedRowOffset));
  }

  clampHorizontalOffset(displayColumnIndex: number): number {
    const maximumHorizontalOffset = Math.max(0, this.widestVisibleLineWidth() - this.sharedCodeViewportWidth());
    return Math.max(0, Math.min(Math.round(displayColumnIndex), maximumHorizontalOffset));
  }

  synchronizeActiveChangeBlockNumber(): void {
    if (this.alignment.changeBlocks.length === 0) {
      this.activeChangeBlockNumber.value = 0;
      return;
    }
    const alignedRowIndex = this.alignedRowScrollOffset.value;
    const containingChangeBlockNumber = this.changeBlockNumberAt(alignedRowIndex);
    if (containingChangeBlockNumber !== null) {
      this.activeChangeBlockNumber.value = containingChangeBlockNumber;
      return;
    }
    const followingChangeBlockIndex = this.alignment.changeBlocks.findIndex(
      (changeBlock) => changeBlock.startAlignedRowIndex > alignedRowIndex,
    );
    this.activeChangeBlockNumber.value =
      followingChangeBlockIndex >= 0 ? followingChangeBlockIndex + 1 : this.alignment.changeBlocks.length;
  }

  changeBlockNumberAt(alignedRowIndex: number): number | null {
    const containingChangeBlockIndex = this.alignment.changeBlocks.findIndex(
      (changeBlock) =>
        alignedRowIndex >= changeBlock.startAlignedRowIndex &&
        alignedRowIndex < changeBlock.endAlignedRowIndexExclusive,
    );
    return containingChangeBlockIndex < 0 ? null : containingChangeBlockIndex + 1;
  }

  dispose(): void {
    try {
      this.selectionEditor?.dispose();
      this.previousFindEditor.dispose();
      this.currentFindEditor.dispose();
      (this.options.parentRenderable ?? this.renderer.root).remove(this.rootRenderable);
      this.rootRenderable.destroyRecursively();
    } catch {
      // Disposal is idempotent from the caller's perspective.
    }
  }
}

export namespace DiffView {
  export const $Class = $DiffView;
  export let Class = Reactive($DiffView);
  export type Instance = typeof Class.Instance;
}
