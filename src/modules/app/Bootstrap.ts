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
import { FrameProbe } from '../system/FrameProbe';
import { Environment } from '../system/Environment';
import { Logging } from '../system/Logging';
import { dirname, join } from 'node:path';

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

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true });

  Kernel.instance.seal();
  Kernel.instance.assertSealed();

  const app = new App.Class();
  app.attach(renderer);

  const theme = new Theme.Class();
  const workspace = new Workspace.Class();
  workspace.open(options.root ?? Environment.Class.cwd);

  const commands = new CommandRegistry.Class();

  const view = buildRootView(renderer, workspace, theme, commands);

  // Last mouse event seen (for the observability side channel — proves the mouse path is live).
  let lastMouse: { type: string; x: number; y: number; button: number } | null = null;

  // Publish model state to the observability side channel (read-only over model state).
  const publish = (): void => {
    const editor = workspace.editor;
    StatusChannel.Class.update({
      mouse: lastMouse,
      activeWorkspace: workspace.name.value,
      workspaces: [workspace.name.value],
      activeBuffer: editor.hasDocument.value ? editor.document.path : null,
      bufferRevision: editor.document.revision.value,
      dirty: editor.document.dirty.value,
      cursor: editor.hasDocument.value
        ? { line: editor.cursor.line.value, col: editor.cursor.col.value }
        : null,
      hasSelection: editor.cursor.hasSelection,
      selection: editor.cursor.selectionRange(),
      openBuffers: editor.hasDocument.value ? [editor.document.path] : [],
      overlay: commands.open.value ? 'palette' : null,
      paletteQuery: commands.open.value ? commands.query.value : '',
      paletteMatches: commands.open.value ? commands.filtered.length : 0,
      focus: workspace.focus.value,
      treeRows: workspace.tree.rows.length,
      treeSelected: workspace.tree.selectedIndex.value,
      editorScrollTop: editor.viewport.scrollTop.value,
      gitLogScrollTop: workspace.gitPanel.logScrollTop.value,
      gitLogIndex: workspace.gitPanel.logIndex.value,
      gitLogLoaded: workspace.commitLog.value?.loadedCount ?? 0,
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
    const editor = workspace.editor;
    // Explicit subscriptions to the load-bearing signals (document.revision in particular is only
    // read indirectly by update(), so touch it here to guarantee content changes repaint).
    void editor.document.revision.value;
    void editor.cursor.line.value;
    void editor.cursor.col.value;
    void editor.cursor.anchor.value;
    void editor.viewport.scrollTop.value;
    void workspace.focus.value;
    void workspace.tree.selectedIndex.value;
    // Git state is produced asynchronously (refresh/log outlive boot); observe it so the sidebar
    // repaints — and the status side-channel flushes — when git data arrives.
    const git = workspace.git.value;
    if (git) {
      void git.branch.value;
      void git.staged.value;
      void git.unstaged.value;
      void git.untracked.value;
      void git.refreshing.value;
    }
    const gitPanel = workspace.gitPanel;
    void gitPanel.view.value;
    void gitPanel.changesIndex.value;
    void gitPanel.logIndex.value;
    void gitPanel.logScrollTop.value;
    void gitPanel.splitRatio.value;
    void commands.open.value;
    void commands.query.value;
    void commands.selectedIndex.value;
    void theme.paletteName.value;
    paint();
  });

  // Frame-settle signal for the tmux harness (a frame actually rendered).
  const framePath = join(dirname(StatusChannel.Class.path), 'frame.json');
  let frame = 0;
  // Smooth-scroll animation clock. dt is clamped so a resume from idle (a "paused clock") advances
  // one frame's worth, not the whole idle gap — the paused-clock invariant.
  let lastFrameMs = 0;
  const MAX_DT = 0.1; // seconds
  const onFrame = (): void => {
    frame += 1;
    // Drive the commit-log glide: step the momentum by real dt; keep requesting frames while it
    // moves so the animation is self-sustaining even on frames that advance 0 whole rows.
    const nowMs = performance.now();
    const dt = lastFrameMs === 0 ? 1 / 30 : Math.min(MAX_DT, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;
    if (workspace.gitPanel.logMomentum.value.velocity !== 0) {
      if (workspace.tickGitLogScroll(dt)) renderer.requestRender();
    }
    StatusChannel.Class.settle(frame);
    // Exact per-cell visual snapshot for tests (env-gated; no-op otherwise).
    FrameProbe.Class.dump(renderer, framePath);
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
  let accelerationDirection = '';
  let accelerationRun = 0;
  let accelerationLast = 0;
  const ACCELERATION_WINDOW_MS = 90;
  const movementAcceleration = (key: KeyEvent): number => {
    const now = Date.now();
    const direction = key.name;
    if (direction === accelerationDirection && now - accelerationLast < ACCELERATION_WINDOW_MS) {
      accelerationRun += 1;
    } else {
      accelerationRun = 0;
    }
    accelerationDirection = direction;
    accelerationLast = now;
    if (accelerationRun < 4) return 1;
    return Math.min(8, 1 + Math.floor((accelerationRun - 3) / 2));
  };
  const isTypedCharacter = (key: KeyEvent): boolean => {
    if (key.ctrl || key.meta || key.option) return false;
    const sequence = key.sequence;
    if (!sequence || sequence.length !== 1) return false;
    const code = sequence.charCodeAt(0);
    return code >= 32 && code !== 127;
  };

  const onKey = (key: KeyEvent): void => {
    if (key.name === 'q' && key.ctrl) {
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

    // Ctrl+G toggles the git sidebar; entering it loads the first log window + refreshes status.
    if (key.name === 'g' && key.ctrl) {
      workspace.toggleGit();
      if (workspace.focus.value === 'git') {
        workspace.gitPanel.region.value = 'log';
        void workspace.git.value?.refresh();
        void workspace.commitLog.value?.ensureRange(0, 50);
      }
      return;
    }

    const focus = workspace.focus.value;

    if (key.name === 'tab') {
      workspace.toggleFocus();
    } else if (focus === 'git') {
      const gitPanel = workspace.gitPanel;
      const moveLog = (delta: number): void => {
        workspace.haltGitLogScroll(); // keyboard is precise — adopt-and-stop any glide (One-Writer)
        const end = workspace.commitLog.value?.knownEnd.value ?? Number.POSITIVE_INFINITY;
        gitPanel.logIndex.value = Math.max(0, Math.min(gitPanel.logIndex.value + delta, Number.isFinite(end) ? end - 1 : gitPanel.logIndex.value + delta));
        const approximateVisible = 12;
        if (gitPanel.logIndex.value < gitPanel.logScrollTop.value) gitPanel.logScrollTop.value = gitPanel.logIndex.value;
        else if (gitPanel.logIndex.value >= gitPanel.logScrollTop.value + approximateVisible)
          gitPanel.logScrollTop.value = gitPanel.logIndex.value - approximateVisible + 1;
        void workspace.commitLog.value?.ensureRange(gitPanel.logScrollTop.value, 50);
      };
      switch (key.name) {
        case 'up': moveLog(-1); break;
        case 'down': moveLog(1); break;
        case 'pageup': moveLog(-10); break;
        case 'pagedown': moveLog(10); break;
        case 'escape': workspace.focusFiles(); break;
        default: break;
      }
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
          // Right on a FILE opens it (same as Enter — user expectation); on a collapsed dir,
          // expands it; on an expanded dir, steps into it. Focus switching stays on Tab.
          if (workspace.tree.selected?.isDir && workspace.tree.selected.expanded)
            workspace.tree.moveSelection(1);
          else workspace.activate();
          break;
        case 'left':
          if (workspace.tree.selected?.isDir && workspace.tree.selected.expanded)
            workspace.activate();
          break;
        default:
          break;
      }
    } else {
      // editor focus. invariant: Selection is an anchor plus the cursor and edits replace it
      // (src/modules/editor/editor.invariants.md)
      const editor = workspace.editor;
      const acceleration = movementAcceleration(key);
      const extend = key.shift; // shift + movement extends the selection
      if (key.ctrl) {
        // Ctrl chords: save / select-all / clipboard / undo-redo.
        switch (key.name) {
          case 's': editor.save(); break;
          case 'a': editor.selectAll(); break;
          case 'c': void editor.copySelection(); break;
          case 'x': void editor.cutSelection(); break;
          case 'v': void editor.pasteClipboard(); break;
          case 'z': key.shift ? editor.performRedo() : editor.performUndo(); break;
          case 'y': editor.performRedo(); break;
          default: break;
        }
      } else {
        // Plain keys: movement (acceleration + shift-extend), editing, focus.
        switch (key.name) {
          case 'up': editor.moveVertical(-acceleration, extend); break;
          case 'down': editor.moveVertical(acceleration, extend); break;
          case 'left': editor.moveHorizontal(-acceleration, extend); break;
          case 'right': editor.moveHorizontal(acceleration, extend); break;
          case 'pageup': editor.pageUp(extend); break;
          case 'pagedown': editor.pageDown(extend); break;
          case 'home': editor.moveToLineStart(extend); break;
          case 'end': editor.moveToLineEnd(extend); break;
          case 'return': editor.insertNewline(); break;
          case 'backspace': editor.backspace(); break;
          case 'delete': editor.deleteChar(); break;
          case 'escape':
            if (editor.hasSelection) editor.cursor.clearSelection();
            else workspace.focusFiles();
            break;
          default:
            if (isTypedCharacter(key)) editor.insertText(key.sequence);
        }
      }
    }
    // No explicit render here — any model mutation above triggers the frame effect.
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  // Global mouse capture: events bubble to the root renderable. Records the last event to the
  // status channel (verification) and repaints. Per-region handlers (tree, sidebar, dividers) are
  // attached on their own renderables and run before this via propagation.
  const onMouse = (event: { type: string; x: number; y: number; button: number }): void => {
    lastMouse = { type: event.type, x: event.x, y: event.y, button: event.button };
    paint();
  };
  renderer.root.onMouse = onMouse;
  app.onDispose(() => {
    if (renderer.root.onMouse === onMouse) renderer.root.onMouse = undefined;
  });

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
