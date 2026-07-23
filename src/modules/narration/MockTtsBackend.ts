// A deterministic TtsBackend test double: no engine, no player, no sound. Every speak() is recorded in
// order so a test can assert EXACTLY what would have been spoken and in what sequence, and every stop()
// is counted so barge-in is assertable. This is what keeps the narration gate hermetic and non-flaky —
// scripted transcript in, asserted spoken lines out — while SystemTtsBackend proves real audio against a
// live engine. Selected in CI via INVAR_TTS_BACKEND=mock so the driving smoke never emits sound.
//
// invariant: Narration audio crosses exactly one TTS backend seam (src/modules/narration/narration.invariants.md)
import type { TtsBackend } from './TtsBackend';

class $MockTtsBackend implements TtsBackend {
  /** Every non-empty text handed to speak(), in order — the assertion surface. */
  readonly spoken: string[] = [];
  /** How many times stop() was called (barge-in count). */
  stopCount = 0;
  disposed = false;

  speak(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.spoken.push(trimmed);
  }

  stop(): void {
    this.stopCount += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export namespace MockTtsBackend {
  export const $Class = $MockTtsBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
