// The third projection, proven with plain doubles: a scripted AgentSession transcript in, the exact
// spoken lines (and their order) out through a MockTtsBackend — no engine, no audio. Covers the
// milestone filter (only COMPLETED turns speak), the off-by-default gate (silent when disabled),
// assistant-only narration, ordering across turns, barge-in, and the mid-session enable (no backlog).
import { test, expect } from 'bun:test';
import { ref } from 'vue';
import { AgentSession } from '../agent/AgentSession';
import { MockAgentBackend } from '../agent/MockAgentBackend';
import { MockTtsBackend } from './MockTtsBackend';
import { NarrationProjection } from './NarrationProjection';
import type { AgentEvent } from '../agent/AgentEvents';

function wire(enabled: boolean) {
  const backend = new MockAgentBackend.Class();
  const session = new AgentSession.Class(backend);
  const tts = new MockTtsBackend.Class();
  const toggle = ref(enabled);
  const projection = new NarrationProjection.Class(session, toggle, tts);
  return { backend, session, tts, toggle, projection };
}

// A full assistant turn that STARTS, streams two deltas, and ENDS (the completion milestone).
const completedTurn = (text: string): AgentEvent[] => [
  { kind: 'session-start' },
  { kind: 'text-delta', text: text.slice(0, Math.ceil(text.length / 2)) },
  { kind: 'text-delta', text: text.slice(Math.ceil(text.length / 2)) },
  { kind: 'session-end', reason: 'completed' },
];

test('OFF by default: a completed turn speaks NOTHING', () => {
  const { backend, tts, projection } = wire(false);
  backend.script(completedTurn('hello world'));
  expect(tts.spoken).toEqual([]);
  expect(projection.spokenCount.value).toBe(0);
});

test('ON: a completed assistant turn is spoken once, in full', () => {
  const { backend, tts, projection } = wire(true);
  backend.script(completedTurn('hello world'));
  expect(tts.spoken).toEqual(['hello world']);
  expect(projection.spokenCount.value).toBe(1);
  expect(projection.lastSpoken.value).toBe('hello world');
});

test('MILESTONE filter: streaming text is NOT spoken until the turn completes', () => {
  const { backend, tts } = wire(true);
  backend.emit({ kind: 'session-start' });
  backend.emit({ kind: 'text-delta', text: 'thinking' });
  backend.emit({ kind: 'text-delta', text: ' more' });
  expect(tts.spoken).toEqual([]); // still streaming → not a milestone → silent
  backend.emit({ kind: 'session-end', reason: 'completed' });
  expect(tts.spoken).toEqual(['thinking more']); // boundary reached → one utterance, whole turn
});

test('a turn closed by a following tool-use is spoken at that boundary', () => {
  const { backend, tts } = wire(true);
  backend.emit({ kind: 'session-start' });
  backend.emit({ kind: 'text-delta', text: 'let me check' });
  expect(tts.spoken).toEqual([]); // trailing open turn, still awaiting → silent
  backend.emit({ kind: 'tool-use', id: 't1', name: 'Bash', input: {} });
  expect(tts.spoken).toEqual(['let me check']); // the tool-use closed the assistant turn → spoken
});

test('multiple turns speak in order; only assistant text, never user/tool entries', () => {
  const { session, backend, tts } = wire(true);
  session.send('first question'); // a USER entry — must never be spoken
  backend.script([
    { kind: 'text-delta', text: 'answer one' },
    { kind: 'tool-use', id: 't1', name: 'Read', input: {} },
    { kind: 'tool-result', id: 't1', result: 'file contents', isError: false }, // must never be spoken
    { kind: 'text-delta', text: 'answer two' },
    { kind: 'session-end', reason: 'completed' },
  ]);
  expect(tts.spoken).toEqual(['answer one', 'answer two']);
});

test('barge-in: bargeIn() stops the backend (interruptibility)', () => {
  const { tts, projection } = wire(true);
  projection.bargeIn();
  projection.bargeIn();
  expect(tts.stopCount).toBe(2);
});

test('enabling mid-session starts from the NEXT turn — no backlog flood', () => {
  const { backend, tts, toggle } = wire(false);
  backend.script(completedTurn('old turn while muted')); // arrived while OFF
  expect(tts.spoken).toEqual([]);
  toggle.value = true; // user enables narration now
  backend.script([
    { kind: 'session-start' },
    { kind: 'text-delta', text: 'new turn' },
    { kind: 'session-end', reason: 'completed' },
  ]);
  expect(tts.spoken).toEqual(['new turn']); // the old muted turn is NOT re-spoken
});

test('dispose stops watching and disposes the backend', () => {
  const { backend, tts, projection } = wire(true);
  projection.dispose();
  expect(tts.disposed).toBe(true);
  backend.script(completedTurn('after dispose')); // no longer observed
  expect(tts.spoken).toEqual([]);
});
