export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface PendingJsonRpcRequest<Result = unknown> {
  id: JsonRpcId;
  message: JsonRpcRequest;
  response: Promise<Result>;
}

export interface JsonRpcOptions {
  maxHeaderBytes?: number;
  maxMessageBytes?: number;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

const HEADER_END = new Uint8Array([13, 10, 13, 10]);

class $JsonRpc {
  private bytes = new Uint8Array(0);
  private bodyLength: number | null = null;
  private requestId = 0;
  private readonly pending = new Map<JsonRpcId, PendingResponse>();
  private readonly maxHeaderBytes: number;
  private readonly maxMessageBytes: number;

  constructor(options: JsonRpcOptions = {}) {
    this.maxHeaderBytes = options.maxHeaderBytes ?? 8 * 1024;
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;
  }

  encode(message: JsonRpcMessage): Uint8Array {
    const body = new TextEncoder().encode(JSON.stringify(message));
    if (body.byteLength > this.maxMessageBytes) {
      throw new Error(`JSON-RPC message exceeds ${this.maxMessageBytes} bytes`);
    }
    const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    const framed = new Uint8Array(header.byteLength + body.byteLength);
    framed.set(header, 0);
    framed.set(body, header.byteLength);
    return framed;
  }

  createRequest<Result = unknown>(method: string, params?: unknown): PendingJsonRpcRequest<Result> {
    const id = ++this.requestId;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;

    let resolveResponse!: (value: Result) => void;
    let rejectResponse!: (reason: Error) => void;
    const response = new Promise<Result>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.pending.set(id, {
      resolve: (value) => resolveResponse(value as Result),
      reject: rejectResponse,
    });
    return { id, message, response };
  }

  rejectRequest(id: JsonRpcId, reason: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.reject(reason);
  }

  rejectAll(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  /**
   * Append an arbitrary byte-stream chunk. Complete messages are returned in wire order;
   * response messages also settle their matching request promise.
   *
   * invariant: Byte streams do not preserve message boundaries (src/modules/lsp/lsp.invariants.md)
   */
  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.append(chunk);
    const messages: JsonRpcMessage[] = [];

    while (true) {
      if (this.bodyLength === null) {
        const headerEnd = this.findHeaderEnd();
        if (headerEnd < 0) {
          if (this.bytes.byteLength > this.maxHeaderBytes) {
            throw new Error(`JSON-RPC header exceeds ${this.maxHeaderBytes} bytes`);
          }
          break;
        }
        const headerBytes = this.bytes.slice(0, headerEnd);
        this.bodyLength = this.parseContentLength(headerBytes);
        this.bytes = this.bytes.slice(headerEnd + HEADER_END.byteLength);
      }

      if (this.bytes.byteLength < this.bodyLength) break;
      const body = this.bytes.slice(0, this.bodyLength);
      this.bytes = this.bytes.slice(this.bodyLength);
      this.bodyLength = null;

      const decoded = new TextDecoder().decode(body);
      const parsed: unknown = JSON.parse(decoded);
      if (!this.isMessage(parsed)) throw new Error('Invalid JSON-RPC 2.0 message');
      this.correlate(parsed);
      messages.push(parsed);
    }

    return messages;
  }

  private append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.bytes.byteLength === 0) {
      this.bytes = chunk.slice();
      return;
    }
    const joined = new Uint8Array(this.bytes.byteLength + chunk.byteLength);
    joined.set(this.bytes, 0);
    joined.set(chunk, this.bytes.byteLength);
    this.bytes = joined;
  }

  private findHeaderEnd(): number {
    const lastStart = this.bytes.byteLength - HEADER_END.byteLength;
    for (let offset = 0; offset <= lastStart; offset++) {
      let matches = true;
      for (let headerOffset = 0; headerOffset < HEADER_END.byteLength; headerOffset++) {
        if (this.bytes[offset + headerOffset] !== HEADER_END[headerOffset]) {
          matches = false;
          break;
        }
      }
      if (matches) return offset;
    }
    return -1;
  }

  private parseContentLength(headerBytes: Uint8Array): number {
    // LSP headers are ASCII; UTF-8 decodes them identically. (Bun's TextDecoder type
    // rejects the 'ascii' label.)
    const header = new TextDecoder().decode(headerBytes);
    let length: number | null = null;
    for (const line of header.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      if (name !== 'content-length') continue;
      const value = line.slice(separator + 1).trim();
      if (!/^\d+$/.test(value)) throw new Error('Invalid JSON-RPC Content-Length');
      length = Number(value);
      break;
    }
    if (length === null) throw new Error('Missing JSON-RPC Content-Length');
    if (!Number.isSafeInteger(length) || length < 0 || length > this.maxMessageBytes) {
      throw new Error(`JSON-RPC Content-Length exceeds ${this.maxMessageBytes} bytes`);
    }
    return length;
  }

  private isMessage(value: unknown): value is JsonRpcMessage {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.jsonrpc !== '2.0') return false;
    if (typeof candidate.method === 'string') return true;
    return 'id' in candidate && ('result' in candidate || 'error' in candidate);
  }

  private correlate(message: JsonRpcMessage): void {
    if ('method' in message || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      Object.assign(error, { code: message.error.code, data: message.error.data });
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }
}

export namespace JsonRpc {
  export const $Class = $JsonRpc;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
