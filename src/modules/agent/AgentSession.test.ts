import { describe, expect, test } from 'bun:test';
import { AgentSession } from './AgentSession';
import { MockAgentBackend } from './MockAgentBackend';

/** A session wired to a scriptable mock backend — the whole harness with no subprocess. */
function makeSession(): { session: AgentSession.Model; backend: MockAgentBackend.Model } {
  const backend = new MockAgentBackend.Class();
  const session = new AgentSession.Class(backend);
  return { session, backend };
}

describe('AgentSession', () => {
  test('send records the prompt through the seam, appends a user entry, and goes streaming', () => {
    const { session, backend } = makeSession();

    session.send('  hello claude  ');

    expect(backend.sent).toEqual(['hello claude']); // trimmed, submitted through the one seam
    expect(session.transcript).toEqual([{ role: 'user', text: 'hello claude' }]);
    expect(session.status.value).toBe('streaming');
    expect(session.busy).toBe(true);
  });

  test('an empty or whitespace-only prompt is ignored (no turn, no entry)', () => {
    const { session, backend } = makeSession();
    session.send('   ');
    expect(backend.sent).toEqual([]);
    expect(session.transcript).toEqual([]);
    expect(session.status.value).toBe('idle');
  });

  test('consecutive text-deltas coalesce into ONE growing assistant entry', () => {
    const { session, backend } = makeSession();
    session.send('hi');

    backend.script([
      { kind: 'text-delta', text: 'Hel' },
      { kind: 'text-delta', text: 'lo ' },
      { kind: 'text-delta', text: 'there' },
    ]);

    expect(session.transcript).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'Hello there' },
    ]);
    expect(session.status.value).toBe('streaming');
  });

  test('a tool-use closes the assistant turn and pairs with its result by id', () => {
    const { session, backend } = makeSession();
    session.send('read the file');

    backend.script([
      { kind: 'text-delta', text: 'Let me look.' },
      { kind: 'tool-use', id: 't1', name: 'readFile', input: { path: 'a.ts' } },
    ]);
    expect(session.status.value).toBe('awaiting-tool');

    backend.emit({ kind: 'tool-result', id: 't1', result: 'file contents', isError: false });
    // A delta AFTER the tool result starts a NEW assistant entry, not appended to the pre-tool one.
    backend.emit({ kind: 'text-delta', text: 'Done.' });

    expect(session.transcript).toEqual([
      { role: 'user', text: 'read the file' },
      { role: 'assistant', text: 'Let me look.' },
      { role: 'tool-use', id: 't1', name: 'readFile', input: { path: 'a.ts' } },
      { role: 'tool-result', id: 't1', result: 'file contents', isError: false },
      { role: 'assistant', text: 'Done.' },
    ]);
    expect(session.status.value).toBe('streaming');
  });

  test('session-end returns to idle (completed) or ended (error); busy clears', () => {
    const { session, backend } = makeSession();
    session.send('go');
    backend.emit({ kind: 'text-delta', text: 'ok' });
    backend.emit({ kind: 'session-end', reason: 'completed' });
    expect(session.status.value).toBe('idle');
    expect(session.busy).toBe(false);

    session.send('again');
    backend.emit({ kind: 'session-end', reason: 'error' });
    expect(session.status.value).toBe('ended');
  });

  test('an error event appends an error entry without derailing the transcript', () => {
    const { session, backend } = makeSession();
    session.send('go');
    backend.emit({ kind: 'error', message: 'backend exploded' });
    expect(session.transcript).toEqual([
      { role: 'user', text: 'go' },
      { role: 'error', text: 'backend exploded' },
    ]);
  });

  test('send is refused while a turn is in flight (one turn at a time)', () => {
    const { session, backend } = makeSession();
    session.send('first');
    backend.emit({ kind: 'text-delta', text: 'working' }); // still streaming
    session.send('second'); // must be ignored

    expect(backend.sent).toEqual(['first']);
    expect(session.transcript.filter((e) => e.role === 'user')).toEqual([{ role: 'user', text: 'first' }]);
  });

  test('renderRevision bumps on every folded event (the reactive paint pulse)', () => {
    const { session, backend } = makeSession();
    const before = session.renderRevision.value;
    session.send('go'); // +1
    backend.emit({ kind: 'text-delta', text: 'a' }); // +1
    backend.emit({ kind: 'text-delta', text: 'b' }); // +1
    expect(session.renderRevision.value).toBe(before + 3);
  });

  test('interrupt only fires while busy and drives an interrupted end', () => {
    const { session, backend } = makeSession();
    session.interrupt(); // idle → no-op
    expect(backend.interrupted).toBe(false);

    session.send('go');
    session.interrupt(); // busy → interrupts
    expect(backend.interrupted).toBe(true);
    expect(session.status.value).toBe('idle');
  });

  test('dispose tears down the backend', () => {
    const { session, backend } = makeSession();
    session.dispose();
    expect(backend.disposed).toBe(true);
  });
});

