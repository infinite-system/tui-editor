import { Reactive } from 'ivue';
import { ref } from 'vue';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TextDocument } from '../editor/TextDocument';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Environment } from '../system/Environment';
import { Files } from '../system/Files';
import { Logging } from '../system/Logging';
import { StatusChannel } from '../system/StatusChannel';
import type { LanguageCapabilities, LanguageProvider } from './LanguageProvider';
import { TypeScriptProvider } from './TypeScriptProvider';
import { LspProcess, type LspProcessLike } from './LspProcess';
import { LspTransport } from './LspTransport';

export type TextDocumentModel = InstanceType<typeof TextDocument.Class>;
export type LanguageClientStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'unavailable'
  | 'error'
  | 'disposed';

export interface TextPosition {
  line: number;
  column: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface LanguageLocation {
  uri: string;
  range: TextRange;
}

export interface LanguageHover {
  contents: string;
  range: TextRange | null;
}

export interface LanguageDiagnostic {
  source: string;
  severity: 1 | 2 | 3 | 4;
  message: string;
  code: string | number | null;
  range: TextRange;
  version: number;
}

export interface LanguageClientOptions {
  rootPath?: string;
  providers?: readonly LanguageProvider[];
  processFactory?: () => LspProcessLike;
  transportFactory?: (process: LspProcessLike) => LspTransport.Model;
  maxDiagnosticsPerDocument?: number;
  maxReferencesPerRequest?: number;
  /** Late-read of the `typescriptServer` setting, threaded to the default TypeScript provider so the
   *  chosen server (or 'auto') is honoured when a document activates. */
  preferredTypeScriptServer?: () => string;
  /** Late-read of the `lspFileSizeLimitKb` setting (KB; default 2048 = 2 MB). A document whose text exceeds this budget is
   *  NEVER attached to the server (no `didOpen`/`didChange`), so the server can't balloon on a huge
   *  file and crash the app. `0` (or any non-positive) means "no limit — always attach". Read late so a
   *  live settings change is honoured on the next open/sync. */
  fileSizeLimitKb?: () => number;
}

interface OpenDocument {
  document: TextDocumentModel;
  uri: string;
  languageId: string;
  opened: boolean;
  lastSentVersion: number | null;
  sending: Promise<void>;
}

interface DiagnosticBatch {
  version: number;
  items: readonly LanguageDiagnostic[];
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

const NO_CAPABILITIES: LanguageCapabilities = {
  diagnostics: false,
  definition: false,
  hover: false,
  references: false,
};

/** Pull-diagnostics debounce windows. A freshly opened document pulls almost immediately (off the
 *  sync microtask); rapid typing coalesces to one pull ~350ms after the last keystroke. */
const DIAGNOSTIC_PULL_OPEN_DELAY_MILLISECONDS = 50;
const DIAGNOSTIC_PULL_CHANGE_DELAY_MILLISECONDS = 350;

interface DocumentDiagnosticReport {
  kind: 'full' | 'unchanged';
  resultId: string | null;
  items: readonly unknown[];
}

class $LanguageClient {
  private readonly rootPath: string;
  private readonly providers: readonly LanguageProvider[];
  private readonly processFactory: (() => LspProcessLike) | null;
  private readonly transportFactory:
    | ((process: LspProcessLike) => LspTransport.Model)
    | null;
  private readonly maxDiagnosticsPerDocument: number;
  private readonly maxReferencesPerRequest: number;
  private readonly preferredTypeScriptServer: (() => string) | undefined;
  private readonly fileSizeLimitKb: (() => number) | undefined;
  /** URIs of documents currently suppressed for exceeding the size budget — the set the size notice
   *  reads to prove the suppression is never a silent no-op. */
  private readonly sizeSuppressedUris = new Set<string>();
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnosticBatches = new Map<string, DiagnosticBatch>();
  /** Last `resultId` per URI for pull diagnostics — echoed back as `previousResultId` so the server
   *  may answer with an `unchanged` report instead of recomputing. */
  private readonly diagnosticResultIds = new Map<string, string>();
  /** Per-URI debounce timers for pull diagnostics — the active pull scheduled for each document. */
  private readonly diagnosticPullTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private process: LspProcessLike | null = null;
  private transport: LspTransport.Model | null = null;
  private provider: LanguageProvider | null = null;
  private serverCapabilities: Record<string, unknown> = {};
  private startPromise: Promise<boolean> | null = null;
  private activationGeneration = 0;
  private disposed = false;
  private publishedPid: number | null = null;

