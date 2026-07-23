// The construction seam for the narration's TTS backend. Auto-detect + graceful fallback, exactly like
// AgentFactory picks an agent backend: INVAR_TTS_BACKEND=mock forces the silent MockTtsBackend (keeps
// the driving smoke hermetic — no audio in CI), otherwise a SystemTtsBackend is built and IT decides
// whether a real engine is present (no engine → it is a clean no-op). Overridable Static seam so a test
// or alternate host can inject any TtsBackend without the caller knowing which it got.
//
// invariant: Narration audio crosses exactly one TTS backend seam (src/modules/narration/narration.invariants.md)
import { Static } from 'ivue/extras';
import type { TtsBackend } from './TtsBackend';
import { MockTtsBackend } from './MockTtsBackend';
import { SystemTtsBackend } from './SystemTtsBackend';

export interface TtsCreateOptions {
  /** The user-selected piper voice NAME (`agentNarrationVoice`); threaded to the real backend so the
   *  chosen voice is used. Ignored by the mock. */
  voice?: string;
  /** Speech rate (`agentNarrationRate`, piper length_scale; lower = faster). Ignored by the mock. */
  rate?: number;
}

/** Pick the TTS backend. `INVAR_TTS_BACKEND=mock` → the silent recording double (CI/tests). Otherwise
 *  the real SystemTtsBackend, which auto-detects an engine (in the selected voice + rate) and no-ops
 *  when none is installed. */
function $createBackend(options: TtsCreateOptions = {}): TtsBackend {
  if (process.env.INVAR_TTS_BACKEND === 'mock') return new MockTtsBackend.Class();
  return new SystemTtsBackend.Class({ voice: options.voice, rate: options.rate });
}

class $TtsFactory {
  static createBackend = $createBackend;
}

export namespace TtsFactory {
  export const $Class = $TtsFactory;
  export const Class = Static($TtsFactory);
}
