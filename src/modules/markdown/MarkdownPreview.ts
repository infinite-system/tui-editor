import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { MarkdownDocument, type MarkdownDocumentOptions, type MarkdownSource } from './MarkdownDocument';
import type { BlockRecord, BlockKind } from './MarkdownParser';
import { StatusChannel } from '../system/StatusChannel';

export interface RenderTarget {
  requestRender(): void;
}

export type PreviewRowRole =
  | 'content'
  | 'codeBorder'
  | 'codeContent'
  | 'quote'
  | 'table'
  | 'rule'
  | 'spacer'
  | 'status';

/** Ephemeral flyweight row. Only rows in the requested viewport are instantiated. */
export interface PreviewRow {
  block: BlockRecord | null;
  blockIndex: number;
  textStart: number;
  textEnd: number;
  prefix: string;
  suffix: string;
  role: PreviewRowRole;
  overrideText?: string;
}

type EmitRow = (
  block: BlockRecord | null,
  blockIndex: number,
  textStart: number,
  textEnd: number,
  prefix: string,
  suffix: string,
  role: PreviewRowRole,
  overrideText?: string,
) => boolean;

const EMPTY_BLOCKS: readonly BlockRecord[] = Object.freeze([]);

// invariant: Parsing starts only after opening (src/modules/markdown/markdown.invariants.md)
// invariant: Preview rendering follows visible rows (src/modules/markdown/markdown.invariants.md)
class $MarkdownPreview {
  declare $watchEffect: typeof import('vue').watchEffect;
  declare $stopEffects: () => void;

  private renderTarget: RenderTarget | null = null;
  private documentOptions: MarkdownDocumentOptions = {};

  get document() {
    return shallowRef<MarkdownDocument.Model | null>(null);
  }
  get active() {
    return ref(false);
  }
  get scrollTop() {
    return ref(0);
  }

  get blocks(): readonly BlockRecord[] {
    return this.document.value?.blocks.value ?? EMPTY_BLOCKS;
  }

  get parsedRevision(): number {
    return this.document.value?.revision.value ?? -1;
  }

  open(
    source: MarkdownSource,
    renderTarget: RenderTarget | null = null,
    documentOptions: MarkdownDocumentOptions = {},
  ): void {
    if (this.active.value) this.close();

    this.documentOptions = documentOptions;
    this.renderTarget = renderTarget;
    const document = this.createDocument(source);
    this.document.value = document;
    this.scrollTop.value = 0;
    this.active.value = true;
    document.open();
    this.$watchEffect(() => this.invalidateRender());
    StatusChannel.Class.update({ markdownPreviewOpen: true, markdownScrollTop: 0 });
  }

  // invariant: Closing releases all preview work (src/modules/markdown/markdown.invariants.md)
  close(): void {
    const target = this.renderTarget;
    this.document.value?.close();
    this.document.value = null;
    this.active.value = false;
    this.scrollTop.value = 0;
    this.renderTarget = null;
    this.documentOptions = {};
    this.$stopEffects();
    target?.requestRender();
    StatusChannel.Class.update({
      markdownPreviewOpen: false,
      markdownScrollTop: 0,
      markdownBlockCount: 0,
    });
  }

  dispose(): void {
    this.close();
  }

  attachRenderTarget(target: RenderTarget): void {
    this.renderTarget = target;
    if (this.active.value) target.requestRender();
  }

  detachRenderTarget(target: RenderTarget): void {
    if (this.renderTarget === target) this.renderTarget = null;
  }

  scrollBy(delta: number, width: number, height: number): void {
    const maximum = Math.max(0, this.totalRows(width) - Math.max(1, height));
    this.scrollTop.value = Math.max(0, Math.min(maximum, this.scrollTop.value + delta));
    StatusChannel.Class.update({ markdownScrollTop: this.scrollTop.value });
  }

  scrollTo(row: number, width: number, height: number): void {
    const maximum = Math.max(0, this.totalRows(width) - Math.max(1, height));
    this.scrollTop.value = Math.max(0, Math.min(maximum, row));
    StatusChannel.Class.update({ markdownScrollTop: this.scrollTop.value });
  }

  // invariant: Preview rendering follows visible rows (src/modules/markdown/markdown.invariants.md)
  visibleRows(width: number, height: number): PreviewRow[] {
    const document = this.document.value;
    const rowWidth = Math.max(1, Math.floor(width));
    const rowLimit = Math.max(0, Math.floor(height));
    if (!document || rowLimit === 0) return [];

    if (document.error.value) return [this.statusRow(`Markdown: ${document.error.value}`)];
    if (document.parsing.value && document.blocks.value.length === 0) {
      return [this.statusRow('Parsing Markdown…')];
    }

    return this.collectRows(document.blocks.value, rowWidth, this.scrollTop.value, rowLimit);
  }

  totalRows(width: number): number {
    const document = this.document.value;
    if (!document) return 0;
    let rowCount = 0;
    const emit: EmitRow = () => {
      rowCount++;
      return false;
    };
    this.visitBlocks(document.blocks.value, Math.max(1, Math.floor(width)), emit);
    return rowCount;
  }