  constructor(options: LanguageClientOptions = {}) {
    this.rootPath = options.rootPath ?? this.defaultRootPath();
    // Set BEFORE createProviders() — the default TypeScript provider reads it at construction.
    this.preferredTypeScriptServer = options.preferredTypeScriptServer;
    this.fileSizeLimitKb = options.fileSizeLimitKb;
    this.providers = options.providers ? [...options.providers] : this.createProviders();
    this.processFactory = options.processFactory ?? null;
    this.transportFactory = options.transportFactory ?? null;
    this.maxDiagnosticsPerDocument = Math.max(1, options.maxDiagnosticsPerDocument ?? 10_000);
    this.maxReferencesPerRequest = Math.max(1, options.maxReferencesPerRequest ?? 5_000);
  }

  get status() {
    return ref<LanguageClientStatus>('idle');
  }
  get error() {
    return ref<string | null>(null);
  }
  get activeProviderId() {
    return ref<string | null>(null);
  }
  get diagnosticsRevision() {
    return ref(0);
  }
  /** Bumped whenever a document's size-suppression state flips, so a reactive reader (the status-bar
   *  notice) re-evaluates when a large file is opened or its budget changes. */
  get sizeSuppressionRevision() {
    return ref(0);
  }

  get isReady(): boolean {
    return this.status.value === 'ready';
  }
  get diagnosticCount(): number {
    void this.diagnosticsRevision.value;
    let count = 0;
    for (const batch of this.diagnosticBatches.values()) count += batch.items.length;
    return count;
  }

  protected defaultRootPath(): string {
    return Environment.Class.cwd;
  }

  protected createProviders(): readonly LanguageProvider[] {
    return [new TypeScriptProvider.Class({ preferredServer: this.preferredTypeScriptServer })];
  }

  protected createProcess(): LspProcessLike {
    return this.processFactory ? this.processFactory() : new LspProcess.Class();
  }

  protected createTransport(process: LspProcessLike): LspTransport.Model {
    return this.transportFactory
      ? this.transportFactory(process)
      : new LspTransport.Class(process);
  }

  /** True when some provider can serve this document — the guard callers use before a
   *  semantic request, so an unsupported file never triggers a server start. */
  supportsDocument(document: TextDocumentModel): boolean {
    return Boolean(document.path) &&
      this.providers.some((provider) => provider.supportsPath(document.path));
  }

  /** The current size budget in KB (`0` = no limit). Read late so a live settings change applies. */
  private currentFileSizeLimitKb(): number {
    const limit = this.fileSizeLimitKb?.() ?? 0;
    return Number.isFinite(limit) && limit > 0 ? limit : 0;
  }

  /** True when `document`'s text is larger than the configured budget (and a budget is set). Uses
   *  `text.length / 1024` — the same cheap measure the server would otherwise ingest whole. */
  private documentExceedsSizeLimit(document: TextDocumentModel): boolean {
    const limit = this.currentFileSizeLimitKb();
    return limit > 0 && document.text.length / 1024 > limit;
  }

  /** Recompute `document`'s suppression against the current budget, updating the tracked set and
   *  bumping the reactive signal on a change. Returns whether it is now suppressed. */
  private refreshSizeSuppression(document: TextDocumentModel): boolean {
    const uri = this.uriFor(document.path);
    const exceeds = this.documentExceedsSizeLimit(document);
    const wasSuppressed = this.sizeSuppressedUris.has(uri);
    if (exceeds === wasSuppressed) return exceeds;
    if (exceeds) this.sizeSuppressedUris.add(uri);
    else this.sizeSuppressedUris.delete(uri);
    this.sizeSuppressionRevision.value++;
    return exceeds;
  }

  /** True when the given document/URI is currently suppressed for exceeding the size budget. */
  isSizeSuppressed(documentOrUri: TextDocumentModel | string): boolean {
    void this.sizeSuppressionRevision.value;
    const uri = typeof documentOrUri === 'string' ? documentOrUri : this.uriFor(documentOrUri.path);
    return this.sizeSuppressedUris.has(uri);
  }

  /** A user-facing notice when `document` is size-suppressed, else `null` — so a suppressed file is
   *  never a silent no-op. */
  sizeSuppressionNotice(document: TextDocumentModel): string | null {
    if (!this.isSizeSuppressed(document)) return null;
    const kilobytes = Math.round(document.text.length / 1024);
    return `Large file — language features off (${kilobytes} KB > ${this.currentFileSizeLimitKb()} KB limit)`;
  }

