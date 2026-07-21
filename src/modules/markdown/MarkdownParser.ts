export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'listitem'
  | 'code'
  | 'blockquote'
  | 'table'
  | 'hr';

export const enum InlineStyle {
  Emphasis = 1,
  Strong = 2,
  Code = 3,
  Link = 4,
}

export interface BlockRange {
  /** Zero-based, inclusive source line. */
  startLine: number;
  /** Zero-based, exclusive source line. */
  endLine: number;
  /** Inclusive UTF-16 source offset. */
  startOffset: number;
  /** Exclusive UTF-16 source offset. */
  endOffset: number;
}

/**
 * Compact block record. Inline spans are packed as repeated
 * [start, end, InlineStyle, linkIndexPlusOne] integers, never token objects.
 */
export interface BlockRecord {
  kind: BlockKind;
  level?: number;
  marker?: string;
  language?: string;
  text: string;
  spans: readonly number[];
  links: readonly string[];
  range: BlockRange;
}

export interface MarkdownParseResult {
  revision: number;
  blocks: readonly BlockRecord[];
}

interface SourceLine {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface InlineResult {
  text: string;
  spans: number[];
  links: string[];
}

const EMPTY_NUMBERS: readonly number[] = Object.freeze([]);
const EMPTY_STRINGS: readonly string[] = Object.freeze([]);

// invariant: Markdown blocks stay compact (src/modules/markdown/markdown.invariants.md)
class $MarkdownParser {
  parse(text: string, revision = 0): MarkdownParseResult {
    const lines = this.splitSourceLines(text);
    const blocks: BlockRecord[] = [];
    let lineIndex = 0;

    while (lineIndex < lines.length) {
      if (this.isBlank(lines[lineIndex]!.text)) {
        lineIndex++;
        continue;
      }

      const codeEnd = this.readCodeBlock(lines, lineIndex, blocks);
      if (codeEnd !== lineIndex) {
        lineIndex = codeEnd;
        continue;
      }

      const tableEnd = this.readTable(lines, lineIndex, blocks);
      if (tableEnd !== lineIndex) {
        lineIndex = tableEnd;
        continue;
      }

      const headingEnd = this.readHeading(lines, lineIndex, blocks);
      if (headingEnd !== lineIndex) {
        lineIndex = headingEnd;
        continue;
      }

      if (this.isHorizontalRule(lines[lineIndex]!.text)) {
        blocks.push(this.createBlock('hr', '─', lineIndex, lineIndex + 1, lines));
        lineIndex++;
        continue;
      }

      const quoteEnd = this.readBlockquote(lines, lineIndex, blocks);
      if (quoteEnd !== lineIndex) {
        lineIndex = quoteEnd;
        continue;
      }

      const listEnd = this.readList(lines, lineIndex, blocks);
      if (listEnd !== lineIndex) {
        lineIndex = listEnd;
        continue;
      }

      lineIndex = this.readParagraph(lines, lineIndex, blocks);
    }

    return { revision, blocks };
  }

  async parseAsync(text: string, revision: number): Promise<MarkdownParseResult> {
    await Promise.resolve();
    return this.parse(text, revision);
  }

  dispose(): void {
    // Plain parser currently owns no native handle. The seam remains for a future parser.
  }

  private splitSourceLines(source: string): SourceLine[] {
    const lines: SourceLine[] = [];
    const expression = /.*(?:\r\n|\n|$)/g;
    let match: RegExpExecArray | null;

    while ((match = expression.exec(source))) {
      if (!match[0] && match.index === source.length) break;
      const raw = match[0];
      const eolLength = raw.endsWith('\r\n') ? 2 : raw.endsWith('\n') ? 1 : 0;
      lines.push({
        text: raw.slice(0, raw.length - eolLength),
        startOffset: match.index,
        endOffset: match.index + raw.length - eolLength,
      });
      if (expression.lastIndex >= source.length) break;
    }

    return lines.length ? lines : [{ text: '', startOffset: 0, endOffset: 0 }];
  }

