import {
  JsonRpc,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from './JsonRpc';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { LspProcessLike } from './LspProcess';

export type LspNotificationHandler = (method: string, params: unknown) => void | Promise<void>;
export type LspRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>;
export type LspCloseHandler = (reason: Error) => void;

class $LspTransport {
  private readonly rpc: JsonRpc.Model;
  // The `node:stream/web` default reader is exactly what `ReadableStream#getReader()` yields
  // under Bun's lib types. The bare global `ReadableStreamDefaultReader` is a different type
  // that demands `readMany` (a Bun web-stream method the DOM reader lacks); pinning to the
  // node type removes that mismatch. The pump only calls read/cancel/releaseLock.
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private notificationHandler: LspNotificationHandler | null = null;
  private requestHandler: LspRequestHandler | null = null;
  private closeHandler: LspCloseHandler | null = null;
  private active = false;
  private closeReason: Error | null = null;

  constructor(private readonly process: LspProcessLike) {
    this.rpc = this.createJsonRpc();
  }

  protected createJsonRpc(): JsonRpc.Model {
    return new JsonRpc.Class();
  }

  get running(): boolean {
    return this.active;
  }
  get error(): Error | null {
    return this.closeReason;
  }

  onNotification(handler: LspNotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: LspRequestHandler | null): void {
    this.requestHandler = handler;
  }

  onClose(handler: LspCloseHandler | null): void {
    this.closeHandler = handler;
  }

  start(): boolean {
    if (this.active) return true;
    const output = this.process.stdout;
    if (!this.process.running || !output || !this.process.stdin) return false;
    this.active = true;
    this.closeReason = null;
    this.reader = output.getReader();
    void this.pump();
    void this.process.exited.then((code) => {
      if (this.active) this.close(new Error(`Language server exited with code ${code}`));
    });
    return true;
  }

  async request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    if (!this.active) throw this.closeReason ?? new Error('LSP transport is not running');
    const pending = this.rpc.createRequest<Result>(method, params);
    try {
      await this.send(pending.message);
    } catch (reason) {
      this.rpc.rejectRequest(pending.id, this.toError(reason));
    }
    return await pending.response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    await this.send(message);
  }

  async respond(id: JsonRpcId, result: unknown, error?: JsonRpcError): Promise<void> {
    const message: JsonRpcResponse = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    await this.send(message);
  }

  dispose(): void {
    const reader = this.reader;
    this.reader = null;
    if (reader) void reader.cancel().catch(() => undefined);
    this.close(new Error('LSP transport disposed'));
    this.notificationHandler = null;
    this.requestHandler = null;
    this.closeHandler = null;
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    if (!this.active) throw this.closeReason ?? new Error('LSP transport is not running');
    const input = this.process.stdin;
    if (!input) throw new Error('Language server stdin is unavailable');
    try {
      await Promise.resolve(input.write(this.rpc.encode(message)));
      await Promise.resolve(input.flush?.());
    } catch (reason) {
      const error = this.toError(reason);
      this.close(error);
      throw error;
    }
  }

  private async pump(): Promise<void> {
    const reader = this.reader;
    if (!reader) return;
    try {
      while (this.active) {
        const result = await reader.read();
        if (result.done) {
          this.close(new Error('Language server stdout closed'));
          break;
        }
        for (const message of this.rpc.push(result.value)) this.dispatch(message);
      }
    } catch (reason) {
      this.close(this.toError(reason));
    } finally {
      if (this.reader === reader) this.reader = null;
      try {
        reader.releaseLock();
      } catch {
        // A cancelled stream can release the lock before this point.
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (!('method' in message)) return;
    if ('id' in message) {
      void this.dispatchRequest(message.id, message.method, message.params);
      return;
    }
    try {
      void Promise.resolve(this.notificationHandler?.(message.method, message.params)).catch(
        () => undefined,
      );
    } catch {
      // Notification handlers cannot be allowed to terminate the byte-stream pump.
    }
  }

  private async dispatchRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      await this.respond(id, null, { code: -32601, message: `Method not found: ${method}` });
      return;
    }
    try {
      const result = await this.requestHandler(method, params);
      await this.respond(id, result ?? null);
    } catch (reason) {
      await this.respond(id, null, { code: -32603, message: this.toError(reason).message });
    }
  }

  private close(reason: Error): void {
    if (!this.active && this.closeReason) return;
    this.active = false;
    this.closeReason = reason;
    this.rpc.rejectAll(reason);
    this.closeHandler?.(reason);
  }

  private toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
}

export namespace LspTransport {
  export const $Class = $LspTransport;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
