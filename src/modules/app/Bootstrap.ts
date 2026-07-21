// Boot sequence: seal the kernel, create the renderer, open the workspace, build the frame,
// wire input, stand up the settle-detecting status channel, and run until quit.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: Data flows one way (project.invariants.md)
import { createCliRenderer, type CliRenderer, type KeyEvent } from '@opentui/core';
import { App } from './App';
import { Kernel } from '../kernel/Kernel';
import { Workspace } from '../workspace/Workspace';
import { Theme } from '../theme/Theme';
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
  const root = options.root ?? Environment.Class.cwd;
  workspace.open(root);

  const view = buildRootView(renderer, workspace, theme);

  // Publish model state to the observability side channel.
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
      overlay: null,
      focus: workspace.focus.value,
      treeRows: workspace.tree.rows.length,
      treeSelected: workspace.tree.selectedIndex.value,
    });
  };

  let frame = 0;
  const render = async (): Promise<void> => {
    // Keep the editor viewport sized to the current frame before rendering.
    workspace.editor.viewport.setSize(view.editorViewportWidth(), view.editorViewportHeight());
    view.update();
    publish();
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

  // --- input ---------------------------------------------------------------
  // Accelerated arrows: terminals report key REPEAT (not down/up), so we ramp the step size
  // when the same arrow keeps arriving quickly, and reset when the direction changes or the
  // stream pauses. invariant: Terminals report key repeat, not key up (project.invariants.md)
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
    // 1,1,1 then ramp: after ~4 rapid repeats start accelerating, cap at 8.
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
    let changed = true;
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
          changed = false;
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
      } else if (key.name === 'tab' /* already handled above, but guard */) {
        // no-op (focus switch handled earlier)
      } else if (key.name === 'escape') {
        workspace.focusFiles();
      } else if (isTypedCharacter(key)) {
        ed.insertText(key.sequence);
      } else {
        changed = false;
      }
    }

    if (changed) void render();
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  const onResize = (): void => void render();
  renderer.on('resize', onResize);
  app.onDispose(() => renderer.off('resize', onResize));

  renderer.start();
  app.markStarted();
  await render();

  Logging.Class.info('Boot complete');
  return { app, workspace, theme, renderer, view, render, shutdown };
}