  private readCodeBlock(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    const opening = lines[startLine]!.text.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (!opening) return startLine;

    const fence = opening[1]!;
    const closingExpression = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    const content: string[] = [];
    let endLine = startLine + 1;
    while (endLine < lines.length && !closingExpression.test(lines[endLine]!.text)) {
      content.push(lines[endLine]!.text);
      endLine++;
    }
    if (endLine < lines.length) endLine++;

    const block = this.createBlock('code', content.join('\n'), startLine, endLine, lines);
    block.language = opening[2] || undefined;
    blocks.push(block);
    return endLine;
  }

  private readTable(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    if (
      startLine + 1 >= lines.length ||
      !lines[startLine]!.text.includes('|') ||
      !this.isTableSeparator(lines[startLine + 1]!.text)
    ) {
      return startLine;
    }

    const rows: string[] = [this.normalizeTableRow(lines[startLine]!.text)];
    let endLine = startLine + 2;
    while (
      endLine < lines.length &&
      !this.isBlank(lines[endLine]!.text) &&
      lines[endLine]!.text.includes('|')
    ) {
      rows.push(this.normalizeTableRow(lines[endLine]!.text));
      endLine++;
    }

    blocks.push(this.createInlineBlock('table', rows.join('\n'), startLine, endLine, lines));
    return endLine;
  }

  private readHeading(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    const atx = lines[startLine]!.text.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (atx) {
      const block = this.createInlineBlock('heading', atx[2]!, startLine, startLine + 1, lines);
      block.level = atx[1]!.length;
      blocks.push(block);
      return startLine + 1;
    }

    if (startLine + 1 < lines.length) {
      const setext = lines[startLine + 1]!.text.match(/^\s*(=+|-+)\s*$/);
      if (setext && !this.isBlank(lines[startLine]!.text)) {
        const block = this.createInlineBlock(
          'heading',
          lines[startLine]!.text.trim(),
          startLine,
          startLine + 2,
          lines,
        );
        block.level = setext[1]![0] === '=' ? 1 : 2;
        blocks.push(block);
        return startLine + 2;
      }
    }

    return startLine;
  }

  private readBlockquote(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    if (!/^\s*>/.test(lines[startLine]!.text)) return startLine;

    const content: string[] = [];
    let endLine = startLine;
    while (endLine < lines.length && /^\s*>/.test(lines[endLine]!.text)) {
      content.push(lines[endLine]!.text.replace(/^\s*>\s?/, ''));
      endLine++;
    }
    blocks.push(this.createInlineBlock('blockquote', content.join('\n'), startLine, endLine, lines));
    return endLine;
  }

  private readList(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    if (!this.matchListItem(lines[startLine]!.text)) return startLine;

    let endLine = startLine;
    const items: BlockRecord[] = [];
    while (endLine < lines.length) {
      const item = this.matchListItem(lines[endLine]!.text);
      if (!item) break;
      const block = this.createInlineBlock('listitem', item.text, endLine, endLine + 1, lines);
      block.level = Math.floor(item.indent.length / 2) + 1;
      block.marker = /^\d/.test(item.marker) ? item.marker : '•';
      items.push(block);
      endLine++;
    }

    const container = this.createBlock('list', '', startLine, endLine, lines);
    container.level = Math.min(...items.map((item) => item.level ?? 1));
    blocks.push(container, ...items);
    return endLine;
  }

  private readParagraph(
    lines: readonly SourceLine[],
    startLine: number,
    blocks: BlockRecord[],
  ): number {
    const content: string[] = [];
    let endLine = startLine;
    while (endLine < lines.length && !this.isBlank(lines[endLine]!.text)) {
      if (endLine > startLine && this.startsBlock(lines, endLine)) break;
      content.push(lines[endLine]!.text.trim());
      endLine++;
    }
    blocks.push(this.createInlineBlock('paragraph', content.join(' '), startLine, endLine, lines));
    return endLine;
  }

