// The text-to-speech I/O seam — the honest minimal shape of "a thing that can utter text aloud". A
// backend takes text to speak, can be stopped mid-utterance (barge-in), and has a lifetime. Nothing
// about HOW the speech is produced belongs here. This is the swap seam (parallel to the terminal's
// TerminalBackend and the agent's AgentBackend): MockTtsBackend records what WOULD be spoken for a
// hermetic gate (no audio in CI); SystemTtsBackend drives a real engine (espeak-ng/piper/say) into a
// player. NarrationProjection depends ONLY on this interface, so every implementation is interchangeable
// with zero change above the seam.
//
// invariant: Narration audio crosses exactly one TTS backend seam (src/modules/narration/narration.invariants.md)

/** A destination for spoken text. The single boundary between NarrationProjection and whatever turns
 *  text into sound (a real synthesis engine + player, or a silent test double). */
export interface TtsBackend {
  /** Utter `text` aloud. Implementations MAY queue utterances so turns are spoken in order; a queued
   *  backend speaks them sequentially. Calling with empty/whitespace text is a no-op. */
  speak(text: string): void;
  /** Stop the current utterance AND drop anything queued — the barge-in primitive. Idempotent; safe to
   *  call when nothing is speaking. */
  stop(): void;
  /** Release every owned resource (child processes, streams). Idempotent. */
  dispose(): void;
}
