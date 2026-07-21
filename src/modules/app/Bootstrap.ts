// Boot sequence: seal the kernel, create the renderer, build the frame, wire input,
// stand up the settle-detecting status channel, and run until quit.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: The terminal shows a bounded viewport (project.invariants.md)
import { createCliRenderer, type CliRenderer, type KeyEvent } from '@opentui/core';
import { App } from './App';
import { Kernel } from '../kernel/Kernel';
import { buildRootView, type RootViewHandles } from '../ui/RootView';
import { StatusChannel } from '../system/StatusChannel';
import { Logging } from '../system/Logging';

export interface BootOptions {
  onQuit?: () => void;
  headlessWidth?: number;
  headlessHeight?: number;
}

export interface BootedApp {
  app: App.Instance;
  renderer: CliRenderer;
  view: RootViewHandles;
  shutdown(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<BootedApp> {
  Logging.Class.info('Boot start');

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    // event-driven: we drive frames with requestRender(), no idle animation loop.
  });

  // Seal the kernel before any application instance exists.
  Kernel.instance.seal();
  Kernel.instance.assertSealed();

  const app = new App.Class();
  app.attach(renderer);

  const view = buildRootView(renderer, app);

  // Settle detection: request a render, wait for the next real frame emission (with a
  // timeout fallback so the harness never hangs), then publish a quiescent snapshot.
  let frame = 0;
  const settle = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        renderer.off('frame', finish);
        resolve();
      };
      renderer.once('frame', finish);
      renderer.requestRender();
      setTimeout(finish, 120);
    });
    frame += 1;
    StatusChannel.Class.settle(frame);
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    Logging.Class.info('Shutdown start');
    view.dispose();
    app.dispose();
    options.onQuit?.();
  };

  // Input: global keybindings. Ctrl+Q / Ctrl+C quit cleanly.
  const onKey = (key: KeyEvent): void => {
    if ((key.name === 'q' && key.ctrl) || (key.name === 'c' && key.ctrl)) {
      void shutdown();
      return;
    }
    // Future: dispatch to command/keybinding registries.
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  // Resize: re-publish dimensions and re-render.
  const onResize = (w: number, h: number): void => {
    StatusChannel.Class.update({ width: w, height: h });
    void settle();
  };
  renderer.on('resize', onResize);
  app.onDispose(() => renderer.off('resize', onResize));

  renderer.start();
  app.markStarted();
  await settle();

  Logging.Class.info('Boot complete');
  return { app, renderer, view, shutdown };
}