  protected createDocument(source: MarkdownSource): MarkdownDocument.Model {
    return new MarkdownDocument.Class(source, this.documentOptions);
  }

  private invalidateRender(): void {
    void this.active.value;
    void this.scrollTop.value;
    const document = this.document.value;
    if (document) {
      void document.revision.value;
      void document.parsing.value;
      void document.error.value;
    }
    this.renderTarget?.requestRender();
  }

  private collectRows(
    blocks: readonly BlockRecord[],
    width: number,
    firstVisible: number,
    visibleCount: number,
  ): PreviewRow[] {
    const rows: PreviewRow[] = [];
    let rowIndex = 0;
    const endVisible = firstVisible + visibleCount;
    const emit: EmitRow = (
      block,
      blockIndex,
      textStart,
      textEnd,
      prefix,
      suffix,
      role,
      overrideText,
    ) => {
      if (rowIndex >= firstVisible && rowIndex < endVisible) {
        rows.push({ block, blockIndex, textStart, textEnd, prefix, suffix, role, overrideText });
      }
      rowIndex++;
      return rowIndex >= endVisible;
    };

    this.visitBlocks(blocks, width, emit);
    return rows;
  }

  private visitBlocks(blocks: readonly BlockRecord[], width: number, emit: EmitRow): void {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex]!;
      if (block.kind === 'list') continue;
      if (this.visitBlock(block, blockIndex, width, emit)) return;
      if (emit(null, -1, 0, 0, '', '', 'spacer')) return;
    }
  }

  private visitBlock(block: BlockRecord, blockIndex: number, width: number, emit: EmitRow): boolean {
    switch (block.kind) {
      case 'code':
        return this.visitCode(block, blockIndex, width, emit);
      case 'blockquote':
        return this.visitWrapped(block, blockIndex, width, '│ ', '', 'quote', emit);
      case 'table':
        return this.visitWrapped(block, blockIndex, width, '│ ', ' │', 'table', emit);
      case 'hr':
        return emit(block, blockIndex, 0, 0, '', '', 'rule', '─'.repeat(width));
      case 'listitem': {
        const indentation = '  '.repeat(Math.max(0, (block.level ?? 1) - 1));
        const prefix = `${indentation}${block.marker ?? '•'} `;
        return this.visitWrapped(block, blockIndex, width, prefix, '', 'content', emit);
      }
      default:
        return this.visitWrapped(block, blockIndex, width, '', '', 'content', emit);
    }
  }

  private visitCode(block: BlockRecord, blockIndex: number, width: number, emit: EmitRow): boolean {
    const label = block.language ? ` ${block.language} ` : '';
    const remaining = Math.max(0, width - label.length - 2);
    if (emit(block, blockIndex, 0, 0, '', '', 'codeBorder', `┌${label}${'─'.repeat(remaining)}┐`.slice(0, width))) {
      return true;
    }
    if (this.visitWrapped(block, blockIndex, width, '│ ', ' │', 'codeContent', emit)) return true;
    return emit(block, blockIndex, 0, 0, '', '', 'codeBorder', `└${'─'.repeat(Math.max(0, width - 2))}┘`.slice(0, width));
  }

  private visitWrapped(
    block: BlockRecord,
    blockIndex: number,
    width: number,
    firstPrefix: string,
    suffix: string,
    role: PreviewRowRole,
    emit: EmitRow,
  ): boolean {
    const contentWidth = Math.max(1, width - firstPrefix.length - suffix.length);
    let lineStart = 0;
    let isFirst = true;

    while (lineStart <= block.text.length) {
      const newline = block.text.indexOf('\n', lineStart);
      const physicalEnd = newline < 0 ? block.text.length : newline;
      if (physicalEnd === lineStart) {
        if (emit(block, blockIndex, lineStart, lineStart, isFirst ? firstPrefix : ' '.repeat(firstPrefix.length), suffix, role)) {
          return true;
        }
      } else {
        let segmentStart = lineStart;
        while (segmentStart < physicalEnd) {
          let segmentEnd = Math.min(physicalEnd, segmentStart + contentWidth);
          if (segmentEnd < physicalEnd) {
            const candidate = block.text.lastIndexOf(' ', segmentEnd);
            if (candidate > segmentStart) segmentEnd = candidate;
          }
          if (emit(
            block,
            blockIndex,
            segmentStart,
            segmentEnd,
            isFirst ? firstPrefix : ' '.repeat(firstPrefix.length),
            suffix,
            role,
          )) {
            return true;
          }
          isFirst = false;
          segmentStart = segmentEnd;
          while (segmentStart < physicalEnd && block.text[segmentStart] === ' ') segmentStart++;
        }
      }
      isFirst = false;
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    return false;
  }

  private statusRow(text: string): PreviewRow {
    return {
      block: null,
      blockIndex: -1,
      textStart: 0,
      textEnd: 0,
      prefix: '',
      suffix: '',
      role: 'status',
      overrideText: text,
    };
  }
}

export namespace MarkdownPreview {
  export const $Class = $MarkdownPreview;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