  /**
   * Register a TS/JS document and schedule activation without making file-open wait for a
   * subprocess. Unsupported files remain entirely local. A document larger than the size budget is
   * size-suppressed and never attached (no subprocess start for it), so the server can't balloon.
   *
   * invariant: LSP activation follows semantic demand (src/modules/lsp/lsp.invariants.md)
   */
  openDocument(document: TextDocumentModel): void {
    if (this.disposed || !this.supportsDocument(document)) return;
    if (this.refreshSizeSuppression(document)) return;
    const state = this.rememberDocument(document);
    void this.ensureStarted(document.path).then((ready) => {
      if (ready) return this.synchronize(state);
    }).catch((reason) => this.containFailure(reason));
  }

  syncDocument(document: TextDocumentModel): void {
    if (this.disposed || !document.path) return;
    if (this.refreshSizeSuppression(document)) return;
    const state = this.rememberDocument(document);
    if (!this.isReady) {
      this.openDocument(document);
      return;
    }
    void this.synchronize(state).catch((reason) => this.containFailure(reason));
  }

  closeDocument(documentOrUri: TextDocumentModel | string): void {
    const uri = typeof documentOrUri === 'string' ? documentOrUri : this.uriFor(documentOrUri.path);
    const state = this.documents.get(uri);
    if (!state) return;
    this.documents.delete(uri);
    if (this.sizeSuppressedUris.delete(uri)) this.sizeSuppressionRevision.value++;
    this.cancelDiagnosticPull(uri);
    this.diagnosticResultIds.delete(uri);
    if (state.opened && this.transport?.running) {
      void this.transport.notify('textDocument/didClose', { textDocument: { uri } }).catch(
        (reason) => this.containFailure(reason),
      );
    }
    if (this.diagnosticBatches.delete(uri)) this.bumpDiagnostics();
  }

  /** A bounded window over compact, non-reactive diagnostic records. */
  diagnosticSlice(
    documentOrUri: TextDocumentModel | string,
    start: number,
    count: number,
  ): readonly LanguageDiagnostic[] {
    void this.diagnosticsRevision.value;
    const uri = typeof documentOrUri === 'string' ? documentOrUri : this.uriFor(documentOrUri.path);
    const items = this.diagnosticBatches.get(uri)?.items ?? [];
    const safeStart = Math.max(0, start);
    const safeCount = Math.max(0, Math.min(count, this.maxDiagnosticsPerDocument));
    return items.slice(safeStart, safeStart + safeCount);
  }

  diagnosticCountFor(documentOrUri: TextDocumentModel | string): number {
    void this.diagnosticsRevision.value;
    const uri = typeof documentOrUri === 'string' ? documentOrUri : this.uriFor(documentOrUri.path);
    return this.diagnosticBatches.get(uri)?.items.length ?? 0;
  }

  /** Observe the activation already scheduled by openDocument without starting a new one. */
  async whenStarted(): Promise<boolean> {
    return this.startPromise ? await this.startPromise : this.isReady;
  }

  async definition(
    document: TextDocumentModel,
    position: TextPosition,
  ): Promise<LanguageLocation | null> {
    if (!this.supports('definition')) return null;
    const requestRevision = document.revision.value;
    const lspPosition = this.toLspPosition(document, position);
    const transport = await this.transportFor(document, requestRevision);
    if (!transport) return null;
    try {
      const result = await transport.request<unknown>('textDocument/definition', {
        textDocument: { uri: this.uriFor(document.path) },
        position: lspPosition,
      });
      if (document.revision.value !== requestRevision) return null;
      const locations = this.parseLocations(result);
      return locations[0] ?? null;
    } catch (reason) {
      this.containFailure(reason);
      return null;
    }
  }

  async references(
    document: TextDocumentModel,
    position: TextPosition,
    includeDeclaration = true,
  ): Promise<readonly LanguageLocation[]> {
    if (!this.supports('references')) return [];
    const requestRevision = document.revision.value;
    const lspPosition = this.toLspPosition(document, position);
    const transport = await this.transportFor(document, requestRevision);
    if (!transport) return [];
    try {
      const result = await transport.request<unknown>('textDocument/references', {
        textDocument: { uri: this.uriFor(document.path) },
        position: lspPosition,
        context: { includeDeclaration },
      });
      if (document.revision.value !== requestRevision) return [];
      return this.parseLocations(result).slice(0, this.maxReferencesPerRequest);
    } catch (reason) {
      this.containFailure(reason);
      return [];
    }
  }

