// Boot sequence: seal the kernel, create the renderer, open the workspace, build the frame,
// wire ONE reactive frame effect, wire input, and run until quit.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: Data flows one way (project.invariants.md)
// invariant: Rendering is one coarse frame effect (app.invariants.md)
import { createCliRenderer, type CliRenderer, type KeyEvent } from '@opentui/core';
import { App } from './App';
import { Kernel } from '../kernel/Kernel';
import { Workspace } from '../workspace/Workspace';
import { Theme } from '../theme/Theme';
import { CommandRegistry } from '../commands/CommandRegistry';
import { registerDefaultCommands } from '../commands/commands.defaults';
import { buildRootView, type RootView } from '../ui/RootView';
import { StatusChannel } from '../system/StatusChannel';
import { Environment } from '../system/Environment';
import { Logging } from '../system/Logging';

export interface BootOptions {
  root?: string;
  onQuit?: () => void;
}

export interface BootedApp {
  app: App.Instance;
  workspace: Workspace.Instance;
  theme: Theme.Instance;
  renderer: CliRenderer;
  view: RootView;
  render(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<BootedApp> {
  Logging.Class.info('Boot start');

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

  Kernel.instance.seal();
  Kernel.instance.assertSealed();

  const app = new App.Class();
  app.attach(renderer);

  const theme = new Theme.Class();
  const workspace = new Workspace.Class();
  workspace.open(options.root ?? Environment.Class.cwd);

  const commands = new CommandRegistry.Class();

  const view = buildRootView(renderer, workspace, theme, commands);

  // Publish model state to the observability side channel (read-only over model state).
  const publish = (): void => {
    const ed = workspace.editor;
    StatusChannel.Class.update({
      activeWorkspace: workspace.name.value,
      workspaces: [workspace.name.value],
      activeBuffer: ed.hasDocument.value ? ed.document.path : null,
      bufferRevision: ed.document.revision.value,
      dirty: ed.document.dirty.value,
      cursor: ed.hasDocument.value
        ? { line: ed.cursor.line.value, col: ed.cursor.col.value }
        : null,
      openBuffers: ed.hasDocument.value ? [ed.document.path] : [],
      overlay: commands.open.value ? 'palette' : null,
      paletteQuery: commands.open.value ? commands.query.value : '',
      paletteMatches: commands.open.value ? commands.filtered.length : 0,
      focus: workspace.focus.value,
      treeRows: workspace.tree.rows.length,
      treeSelected: workspace.tree.selectedIndex.value,
    });
  };

  // Pull current state into the renderables and request a frame. READ-ONLY over model state
  // (no ref writes), so it is safe to run inside the reactive effect with no feedback loop.
  const paint = (): void => {
    view.update();
    publish();
    renderer.requestRender();
  };

  // The editor viewport size derives from the rendered layout (non-reactive), so it is synced on
  // the external triggers (boot, resize) — NOT inside the frame effect, which would be a
  // projection→model write feeding the effect it observes.
  // invariant: Rendering is one coarse frame effect (app.invariants.md)
  const syncSize = (): void => {
    workspace.editor.viewport.setSize(view.editorViewportWidth(), view.editorViewportHeight());
  };

  // The single coarse reactive frame effect: observe the load-bearing signals and repaint on ANY
  // change — keyboard input OR an async producer (syntax/LSP/git). This is what lets a git refresh
  // or an LSP diagnostic repaint the screen without a keypress.
  // invariant: Rendering is one coarse frame effect (app.invariants.md)
  app.$watchEffect(() => {
    const ed = workspace.editor;
    // Explicit subscriptions to the load-bearing signals (document.revision in particular is only
    // read indirectly by update(), so touch it here to guarantee content changes repaint).
    void ed.document.revision.value;
    void ed.cursor.line.value;
    void ed.cursor.col.value;
    void ed.viewport.scrollTop.value;
    void workspace.focus.value;
    void workspace.tree.selectedIndex.value;
    void commands.open.value;
    void commands.query.value;
    void commands.selectedIndex.value;
    void theme.paletteName.value;
    paint();
  });

  // Frame-settle signal for the tmux harness (a frame actually rendered).
  let frame = 0;
  const onFrame = (): void => {
    frame += 1;
    StatusChannel.Class.settle(frame);
  };
  renderer.on('frame', onFrame);
  app.onDispose(() => renderer.off('frame', onFrame));

  // Awaitable render for boot/resize/harness determinism: sync size, paint, wait one frame.
  const render = async (): Promise<void> => {
    syncSize();
    paint();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        renderer.off('frame', finish);
        resolve();
      };
      renderer.once('frame', finish);
      renderer.requestRender();
      setTimeout(finish, 120);
    });
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    Logging.Class.info('Shutdown start');
    app.$stopEffects(); // stop the frame effect FIRST — no repaint during teardown
    view.dispose();
    app.dispose();
    options.onQuit?.();
  };

  registerDefaultCommands(commands, {
    workspace,
    theme,
    quit: () => void shutdown(),
    requestRender: () => app.requestRender(),
  });

  // --- input: handlers MUTATE model state only; the frame effect repaints. -----------------
  // Accelerated arrows: terminals report key REPEAT (not down/up), so we ramp the step size when
  // the same arrow keeps arriving quickly, and reset on direction change or pause.
  // invariant: Terminals report key repeat not key up (project.invariants.md)
  let accelDir = '';
  let accelRun = 0;
  let accelLast = 0;
  const ACCEL_WINDOW_MS = 90;
  const movementAcceleration = (key: KeyEvent): number => {
    const now = Date.now();
    const dir = key.name;
    if (dir === accelDir && now - accelLast < ACCEL_WINDOW_MS) {
      accelRun += 1;
    } else {
      accelRun = 0;
    }
    accelDir = dir;
    accelLast = now;
    if (accelRun < 4) return 1;
    return Math.min(8, 1 + Math.floor((accelRun - 3) / 2));
  };
  const isTypedCharacter = (key: KeyEvent): boolean => {
    if (key.ctrl || key.meta || key.option) return false;
    const s = key.sequence;
    if (!s || s.length !== 1) return false;
    const code = s.charCodeAt(0);
    return code >= 32 && code !== 127;
  };

  const onKey = (key: KeyEvent): void => {
    if ((key.name === 'q' && key.ctrl) || (key.name === 'c' && key.ctrl)) {
      void shutdown();
      return;
    }

    // Palette captures all input while open.
    if (commands.open.value) {
      switch (key.name) {
        case 'escape':
          commands.closePalette();
          break;
        case 'return':
          commands.runSelected();
          break;
        case 'up':
          commands.moveSelection(-1);
          break;
        case 'down':
          commands.moveSelection(1);
          break;
        case 'backspace':
          commands.backspaceQuery();
          break;
        default:
          if (isTypedCharacter(key)) commands.appendQuery(key.sequence);
      }
      return;
    }

    // Ctrl+P opens the palette from anywhere.
    if (key.name === 'p' && key.ctrl) {
      commands.openPalette();
      return;
    }

    const focus = workspace.focus.value;

    if (key.name === 'tab') {
      workspace.toggleFocus();
    } else if (focus === 'files') {
      switch (key.name) {
        case 'up':
          workspace.tree.moveSelection(-1);
          break;
        case 'down':
          workspace.tree.moveSelection(1);
          break;
        case 'return':
        case 'space':
          workspace.activate();
          break;
        case 'right':
          if (workspace.tree.selected?.isDir && !workspace.tree.selected.expanded)
            workspace.activate();
          else workspace.focusEditor();
          break;
        case 'left':
          if (workspace.tree.selected?.isDir && workspace.tree.selected.expanded)
            workspace.activate();
          break;
        default:
          break;
      }
    } else {
      // editor focus
      const ed = workspace.editor;
      const accel = movementAcceleration(key);
      if (key.name === 's' && key.ctrl) {
        ed.save();
      } else if (key.name === 'z' && key.ctrl && !key.shift) {
        ed.performUndo();
      } else if ((key.name === 'z' && key.ctrl && key.shift) || (key.name === 'y' && key.ctrl)) {
        ed.performRedo();
      } else if (key.name === 'up') {
        ed.moveVertical(-accel);
      } else if (key.name === 'down') {
        ed.moveVertical(accel);
      } else if (key.name === 'left') {
        ed.moveHorizontal(-accel);
      } else if (key.name === 'right') {
        ed.moveHorizontal(accel);
      } else if (key.name === 'pageup') {
        ed.pageUp();
      } else if (key.name === 'pagedown') {
        ed.pageDown();
      } else if (key.name === 'home') {
        ed.moveToLineStart();
      } else if (key.name === 'end') {
        ed.moveToLineEnd();
      } else if (key.name === 'return') {
        ed.insertNewline();
      } else if (key.name === 'backspace') {
        ed.backspace();
      } else if (key.name === 'delete') {
        ed.deleteChar();
      } else if (key.name === 'escape') {
        workspace.focusFiles();
      } else if (isTypedCharacter(key)) {
        ed.insertText(key.sequence);
      }
    }
    // No explicit render here — any model mutation above triggers the frame effect.
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  const onResize = (): void => {
    void render();
  };
  renderer.on('resize', onResize);
  app.onDispose(() => renderer.off('resize', onResize));

  renderer.start();
  app.markStarted();
  await render();

  Logging.Class.info('Boot complete');
  return { app, workspace, theme, renderer, view, render, shutdown };
}
