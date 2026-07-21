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
import { CommandDefaults } from '../commands/CommandDefaults';
import { buildRootView, type RootView } from '../ui/RootView';
import { StatusChannel } from '../system/StatusChannel';
import { FrameProbe } from '../system/FrameProbe';
import { ScrollPhysics } from '../ui/ScrollPhysics';
import { Clipboard } from '../system/Clipboard';
import { GitRows } from '../git/GitRows';
import { KeybindingRegistry } from '../keybindings/KeybindingRegistry';
import { canonicalBindings } from '../keybindings/keybindings.defaults';
import { macOverlayBindings } from '../keybindings/keybindings.mac';
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

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
    enableMouseMovement: true, // hover highlighting (over/out/move)
    // Kitty keyboard protocol where available: super-modifier fidelity for the mac overlay
    // (Cmd chords); legacy terminals silently stay at base fidelity.
    useKittyKeyboard: {},
  });

  Kernel.instance.seal();
  Kernel.instance.assertSealed();

  const app = new App.Class();
  app.attach(renderer);

  const theme = new Theme.Class();
  const workspace = new Workspace.Class();
  workspace.open(options.root ?? Environment.Class.cwd);

  const commands = new CommandRegistry.Class();

  const view = buildRootView(renderer, workspace, theme, commands, app);

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
      treeHovered: workspace.tree.hoveredIndex.value,
      editorScrollTop: editor.viewport.scrollTop.value,
      editorScrollLeft: editor.viewport.scrollLeft.value,
      gitLogScrollTop: workspace.gitPanel.logScrollTop.value,
      gitLogIndex: workspace.gitPanel.logIndex.value,
      gitLogLoaded: workspace.commitLog.value?.loadedCount ?? 0,
      gitLogExpanded: workspace.commitExpansion.value?.entries.value.length ?? 0,
      gitRegion: workspace.gitPanel.region.value,
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
    void editor.viewport.scrollLeft.value;
    void workspace.focus.value;
    void workspace.sidebarView.value;
    void workspace.tree.selectedIndex.value;
    void workspace.tree.hoveredIndex.value;
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
    // Inline commit expansion is produced asynchronously (the lazy name-status fetch lands after
    // Enter); observe the entries so the loading row is replaced by file rows without a keypress.
    void workspace.commitExpansion.value?.entries.value;
    const gitPanel = workspace.gitPanel;
    void gitPanel.changesIndex.value;
    void gitPanel.logIndex.value;
    void gitPanel.logScrollTop.value;
    void gitPanel.changesScrollTop.value;
    void gitPanel.changesHovered.value;
    void gitPanel.logHovered.value;
    void gitPanel.confirmDiscard.value;
    void gitPanel.splitRatio.value;
    void commands.open.value;
    void commands.query.value;
    void commands.selectedIndex.value;
    void theme.paletteName.value;
    void app.quitChordArmed.value;
    void app.copyNotice.value;
    paint();
  });

  // Frame-settle signal for the tmux harness (a frame actually rendered).
  const framePath =
    process.env.TUI_FRAME_PATH ||
    join(
      dirname(StatusChannel.Class.path),
      StatusChannel.Class.path.split('/').pop()!.replace('status', 'frame'),
    );
  let frame = 0;
  // Smooth-scroll animation clock. dt is clamped so a resume from idle (a "paused clock") advances
  // one frame's worth, not the whole idle gap — the paused-clock invariant.
  let lastFrameMs = 0;
  const MAX_DT = 0.1; // seconds
  // Animation liveness: while ANY animation runs (momentum glide, drag-edge auto-scroll) we hold
  // ONE live request so the render loop runs; at quiescence we drop it and the loop STOPS (frames
  // and status writes cease — 'idle CPU above ~zero is forbidden').
  let liveAnimationHeld = false;
  const syncAnimationLiveness = (animating: boolean): void => {
    if (animating && !liveAnimationHeld) {
      renderer.requestLive();
      liveAnimationHeld = true;
    } else if (!animating && liveAnimationHeld) {
      renderer.dropLive();
      liveAnimationHeld = false;
      lastFrameMs = 0; // paused-clock: the next animation's first frame gets a fresh dt
    }
  };
  const onFrame = (): void => {
    frame += 1;
    // Drive the commit-log glide: step the momentum by real dt; the live request keeps frames
    // coming while anything moves.
    const nowMs = performance.now();
    const dt = lastFrameMs === 0 ? 1 / 30 : Math.min(MAX_DT, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;
    let animating = false;
    if (workspace.gitPanel.logMomentum.value.velocity !== 0) {
      animating = workspace.tickGitLogScroll(dt) || animating;
    }
    // Drag-edge auto-scroll: while a selection drag holds at a pane edge, keep scrolling +
    // extending the selection.
    animating = view.tickDragAutoScroll(dt) || animating;
    syncAnimationLiveness(animating);
    // Converge the viewport size with the LAID-OUT layout (gutter width changes when a file opens
    // or its line count crosses a digit boundary; boot/resize alone goes stale). Mutating outside
    // the reactive effect: the write triggers one repaint and converges — no feedback loop.
    const editorViewport = workspace.editor.viewport;
    const laidOutWidth = view.editorViewportWidth();
    const laidOutHeight = view.editorViewportHeight();
    if (editorViewport.width.value !== laidOutWidth || editorViewport.height.value !== laidOutHeight) {
      editorViewport.setSize(laidOutWidth, laidOutHeight);
      renderer.requestRender(); // one-shot convergence (not an animation — no live request)
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

  CommandDefaults.Class.registerDefaultCommands(commands, {
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
  // Continuous key-repeat run tracking; the CURVES live in ScrollPhysics (hand-tuned product
  // values — quiet start, strong quadratic build, high cap).
  const movementRun = (key: KeyEvent): number => {
    const now = Date.now();
    const direction = key.name;
    if (direction === accelerationDirection && now - accelerationLast < ScrollPhysics.Class.KEY_RUN_WINDOW_MS) {
      accelerationRun += 1;
    } else {
      accelerationRun = 0;
    }
    accelerationDirection = direction;
    accelerationLast = now;
    return accelerationRun;
  };
  const movementAcceleration = (key: KeyEvent): number =>
    ScrollPhysics.Class.keyAcceleration(movementRun(key));
  const isTypedCharacter = (key: KeyEvent): boolean => {
    if (key.ctrl || key.meta || key.option) return false;
    const sequence = key.sequence;
    if (!sequence || sequence.length !== 1) return false;
    const code = sequence.charCodeAt(0);
    return code >= 32 && code !== 127;
  };

  // ---------------------------------------------------------------------------------------------
  // Keyboard: ONE decode layer (OpenTUI) -> registry resolution (pure data lookup) -> action
  // dispatch. No chord conditionals live here — bindings are data in keybindings.defaults/mac.
  // invariant: Bindings are intent addressed (src/modules/keybindings/keybindings.invariants.md)
  const keybindings = new KeybindingRegistry.Class();
  keybindings.registerGuard('editorHasSelection', () => workspace.editor.cursor.hasSelection);
  keybindings.registerLayer('canonical', canonicalBindings);
  keybindings.registerLayer('mac', macOverlayBindings);

  // Git-panel helpers shared by the git action handlers (region-aware continuous flow).
  const currentChangeRows = () => {
    const git = workspace.git.value;
    return git ? GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
  };
  const normalizeChangesIndex = (): void => {
    const rows = currentChangeRows();
    if (rows[workspace.gitPanel.changesIndex.value]?.kind !== 'file') {
      const firstFile = GitRows.Class.nextFileRow(rows, -1, 1);
      if (firstFile >= 0) workspace.gitPanel.changesIndex.value = firstFile;
    }
  };
  // Up/Down walk the FLAT log rows (commit headers AND expanded file rows are both selectable) —
  // logIndex is a flat-row index over the same row model the renderer draws.
  const moveLog = (delta: number): void => {
    const gitPanel = workspace.gitPanel;
    workspace.haltGitLogScroll(); // keyboard is precise — adopt-and-stop any glide (One-Writer)
    const end = workspace.logFlatEnd();
    gitPanel.logIndex.value = Math.max(
      0,
      Math.min(gitPanel.logIndex.value + delta, Number.isFinite(end) ? end - 1 : gitPanel.logIndex.value + delta),
    );
    const approximateVisible = 12;
    if (gitPanel.logIndex.value < gitPanel.logScrollTop.value) gitPanel.logScrollTop.value = gitPanel.logIndex.value;
    else if (gitPanel.logIndex.value >= gitPanel.logScrollTop.value + approximateVisible)
      gitPanel.logScrollTop.value = gitPanel.logIndex.value - approximateVisible + 1;
    workspace.ensureLogWindow(gitPanel.logScrollTop.value);
  };
  const moveChanges = (direction: 1 | -1): void => {
    const gitPanel = workspace.gitPanel;
    const rows = currentChangeRows();
    const next = GitRows.Class.nextFileRow(rows, gitPanel.changesIndex.value, direction);
    if (next >= 0) gitPanel.changesIndex.value = next;
    else if (direction === 1) gitPanel.region.value = 'log'; // flow into the log
  };

  // The ACTION TABLE: every binding's action id -> its handler. Handlers receive the raw KeyEvent
  // for parameters that compose (shift = extend; repeat runs = acceleration).
  const actionHandlers: Record<string, (key: KeyEvent) => void> = {
    'app.quit': () => void shutdown(),
    'palette.open': () => commands.openPalette(),
    'palette.close': () => commands.closePalette(),
    'palette.run': () => commands.runSelected(),
    'palette.previous': () => commands.moveSelection(-1),
    'palette.next': () => commands.moveSelection(1),
    'palette.erase': () => commands.backspaceQuery(),
    'focus.toggle': () => workspace.toggleFocus(),
    'git.togglePanel': () => {
      workspace.toggleGit();
      if (workspace.focus.value === 'git') {
        workspace.gitPanel.region.value = 'changes';
        void workspace.git.value?.refresh();
        void workspace.commitLog.value?.ensureRange(0, 50);
      }
    },
    'git.up': () => {
      normalizeChangesIndex();
      if (workspace.gitPanel.region.value === 'changes') moveChanges(-1);
      else if (workspace.gitPanel.logIndex.value === 0) {
        workspace.gitPanel.region.value = 'changes'; // flow back up into the changes
        const rows = currentChangeRows();
        const last = GitRows.Class.nextFileRow(rows, rows.length, -1);
        if (last >= 0) workspace.gitPanel.changesIndex.value = last;
      } else moveLog(-1);
    },
    'git.down': () => {
      normalizeChangesIndex();
      if (workspace.gitPanel.region.value === 'changes') moveChanges(1);
      else moveLog(1);
    },
    'git.pageUp': () => {
      if (workspace.gitPanel.region.value === 'log') moveLog(-10);
    },
    'git.pageDown': () => {
      if (workspace.gitPanel.region.value === 'log') moveLog(10);
    },
    'git.stageToggle': () => {
      // Enter in the LOG region activates the flat row: commit header = toggle inline expansion
      // (lazy fetch); file row = open that file's diff for that commit.
      if (workspace.gitPanel.region.value === 'log') {
        workspace.activateLogRow(workspace.gitPanel.logIndex.value);
        return;
      }
      normalizeChangesIndex();
      void workspace.toggleStageAtRow(workspace.gitPanel.changesIndex.value);
    },
    'git.openFile': () => {
      if (workspace.gitPanel.region.value === 'log') {
        workspace.activateLogRow(workspace.gitPanel.logIndex.value);
        return;
      }
      normalizeChangesIndex();
      void workspace.openChangeAtRow(workspace.gitPanel.changesIndex.value);
    },
    'git.expandRight': () => {
      // Right on a collapsed commit expands it; on an expanded one steps into its first file row
      // (tree parity). No-op outside the log region.
      if (workspace.gitPanel.region.value !== 'log') return;
      const row = workspace.logRowAt(workspace.gitPanel.logIndex.value);
      if (row?.kind !== 'commit') return;
      if (row.expanded) moveLog(1);
      else workspace.activateLogRow(workspace.gitPanel.logIndex.value);
    },
    'git.collapseLeft': () => {
      if (workspace.gitPanel.region.value === 'log')
        workspace.collapseLogRow(workspace.gitPanel.logIndex.value);
    },
    'git.discard': () => {
      normalizeChangesIndex();
      workspace.requestDiscardAtRow(workspace.gitPanel.changesIndex.value);
    },
    'git.leave': () => workspace.focusFiles(),
    'tree.up': () => workspace.tree.moveSelection(-1),
    'tree.down': () => workspace.tree.moveSelection(1),
    'tree.activate': () => void workspace.activate(),
    'tree.rightExpandOrOpen': () => {
      // Right on a FILE opens it; on a collapsed dir expands; on an expanded dir steps into it.
      if (workspace.tree.selected?.isDir && workspace.tree.selected.expanded)
        workspace.tree.moveSelection(1);
      else workspace.activate();
    },
    'tree.leftCollapse': () => {
      if (workspace.tree.selected?.isDir && workspace.tree.selected.expanded) workspace.activate();
    },
    'editor.moveUp': (key) => workspace.editor.moveVertical(-movementAcceleration(key), key.shift),
    'editor.moveDown': (key) => workspace.editor.moveVertical(movementAcceleration(key), key.shift),
    'editor.moveLeft': (key) => workspace.editor.moveHorizontal(-movementAcceleration(key), key.shift),
    'editor.moveRight': (key) => workspace.editor.moveHorizontal(movementAcceleration(key), key.shift),
    'editor.pageUp': (key) => workspace.editor.pageUp(key.shift),
    'editor.pageDown': (key) => workspace.editor.pageDown(key.shift),
    'editor.lineStart': (key) => workspace.editor.moveToLineStart(key.shift),
    'editor.lineEnd': (key) => workspace.editor.moveToLineEnd(key.shift),
    'editor.jumpUp': (key) =>
      workspace.editor.moveVertical(-ScrollPhysics.Class.jumpRows(movementRun(key)), key.shift),
    'editor.jumpDown': (key) =>
      workspace.editor.moveVertical(ScrollPhysics.Class.jumpRows(movementRun(key)), key.shift),
    'editor.wordLeft': (key) => workspace.editor.moveWordHorizontal(-1, key.shift),
    'editor.wordRight': (key) => workspace.editor.moveWordHorizontal(1, key.shift),
    'editor.documentStart': (key) => workspace.editor.moveDocumentStart(key.shift),
    'editor.documentEnd': (key) => workspace.editor.moveDocumentEnd(key.shift),
    'editor.newline': () => workspace.editor.insertNewline(),
    'editor.backspace': () => workspace.editor.backspace(),
    'editor.delete': () => workspace.editor.deleteChar(),
    'editor.escape': () => {
      if (workspace.editor.hasSelection) workspace.editor.cursor.clearSelection();
      else workspace.focusFiles();
    },
    'editor.save': () => workspace.editor.save(),
    'editor.selectAll': () => workspace.editor.selectAll(),
    'editor.copy': () => {
      // Publish how many characters landed on the clipboard — the observable proof that copy
      // actually copied (the human-QA "cannot copy" bug's verification channel).
      void workspace.editor.copySelection().then((copiedCharacters) => {
        if (copiedCharacters > 0) {
          app.copyNotice.value = `Copied ${copiedCharacters} chars (${Clipboard.Class.lastBackend ?? 'no backend'})`;
        }
        StatusChannel.Class.update({
          lastCopyChars: copiedCharacters,
          clipboardBackend: Clipboard.Class.lastBackend,
        });
        StatusChannel.Class.flush();
      });
    },
    'editor.cut': () => void workspace.editor.cutSelection(),
    'editor.paste': () => void workspace.editor.pasteClipboard(),
    'editor.undo': () => workspace.editor.performUndo(),
    'editor.redo': () => workspace.editor.performRedo(),
  };

  const onKey = (key: KeyEvent): void => {
    // Destructive-confirm overlay is MODAL: y confirms, anything else cancels — the context's
    // residual, not a binding.
    if (workspace.gitPanel.confirmDiscard.value) {
      if (key.name === 'y') void workspace.confirmDiscard();
      else workspace.cancelDiscard();
      return;
    }

    const context = commands.open.value ? 'palette' : workspace.focus.value;
    const resolution = keybindings.resolve(
      // Alt-family collapse: mac terminals surface Option as `option` OR `meta` (ESC-prefixed
      // forms); both mean the alt slot of a chord pattern.
      { name: key.name, ctrl: key.ctrl, shift: key.shift, option: key.option || key.meta, super: key.super },
      context,
      Date.now(),
    );
    app.quitChordArmed.value = resolution.chordPending; // status-bar hint mirrors the pending chord
    if (resolution.action) {
      actionHandlers[resolution.action]?.(key);
      return;
    }
    if (resolution.chordPending) return;
    // Residual defaults: unbound printable keys TYPE in type-accepting contexts.
    if (context === 'palette' && isTypedCharacter(key)) commands.appendQuery(key.sequence);
    else if (context === 'editor' && isTypedCharacter(key)) workspace.editor.insertText(key.sequence);
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

  // DEMAND-DRIVEN rendering: auto() renders only on requestRender()/live requests — no continuous
  // targetFps loop at rest (the idle-leak fix: at-rest frame delta must be 0). Animations hold a
  // live request below and drop it on quiescence.
  renderer.auto();
  app.markStarted();
  await render();

  Logging.Class.info('Boot complete');
  return { app, workspace, theme, renderer, view, render, shutdown };
}
