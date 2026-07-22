import {
  BoxRenderable,
  StyledText,
  fg,
  bg,
  bold,
  italic,
  underline,
  link as terminalLink,
  type BoxOptions,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core';
import { InlineStyle, type BlockRecord } from './MarkdownParser';
import { MarkdownPreview, type PreviewRow } from './MarkdownPreview';
import type { Palette } from '../theme/ThemePalettes';
import { SelectableText } from '../ui/SelectableText';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import type { FindInBuffer } from '../search/FindInBuffer';

export interface MarkdownRenderableTheme {
  readonly palette: Palette;
}

export type MarkdownRenderableOptions = Omit<BoxOptions, 'flexDirection'>;

export interface MarkdownReferenceHit {
  key: string;
  target: string;
}

// invariant: Preview rendering follows visible rows (src/modules/markdown/markdown.invariants.md)
class $MarkdownRenderable extends BoxRenderable {
  readonly bodyRenderable: SelectableText;
  private visibleRowsSnapshot: PreviewRow[] = [];
  private hoveredReferenceKey: string | null = null;
  private findEngineProvider: (() => FindInBuffer.Instance | null) | null = null;

  constructor(
    renderer: CliRenderer,
    readonly preview: MarkdownPreview.Model,
    readonly theme: MarkdownRenderableTheme,
    options: MarkdownRenderableOptions = {},
  ) {
    super(renderer, {
      id: 'markdown-preview',
      flexGrow: 1,
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      padding: 0,
      overflow: 'hidden',
      ...options,
    });
    this.bodyRenderable = new SelectableText(renderer, {
      id: 'markdown-preview-body',
      width: '100%',
      height: '100%',
      content: '',
      wrapMode: 'none',
      truncate: true,
      selectable: false,
    });
    this.add(this.bodyRenderable);
    this.preview.attachRenderTarget(this);
  }

  setHoveredReferenceKey(referenceKey: string | null): void {
    this.hoveredReferenceKey = referenceKey;
  }

  attachFindEngineProvider(provider: () => FindInBuffer.Instance | null): void {
    this.findEngineProvider = provider;
  }

  refresh(): void {
    this.pullVisibleRows();
  }

  positionAtCell(screenColumn: number, screenRow: number): { line: number; column: number } | null {
    const visibleRowIndex = screenRow - this.bodyRenderable.y;
    const row = this.visibleRowsSnapshot[visibleRowIndex];
    if (!row) return null;
    const rowText = this.preview.textForRow(row);
    return {
      line: this.preview.scrollTop.value + visibleRowIndex,
      column: EditorCoordinates.Class.graphemeAtDisplayColumn(
        rowText,
        Math.max(0, screenColumn - this.bodyRenderable.x),
      ),
    };
  }

  referenceAtCell(screenColumn: number, screenRow: number): MarkdownReferenceHit | null {
    const visibleRowIndex = screenRow - this.bodyRenderable.y;
    const row = this.visibleRowsSnapshot[visibleRowIndex];
    if (!row?.block) return null;
    const rowText = this.preview.textForRow(row);
    const rowGraphemeColumn = EditorCoordinates.Class.graphemeAtDisplayColumn(
      rowText,
      Math.max(0, screenColumn - this.bodyRenderable.x),
    );
    const rowUtf16Offset = EditorCoordinates.Class.graphemeToU16(rowText, rowGraphemeColumn);
    const blockUtf16Offset = row.textStart + rowUtf16Offset - row.prefix.length;
    for (let spanIndex = 0; spanIndex < row.block.spans.length; spanIndex += 4) {
      const spanStart = row.block.spans[spanIndex]!;
      const spanEnd = row.block.spans[spanIndex + 1]!;
      const inlineStyle = row.block.spans[spanIndex + 2]!;
      const linkIndexPlusOne = row.block.spans[spanIndex + 3]!;
      if (blockUtf16Offset < spanStart || blockUtf16Offset >= spanEnd) continue;
      const target = inlineStyle === InlineStyle.Link
        ? row.block.links[linkIndexPlusOne - 1]
        : inlineStyle === InlineStyle.Code
          ? row.block.text.slice(spanStart, spanEnd)
          : undefined;
      if (!target) return null;
      return {
        key: this.referenceKey(row.blockIndex, spanStart, spanEnd, inlineStyle),
        target,
      };
    }
    return null;
  }

  setSelectionRange(anchorColumn: number, anchorRow: number, focusColumn: number, focusRow: number): void {
    this.bodyRenderable.setSelectionRange(anchorColumn, anchorRow, focusColumn, focusRow);
  }

  clearSelectionRange(): void {
    this.bodyRenderable.clearSelectionRange();
  }

  protected override onUpdate(deltaTime: number): void {
    this.pullVisibleRows();
    super.onUpdate(deltaTime);
  }

  protected override destroySelf(): void {
    this.preview.detachRenderTarget(this);
    super.destroySelf();
  }

  private pullVisibleRows(): void {
    const palette = this.theme.palette;
    const width = Math.max(1, this.width);
    const height = Math.max(1, this.height);
    const rows = this.preview.visibleRows(width, height);
    this.visibleRowsSnapshot = rows;
    const chunks: TextChunk[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      this.appendRow(chunks, rows[rowIndex]!, rowIndex, palette);
      if (rowIndex < rows.length - 1) chunks.push(fg(palette.fg)('\n'));
    }
    this.bodyRenderable.content = new StyledText(chunks);
    this.bodyRenderable.fg = palette.fg;
    this.backgroundColor = palette.bg;
  }

  private appendRow(chunks: TextChunk[], row: PreviewRow, visibleRowIndex: number, palette: Palette): void {
    if (row.role === 'spacer') {
      chunks.push(fg(palette.fg)(''));
      return;
    }
    if (row.role === 'status') {
      chunks.push(italic(fg(palette.dim)(row.overrideText ?? '')));
      return;
    }
    if (row.role === 'rule' || row.role === 'codeBorder') {
      chunks.push(fg(row.role === 'rule' ? palette.dim : palette.border)(row.overrideText ?? ''));
      return;
    }

    const block = row.block;
    if (!block) return;
    chunks.push(this.decoratePrefix(row.prefix, row, palette));
    this.appendInline(chunks, block, row, visibleRowIndex, palette);
    if (row.suffix) chunks.push(this.decoratePrefix(row.suffix, row, palette));
  }

  private appendInline(
    chunks: TextChunk[],
    block: BlockRecord,
    row: PreviewRow,
    visibleRowIndex: number,
    palette: Palette,
  ): void {
    let position = row.textStart;
    const spans = block.spans;
    const findEngine = this.findEngineProvider?.() ?? null;
    const renderedRowIndex = this.preview.scrollTop.value + visibleRowIndex;
    const findMatches = findEngine?.matches.value.filter((match) => match.line === renderedRowIndex) ?? [];
    const rowText = this.preview.textForRow(row);
    while (position < row.textEnd) {
      let nextBoundary = row.textEnd;
      let activeStyle = 0;
      let activeLink = 0;
      let activeSpanStart = -1;
      let activeSpanEnd = -1;

      for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 4) {
        const spanStart = spans[spanIndex]!;
        const spanEnd = spans[spanIndex + 1]!;
        if (spanStart <= position && spanEnd > position) {
          activeStyle = spans[spanIndex + 2]!;
          activeLink = spans[spanIndex + 3]!;
          activeSpanStart = spanStart;
          activeSpanEnd = spanEnd;
          nextBoundary = Math.min(nextBoundary, spanEnd);
        } else if (spanStart > position) {
          nextBoundary = Math.min(nextBoundary, spanStart);
        }
      }

      let findHighlighted = false;
      for (const match of findMatches) {
        const matchStartUtf16 = EditorCoordinates.Class.graphemeToU16(rowText, match.startColumn);
        const matchEndUtf16 = EditorCoordinates.Class.graphemeToU16(rowText, match.endColumn);
        const blockMatchStart = row.textStart + matchStartUtf16 - row.prefix.length;
        const blockMatchEnd = row.textStart + matchEndUtf16 - row.prefix.length;
        if (blockMatchStart <= position && blockMatchEnd > position) {
          findHighlighted = true;
          nextBoundary = Math.min(nextBoundary, blockMatchEnd);
        } else if (blockMatchStart > position) {
          nextBoundary = Math.min(nextBoundary, blockMatchStart);
        }
      }

      const text = block.text.slice(position, nextBoundary);
      const referenceKey = activeSpanStart >= 0
        ? this.referenceKey(row.blockIndex, activeSpanStart, activeSpanEnd, activeStyle)
        : null;
      chunks.push(this.decorateText(
        text,
        block,
        row,
        activeStyle,
        activeLink,
        findHighlighted,
        referenceKey !== null && referenceKey === this.hoveredReferenceKey,
        palette,
      ));
      position = nextBoundary;
    }
  }

  private decoratePrefix(text: string, row: PreviewRow, palette: Palette): TextChunk {
    if (row.role === 'codeContent') return bg(palette.panel)(fg(palette.border)(text));
    if (row.role === 'quote') return bold(fg(palette.accent)(text));
    if (row.role === 'table') return fg(palette.border)(text);
    return fg(palette.accent)(text);
  }

  private decorateText(
    text: string,
    block: BlockRecord,
    row: PreviewRow,
    inlineStyle: number,
    linkIndexPlusOne: number,
    findHighlighted: boolean,
    referenceHovered: boolean,
    palette: Palette,
  ): TextChunk {
    const color = this.blockColor(block.kind, row, palette);
    let chunk = fg(color)(text);

    if (row.role === 'codeContent' || inlineStyle === InlineStyle.Code) {
      chunk = bg(palette.panel)(fg(palette.string)(chunk));
    } else if (inlineStyle === InlineStyle.Emphasis) {
      chunk = italic(chunk);
    } else if (inlineStyle === InlineStyle.Strong) {
      chunk = bold(chunk);
    } else if (inlineStyle === InlineStyle.Link) {
      chunk = underline(fg(palette.accent)(chunk));
      const target = block.links[linkIndexPlusOne - 1];
      if (target) chunk = terminalLink(target)(chunk);
    }

    if (referenceHovered) chunk = bold(underline(fg(palette.accent)(chunk)));
    if (findHighlighted) chunk = bg(palette.cursorLine)(chunk);

    if (block.kind === 'heading') chunk = bold(chunk);
    return chunk;
  }

  private blockColor(kind: BlockRecord['kind'], row: PreviewRow, palette: Palette): string {
    if (kind === 'heading') return palette.accent;
    if (row.role === 'quote') return palette.dim;
    if (row.role === 'table') return palette.fg;
    if (row.role === 'codeContent') return palette.string;
    return palette.fg;
  }


  private referenceKey(blockIndex: number, spanStart: number, spanEnd: number, inlineStyle: number): string {
    return `${blockIndex}:${spanStart}:${spanEnd}:${inlineStyle}`;
  }
}

export namespace MarkdownRenderable {
  export const $Class = $MarkdownRenderable;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
