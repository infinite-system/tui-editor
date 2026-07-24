// The speech-queue bound (review perf 9): pending narration must never accumulate unbounded while
// slow playback drains — the policy is drop-OLDEST past the cap, so what eventually plays is the
// newest speech, the speech that still describes the screen. Tested through the pure static (this
// box detects no TTS engine, so the full backend is silent by construction).
import { describe, test, expect } from 'bun:test';
import { SystemTtsBackend, MAX_PENDING_UTTERANCES } from './SystemTtsBackend';

describe('SystemTtsBackend.enqueueBounded', () => {
  test('under the cap everything queues in order', () => {
    const queue: string[] = [];
    for (let index = 0; index < MAX_PENDING_UTTERANCES; index++) {
      SystemTtsBackend.Class.enqueueBounded(queue, `utterance ${index}`, MAX_PENDING_UTTERANCES);
    }
    expect(queue.length).toBe(MAX_PENDING_UTTERANCES);
    expect(queue[0]).toBe('utterance 0');
  });

  test('past the cap the OLDEST utterances drop and the newest survive', () => {
    const queue: string[] = [];
    for (let index = 0; index < MAX_PENDING_UTTERANCES * 3; index++) {
      SystemTtsBackend.Class.enqueueBounded(queue, `utterance ${index}`, MAX_PENDING_UTTERANCES);
    }
    expect(queue.length).toBe(MAX_PENDING_UTTERANCES);
    expect(queue[0]).toBe(`utterance ${MAX_PENDING_UTTERANCES * 2}`);
    expect(queue[queue.length - 1]).toBe(`utterance ${MAX_PENDING_UTTERANCES * 3 - 1}`);
  });

  test('the queue length is bounded at every step, not only at the end', () => {
    const queue: string[] = [];
    for (let index = 0; index < 100; index++) {
      SystemTtsBackend.Class.enqueueBounded(queue, `utterance ${index}`, 3);
      expect(queue.length).toBeLessThanOrEqual(3);
    }
  });
});
