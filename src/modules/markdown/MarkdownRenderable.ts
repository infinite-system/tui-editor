import {
  BoxRenderable,
  TextRenderable,
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

export interface MarkdownRenderableTheme {
  readonly palette: Palette;
}

export type MarkdownRenderableOptions = Omit<BoxOptions, 'flexDirection'>;

// invariant: Preview rendering follows visible rows (src/modules/markdown/markdown.invariants.md)
class $MarkdownRenderable extends BoxRenderable {
  private readonly body: TextRenderable;

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
    this.body = new TextRenderable(renderer, {
      id: 'markdown-preview-body',
      width: '100%',
      height: '100%',
      content: '',
      wrapMode: 'none',
      truncate: true,
    });
    this.add(this.body);
    this.preview.attachRenderTarget(this);
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
    const chunks: TextChunk[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      this.appendRow(chunks, rows[rowIndex]!, palette);
      if (rowIndex < rows.length - 1) chunks.push(fg(palette.fg)('\n'));
    }
    this.body.content = new StyledText(chunks);
    this.body.fg = palette.fg;
    this.backgroundColor = palette.bg;
  }

  private appendRow(chunks: TextChunk[], row: PreviewRow, palette: Palette): void {
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
    this.appendInline(chunks, block, row, palette);
    if (row.suffix) chunks.push(this.decoratePrefix(row.suffix, row, palette));
  }

  private appendInline(
    chunks: TextChunk[],
    block: BlockRecord,
    row: PreviewRow,
    palette: Palette,
  ): void {
    let position = row.textStart;
    const spans = block.spans;
    while (position < row.textEnd) {
      let nextBoundary = row.textEnd;
      let activeStyle = 0;
      let activeLink = 0;

      for (let spanIndex = 0; spanIndex < spans.length; spanIndex += 4) {
        const spanStart = spans[spanIndex]!;
        const spanEnd = spans[spanIndex + 1]!;
        if (spanStart <= position && spanEnd > position) {
          activeStyle = spans[spanIndex + 2]!;
          activeLink = spans[spanIndex + 3]!;
          nextBoundary = Math.min(nextBoundary, spanEnd);
        } else if (spanStart > position) {
          nextBoundary = Math.min(nextBoundary, spanStart);
        }
      }

      const text = block.text.slice(position, nextBoundary);
      chunks.push(this.decorateText(text, block, row, activeStyle, activeLink, palette));
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
}

export namespace MarkdownRenderable {
  export const $Class = $MarkdownRenderable;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