  private startsBlock(lines: readonly SourceLine[], lineIndex: number): boolean {
    const text = lines[lineIndex]!.text;
    return (
      /^\s*(#{1,6})\s+/.test(text) ||
      /^\s*(`{3,}|~{3,})/.test(text) ||
      /^\s*>/.test(text) ||
      Boolean(this.matchListItem(text)) ||
      this.isHorizontalRule(text) ||
      (lineIndex + 1 < lines.length && text.includes('|') && this.isTableSeparator(lines[lineIndex + 1]!.text))
    );
  }

  private createInlineBlock(
    kind: BlockKind,
    sourceText: string,
    startLine: number,
    endLine: number,
    lines: readonly SourceLine[],
  ): BlockRecord {
    const inline = this.parseInline(sourceText);
    return this.createBlock(kind, inline.text, startLine, endLine, lines, inline.spans, inline.links);
  }

  private createBlock(
    kind: BlockKind,
    text: string,
    startLine: number,
    endLine: number,
    lines: readonly SourceLine[],
    spans: readonly number[] = EMPTY_NUMBERS,
    links: readonly string[] = EMPTY_STRINGS,
  ): BlockRecord {
    const finalLine = lines[Math.max(startLine, endLine - 1)]!;
    return {
      kind,
      text,
      spans,
      links,
      range: {
        startLine,
        endLine,
        startOffset: lines[startLine]!.startOffset,
        endOffset: finalLine.endOffset,
      },
    };
  }

  private parseInline(source: string): InlineResult {
    let output = '';
    const spans: number[] = [];
    const links: string[] = [];
    let sourceIndex = 0;

    while (sourceIndex < source.length) {
      const linkMatch = source.slice(sourceIndex).match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (linkMatch) {
        const start = output.length;
        output += linkMatch[1]!;
        links.push(linkMatch[2]!);
        spans.push(start, output.length, InlineStyle.Link, links.length);
        sourceIndex += linkMatch[0].length;
        continue;
      }

      const codeMatch = source.slice(sourceIndex).match(/^`([^`]+)`/);
      if (codeMatch) {
        const start = output.length;
        output += codeMatch[1]!;
        spans.push(start, output.length, InlineStyle.Code, 0);
        sourceIndex += codeMatch[0].length;
        continue;
      }

      const strongMatch = source.slice(sourceIndex).match(/^(\*\*|__)(.+?)\1/);
      if (strongMatch) {
        const start = output.length;
        output += strongMatch[2]!;
        spans.push(start, output.length, InlineStyle.Strong, 0);
        sourceIndex += strongMatch[0].length;
        continue;
      }

      const emphasisMatch = source.slice(sourceIndex).match(/^(\*|_)([^*_\n]+?)\1/);
      if (emphasisMatch) {
        const start = output.length;
        output += emphasisMatch[2]!;
        spans.push(start, output.length, InlineStyle.Emphasis, 0);
        sourceIndex += emphasisMatch[0].length;
        continue;
      }

      if (source[sourceIndex] === '\\' && sourceIndex + 1 < source.length) {
        output += source[sourceIndex + 1]!;
        sourceIndex += 2;
        continue;
      }

      output += source[sourceIndex]!;
      sourceIndex++;
    }

    return { text: output, spans, links };
  }

  private matchListItem(text: string): { indent: string; marker: string; text: string } | null {
    const match = text.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    return match ? { indent: match[1]!, marker: match[2]!, text: match[3]! } : null;
  }

  private isTableSeparator(text: string): boolean {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text);
  }

  private normalizeTableRow(text: string): string {
    return text.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join(' │ ');
  }

  private isHorizontalRule(text: string): boolean {
    return /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(text);
  }

  private isBlank(text: string): boolean {
    return /^\s*$/.test(text);
  }
}

export namespace MarkdownParser {
  export const $Class = $MarkdownParser;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
