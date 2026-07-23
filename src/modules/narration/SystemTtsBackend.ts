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

/** Resolve the first available engine, or null. `espeak-ng --stdout` and `piper --output_file -` emit a
 *  WAV on stdout; macOS `say` plays directly. Piper needs a voice model — taken from INVAR_PIPER_MODEL,
 *  and piper is skipped when that is unset (a model-less piper cannot synthesize). */
function detectEngine(): DetectedEngine | null {
  const espeak = Bun.which('espeak-ng') ?? Bun.which('espeak');
  if (espeak) {
    return { name: 'espeak-ng', playsDirectly: false, synthCommand: (text) => [espeak, '--stdout', text] };
  }
  const piper = Bun.which('piper');
  const piperModel = process.env.INVAR_PIPER_MODEL;
  if (piper && piperModel) {
    return {
      name: 'piper',
      playsDirectly: false,
      // piper reads the utterance on stdin; we pass text through the queue by writing it to stdin below.
      synthCommand: () => [piper, '--model', piperModel, '--output_file', '-'],
    };
  }
  const say = Bun.which('say');
  if (say) {
    return { name: 'say', playsDirectly: true, synthCommand: (text) => [say, text] };
  }
  return null;
}

/** The Linux player for a WAV stream on stdin, or null when the engine plays directly / none present. */
function detectPlayer(): string | null {
  const pwPlay = Bun.which('pw-play');
  if (pwPlay) return pwPlay;
  const aplay = Bun.which('aplay');
  if (aplay) return aplay;
  return null;
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