  async hover(document: TextDocumentModel, position: TextPosition): Promise<LanguageHover | null> {
    if (!this.supports('hover')) return null;
    const requestRevision = document.revision.value;
    const lspPosition = this.toLspPosition(document, position);
    const transport = await this.transportFor(document, requestRevision);
    if (!transport) return null;
    try {
      const result = await transport.request<unknown>('textDocument/hover', {
        textDocument: { uri: this.uriFor(document.path) },
        position: lspPosition,
      });
      if (document.revision.value !== requestRevision) return null;
      return this.parseHover(result, this.uriFor(document.path));
    } catch (reason) {
      this.containFailure(reason);
      return null;
    }
  }

  /**
   * Attempt the protocol shutdown handshake, then unconditionally release transport,
   * process, diagnostics, and ivue effects.
   *
   * invariant: Client disposal releases the server (src/modules/lsp/lsp.invariants.md)
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ++this.activationGeneration;
    this.status.value = 'disposed';
    this.error.value = null;
    this.activeProviderId.value = null;
    this.publishStatus();

    const transport = this.transport;
    const process = this.process;
    this.transport = null;
    this.process = null;
    this.provider = null;
    this.startPromise = null;
    if (transport?.running) {
      try {
        await this.withTimeout(transport.request('shutdown'), 100);
        await transport.notify('exit');
      } catch {
        // A failed/slow shutdown still falls through to the unconditional kill below.
      }
    }
    transport?.dispose();
    process?.dispose();
    for (const timer of this.diagnosticPullTimers.values()) clearTimeout(timer);
    this.diagnosticPullTimers.clear();
    this.diagnosticResultIds.clear();
    this.documents.clear();
    this.sizeSuppressedUris.clear();
    if (this.diagnosticBatches.size > 0) {
      this.diagnosticBatches.clear();
      this.diagnosticsRevision.value++;
    }
    this.publishStatus();
    // No $stopEffects(): this model owns no $watch/$watchEffect effects, and its reactive
    // state (status/error/activeProviderId/diagnosticsRevision) lives in ivue's cached
    // getter cells. $stopEffects() would clear those cells, discarding the terminal
    // 'disposed' status just set above and making a disposed client re-read as 'idle'.
    // invariant: Client disposal releases the server (src/modules/lsp/lsp.invariants.md)
  }

  private rememberDocument(document: TextDocumentModel): OpenDocument {
    const uri = this.uriFor(document.path);
    const existing = this.documents.get(uri);
    if (existing && existing.document === document) return existing;
    const state: OpenDocument = {
      document,
      uri,
      languageId: this.languageIdFor(document.path),
      opened: false,
      lastSentVersion: null,
      sending: Promise.resolve(),
    };
    this.documents.set(uri, state);
    return state;
  }

  private ensureStarted(path: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.isReady && this.transport?.running) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    const generation = ++this.activationGeneration;
    this.status.value = 'starting';
    this.error.value = null;
    this.publishStatus();
    const promise = this.activate(path, generation);
    this.startPromise = promise;
    return promise;
  }

  /**
   * Every failure is converted into observable optional-service state; none escapes into
   * editor input or document mutation.
   *
   * invariant: Server failures remain contained (src/modules/lsp/lsp.invariants.md)
   */
  private async activate(path: string, generation: number): Promise<boolean> {
    try {
      const selection = await this.resolveProvider(path);
      if (!selection || !this.isCurrent(generation)) {
        if (this.isCurrent(generation)) this.setUnavailable('No TypeScript language server found');
        return false;
      }

      const process = this.createProcess();
      if (!process.start(selection.command, this.rootPath)) {
        this.setUnavailable(process.error ?? `Unable to start ${selection.command.command}`);
        return false;
      }
      if (!this.isCurrent(generation)) {
        process.dispose();
        return false;
      }

      const transport = this.createTransport(process);
      transport.onNotification((method, params) => this.handleNotification(method, params));
      transport.onRequest((method, params) => this.handleServerRequest(method, params));
      transport.onClose((reason) => this.handleTransportClose(transport, process, reason));
      if (!transport.start()) {
        process.dispose();
        this.setUnavailable('Language server stdio is unavailable');
        return false;
      }
      this.process = process;
      this.transport = transport;
      this.provider = selection.provider;

      const initializeResult = await transport.request<unknown>('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Invar', version: '0.1.0' },
        rootUri: pathToFileURL(resolvePath(this.rootPath)).href,
        workspaceFolders: [
          {
            uri: pathToFileURL(resolvePath(this.rootPath)).href,
            name: Files.Class.basename(this.rootPath) || this.rootPath,
          },
        ],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            publishDiagnostics: { versionSupport: true, relatedInformation: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            references: { dynamicRegistration: false },
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            diagnostics: { refreshSupport: true },
          },
        },
      });
      if (!this.isCurrent(generation) || this.transport !== transport) {
        transport.dispose();
        process.dispose();
        return false;
      }
      this.serverCapabilities = this.objectValue(initializeResult)?.capabilities as
        | Record<string, unknown>
        | undefined ?? {};
      await transport.notify('initialized', {});
      this.status.value = 'ready';
      this.error.value = null;
      this.activeProviderId.value = selection.provider.id;
      this.publishStatus();
      for (const document of this.documents.values()) {
        if (selection.provider.supportsPath(document.document.path)) {
          // Contain a mid-sync server death (broken pipe / abrupt exit) here too: an uncaught
          // rejection from this initial re-sync must never escape as an unhandled rejection.
          void this.synchronize(document).catch((reason) => this.containFailure(reason));
        }
      }
      return true;
    } catch (reason) {
      if (this.isCurrent(generation)) this.containFailure(reason);
      return false;
    }
  }

  private async resolveProvider(path: string): Promise<{
    provider: LanguageProvider;
    command: Awaited<ReturnType<LanguageProvider['resolve']>> & {};
  } | null> {
    for (const provider of this.providers) {
      if (!provider.supportsPath(path)) continue;
      try {
        const command = await provider.resolve(this.rootPath);
        if (command) return { provider, command };
      } catch {
        // Continue to the next provider; one resolver cannot disable the stack.
      }
    }
    return null;
  }

  private synchronize(state: OpenDocument): Promise<void> {
    state.sending = state.sending.then(() => this.sendLatestDocument(state));
    return state.sending;
  }

  private async sendLatestDocument(state: OpenDocument): Promise<void> {
    const transport = this.transport;
    if (!transport?.running || !this.provider?.supportsPath(state.document.path)) return;
    // The single choke point where a document's text actually reaches the server. Never send a
    // document that exceeds the size budget, so an oversized file is never attached even if a caller
    // reaches here — the load-bearing guard the size-guard invariant rests on.
    // invariant: The LSP attaches only to documents within the size budget (src/modules/lsp/lsp.invariants.md)
    if (this.documentExceedsSizeLimit(state.document)) return;
    const version = state.document.revision.value;
    if (state.lastSentVersion === version) return;
    if (!state.opened) {
      await transport.notify('textDocument/didOpen', {
        textDocument: {
          uri: state.uri,
          languageId: state.languageId,
          version,
          text: state.document.text,
        },
      });
      state.opened = true;
      state.lastSentVersion = version;
      this.scheduleDiagnosticPull(state, DIAGNOSTIC_PULL_OPEN_DELAY_MILLISECONDS);
      return;
    }
    await transport.notify('textDocument/didChange', {
      textDocument: { uri: state.uri, version },
      contentChanges: [{ text: state.document.text }],
    });
    state.lastSentVersion = version;
    this.scheduleDiagnosticPull(state, DIAGNOSTIC_PULL_CHANGE_DELAY_MILLISECONDS);
  }

  private async transportFor(
    document: TextDocumentModel,
    requestRevision: number,
  ): Promise<LspTransport.Model | null> {
    if (this.disposed || !document.path) return null;
    const state = this.rememberDocument(document);
    if (!(await this.ensureStarted(document.path))) return null;
    if (document.revision.value !== requestRevision) return null;
    try {
      await this.synchronize(state);
    } catch (reason) {
      this.containFailure(reason);
      return null;
    }
    if (document.revision.value !== requestRevision) return null;
    return this.transport?.running ? this.transport : null;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') this.applyDiagnostics(params);
  }

  private handleServerRequest(method: string, params: unknown): unknown {
    if (method === 'workspace/configuration') {
      const items = this.objectValue(params)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    }
    if (method === 'workspace/workspaceFolders') {
      return [
        {
          uri: pathToFileURL(resolvePath(this.rootPath)).href,
          name: Files.Class.basename(this.rootPath) || this.rootPath,
        },
      ];
    }
    if (method === 'client/registerCapability' || method === 'window/workDoneProgress/create') {
      return null;
    }
    if (method === 'workspace/diagnostic/refresh') {
      // The server signals that a change elsewhere (e.g. another file) may have invalidated the
      // diagnostics it computed for open documents; re-pull each so cross-file errors stay fresh.
      this.refreshAllPulledDiagnostics();
      return null;
    }
    throw new Error(`Unsupported server request: ${method}`);
  }

  /**
   * PUSH path (`textDocument/publishDiagnostics`, used by typescript-language-server). Resolves
   * the batch version, then hands the raw diagnostics to the shared, source-agnostic store.
   *
   * invariant: Diagnostic updates match current revisions (src/modules/lsp/lsp.invariants.md)
   */
  private applyDiagnostics(params: unknown): void {
    const value = this.objectValue(params);
    const uri = typeof value?.uri === 'string' ? value.uri : null;
    if (!uri || !Array.isArray(value?.diagnostics)) return;
    const state = this.documents.get(uri);
    if (!state || !state.opened) return;
    // Real servers (typescript-language-server 5.x) omit `version` even when the client
    // advertises publishDiagnostics.versionSupport. A versionless batch is attributed to the
    // last revision synced to the server — and still accepted only when that revision is the
    // document's current one, so a batch computed against stale text remains impossible.
    const reportedVersion = typeof value?.version === 'number' ? value.version : null;
    const version = reportedVersion ?? state.lastSentVersion;
    if (version === null) return;
    this.storeDiagnostics(uri, version, value.diagnostics);
  }

  /**
   * PULL path (`textDocument/diagnostic`, used by tsgo/native-preview, which never pushes). Sends
   * the request for the document's synced revision, parses the `DocumentDiagnosticReport`, and
   * feeds a `full` report into the SAME store as the push path. Guarded by the server's advertised
   * `diagnosticProvider` capability so a push-only server is never polled.
   *
   * invariant: Diagnostics reach the store by push or pull (src/modules/lsp/lsp.invariants.md)
   * invariant: Server failures remain contained (src/modules/lsp/lsp.invariants.md)
   */
  private async pullDiagnostics(state: OpenDocument): Promise<void> {
    const transport = this.transport;
    if (!transport?.running || !this.serverPullsDiagnostics) return;
    if (!state.opened || !this.provider?.supportsPath(state.document.path)) return;
    // Stamp the pull with the revision currently synced to the server. If the document advances
    // while the request is in flight, `lastSentVersion` moves past it and the store's revision
    // guard drops the stale report — the same staleness rule the push path obeys.
    const requestVersion = state.lastSentVersion;
    if (requestVersion === null) return;
    const previousResultId = this.diagnosticResultIds.get(state.uri);
    let report: unknown;
    try {
      report = await transport.request<unknown>('textDocument/diagnostic', {
        textDocument: { uri: state.uri },
        ...(previousResultId ? { previousResultId } : {}),
      });
    } catch (reason) {
      this.containFailure(reason);
      return;
    }
    this.ingestDiagnosticReport(state.uri, requestVersion, report);
  }

  /** Parse a `DocumentDiagnosticReport`. A `full` report REPLACES the stored batch (so a report
   *  that no longer lists a prior error clears it); an `unchanged` report keeps the current batch
   *  and only refreshes the `resultId`. */
  private ingestDiagnosticReport(uri: string, version: number, report: unknown): void {
    const parsed = this.parseDiagnosticReport(report);
    if (!parsed) return;
    if (parsed.resultId) this.diagnosticResultIds.set(uri, parsed.resultId);
    else this.diagnosticResultIds.delete(uri);
    if (parsed.kind === 'unchanged') return;
    this.storeDiagnostics(uri, version, parsed.items);
  }

  private parseDiagnosticReport(report: unknown): DocumentDiagnosticReport | null {
    const value = this.objectValue(report);
    if (!value) return null;
    const kind = value.kind === 'unchanged' ? 'unchanged' : 'full';
    const resultId = typeof value.resultId === 'string' ? value.resultId : null;
    const items = kind === 'full' && Array.isArray(value.items) ? value.items : [];
    return { kind, resultId, items };
  }

  /**
   * The single source-agnostic diagnostic sink: whether a batch arrived by PUSH notification or by
   * PULL response, it is stored only under the revision that equals both the document's current
   * revision and the last one synced to the server, capped at `maxDiagnosticsPerDocument`.
   *
   * invariant: Diagnostic updates match current revisions (src/modules/lsp/lsp.invariants.md)
   * invariant: Diagnostic storage stays compact and bounded (src/modules/lsp/lsp.invariants.md)
   * invariant: Diagnostics reach the store by push or pull (src/modules/lsp/lsp.invariants.md)
   */
  private storeDiagnostics(uri: string, version: number, rawDiagnostics: readonly unknown[]): void {
    const state = this.documents.get(uri);
    if (!state || !state.opened) return;
    if (state.document.revision.value !== version || state.lastSentVersion !== version) return;

    const items: LanguageDiagnostic[] = [];
    for (const candidate of rawDiagnostics.slice(0, this.maxDiagnosticsPerDocument)) {
      const diagnostic = this.parseDiagnostic(candidate, uri, version);
      if (diagnostic) items.push(diagnostic);
    }
    this.diagnosticBatches.set(uri, { version, items });
    this.bumpDiagnostics();
  }

  /** True when the server advertised a pull-model `diagnosticProvider` on initialize (tsgo does;
   *  typescript-language-server does not — it pushes). Only then is `textDocument/diagnostic` sent. */
  private get serverPullsDiagnostics(): boolean {
    return Boolean(this.serverCapabilities.diagnosticProvider);
  }

  /** Debounce a pull for `state`, collapsing rapid edits into one `textDocument/diagnostic`. No-op
   *  for push-model servers, so the debounce/timer machinery never runs under typescript-language-server. */
  private scheduleDiagnosticPull(state: OpenDocument, delayMilliseconds: number): void {
    if (this.disposed || !this.serverPullsDiagnostics) return;
    const existing = this.diagnosticPullTimers.get(state.uri);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.diagnosticPullTimers.delete(state.uri);
      void this.pullDiagnostics(state).catch((reason) => this.containFailure(reason));
    }, delayMilliseconds);
    this.diagnosticPullTimers.set(state.uri, timer);
  }

  private cancelDiagnosticPull(uri: string): void {
    const timer = this.diagnosticPullTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.diagnosticPullTimers.delete(uri);
    }
  }

  /** Re-pull every open, supported document — the response to `workspace/diagnostic/refresh`. */
  private refreshAllPulledDiagnostics(): void {
    if (!this.serverPullsDiagnostics) return;
    for (const state of this.documents.values()) {
      if (state.opened) this.scheduleDiagnosticPull(state, DIAGNOSTIC_PULL_CHANGE_DELAY_MILLISECONDS);
    }
  }

  private parseDiagnostic(value: unknown, uri: string, version: number): LanguageDiagnostic | null {
    const candidate = this.objectValue(value);
    const range = this.parseRange(candidate?.range, uri);
    if (!range || typeof candidate?.message !== 'string') return null;
    const rawSeverity = typeof candidate.severity === 'number' ? candidate.severity : 1;
    const severity = Math.max(1, Math.min(4, rawSeverity)) as 1 | 2 | 3 | 4;
    const rawCode = candidate.code;
    const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : null;
    return {
      source: typeof candidate.source === 'string' ? candidate.source : 'typescript',
      severity,
      message: candidate.message,
      code,
      range,
      version,
    };
  }

  private parseLocations(value: unknown): LanguageLocation[] {
    const candidates = Array.isArray(value) ? value : value ? [value] : [];
    const locations: LanguageLocation[] = [];
    for (const candidateValue of candidates) {
      const candidate = this.objectValue(candidateValue);
      const uri = typeof candidate?.uri === 'string'
        ? candidate.uri
        : typeof candidate?.targetUri === 'string'
          ? candidate.targetUri
          : null;
      const rawRange = candidate?.range ?? candidate?.targetSelectionRange ?? candidate?.targetRange;
      const range = uri ? this.parseRange(rawRange, uri) : null;
      if (uri && range) locations.push({ uri, range });
    }
    return locations;
  }

  private parseHover(value: unknown, uri: string): LanguageHover | null {
    const candidate = this.objectValue(value);
    if (!candidate || !('contents' in candidate)) return null;
    const contents = this.hoverText(candidate.contents);
    if (!contents) return null;
    return {
      contents,
      range: candidate.range ? this.parseRange(candidate.range, uri) : null,
    };
  }

  private hoverText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((item) => this.hoverText(item)).filter(Boolean).join('\n\n');
    const candidate = this.objectValue(value);
    if (typeof candidate?.value === 'string') return candidate.value;
    if (typeof candidate?.language === 'string' && typeof candidate?.value === 'string') {
      return candidate.value;
    }
    return '';
  }

  private parseRange(value: unknown, uri: string): TextRange | null {
    const candidate = this.objectValue(value);
    const start = this.parseLspPosition(candidate?.start);
    const end = this.parseLspPosition(candidate?.end);
    if (!start || !end) return null;
    return {
      start: this.fromLspPosition(uri, start),
      end: this.fromLspPosition(uri, end),
    };
  }

  private parseLspPosition(value: unknown): LspPosition | null {
    const candidate = this.objectValue(value);
    if (typeof candidate?.line !== 'number' || typeof candidate?.character !== 'number') return null;
    return {
      line: Math.max(0, Math.trunc(candidate.line)),
      character: Math.max(0, Math.trunc(candidate.character)),
    };
  }

  /** invariant: LSP positions cross through UTF-16 (src/modules/lsp/lsp.invariants.md) */
  private toLspPosition(document: TextDocumentModel, position: TextPosition): LspPosition {
    const line = Math.max(0, Math.min(Math.trunc(position.line), document.lineCount - 1));
    const text = document.line(line);
    const graphemeColumn = Math.max(0, Math.trunc(position.column));
    return { line, character: EditorCoordinates.Class.graphemeToU16(text, graphemeColumn) };
  }

  private fromLspPosition(uri: string, position: LspPosition): TextPosition {
    const lineText = this.lineForUri(uri, position.line);
    const utf16Column = Math.max(0, Math.min(position.character, lineText.length));
    return {
      line: position.line,
      column: EditorCoordinates.Class.u16ToGrapheme(lineText, utf16Column),
    };
  }

  private lineForUri(uri: string, line: number): string {
    const open = this.documents.get(uri);
    if (open) return open.document.line(line);
    try {
      const path = fileURLToPath(uri);
      if (!Files.Class.exists(path)) return '';
      return Files.Class.read(path).split(/\r?\n/)[line] ?? '';
    } catch {
      return '';
    }
  }

  private supports(capability: keyof LanguageCapabilities): boolean {
    if (this.provider) return this.provider.capabilities[capability];
    return this.providers.some((provider) => provider.capabilities[capability]);
  }

  private languageIdFor(path: string): string {
    switch (Files.Class.extname(path).toLowerCase()) {
      case '.tsx':
        return 'typescriptreact';
      case '.jsx':
        return 'javascriptreact';
      case '.js':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      default:
        return 'typescript';
    }
  }

  private uriFor(path: string): string {
    return pathToFileURL(resolvePath(path)).href;
  }

  private handleTransportClose(
    transport: LspTransport.Model,
    process: LspProcessLike,
    reason: Error,
  ): void {
    if (this.disposed || this.transport !== transport) return;
    this.transport = null;
    this.process = null;
    this.provider = null;
    this.startPromise = null;
    process.dispose();
    this.status.value = 'error';
    this.error.value = reason.message;
    this.activeProviderId.value = null;
    Logging.Class.error(`LSP failed: ${reason.message}`);
    this.publishStatus();
  }

  private containFailure(reason: unknown): void {
    if (this.disposed) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.status.value = 'error';
    this.error.value = error.message;
    Logging.Class.error(`LSP failed: ${error.message}`);
    this.publishStatus();
  }

  private setUnavailable(message: string): void {
    this.startPromise = null;
    this.status.value = 'unavailable';
    this.error.value = message;
    this.activeProviderId.value = null;
    this.publishStatus();
  }

  private bumpDiagnostics(): void {
    this.diagnosticsRevision.value++;
    this.publishStatus();
  }

  private publishStatus(): void {
    const snapshot = StatusChannel.Class.snapshot;
    const pids = snapshot.subprocessPids.filter((pid) => pid !== this.publishedPid);
    const currentPid = this.process?.pid ?? null;
    if (currentPid !== null && !pids.includes(currentPid)) pids.push(currentPid);
    this.publishedPid = currentPid;
    StatusChannel.Class.update({
      lspStatus: this.status.value,
      lspProvider: this.activeProviderId.value,
      diagnosticsCount: this.diagnosticCount,
      subprocessPids: pids,
    });
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.activationGeneration;
  }

  private objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private async withTimeout<Result>(promise: Promise<Result>, milliseconds: number): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('LSP shutdown timed out')), milliseconds);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export namespace LanguageClient {
  export const $Class = $LanguageClient;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
