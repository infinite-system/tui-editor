import { test, expect } from 'bun:test';
import { JsonRpc, type JsonRpcMessage, type JsonRpcResponse } from '../JsonRpc';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function frame(rpc: JsonRpc.Model, message: JsonRpcMessage): Uint8Array {
  return rpc.encode(message);
}

test('encode produces a Content-Length header and a JSON body', () => {
  const rpc = new JsonRpc.Class();
  const bytes = rpc.encode({ jsonrpc: '2.0', method: 'ping', params: { a: 1 } });
  const text = decode(bytes);
  const [header, body = ''] = text.split('\r\n\r\n');
  const bodyBytes = new TextEncoder().encode(body);
  expect(header).toBe(`Content-Length: ${bodyBytes.byteLength}`);
  expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', method: 'ping', params: { a: 1 } });
});

test('a full frame decodes to exactly one message', () => {
  const encoder = new JsonRpc.Class();
  const decoder = new JsonRpc.Class();
  const messages = decoder.push(frame(encoder, { jsonrpc: '2.0', method: 'notify', params: 42 }));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({ jsonrpc: '2.0', method: 'notify', params: 42 });
});

test('a message split across two chunks is buffered until complete', () => {
  const encoder = new JsonRpc.Class();
  const decoder = new JsonRpc.Class();
  const bytes = frame(encoder, { jsonrpc: '2.0', method: 'split', params: { text: 'hello world' } });
  const midpoint = Math.floor(bytes.byteLength / 2);

  expect(decoder.push(bytes.slice(0, midpoint))).toHaveLength(0); // header/body incomplete
  const rest = decoder.push(bytes.slice(midpoint));
  expect(rest).toHaveLength(1);
  expect(rest[0]).toEqual({ jsonrpc: '2.0', method: 'split', params: { text: 'hello world' } });
});

test('two messages in one chunk decode in wire order', () => {
  const encoder = new JsonRpc.Class();
  const decoder = new JsonRpc.Class();
  const firstFrame = frame(encoder, { jsonrpc: '2.0', method: 'first' });
  const secondFrame = frame(encoder, { jsonrpc: '2.0', method: 'second' });
  const both = new Uint8Array(firstFrame.byteLength + secondFrame.byteLength);
  both.set(firstFrame, 0);
  both.set(secondFrame, firstFrame.byteLength);

  const messages = decoder.push(both);
  expect(messages).toHaveLength(2);
  expect((messages[0] as { method: string }).method).toBe('first');
  expect((messages[1] as { method: string }).method).toBe('second');
});

test('a response frame settles its matching pending request', async () => {
  const rpc = new JsonRpc.Class();
  const pending = rpc.createRequest<{ ok: boolean }>('doThing');
  const id = pending.id;

  const response: JsonRpcResponse = { jsonrpc: '2.0', id, result: { ok: true } };
  const back = new JsonRpc.Class().encode(response);
  rpc.push(back); // same instance correlates the response to the pending request

  expect(await pending.response).toEqual({ ok: true });
});

test('an error response rejects its pending request', async () => {
  const rpc = new JsonRpc.Class();
  const pending = rpc.createRequest('willFail');
  const back = new JsonRpc.Class().encode({
    jsonrpc: '2.0',
    id: pending.id,
    error: { code: -32000, message: 'boom' },
  });
  rpc.push(back);
  await expect(pending.response).rejects.toThrow('boom');
});

test('a malformed JSON body throws rather than emitting a message', () => {
  const decoder = new JsonRpc.Class();
  const body = new TextEncoder().encode('{ not json');
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header, 0);
  bytes.set(body, header.byteLength);
  expect(() => decoder.push(bytes)).toThrow();
});
