// The application root — owns the renderer (an external resource with a lifetime) and the
// top-level reactive UI state. Built only after the kernel is sealed.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: ivue owns state and OpenTUI owns projection (project.invariants.md)
// invariant: Data flows one way (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import type { CliRenderer } from '@opentui/core';
import { StatusChannel } from '../system/StatusChannel';
import { Logging } from '../system/Logging';

class $App {
  // The renderer is a plain owned resource, never reactive — App owns its lifetime.
  renderer: CliRenderer | null = null;
  private disposers: Array<() => void> = [];
  private started = false;

  // Reactive UI state.
  get title() {
    return ref('Invar');
  }
  get statusMessage() {
    return ref('Ready · Ctrl+Q to quit');
  }
  // Ctrl+X..Ctrl+C quit chord (VS Code's terminal intercepts Ctrl+Q): armed by Ctrl+X, fires on
  // Ctrl+C, disarmed by any other key or after the timeout.
  get quitChordArmed() {
    return ref(false);
  }
  // Last copy feedback ("Copied 42 chars (osc52)") — the user-visible proof that copy fired.
  get copyNotice() {
    return ref('');
  }
  private quitChordArmedAtMs = 0;

  armQuitChord(nowMs: number): void {
    this.quitChordArmed.value = true;
    this.quitChordArmedAtMs = nowMs;
  }
  disarmQuitChord(): void {
    this.quitChordArmed.value = false;
  }
  quitChordActive(nowMs: number, timeoutMs = 2000): boolean {
    if (!this.quitChordArmed.value) return false;
    if (nowMs - this.quitChordArmedAtMs > timeoutMs) {
      this.quitChordArmed.value = false;
      return false;
    }
    return true;
  }

  /** Register a disposer to run on shutdown (LIFO). */
  onDispose(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  /** Attach the renderer and push initial dimensions to the side channel. */
  attach(renderer: CliRenderer): void {
    this.renderer = renderer;
    StatusChannel.Class.update({
      width: renderer.width,
      height: renderer.height,
      lifecycleTier: 'active',
    });
  }

  requestRender(): void {
    this.renderer?.requestRender();
  }

  markStarted(): void {
    this.started = true;
    // Boot duration measured INSIDE the process (performance.now() = ms since process start):
    // the bare app cost, excluding the harness's tmux/login-shell/bun-resolve overhead — the
    // number the perf baseline's cold-start target is actually about.
    StatusChannel.Class.update({
      ready: true,
      lifecycleTier: 'active',
      bootDurationMilliseconds: Math.round(performance.now()),
    });
    StatusChannel.Class.flush();
    Logging.Class.info('App started');
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Tear down every owned resource in reverse order, then the renderer. */
  dispose(): void {
    StatusChannel.Class.update({ lifecycleTier: 'disposing', ready: false });
    StatusChannel.Class.flush();
    // Stop the frame effect (and any other owned effect) before tearing down renderables.
    // Idempotent — shutdown() also calls this first. invariant: A referenced resource stays alive.
    // $stopEffects is injected by Reactive() on the wrapped instance, not on the raw $App type.
    try {
      (this as { $stopEffects?: () => void }).$stopEffects?.();
    } catch {
      /* no effects registered */
    }
    for (const disposer of this.disposers.reverse()) {
      try {
        disposer();
      } catch (error) {
        Logging.Class.error(`disposer failed: ${String(error)}`);
      }
    }
    this.disposers = [];
    try {
      this.renderer?.destroy();
    } catch (error) {
      Logging.Class.error(`renderer destroy failed: ${String(error)}`);
    }
    this.renderer = null;
    Logging.Class.info('App disposed');
  }
}

export namespace App {
  export const $Class = $App;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
