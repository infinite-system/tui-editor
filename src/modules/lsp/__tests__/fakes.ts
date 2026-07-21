// In-process scripted LSP server used by the lifecycle and diagnostic tests. It implements
// `LspProcessLike` with a real `ReadableStream` stdout and a capturing stdin, so the real
// `LspTransport` + `LanguageClient` run unmodified over it — no real LSP binary is spawned.
//
// Client->server bytes are decoded with a `JsonRpc` instance; requests are auto-answered
// (initialize + shutdown, plus a scriptable responder map). Tests drive the server->client
// direction directly via `pushNotification` / `pushDiagnostics`.
import { JsonRpc, type JsonRpcMessage } from '../JsonRpc';
import type { LanguageServerCommand } from '../LanguageProvider';
import type { LspProcessLike, LspWritable } from '../LspProcess';
import type {
  LanguageCapabilities,
  LanguageProvider,
} from '../LanguageProvider';

export type ServerResponder = (params: unknown) => unknown;

export class FakeLspProcess implements LspProcessLike {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private _stdout: ReadableStream<Uint8Array> | null = null;
  private _stdin: LspWritable | null = null;
  private readonly decoder = new JsonRpc.Class();
  private readonly encoder = new JsonRpc.Class();
  private exitResolve!: (code: number) => void;
  private readonly _exited: Promise<number>;
  private _running = false;
  private readonly _pid: number;
  private readonly seen = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  startCalled = false;
  disposed = false;
  killed = false;
  readonly received: JsonRpcMessage[] = [];

  /** Overridable initialize result; extend `responders` for other requests. */
  onInitialize: ServerResponder = () => ({ capabilities: {} });
  readonly responders = new Map<string, ServerResponder>();

  constructor(pid = 4242) {
    this._pid = pid;
    this._exited = new Promise<number>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get stdin(): LspWritable | null {
    return this._stdin;
  }
  get stdout(): ReadableStream<Uint8Array> | null {
    return this._stdout;
  }
  get exited(): Promise<number> {
    return this._exited;
  }
  get pid(): number | null {
    return this.disposed ? null : this._pid;
  }
  get running(): boolean {
    return this._running;
  }
  get error(): string | null {
    return null;
  }

  start(_command: LanguageServerCommand, _cwd: string): boolean {
    this.startCalled = true;
    this._running = true;
    this._stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this._stdin = {
      write: (data) => {
        this.handleClient(data);
        return data.byteLength;
      },
      flush: () => undefined,
      end: () => undefined,
    };
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.killed = true;
    this._running = false;
    try {
      this.controller?.close();
    } catch {
      // A cancelled/closed stream rejects a second close — disposal is still complete.
    }
    this.controller = null;
    this._stdin = null;
    this._stdout = null;
    this.exitResolve(0);
  }

  /** Enqueue a server->client notification (e.g. publishDiagnostics). */
  pushNotification(method: string, params: unknown): void {
    this.enqueue({ jsonrpc: '2.0', method, params });
  }

  pushDiagnostics(uri: string, version: number, diagnostics: unknown[]): void {
    this.pushNotification('textDocument/publishDiagnostics', { uri, version, diagnostics });
  }

  /** Resolve once the server has received a notification/request with `method`. */
  waitFor(method: string): Promise<void> {
    if (this.seen.has(method)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.waiters.get(method) ?? [];
      list.push(resolve);
      this.waiters.set(method, list);
    });
  }

  private handleClient(data: Uint8Array): void {
    for (const message of this.decoder.push(data)) {
      this.received.push(message);
      const method = 'method' in message ? message.method : null;
      if (method) this.markSeen(method);
      const params = (message as { params?: unknown }).params;
      if (method && 'id' in message && message.id !== undefined) {
        // A request — answer it.
        const id = message.id;
        let result: unknown = null;
        if (method === 'initialize') result = this.onInitialize(params);
        else if (method === 'shutdown') result = null;
        else result = this.responders.get(method)?.(params) ?? null;
        this.enqueue({ jsonrpc: '2.0', id, result });
      }
      if (method === 'exit') this.exitResolve(0);
    }
  }

  private markSeen(method: string): void {
    this.seen.add(method);
    const list = this.waiters.get(method);
    if (list) {
      this.waiters.delete(method);
      for (const resolve of list) resolve();
    }
  }

  private enqueue(message: JsonRpcMessage): void {
    if (!this.controller) return;
    this.controller.enqueue(this.encoder.encode(message));
  }
}

const FULL_CAPABILITIES: LanguageCapabilities = {
  diagnostics: true,
  definition: true,
  hover: true,
  references: true,
};

/** A provider that resolves a dummy command without touching disk. */
export class FakeProvider implements LanguageProvider {
  readonly id = 'fake';
  readonly capabilities = FULL_CAPABILITIES;

  supportsPath(path: string): boolean {
    return path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js');
  }

  async resolve(): Promise<LanguageServerCommand> {
    return { command: 'fake-lsp', args: ['--stdio'] };
  }
}

/** Flush pending micro/macrotasks so in-flight notify chains settle deterministically. */
export async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