describe('AgentSession — interactive permission requests', () => {
  test('permission-request folds to a PENDING transcript entry and exposes pendingPermission', () => {
    const { session, backend } = makeSession();
    session.send('run it');
    const decisions: string[] = [];
    backend.emit({
      kind: 'permission-request', id: 'p1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' },
      respond: (decision) => decisions.push(decision),
    });
    expect(session.transcript.at(-1)).toMatchObject({ role: 'permission-request', id: 'p1', toolName: 'Bash', status: 'pending' });
    expect(session.pendingPermission).toMatchObject({ id: 'p1', toolName: 'Bash' });
    expect(session.status.value).toBe('awaiting-tool'); // the turn is paused on a gated tool
    expect(decisions).toEqual([]); // nothing resolved yet — the call is genuinely paused
  });

  test('respondToPermission routes the decision into the backend callback EXACTLY once and records it', () => {
    const { session, backend } = makeSession();
    session.send('run it');
    const decisions: string[] = [];
    backend.emit({ kind: 'permission-request', id: 'p1', toolName: 'Bash', input: {}, respond: (d) => decisions.push(d) });

    session.respondToPermission('p1', 'allow');
    expect(decisions).toEqual(['allow']);
    expect(session.transcript.at(-1)).toMatchObject({ role: 'permission-request', status: 'allowed' });
    expect(session.pendingPermission).toBeNull();

    session.respondToPermission('p1', 'deny'); // second answer is a no-op (responder consumed)
    expect(decisions).toEqual(['allow']);
  });

  test('deny records a denied entry; always-allow records allowed', () => {
    const { session, backend } = makeSession();
    session.send('x');
    const decisions: string[] = [];
    backend.emit({ kind: 'permission-request', id: 'p1', toolName: 'Bash', input: {}, respond: (d) => decisions.push(d) });
    session.respondToPermission('p1', 'deny');
    expect(session.transcript.at(-1)).toMatchObject({ status: 'denied' });

    backend.emit({ kind: 'permission-request', id: 'p2', toolName: 'Read', input: {}, respond: (d) => decisions.push(d) });
    session.respondToPermission('p2', 'always-allow');
    expect(decisions).toEqual(['deny', 'always-allow']);
    expect(session.transcript.at(-1)).toMatchObject({ status: 'allowed' });
  });

  test('a session-end DENY-resolves any dangling pending request (no leaked pause)', () => {
    const { session, backend } = makeSession();
    session.send('x');
    const decisions: string[] = [];
    backend.emit({ kind: 'permission-request', id: 'p1', toolName: 'Bash', input: {}, respond: (d) => decisions.push(d) });
    backend.emit({ kind: 'session-end', reason: 'interrupted' });
    expect(decisions).toEqual(['deny']);
    expect(session.pendingPermission).toBeNull();
    expect(session.transcript.at(-1)).toMatchObject({ role: 'permission-request', status: 'denied' });
  });

  test('permissionPromptsSupported reflects the backend capability flag', () => {
    const { session } = makeSession();
    expect(session.permissionPromptsSupported).toBe(false); // the mock declares no support
  });
});
