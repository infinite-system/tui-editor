// The application root — owns the renderer (an external resource with a lifetime) and the
// top-level reactive UI state. Built only after the kernel is sealed.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: ivue owns state, OpenTUI owns projection (project.invariants.md)
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
    return ref('Fable');
  }
  get statusMessage() {
    return ref('Ready · Ctrl+Q to quit');
  }

  /** Register a disposer to run on shutdown (LIFO). */
  onDispose(fn: () => void): void {
    this.disposers.push(fn);
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
    StatusChannel.Class.update({ ready: true, lifecycleTier: 'active' });
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
    for (const d of this.disposers.reverse()) {
      try {
        d();
      } catch (e) {
        Logging.Class.error(`disposer failed: ${String(e)}`);
      }
    }
    this.disposers = [];
    try {
      this.renderer?.destroy();
    } catch (e) {
      Logging.Class.error(`renderer destroy failed: ${String(e)}`);
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
