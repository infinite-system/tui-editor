// Discovers the piper voices installed on this machine so the user can PICK one instead of hand-moving
// `.onnx` files. It scans the conventional voices directory (`$XDG_DATA_HOME/piper-voices`, else
// `~/.local/share/piper-voices`) AND its `library/` subdirectory for `*.onnx` models, so EVERY
// downloaded voice is selectable — not just whichever file currently sits at the top level. Pure
// filesystem probe: no engine, no audio. This is the runtime source for the voice picker's dynamic-enum
// options and for SystemTtsBackend's selected-voice resolution.
//
// invariant: The narration voice is chosen from the discovered set (src/modules/narration/narration.invariants.md)
import { Static } from 'ivue/extras';
import { readdirSync } from 'node:fs';

/** One installed voice: its selectable NAME (the `.onnx` basename) and the absolute model path. */
export interface DiscoveredVoice {
  readonly name: string;
  readonly path: string;
}

/** The conventional piper voices directory — `$XDG_DATA_HOME/piper-voices`, else `~/.local/share/…`. */
function voicesDirectory(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME ?? ''}/.local/share`;
  return `${dataHome}/piper-voices`;
}

/** The `*.onnx` models directly in `directory` (never recursive beyond the one level asked for). */
function listOnnx(directory: string): DiscoveredVoice[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.onnx'))
      .map((entry) => ({ name: entry.slice(0, -'.onnx'.length), path: `${directory}/${entry}` }));
  } catch {
    return []; // directory absent / unreadable → no voices from here
  }
}

/** All installed voices: the top-level dir plus its `library/` subdir, deduped by name (top level wins),
 *  sorted by name for a stable picker order. */
function discover(): DiscoveredVoice[] {
  const base = voicesDirectory();
  const found = [...listOnnx(base), ...listOnnx(`${base}/library`)];
  const byName = new Map<string, DiscoveredVoice>();
  for (const voice of found) if (!byName.has(voice.name)) byName.set(voice.name, voice);
  return [...byName.values()].sort((first, second) => first.name.localeCompare(second.name));
}

class $VoiceDiscovery {
  static voicesDirectory = voicesDirectory;
  static discover = discover;

  /** Discovered voice names, sorted. */
  static names(): string[] {
    return discover().map((voice) => voice.name);
  }

  /** Picker options: '' (auto — first found) followed by each discovered voice name. */
  static options(): readonly string[] {
    return ['', ...$VoiceDiscovery.names()];
  }

  /** The `.onnx` path for `selected`, or the first-found when `selected` is empty/unknown, or null when
   *  no voice is installed. This is the selected-over-first-found resolution the picker needs. */
  static resolvePath(selected: string): string | null {
    const voices = discover();
    if (selected) {
      const match = voices.find((voice) => voice.name === selected);
      if (match) return match.path;
    }
    return voices[0]?.path ?? null;
  }
}

export namespace VoiceDiscovery {
  export const $Class = $VoiceDiscovery;
  export const Class = Static($VoiceDiscovery);
}
