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
import { TerminalCapabilities } from '../theme/TerminalCapabilities';
import { CommandRegistry } from '../commands/CommandRegistry';
import { CommandDefaults } from '../commands/CommandDefaults';
import { buildRootView, type RootView } from '../ui/RootView';
import { ContextMenu } from '../ui/ContextMenu';
import { Tooltip } from '../ui/Tooltip';
import { Settings } from '../settings/Settings';
import { SettingsPanel } from '../settings/SettingsPanel';
import { FindBar } from '../search/FindBar';
import { QuickOpen } from '../search/QuickOpen';
import { Files } from '../system/Files';
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
import { HandlerGuard } from './HandlerGuard';
import { TerminalSession } from './TerminalSession';
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

  // Reactive settings store (item G): load user + project settings; changes live-apply + persist.
  const settings = new Settings.Class();
  settings.load({ workspaceRoot: options.root ?? Environment.Class.cwd });
  // Live-apply the scroll physics: the momentum engine reads its ceiling/gain/friction from here, so
  // editing them in the Ctrl+, panel changes scrolling immediately (no restart).
  workspace.attachSettings(settings);

  // App-level overlay view models (the view projects them; input routes through here).
  const contextMenu = new ContextMenu.Class();
  const tooltip = new Tooltip.Class();
  const settingsPanel = new SettingsPanel.Class(settings);
  const findBar = new FindBar.Class();
  const quickOpen = new QuickOpen.Class();

  const view = buildRootView(renderer, workspace, theme, commands, app, contextMenu, tooltip, settingsPanel, findBar, quickOpen);

  // Reveal the find bar's current match in the editor (the ONE writer of the editor selection): select
  // the match range (anchor=start, cursor=end) and scroll it into view. Called after every find action.
  const revealFindMatch = (): void => {
    const match = findBar.engine?.currentMatch;
    if (!match) return;
    const editor = workspace.editor;
    editor.placeCursor(match.line, match.endColumn);
    editor.cursor.anchor.value = { line: match.line, col: match.startColumn }; // after placeCursor -> selection
    editor.revealCursor();
  };

  // Theme + glyph mode are settings-driven (single source): the panel edits settings.theme /
  // settings.glyphMode, and these reactive hooks PUSH the change into the Theme so it live-applies with
  // no restart. GOTCHA reconciled here: the panel's theme option strings ('dark'/'light') are NOT the
  // palette keys ('fable-dark'/'fable-light') — map explicitly, never by string concat.
  const THEME_OPTION_TO_PALETTE_KEY: Record<string, string> = { dark: 'fable-dark', light: 'fable-light' };
  app.$watchEffect(() => {
    const paletteKey = THEME_OPTION_TO_PALETTE_KEY[settings.theme.value] ?? settings.theme.value;
    theme.setPalette(paletteKey);
  });
  app.$watchEffect(() => {
    const mode = settings.glyphMode.value;
    theme.setGlyphLevel(mode === 'auto' ? TerminalCapabilities.Class.detectGlyphLevel() : mode);
  });
  // Word wrap toggling (command OR settings panel) switches viewport.scrollTop between LOGICAL-line and
  // VISUAL-row units. Re-anchoring on the cursor sets a valid scrollTop in the new units — no fragile
  // conversion — so the cursor stays on screen. This MUST be a TARGETED watch on settings.wordWrap, NOT
  // a $watchEffect: revealCursor() READS viewport.scrollTop, so a $watchEffect would re-run on EVERY
  // scroll and re-reveal the cursor — snapping a wheel-scroll back to the cursor's line (the "opening a
  // file, wheel does nothing / can't leave the top" bug: cursor at line 0 pinned the viewport at 0).
  app.$watch(
    () => settings.wordWrap.value,
    () => workspace.editor.revealCursor(),
  );

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
      treeScrollTop: workspace.tree.scrollTop.value,
      treeHovered: workspace.tree.hoveredIndex.value,
      editorScrollTop: editor.viewport.scrollTop.value,
      editorScrollLeft: editor.viewport.scrollLeft.value,
      wordWrap: editor.wordWrap.value,
      changesScrollTop: workspace.gitPanel.changesScrollTop.value,
      gitLogScrollTop: workspace.gitPanel.logScrollTop.value,
      gitLogIndex: workspace.gitPanel.logIndex.value,
      gitLogLoaded: workspace.commitLog.value?.loadedCount ?? 0,
      gitLogExpanded: workspace.commitExpansion.value?.entries.value.length ?? 0,
      gitRegion: workspace.gitPanel.region.value,
      gitSelectedPaths: [...workspace.gitPanel.selectedPaths.value],
      contextMenuOpen: contextMenu.open.value,
      tooltipVisible: tooltip.visible.value,
      settingsOpen: settingsPanel.open.value,
      settingsSelected: settingsPanel.selectedIndex.value,
      sidebarWidth: settings.sidebarWidth.value,
      // Total working-tree changes — proves the GitWatcher live-refreshes on EXTERNAL fs changes.
      gitChangedCount: (() => {
        const repository = workspace.git.value;
        if (!repository) return 0;
        return (
          repository.staged.value.length + repository.unstaged.value.length + repository.untracked.value.length
        );
      })(),
      // Editor buffer tabs (item 10a). liveBufferCount proves the FLYWEIGHT: it must stay far below
      // tabCount (only the active + any dirty background buffer holds a live document).
      bufferTabCount: workspace.buffers.count,
      bufferLiveCount: workspace.buffers.liveCount,
      activeBufferIndex: workspace.buffers.activeIndex.value,
      pendingCloseTab: workspace.pendingCloseTabIndex.value,
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
    // The whole paint pass is exception-isolated: a throw while projecting model→renderables must
    // degrade this one frame (logged to file) and request a repaint, never wedge the demand-driven
    // loop. The signal reads stay first so reactive dependency tracking is unaffected by the guard.
    // invariant: The immediate layer never blocks (project.invariants.md)
    // Explicit subscriptions to the load-bearing signals (document.revision in particular is only
    // read indirectly by update(), so touch it here to guarantee content changes repaint).
    void editor.document.revision.value;
    void editor.cursor.line.value;
    void editor.cursor.col.value;
    void editor.cursor.anchor.value;
    void editor.viewport.scrollTop.value;
    void editor.viewport.scrollLeft.value;
    void editor.wordWrap.value;
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
    void gitPanel.selectedPaths.value;
    // Overlay models: the context menu and tooltip repaint on any of their display state.
    void contextMenu.open.value;
    void contextMenu.items.value;
    void contextMenu.anchorX.value;
    void contextMenu.anchorY.value;
    void contextMenu.hoveredIndex.value;
    void contextMenu.selectedIndex.value;
    void tooltip.visible.value;
    void tooltip.text.value;
    void tooltip.anchorX.value;
    void tooltip.anchorY.value;
    void commands.open.value;
    void commands.query.value;
    void quickOpen.open.value; // repaint the quick-open modal on open/query/selection change
    void quickOpen.query.value;
    void quickOpen.selectedIndex.value;
    void findBar.open.value;
    void commands.selectedIndex.value;
    void theme.paletteName.value;
    void app.quitChordArmed.value;
    void app.copyNotice.value;
    HandlerGuard.Class.run('paint', paint, () => renderer.requestRender());
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
  let lastFrameMilliseconds = 0;
  const MAXIMUM_DELTA_TIME_SECONDS = 0.1; // seconds
  // Animation liveness: while ANY animation runs (any pane's wheel-momentum glide, drag-edge
  // auto-scroll, tooltip dwell) we hold ONE live request so the render loop runs; at quiescence we
  // drop it and the loop STOPS (frames and status writes cease — 'idle CPU above ~zero is forbidden').
  let liveAnimationHeld = false;
  const syncAnimationLiveness = (animating: boolean): void => {
    if (animating && !liveAnimationHeld) {
      renderer.requestLive();
      liveAnimationHeld = true;
    } else if (!animating && liveAnimationHeld) {
      renderer.dropLive();
      liveAnimationHeld = false;
      lastFrameMilliseconds = 0; // paused-clock: the next animation's first frame gets a fresh dt
    }
  };
  const frameTick = (): void => {
    frame += 1;
    // Drive every pane glide: step all momentum by real dt; the live request keeps frames coming
    // while anything moves (including frames that advance 0 whole rows).
    const nowMilliseconds = performance.now();
    const deltaTimeSeconds = lastFrameMilliseconds === 0
      ? 1 / 30
      : Math.min(MAXIMUM_DELTA_TIME_SECONDS, (nowMilliseconds - lastFrameMilliseconds) / 1000);
    lastFrameMilliseconds = nowMilliseconds;
    let animating = false;
    // All pane wheel-momentum regimes (git log, editor V/H, tree, git changes) step here and each
    // settles to EXACTLY zero, so `animating` returns to false at rest — quiescence preserved.
    animating = workspace.tickScrollAnimations(deltaTimeSeconds) || animating;
    // Drag-edge auto-scroll: while a selection drag holds at a pane edge, keep scrolling +
    // extending the selection.
    animating = view.tickDragAutoScroll(deltaTimeSeconds) || animating;
    animating = view.tickDiffMomentum(deltaTimeSeconds) || animating; // the open diff's fling glide
    // Tooltip dwell: the frame tick advances the timer; it's just another animation source, so it
    // folds into the SAME single-live-request model (holds a frame while counting, false at rest).
    animating = tooltip.tick(deltaTimeSeconds) || animating;
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
  // A throw in a frame tick (animation step, layout convergence) must not stop the pump: isolate it
  // and keep the loop alive. invariant: The immediate layer never blocks (project.invariants.md)
  const onFrame = (): void => {
    HandlerGuard.Class.run('frame', frameTick, () => renderer.requestRender());
  };
  renderer.on('frame', onFrame);
  app.onDispose(() => renderer.off('frame', onFrame));
  app.onDispose(() => workspace.dispose()); // stop the working-tree watcher + dispose open buffers

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
    workspace.haltGitChangesScroll(); // keyboard is precise — adopt-and-stop wheel glide
    const rows = currentChangeRows();
    const next = GitRows.Class.nextFileRow(rows, gitPanel.changesIndex.value, direction);
    if (next >= 0) gitPanel.changesIndex.value = next;
    else if (direction === 1) gitPanel.region.value = 'log'; // flow into the log
  };

  // The ACTION TABLE: every binding's action id -> its handler. Handlers receive the raw KeyEvent
  // for parameters that compose (shift = extend; repeat runs = acceleration).
  const actionHandlers: Record<string, (key: KeyEvent) => void> = {
    'app.quit': () => void shutdown(),
    'find.open': () => {
      if (!workspace.editor.hasDocument.value) return;
      findBar.openFor(workspace.editor.document, 'find');
      revealFindMatch();
    },
    'find.replace': () => {
      if (!workspace.editor.hasDocument.value) return;
      findBar.openFor(workspace.editor.document, 'replace');
      revealFindMatch();
    },
    'quickopen.open': () => void quickOpen.show(workspace.root), // Ctrl+P: fuzzy go-to-file over rg --files
    'palette.open': () => commands.openPalette(),
    'palette.close': () => commands.closePalette(),
    'palette.run': () => commands.runSelected(),
    'palette.previous': () => commands.moveSelection(-1),
    'palette.next': () => commands.moveSelection(1),
    'palette.erase': () => commands.backspaceQuery(),
    'focus.toggle': () => workspace.toggleFocus(),
    'settings.toggle': () => settingsPanel.toggle(),
    'settings.close': () => settingsPanel.close(),
    'settings.up': () => settingsPanel.moveSelection(-1),
    'settings.down': () => settingsPanel.moveSelection(1),
    'settings.increase': () => settingsPanel.adjust(1),
    'settings.decrease': () => settingsPanel.adjust(-1),
    'buffer.close': () => workspace.closeActiveTab(),
    'buffer.next': () => workspace.cycleTab(1),
    'buffer.previous': () => workspace.cycleTab(-1),
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
        workspace.haltGitChangesScroll();
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
    'tree.up': () => {
      workspace.haltTreeScroll();
      workspace.tree.moveSelection(-1);
    },
    'tree.down': () => {
      workspace.haltTreeScroll();
      workspace.tree.moveSelection(1);
    },
    'tree.activate': () => void workspace.activate(),
    'tree.rightExpandOrOpen': () => {
      // Right on a FILE opens it; on a collapsed dir expands; on an expanded dir steps into it.
      workspace.haltTreeScroll();
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
    'editor.toggleWordWrap': () => workspace.editor.toggleWordWrap(),
    'menu.previous': () => contextMenu.moveSelection(-1),
    'menu.next': () => contextMenu.moveSelection(1),
    'menu.run': () => contextMenu.runSelected(),
    'menu.close': () => contextMenu.close(),
  };

  const keyTick = (key: KeyEvent): void => {
    tooltip.clear(); // any keypress hides the tooltip (display-only affordance)
    // RESERVED GLOBAL CHORDS (quit) are escape hatches that must fire from ANY mode — checked BEFORE
    // every modal/search branch below, or a focused find/quick-open/settings input would swallow the
    // quit key and TRAP the user with no way out (a hard no-dead-ends / learnability failure). The
    // check is stateless (single-chord match only), so it never disturbs the chord resolver below.
    // invariant: Reserved global chords fire from any mode (keybindings.invariants.md)
    const reservedGlobalAction = keybindings.resolveReservedGlobal({
      name: key.name,
      ctrl: key.ctrl,
      shift: key.shift,
      option: key.option || key.meta,
      super: key.super,
    });
    if (reservedGlobalAction) {
      actionHandlers[reservedGlobalAction]?.(key);
      return;
    }
    // Destructive-confirm overlay is MODAL: y confirms, anything else cancels — the context's
    // residual, not a binding.
    if (workspace.gitPanel.confirmDiscard.value) {
      if (key.name === 'y') void workspace.confirmDiscard();
      else workspace.cancelDiscard();
      return;
    }
    // Same MODAL contract for closing a tab with unsaved edits.
    if (workspace.pendingCloseTabIndex.value >= 0) {
      if (key.name === 'y') workspace.confirmCloseTab();
      else workspace.cancelCloseTab();
      return;
    }

    // Context menu is MODAL: keys resolve ONLY in the 'menu' context (bindings are registry
    // data); anything that is not a menu action closes the menu and is CONSUMED — no keystroke
    // both dismisses the menu and acts on what is beneath it.
    // invariant: A context menu is modal and single-consumer (src/modules/ui/ui.invariants.md)
    if (contextMenu.open.value) {
      const menuResolution = keybindings.resolve(
        { name: key.name, ctrl: key.ctrl, shift: key.shift, option: key.option || key.meta, super: key.super },
        'menu',
        Date.now(),
      );
      if (menuResolution.action?.startsWith('menu.')) actionHandlers[menuResolution.action]?.(key);
      else contextMenu.close();
      return;
    }

    const context = settingsPanel.open.value
      ? 'settings'
      : commands.open.value
        ? 'palette'
        : quickOpen.open.value
          ? 'quickopen'
          : findBar.open.value
            ? 'find'
            : workspace.focus.value;

    // Quick-open (Ctrl+P) modal: type filters the fuzzy file list live, ↑/↓ move, Enter opens the
    // selected file as a tab (add-or-focus), Esc closes. Inline like the palette's query editing.
    if (context === 'quickopen') {
      if (key.name === 'escape') {
        quickOpen.close();
        return;
      }
      if (key.name === 'up') {
        quickOpen.moveSelection(-1);
        return;
      }
      if (key.name === 'down') {
        quickOpen.moveSelection(1);
        return;
      }
      if (key.name === 'return') {
        const path = quickOpen.activate(); // a project-ROOT-relative path (rg/git ls-files)
        quickOpen.close();
        // Resolve against the workspace root — openFileInTab (like the tree) reads an ABSOLUTE path.
        if (path) workspace.openFileInTab(Files.Class.join(workspace.root, path));
        return;
      }
      if (key.name === 'backspace') {
        quickOpen.setQuery(quickOpen.query.value.slice(0, -1));
        return;
      }
      if (isTypedCharacter(key)) {
        quickOpen.setQuery(quickOpen.query.value + key.sequence);
        return;
      }
      return;
    }

    // Find/replace bar has keyboard: type edits the focused field (live find), Enter/Shift+Enter cycle
    // matches, Ctrl+Enter replaces, Tab switches field, Esc closes. Handled inline (not via the registry)
    // because it composes typed input with the match-reveal, like the palette's query editing.
    if (context === 'find') {
      if (key.name === 'escape') {
        findBar.close();
        return;
      }
      if (key.name === 'return') {
        if (key.ctrl && key.shift) findBar.replaceAll();
        else if (key.ctrl) findBar.replaceCurrent();
        else if (key.shift) findBar.previous();
        else findBar.next();
        revealFindMatch();
        return;
      }
      if (key.name === 'tab') {
        findBar.switchField();
        return;
      }
      if (key.name === 'backspace') {
        findBar.backspace();
        revealFindMatch();
        return;
      }
      if (isTypedCharacter(key)) {
        findBar.append(key.sequence);
        revealFindMatch();
        return;
      }
      return; // swallow other keys while the bar is open
    }

    // iTerm2 "Natural Text Editing" remaps Cmd+Left → a RAW ^A byte (0x01), which collides with
    // Ctrl+A = Select All. Under the Kitty protocol a PHYSICALLY pressed Ctrl+A arrives as the kitty
    // form (`key.sequence === 'a'`, an escape-encoded event), so a raw 0x01 control byte here is the
    // Cmd remap → line start. We divert it BEFORE resolving (the registry can't tell them apart:
    // both are {name:'a', ctrl:true}), and ONLY when Kitty is active — on a legacy terminal a raw ^A
    // really is Ctrl+A and must stay Select All. (Cmd+Right = raw ^E is handled by the Ctrl+E binding,
    // which is harmless because Ctrl+E was unbound.) Driven-verified against the real byte streams.
    if (context === 'editor' && renderer.useKittyKeyboard && key.ctrl && key.name === 'a' && key.sequence === '\u0001') {
      workspace.editor.moveToLineStart(key.shift);
      return;
    }

    // A diff is open OVER the tabs: editor-context keys drive the DiffView (synced aligned-row panes),
    // not the hidden buffer. n/p jump changes, Enter promotes to a real editable tab, Esc closes.
    if (context === 'editor' && workspace.showingDiff.value) {
      const diff = view.activeDiffView();
      if (diff) {
        switch (key.name) {
          case 'up': diff.moveByKeyboardAlignedRows(-1); return;
          case 'down': diff.moveByKeyboardAlignedRows(1); return;
          case 'pageup': diff.pageByKeyboard(-1); return;
          case 'pagedown': diff.pageByKeyboard(1); return;
          case 'left': diff.moveByKeyboardColumns(-1); return;
          case 'right': diff.moveByKeyboardColumns(1); return;
          case 'n': diff.jumpToNextChange(); return;
          case 'p': diff.jumpToPreviousChange(); return;
          case 'return': diff.openFull(); return;
          case 'escape': workspace.showingDiff.value = false; workspace.diffRequest.value = null; return;
          default: break;
        }
      }
    }

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
  // A throw while handling a keystroke must not wedge the loop: isolate + repaint so the app stays
  // responsive. invariant: The immediate layer never blocks (project.invariants.md)
  const onKey = (key: KeyEvent): void => {
    HandlerGuard.Class.run('keypress', () => keyTick(key), () => app.requestRender());
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  // Global mouse capture: events bubble to the root renderable. Records the last event to the
  // status channel (verification) and repaints. Per-region handlers (tree, sidebar, dividers) are
  // attached on their own renderables and run before this via propagation.
  const onMouse = (event: { type: string; x: number; y: number; button: number }): void => {
    HandlerGuard.Class.run('mouse', () => {
      lastMouse = { type: event.type, x: event.x, y: event.y, button: event.button };
      if (event.type === 'down') tooltip.clear(); // any click hides the tooltip, wherever it lands
      paint();
    }, () => renderer.requestRender());
  };
  renderer.root.onMouse = onMouse;
  app.onDispose(() => {
    if (renderer.root.onMouse === onMouse) renderer.root.onMouse = undefined;
  });

  // --- terminal session-state recovery ----------------------------------------------------------
  // A VS Code terminal tab (and others) reset the terminal session state on tab-hide and neither
  // restore it nor redraw on return — leaving termios raw mode reverted (Ctrl+Q eaten by XON flow
  // control), mouse SGR + focus reporting dropped (dead wheel/click), and a stale frame (looks
  // frozen). On focus-in we re-enter the FULL terminal setup + force a repaint, restoring all three.
  // invariant: The immediate layer never blocks (project.invariants.md)
  const writeSequence = (sequence: string): void => {
    try {
      process.stdout.write(sequence);
    } catch {
      /* stdout gone (shutdown) — nothing to assert against */
    }
  };
  // Enable focus reporting at startup so the terminal emits \e[I / \e[O and the app RECEIVES the
  // focus-in that triggers recovery (OpenTUI's native setup also enables it; this is idempotent
  // insurance so a focus-in always arrives). Reset it on exit so the shell is left clean.
  TerminalSession.Class.enableFocusReporting(writeSequence);
  app.onDispose(() => TerminalSession.Class.disableFocusReporting(writeSequence));

  const onFocus = (): void => {
    HandlerGuard.Class.run('focus', () => {
      TerminalSession.Class.reenterTerminalModes(renderer); // termios raw + mouse + focus + alt-screen
      syncSize();
      paint(); // push current model→renderables; resume() already armed the full repaint
    }, () => renderer.requestRender());
  };
  renderer.on('focus', onFocus);
  app.onDispose(() => renderer.off('focus', onFocus));

  const onResize = (): void => {
    HandlerGuard.Class.run('resize', () => {
      // Re-assert focus reporting (some terminals drop it on the geometry change that accompanies a
      // tab-return) then re-lay-out + full-repaint. render() → processResize forces a full repaint on
      // a genuine size change; a same-size return is handled by onFocus above.
      TerminalSession.Class.enableFocusReporting(writeSequence);
      void render();
    }, () => renderer.requestRender());
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
