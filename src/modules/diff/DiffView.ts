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
import { displayColumn, graphemeAtDisplayColumn, graphemeToU16, lineWidth } from '../editor/editor.coordinates';
import { Highlighter, type LangId, type Role } from '../syntax/Highlighter';
import { LanguageRegistry } from '../syntax/LanguageRegistry';
import type { Theme } from '../theme/Theme';
import type { Palette } from '../theme/ThemePalettes';
import { ScrollbarGeometry, type BarGeometry } from '../ui/ScrollbarGeometry';
import {
  AT_REST,
  DEFAULT_MOMENTUM,
  VERTICAL_MOMENTUM,
  addImpulse,
  halt,
  isMoving,
  stepMomentum,
  type ScrollMomentum,
} from '../ui/scroll-momentum';
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
  code: TextRenderable;
}

function changedRowColor(kind: AlignedRowKind, palette: Palette): string | null {
  switch (kind) {
    case 'added': return palette.added;
    case 'deleted': return palette.deleted;
    case 'modified': return palette.modified;
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
  readonly alignment: DiffAlignmentResult;
  readonly previousVersionLines: readonly string[];
  readonly currentVersionLines: readonly string[];
  readonly rootRenderable: BoxRenderable;
  private readonly headerRenderable: TextRenderable;
  private readonly bodyRenderable: BoxRenderable;
  private readonly previousPaneRenderables: DiffPaneRenderables;
  private readonly currentPaneRenderables: DiffPaneRenderables;
  private readonly verticalScrollbarRenderable: ScrollBarRenderable;
  private readonly horizontalScrollbarRenderable: ScrollBarRenderable;
  // Presentation geometry only. Projection and hit-testing share these values, but update() does
  // not mutate reactive model state and therefore cannot create a render-invalidation loop.
  private headerSegments: HeaderSegment[] = [];
  private isApplyingScrollbarGeometry = false;
  private verticalReportedToTrueScale = 1;
  private horizontalReportedToTrueScale = 1;

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
  constructor(
    public readonly renderer: CliRenderer,
    public readonly theme: Theme.Instance,
    public readonly options: DiffViewOptions,
  ) {
    this.alignment = DiffAlignment.Class.align(options.previousVersionText, options.currentVersionText);
    this.previousVersionLines = DiffAlignment.Class.splitLines(options.previousVersionText);
    this.currentVersionLines = DiffAlignment.Class.splitLines(options.currentVersionText);
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
    this.rootRenderable.add(this.headerRenderable);
    this.bodyRenderable.add(this.previousPaneRenderables.pane);
    this.bodyRenderable.add(this.currentPaneRenderables.pane);
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

  createPaneRenderables(side: 'previous' | 'current'): DiffPaneRenderables {
    const pane = this.createBoxRenderable({
      id: `diff-${side}-pane`,
      width: '50%',
      height: '100%',
      flexDirection: 'column',
      overflow: 'hidden',
      border: side === 'previous' ? ['right'] : false,
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
    const code = this.createTextRenderable({
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
    this.verticalScrollMomentum.value = addImpulse(
      this.verticalScrollMomentum.value,
      deltaRows,
      VERTICAL_MOMENTUM,
    );
  }

  impulseHorizontalScroll(deltaColumns: number): void {
    this.horizontalScrollMomentum.value = addImpulse(
      this.horizontalScrollMomentum.value,
      deltaColumns,
      DEFAULT_MOMENTUM,
    );
  }

  tickScrollMomentum(deltaTimeSeconds: number): boolean {
    const verticalStep = stepMomentum(this.verticalScrollMomentum.value, deltaTimeSeconds, VERTICAL_MOMENTUM);
    const horizontalStep = stepMomentum(this.horizontalScrollMomentum.value, deltaTimeSeconds, DEFAULT_MOMENTUM);
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
    if (verticalStep.rows !== 0 || horizontalStep.rows !== 0) this.update();
    return isMoving(verticalStep.momentum) || isMoving(horizontalStep.momentum);
  }

  moveByKeyboardAlignedRows(deltaRows: number): void {
    this.verticalScrollMomentum.value = halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(this.alignedRowScrollOffset.value + deltaRows);
    this.synchronizeActiveChangeBlockNumber();
    this.update();
  }

  moveByKeyboardColumns(deltaColumns: number): void {
    this.horizontalScrollMomentum.value = halt();
    this.horizontalScrollOffset.value = this.clampHorizontalOffset(this.horizontalScrollOffset.value + deltaColumns);
    this.update();
  }

  pageByKeyboard(direction: -1 | 1): void {
    this.moveByKeyboardAlignedRows(direction * this.viewportAlignedRowCount());
  }

  haltScrollMomentum(): void {
    this.verticalScrollMomentum.value = halt();
    this.horizontalScrollMomentum.value = halt();
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
    this.verticalScrollMomentum.value = halt();
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
    this.verticalScrollMomentum.value = halt();
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
    this.rootRenderable.backgroundColor = palette.bg;
    this.headerRenderable.bg = palette.statusBg;
    this.bodyRenderable.backgroundColor = palette.bg;
    this.previousPaneRenderables.pane.borderColor = palette.border;
    this.previousPaneRenderables.title.bg = palette.panel;
    this.currentPaneRenderables.title.bg = palette.panel;
    this.previousPaneRenderables.title.content = new StyledText([
      fg(palette.dim)(` Previous — ${this.options.previousVersionPath ?? 'previous version'}`),
    ]);
    this.currentPaneRenderables.title.content = new StyledText([
      fg(palette.accent)(` Current — ${this.options.currentVersionPath ?? 'current version'}`),
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
    this.synchronizeScrollbars();
    this.renderer.requestRender();
  }

  renderHeader(palette: Palette): StyledText {
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
      appendSegment('openFull', openLabel, palette.accent),
      appendSegment('previousChange', previousLabel, palette.dim),
      appendSegment('nextChange', nextLabel, palette.dim),
      fg(palette.fg)(` ${changeCounter}`),
    ];
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
    const codeViewportWidth = this.codeViewportWidth();
    const language = this.languageForSide(side);
    const gutterChunks: TextChunk[] = [];
    const codeChunks: TextChunk[] = [];

    visibleAlignedRows.forEach((alignedRow, visibleAlignedRowIndex) => {
      const lineNumber = side === 'previous' ? alignedRow.leftLineNumber : alignedRow.rightLineNumber;
      const isFillerRow = lineNumber === null;
      const rowBackgroundColor = changedRowColor(alignedRow.kind, palette);
      const gutterText = isFillerRow
        ? ' '.repeat(gutterWidth)
        : `${String(lineNumber).padStart(gutterWidth - 1, ' ')} `;
      const gutterChunk = fg(isFillerRow ? palette.dim : rowBackgroundColor ?? palette.dim)(gutterText);
      gutterChunks.push(
        isFillerRow
          ? dim(rowBackgroundColor ? bg(rowBackgroundColor)(gutterChunk) : gutterChunk)
          : rowBackgroundColor
            ? bg(rowBackgroundColor)(gutterChunk)
            : gutterChunk,
      );

      if (isFillerRow) {
        const fillerChunk = dim(fg(palette.dim)(' '.repeat(codeViewportWidth)));
        codeChunks.push(rowBackgroundColor ? bg(rowBackgroundColor)(fillerChunk) : fillerChunk);
      } else {
        const sourceLine = this.lineForSide(side, lineNumber);
        const visibleLine = this.sliceLineWindow(sourceLine, codeViewportWidth);
        const lineChunks = this.highlightLine(visibleLine, language, palette, rowBackgroundColor);
        codeChunks.push(...lineChunks);
        const remainingColumns = Math.max(0, codeViewportWidth - lineWidth(visibleLine));
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
  ): TextChunk[] {
    // This is the same viewport-local LanguageRegistry + Highlighter seam used by the editor. A
    // future Tree-sitter provider upgrades LanguageRegistry without a second diff rendering path.
    const highlightedSpans = Highlighter.Class.highlightLine(visibleLine, language);
    return highlightedSpans.map((highlightedSpan) => {
      const syntaxChunk = fg(syntaxRoleColor(highlightedSpan.role, palette))(highlightedSpan.text);
      return rowBackgroundColor ? bg(rowBackgroundColor)(syntaxChunk) : syntaxChunk;
    });
  }

  sliceLineWindow(sourceLine: string, codeViewportWidth: number): string {
    const horizontalScrollOffset = this.horizontalScrollOffset.value;
    if (horizontalScrollOffset === 0 && sourceLine.length <= codeViewportWidth) return sourceLine;
    let startGraphemeIndex = graphemeAtDisplayColumn(sourceLine, horizontalScrollOffset);
    if (displayColumn(sourceLine, startGraphemeIndex) < horizontalScrollOffset) startGraphemeIndex++;
    const endGraphemeIndex =
      graphemeAtDisplayColumn(sourceLine, horizontalScrollOffset + codeViewportWidth) + 1;
    return sourceLine.slice(
      graphemeToU16(sourceLine, startGraphemeIndex),
      graphemeToU16(sourceLine, endGraphemeIndex),
    );
  }

  synchronizeScrollbars(): void {
    const bodyWidth = Math.max(1, Number(this.bodyRenderable.width) || 1);
    const bodyHeight = Math.max(1, Number(this.bodyRenderable.height) || 1);
    const region = { top: 0, left: 0, width: bodyWidth, height: bodyHeight };
    this.applyScrollbarGeometry(
      this.verticalScrollbarRenderable,
      'vertical',
      ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, {
        scrollSize: this.alignment.alignedRows.length,
        viewportSize: this.viewportAlignedRowCount(),
        scrollPosition: this.alignedRowScrollOffset.value,
      }),
      this.alignment.alignedRows.length,
    );
    this.applyScrollbarGeometry(
      this.horizontalScrollbarRenderable,
      'horizontal',
      ScrollbarGeometry.Class.scrollbarGeometry('horizontal', region, {
        scrollSize: this.widestVisibleLineWidth(),
        viewportSize: this.codeViewportWidth(),
        scrollPosition: this.horizontalScrollOffset.value,
      }),
      this.widestVisibleLineWidth(),
    );
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
    this.verticalScrollMomentum.value = halt();
    this.alignedRowScrollOffset.value = this.clampAlignedRowOffset(
      Math.round(reportedPosition * this.verticalReportedToTrueScale),
    );
    this.synchronizeActiveChangeBlockNumber();
    this.update();
  }

  onHorizontalScrollbarChanged(reportedPosition: number): void {
    if (this.isApplyingScrollbarGeometry) return;
    this.horizontalScrollMomentum.value = halt();
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

  codeViewportWidth(): number {
    const previousCodeWidth = Number(this.previousPaneRenderables.code.width) || 0;
    const currentCodeWidth = Number(this.currentPaneRenderables.code.width) || 0;
    const laidOutSharedWidth = Math.min(previousCodeWidth, currentCodeWidth);
    if (laidOutSharedWidth > 1) return Math.max(1, laidOutSharedWidth - 1);
    return Math.max(1, Math.floor((Number(this.bodyRenderable.width) || 80) / 2) - 6);
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
    return lineNumber === null ? 0 : lineWidth(this.lineForSide(side, lineNumber));
  }

  clampAlignedRowOffset(alignedRowIndex: number): number {
    const maximumAlignedRowOffset = Math.max(
      0,
      this.alignment.alignedRows.length - this.viewportAlignedRowCount(),
    );
    return Math.max(0, Math.min(Math.round(alignedRowIndex), maximumAlignedRowOffset));
  }

  clampHorizontalOffset(displayColumnIndex: number): number {
    const maximumHorizontalOffset = Math.max(0, this.widestVisibleLineWidth() - this.codeViewportWidth());
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
