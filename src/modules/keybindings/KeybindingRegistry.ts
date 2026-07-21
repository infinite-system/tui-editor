// Layered, intent-addressed keybinding resolution. Bindings are DATA (chord pattern or step list →
// action id, with optional context + guard); resolution is a pure lookup over layers where LATER
// layers shadow earlier ones (canonical floor ← platform overlays ← user rebinds). Multi-step
// chords are step-list data with a timeout — not bespoke state code.
//
// invariant: Bindings are intent addressed (keybindings.invariants.md)
// invariant: Resolution is layered and later layers shadow earlier (keybindings.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

/** A normalized chord pattern. ctrl/alt/super must match exactly (absent = required absent); shift
 *  left undefined is DON'T-CARE (movement actions read the event's shift as "extend"). */
export interface ChordPattern {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  super?: boolean;
}

export interface Keybinding {
  action: string;
  /** Single chord (exclusive with steps). */
  chord?: ChordPattern;
  /** Multi-step chord, e.g. Ctrl+X then Ctrl+C. */
  steps?: ChordPattern[];
  /** Focus context this binding applies in; 'global' applies everywhere. */
  context?: 'global' | 'editor' | 'files' | 'git' | 'palette';
  /** Named guard (host-registered predicate) that must be true for the binding to fire. */
  when?: string;
}

/** The slice of a decoded key event that resolution needs. */
export interface ChordEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  option: boolean;
  super?: boolean;
}

export interface Resolution {
  /** The action to dispatch, or null (no binding — the caller applies the context's default). */
  action: string | null;
  /** True when this event STARTED or ADVANCED a multi-step chord (caller shows the armed hint). */
  chordPending: boolean;
}

const CHORD_TIMEOUT_MS = 2000;

function patternMatches(pattern: ChordPattern, event: ChordEvent): boolean {
  if (pattern.key !== event.name) return false;
  if ((pattern.ctrl ?? false) !== event.ctrl) return false;
  if ((pattern.alt ?? false) !== event.option) return false;
  if ((pattern.super ?? false) !== (event.super ?? false)) return false;
  if (pattern.shift !== undefined && pattern.shift !== event.shift) return false;
  return true;
}

interface Layer {
  name: string;
  bindings: Keybinding[];
}

class $KeybindingRegistry {
  private layers: Layer[] = [];
  private guards = new Map<string, () => boolean>();
  private pendingChord: { binding: Keybinding; stepIndex: number; armedAtMs: number } | null = null;

  /** Bumped whenever layers change, so effective-binding hints recompute. */
  get revision() {
    return ref(0);
  }
  get chordArmed() {
    return shallowRef(false);
  }

  registerLayer(name: string, bindings: Keybinding[]): void {
    this.layers = [...this.layers.filter((layer) => layer.name !== name), { name, bindings }];
    this.revision.value += 1;
  }

  registerGuard(name: string, predicate: () => boolean): void {
    this.guards.set(name, predicate);
  }

  private guardPasses(binding: Keybinding): boolean {
    if (!binding.when) return true;
    const guard = this.guards.get(binding.when);
    return guard ? guard() : false;
  }

  private inContext(binding: Keybinding, context: string): boolean {
    return (binding.context ?? 'global') === 'global' || binding.context === context;
  }

  /**
   * Resolve one decoded key event in a context. Precedence: an in-flight chord's next step, then
   * (scanning layers LAST to first — later shadows earlier): guarded singles, unguarded singles,
   * then chord STARTS. Any non-matching event cancels a pending chord and resolves normally.
   */
  resolve(event: ChordEvent, context: string, nowMs: number): Resolution {
    if (this.pendingChord) {
      const { binding, stepIndex, armedAtMs } = this.pendingChord;
      const expired = nowMs - armedAtMs > CHORD_TIMEOUT_MS;
      const nextStep = binding.steps?.[stepIndex];
      if (!expired && nextStep && patternMatches(nextStep, event)) {
        if (stepIndex + 1 >= (binding.steps?.length ?? 0)) {
          this.pendingChord = null;
          this.chordArmed.value = false;
          return { action: binding.action, chordPending: false };
        }
        this.pendingChord = { binding, stepIndex: stepIndex + 1, armedAtMs: nowMs };
        return { action: null, chordPending: true };
      }
      this.pendingChord = null; // wrong key or timeout breaks the chord; resolve this event normally
      this.chordArmed.value = false;
    }

    let matchedSingle: Keybinding | null = null;
    let matchedGuardedSingle: Keybinding | null = null;
    let matchedChordStart: Keybinding | null = null;
    for (let layerIndex = this.layers.length - 1; layerIndex >= 0; layerIndex--) {
      const layer = this.layers[layerIndex];
      if (!layer) continue;
      for (const binding of layer.bindings) {
        if (!this.inContext(binding, context)) continue;
        if (binding.chord && patternMatches(binding.chord, event) && this.guardPasses(binding)) {
          if (binding.when) matchedGuardedSingle = matchedGuardedSingle ?? binding;
          else matchedSingle = matchedSingle ?? binding;
        } else if (binding.steps?.[0] && patternMatches(binding.steps[0], event) && this.guardPasses(binding)) {
          matchedChordStart = matchedChordStart ?? binding;
        }
      }
      // A hit in a later layer shadows everything earlier — stop at the first layer with any match.
      if (matchedGuardedSingle || matchedSingle || matchedChordStart) break;
    }
    if (matchedGuardedSingle) return { action: matchedGuardedSingle.action, chordPending: false };
    if (matchedSingle) return { action: matchedSingle.action, chordPending: false };
    if (matchedChordStart) {
      this.pendingChord = { binding: matchedChordStart, stepIndex: 1, armedAtMs: nowMs };
      this.chordArmed.value = true;
      return { action: null, chordPending: true };
    }
    return { action: null, chordPending: false };
  }

  cancelChord(): void {
    this.pendingChord = null;
    this.chordArmed.value = false;
  }

  /** The post-shadowing binding map: action id → the chord pattern(s) that reach it (for hints).
   *  invariant: Advertised bindings are deliverable bindings (keybindings.invariants.md) */
  effectiveBindings(context: string): Map<string, Keybinding> {
    void this.revision.value; // subscribe
    const effective = new Map<string, Keybinding>();
    for (const layer of this.layers) {
      for (const binding of layer.bindings) {
        if (!this.inContext(binding, context)) continue;
        effective.set(binding.action, binding); // later layers overwrite = shadowing
      }
    }
    return effective;
  }

  /** Every action bound with `super` must also be reachable without it (the canonical floor).
   *  invariant: The canonical layer is the floor (keybindings.invariants.md) */
  actionsMissingCanonicalFloor(): string[] {
    const superActions = new Set<string>();
    const floorActions = new Set<string>();
    for (const layer of this.layers) {
      for (const binding of layer.bindings) {
        const usesSuper = binding.chord?.super || binding.steps?.some((step) => step.super);
        (usesSuper ? superActions : floorActions).add(binding.action);
      }
    }
    return [...superActions].filter((action) => !floorActions.has(action));
  }
}

export namespace KeybindingRegistry {
  export const $Class = $KeybindingRegistry;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
