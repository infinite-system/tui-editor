// The real TtsBackend: it auto-detects an installed speech engine and speaks through it, sequentially,
// with barge-in. Same auto-detect+graceful-fallback discipline as the agent providers — it prefers the
// first engine on PATH (espeak-ng, then piper, then macOS `say`) and, on Linux, pipes the synthesized
// WAV into whichever player is present (pw-play or aplay). If NO engine is installed it is a clean
// NO-OP: speak()/stop() do nothing and `available` is false, so narration silently does nothing until an
// engine is installed — never an error, never a crash.
//
// SILENT UNTIL AN ENGINE IS INSTALLED on this box: espeak-ng / piper / say are all absent here (only the
// players aplay + pw-play are present), so this backend reports available=false and utters nothing. One
// line enables real audio:  sudo apt-get install -y espeak-ng
//
// invariant: Narration audio crosses exactly one TTS backend seam (src/modules/narration/narration.invariants.md)
// invariant: A missing speech engine degrades to silence, never an error (src/modules/narration/narration.invariants.md)
import { readdirSync } from 'node:fs';
import type { TtsBackend } from './TtsBackend';

/** A detected engine: how to synthesize `text`, and whether it plays on its own (macOS `say`) or emits
 *  a WAV that must be piped into a separate player. */
interface DetectedEngine {
  readonly name: string;
  /** The synth command for one utterance. When `playsDirectly`, this command also plays the audio;
   *  otherwise it must emit a WAV stream on stdout for the player to consume. */
  synthCommand(text: string): string[];
  readonly playsDirectly: boolean;
}

export interface SystemTtsOptions {
  /** Override engine auto-detection (mainly for tests). */
  enginePath?: string;
}

/** Resolve piper's voice model: an explicit INVAR_PIPER_MODEL, else the first `*.onnx` in the
 *  conventional voices dir (`$XDG_DATA_HOME/piper-voices` or `~/.local/share/piper-voices`). Returns null
 *  when no model is found — a model-less piper cannot synthesize, so it is skipped. */
function resolvePiperModel(): string | null {
  const explicit = process.env.INVAR_PIPER_MODEL;
  if (explicit) return explicit;
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ''}/.local/share`;
  const voicesDir = `${dataHome}/piper-voices`;
  try {
    const model = readdirSync(voicesDir)
      .filter((entry) => entry.endsWith('.onnx'))
      .sort()[0];
    return model ? `${voicesDir}/${model}` : null;
  } catch {
    return null; // dir absent / unreadable → no piper model
  }
}

/** Resolve the best available engine, or null. Ordered by QUALITY: piper (neural — far less robotic) is
 *  preferred when its binary AND a voice model are present; espeak-ng (formant synth) is the always-there
 *  fallback; macOS `say` last. espeak/piper emit a WAV on stdout (piped to a player); `say` plays
 *  directly. */
function detectEngine(): DetectedEngine | null {
  const piper = Bun.which('piper');
  const piperModel = piper ? resolvePiperModel() : null;
  if (piper && piperModel) {
    return {
      name: 'piper',
      playsDirectly: false,
      // piper reads the utterance on stdin; the queue writes text to stdin below.
      synthCommand: () => [piper, '--model', piperModel, '--output_file', '-'],
    };
  }
  const espeak = Bun.which('espeak-ng') ?? Bun.which('espeak');
  if (espeak) {
    return { name: 'espeak-ng', playsDirectly: false, synthCommand: (text) => [espeak, '--stdout', text] };
  }
  const say = Bun.which('say');
  if (say) {
    return { name: 'say', playsDirectly: true, synthCommand: (text) => [say, text] };
  }
  return null;
}

/** The Linux player for a WAV stream on stdin, or null when the engine plays directly / none present.
 *  Order matters: the engine emits a WAV (RIFF header declaring the sample rate — espeak-ng is 22050 Hz),
 *  and the player must READ that header off the pipe. `aplay -` parses the WAV header from stdin and
 *  plays at the correct rate; `pw-play -` does NOT parse a header off a pipe — it assumes its default
 *  48000 Hz, playing 22050 Hz audio ~2.18× too fast (the "chipmunk" bug). So prefer aplay; pw-play is
 *  only a last resort (a pw-play-only host would still be fast-pitched — hardening that is a follow-up,
 *  e.g. play via a temp file, which every player parses correctly). */
function detectPlayer(): string | null {
  return Bun.which('aplay') ?? Bun.which('pw-play');
}

type Spawned = { kill(): void; readonly exited: Promise<number> };

class $SystemTtsBackend implements TtsBackend {
  private readonly engine: DetectedEngine | null;
  private readonly playerPath: string | null;
  private readonly queue: string[] = [];
  private synth: Spawned | null = null;
  private player: Spawned | null = null;
  private disposed = false;

  constructor(_options: SystemTtsOptions = {}) {
    this.engine = detectEngine();
    this.playerPath = this.engine && !this.engine.playsDirectly ? detectPlayer() : null;
  }

  /** True when a working engine (and, on Linux, a player) was found — otherwise narration is silent. */
  get available(): boolean {
    if (!this.engine) return false;
    return this.engine.playsDirectly || this.playerPath !== null;
  }

  /** The detected engine name, or 'none' — surfaced so the UI can tell the user why it is silent. */
  get engineName(): string {
    return this.available ? (this.engine?.name ?? 'none') : 'none';
  }

  speak(text: string): void {
    if (this.disposed || !this.available) return; // clean no-op when no engine
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push(trimmed);
    if (!this.synth && !this.player) this.playNext();
  }

  stop(): void {
    this.queue.length = 0;
    this.safeKill(this.player);
    this.safeKill(this.synth);
    this.player = null;
    this.synth = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Pull the next utterance and play it; chain to the following one when it finishes. Every spawn is
   *  guarded — a failure to launch the engine/player just skips that utterance rather than crashing. */
  private playNext(): void {
    const text = this.queue.shift();
    if (text === undefined || !this.engine) {
      this.synth = null;
      this.player = null;
      return;
    }
    try {
      if (this.engine.playsDirectly) {
        const process = Bun.spawn({ cmd: this.engine.synthCommand(text), stdout: 'ignore', stderr: 'ignore' });
        this.player = process;
        this.synth = null;
        void process.exited.then(() => this.onUtteranceDone(process));
        return;
      }
      const synth = Bun.spawn({
        cmd: this.engine.synthCommand(text),
        stdin: this.engine.name === 'piper' ? new TextEncoder().encode(`${text}\n`) : 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      // aplay reads stdin as '-' and quiets with '-q'; pw-play reads stdin as '-'.
      const playerArguments = this.playerPath?.endsWith('aplay') ? ['-q', '-'] : ['-'];
      const player = Bun.spawn({
        cmd: [this.playerPath as string, ...playerArguments],
        stdin: synth.stdout,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      this.synth = synth;
      this.player = player;
      void player.exited.then(() => this.onUtteranceDone(player));
    } catch {
      // Engine/player failed to launch — drop this utterance and try the next so one bad spawn never
      // wedges the queue. Narration degrades to silence, never an error.
      this.synth = null;
      this.player = null;
      this.playNext();
    }
  }

  private onUtteranceDone(finished: Spawned): void {
    if (this.player !== finished) return; // superseded by a stop()/new utterance — ignore stale exit
    this.player = null;
    this.synth = null;
    if (!this.disposed) this.playNext();
  }

  private safeKill(process: Spawned | null): void {
    try {
      process?.kill();
    } catch {
      /* already gone */
    }
  }
}

export namespace SystemTtsBackend {
  export const $Class = $SystemTtsBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
