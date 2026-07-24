import { describe, expect, test } from 'bun:test';
import { CodexAppServerMapping } from './CodexAppServerMapping';

const mapping = CodexAppServerMapping.Class;
const map = (method: string, params: unknown, state = mapping.createTurnState()) =>
  mapping.mapNotification({ method, params }, state);

describe('CodexAppServerMapping.mapNotification', () => {
  test('thread/started → session-start; turn/completed → session-end by status', () => {
    expect(map('thread/started', {})).toEqual([{ kind: 'session-start' }]);
    expect(map('turn/completed', { turn: { status: 'completed' } })).toEqual([{ kind: 'session-end', reason: 'completed' }]);
    expect(map('turn/completed', { turn: { status: 'interrupted' } })).toEqual([{ kind: 'session-end', reason: 'interrupted' }]);
    expect(map('turn/completed', { turn: { status: 'failed' } })).toEqual([{ kind: 'session-end', reason: 'error' }]);
  });

  test('agentMessage deltas stream as text-deltas; the item completion does NOT re-emit streamed text', () => {
    const state = mapping.createTurnState();
    expect(map('item/agentMessage/delta', { itemId: 'm1', delta: 'Hel' }, state)).toEqual([{ kind: 'text-delta', text: 'Hel' }]);
    expect(map('item/agentMessage/delta', { itemId: 'm1', delta: 'lo' }, state)).toEqual([{ kind: 'text-delta', text: 'lo' }]);
    expect(map('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Hello' } }, state)).toEqual([]);
  });

  test('a DELTA-LESS agentMessage completion emits its full text once (fallback path)', () => {
    const state = mapping.createTurnState();
    expect(map('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'Whole reply' } }, state)).toEqual([
      { kind: 'text-delta', text: 'Whole reply' },
    ]);
  });

  test('commandExecution lifecycle → tool-use on start, tool-result on completion', () => {
    const started = map('item/started', { item: { type: 'commandExecution', id: 'c1', command: "/bin/bash -lc 'echo hi'" } });
    expect(started).toEqual([{ kind: 'tool-use', id: 'c1', name: 'Bash', input: { command: "/bin/bash -lc 'echo hi'" } }]);
    const completed = map('item/completed', {
      item: { type: 'commandExecution', id: 'c1', status: 'completed', aggregatedOutput: 'hi\n', exitCode: 0 },
    });
    expect(completed).toEqual([{ kind: 'tool-result', id: 'c1', result: 'hi\n', isError: false }]);
  });

  test('a DECLINED command maps to an error tool-result carrying the denial', () => {
    const completed = map('item/completed', { item: { type: 'commandExecution', id: 'c1', status: 'declined' } });
    expect(completed).toEqual([{ kind: 'tool-result', id: 'c1', result: 'The user denied this command.', isError: true }]);
  });

  test('a non-zero exit code marks the result as an error', () => {
    const completed = map('item/completed', {
      item: { type: 'commandExecution', id: 'c1', status: 'completed', aggregatedOutput: 'boom', exitCode: 2 },
    });
    expect(completed[0]).toMatchObject({ isError: true, result: 'boom' });
  });

  test('uninteresting notifications (reasoning, token usage, unknown) map to []', () => {
    expect(map('item/reasoning/textDelta', { delta: 'thinking' })).toEqual([]);
    expect(map('thread/tokenUsage/updated', {})).toEqual([]);
    expect(map('account/rateLimits/updated', {})).toEqual([]);
    expect(map('item/completed', { item: { type: 'reasoning', id: 'r1' } })).toEqual([]);
  });
});

describe('CodexAppServerMapping.approvalOf', () => {
  test('commandExecution approval → Bash descriptor with the command string', () => {
    const approval = mapping.approvalOf('item/commandExecution/requestApproval', {
      command: "/bin/bash -lc 'rm -rf /tmp/x'",
      reason: 'outside sandbox',
    });
    expect(approval).toMatchObject({ toolName: 'Bash', input: { command: "/bin/bash -lc 'rm -rf /tmp/x'" } });
  });

  test('an ARRAY command (v1 shape) joins to one string', () => {
    const approval = mapping.approvalOf('execCommandApproval', { command: ['bash', '-lc', 'echo hi'] });
    expect(approval).toMatchObject({ toolName: 'Bash', input: { command: 'bash -lc echo hi' } });
  });

  test('fileChange approval → ApplyPatch descriptor; non-approval methods → null', () => {
    expect(mapping.approvalOf('item/fileChange/requestApproval', {})).toMatchObject({ toolName: 'ApplyPatch' });
    expect(mapping.approvalOf('item/agentMessage/delta', {})).toBeNull();
  });
});

describe('CodexAppServerMapping.decisionToCodex', () => {
  test('maps the pane decisions to the v2 wire enums (never the rejected v1 strings)', () => {
    expect(mapping.decisionToCodex('allow')).toBe('accept');
    expect(mapping.decisionToCodex('always-allow')).toBe('acceptForSession');
    expect(mapping.decisionToCodex('deny')).toBe('decline');
  });
});
