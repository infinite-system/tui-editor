import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { MarkdownParser, type BlockRecord, type MarkdownParseResult } from './MarkdownParser';
import { StatusChannel } from '../system/StatusChannel';

export interface MarkdownSource {
  readonly revision: { value: number };
  /** TextDocument.Model supplies a string getter; the callable form supports narrow test doubles. */
  readonly text: string | (() => string);
}

export interface MarkdownDocumentOptions {
  debounceMs?: number;
}

const EMPTY_BLOCKS: readonly BlockRecord[] = Object.freeze([]);

// invariant: Parsing starts only after opening (src/modules/markdown/markdown.invariants.md)
// invariant: Applied blocks match the current revision (src/modules/markdown/markdown.invariants.md)
class $MarkdownDocument {
  declare $watch: typeof import('vue').watch;
  declare $stopEffects: () => void;

  private parser: MarkdownParser.Model | null = null;
  private parseTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleGeneration = 0;
  private requestSequence = 0;
  private latestRequest = 0;
  private readonly debounceMs: number;

  constructor(
    readonly source: MarkdownSource,
    options: MarkdownDocumentOptions = {},
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 40);
  }

  get blocks() {
    return shallowRef<readonly BlockRecord[]>(EMPTY_BLOCKS);
  }
  get revision() {
    return ref(-1);
  }
  get parsing() {
    return ref(false);
  }
  get error() {
    return ref<string | null>(null);
  }
  get opened() {
    return ref(false);
  }

  get blockCount(): number {
    return this.blocks.value.length;
  }

  open(): void {
    if (this.opened.value) return;

    this.lifecycleGeneration++;
    this.parser = this.createParser();
    this.opened.value = true;
    this.$watch(
      () => this.source.revision.value,
      (revision) => this.onSourceRevision(revision),
      { flush: 'sync' },
    );
    this.scheduleParse(this.source.revision.value);
    StatusChannel.Class.update({ markdownActive: true, markdownParsing: true });
  }

  refresh(): void {
    if (!this.opened.value) return;
    this.scheduleParse(this.source.revision.value);
  }

  // invariant: Closing releases all preview work (src/modules/markdown/markdown.invariants.md)
  close(): void {
    if (this.parseTimer) {
      clearTimeout(this.parseTimer);
      this.parseTimer = null;
    }
    this.lifecycleGeneration++;
    this.latestRequest = ++this.requestSequence;
    this.parser?.dispose();
    this.parser = null;
    this.blocks.value = EMPTY_BLOCKS;
    this.revision.value = -1;
    this.parsing.value = false;
    this.error.value = null;
    this.opened.value = false;
    this.$stopEffects();
    StatusChannel.Class.update({
      markdownActive: false,
      markdownParsing: false,
      markdownBlockCount: 0,
      markdownRevision: -1,
    });
  }

  dispose(): void {
    this.close();
  }

  protected createParser(): MarkdownParser.Model {
    return new MarkdownParser.Class();
  }

  protected readSourceText(): string {
    return typeof this.source.text === 'function' ? this.source.text() : this.source.text;
  }

  private onSourceRevision(revision: number): void {
    this.scheduleParse(revision);
  }

  private scheduleParse(revision: number): void {
    if (!this.opened.value) return;
    if (this.parseTimer) clearTimeout(this.parseTimer);

    const requestId = ++this.requestSequence;
    const generation = this.lifecycleGeneration;
    this.latestRequest = requestId;
    this.parsing.value = true;
    this.error.value = null;
    this.parseTimer = setTimeout(() => {
      this.parseTimer = null;
      void this.startParse(revision, generation, requestId);
    }, this.debounceMs);
    StatusChannel.Class.update({ markdownParsing: true });
  }

  // invariant: Applied blocks match the current revision (src/modules/markdown/markdown.invariants.md)
  private async startParse(revision: number, generation: number, requestId: number): Promise<void> {
    if (!this.isCurrent(revision, generation, requestId) || !this.parser) return;

    const sourceText = this.readSourceText();
    try {
      const result = await this.parser.parseAsync(sourceText, revision);
      this.applyResult(result, generation, requestId);
    } catch (error) {
      if (!this.isCurrent(revision, generation, requestId)) return;
      this.error.value = error instanceof Error ? error.message : String(error);
      this.parsing.value = false;
      StatusChannel.Class.update({ markdownParsing: false, markdownError: this.error.value });
    }
  }

  private applyResult(result: MarkdownParseResult, generation: number, requestId: number): void {
    if (!this.isCurrent(result.revision, generation, requestId)) return;

    this.blocks.value = result.blocks;
    this.revision.value = result.revision;
    this.parsing.value = false;
    this.error.value = null;
    StatusChannel.Class.update({
      markdownActive: true,
      markdownParsing: false,
      markdownBlockCount: result.blocks.length,
      markdownRevision: result.revision,
      markdownError: null,
    });
  }

  private isCurrent(revision: number, generation: number, requestId: number): boolean {
    return (
      this.opened.value &&
      generation === this.lifecycleGeneration &&
      requestId === this.latestRequest &&
      revision === this.source.revision.value
    );
  }
}

export namespace MarkdownDocument {
  export const $Class = $MarkdownDocument;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
