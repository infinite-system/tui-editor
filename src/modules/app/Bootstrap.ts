// Boot sequence: seal the kernel, create the renderer, open the workspace, build the frame,
// wire ONE reactive frame effect, wire input, and run until quit.
//
// invariant: The app is built only after the kernel is sealed (project.invariants.md)
// invariant: Data flows one way (project.invariants.md)
// invariant: Rendering is one coarse frame effect (app.invariants.md)
import { createCliRenderer, type CliRenderer, type KeyEvent } from '@opentui/core';
import { Static } from 'ivue/extras';
import { App } from './App';
import { Kernel } from '../kernel/Kernel';
import { Workspace } from '../workspace/Workspace';
import { WorkspaceSet } from '../workspace/WorkspaceSet';
import { Theme } from '../theme/Theme';
import { TerminalCapabilities } from '../theme/TerminalCapabilities';
import { CommandRegistry } from '../commands/CommandRegistry';
import { CommandDefaults } from '../commands/CommandDefaults';
import { RootView } from '../ui/RootView';
import { TabStrip } from '../ui/TabStrip';
import { ContextMenu } from '../ui/ContextMenu';
import { OverlayCoordinator } from '../ui/OverlayCoordinator';
import { ShortcutHelp } from '../ui/ShortcutHelp';
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
import { PanelHost } from '../ui/PanelHost';
import { TerminalFactory } from '../terminal/TerminalFactory';
import { AgentFactory } from '../agent/AgentFactory';
import { AgentPaneContent } from '../agent/AgentPaneContent';
import { TtsFactory } from '../narration/TtsFactory';
import type { TtsBackend } from '../narration/TtsBackend';
import { NarrationProjection } from '../narration/NarrationProjection';
import { dirname, join } from 'node:path';

export interface BootOptions {
  root?: string;
  onQuit?: () => void;
}

export interface BootedApp {
  app: App.Instance;
  workspace: Workspace.Instance;
  workspaceSet: WorkspaceSet.Instance;
  theme: Theme.Instance;
  renderer: CliRenderer;
  view: RootView;
  render(): Promise<void>;
  shutdown(): Promise<void>;
}

async function $boot(options: BootOptions = {}): Promise<BootedApp> {
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
  const commands = new CommandRegistry.Class();

  // Reactive settings store (item G): load user + project settings; changes live-apply + persist.
  const settings = new Settings.Class();
  settings.load({ workspaceRoot: options.root ?? Environment.Class.cwd });
  const workspaceSet = new WorkspaceSet.Class(settings);
  workspaceSet.open(options.root ?? Environment.Class.cwd);
  const keybindings = new KeybindingRegistry.Class();
  keybindings.registerGuard('editorHasSelection', () => workspaceSet.active.editor.cursor.hasSelection);
  keybindings.registerLayer('canonical', canonicalBindings);
  keybindings.registerLayer('mac', macOverlayBindings);
  const bufferTabStrip = new TabStrip.Class('horizontal', () =>
    workspaceSet.active.buffers.tabs().map((bufferTab) => ({
      identifier: bufferTab.path,
      label: Files.Class.basename(bufferTab.path),
      active: bufferTab.active,
      dirty: bufferTab.dirty,
      closable: true,
    })),
  );
  const workspaceTabStrip = new TabStrip.Class(
    settings.workspaceTabPosition.value === 'left' ? 'vertical' : 'horizontal',
    () =>
      workspaceSet.tabs().map((workspaceTab) => ({
        identifier: workspaceTab.root,
        label: workspaceTab.name,
        detailLabel: workspaceTab.detail,
        active: workspaceTab.active,
        closable: workspaceSet.count > 1,
      })),
  );

  // App-level overlay view models (the view projects them; input routes through here).
  const contextMenu = new ContextMenu.Class();
  const tooltip = new Tooltip.Class();
  const settingsPanel = new SettingsPanel.Class(settings);
  const findBar = new FindBar.Class();
  const quickOpen = new QuickOpen.Class();
  const shortcutHelp = new ShortcutHelp.Class(keybindings, commands);
  // The bottom panel slot: a generic, content-agnostic host. Tier S registers ONE PaneContent (the
  // terminal), lazily on first toggle so no shell spawns until the panel is opened.
  const panelHost = new PanelHost.Class();

  const overlayCoordinator = new OverlayCoordinator.Class({
    findBar: () => findBar.close(),
    quickOpen: () => quickOpen.close(),
    commandPalette: () => commands.closePalette(),
    settingsPanel: () => settingsPanel.close(),
    contextMenu: () => contextMenu.close(),
    shortcutHelp: () => shortcutHelp.close(),
  });

  // The ONE terminal-toggle action, shared by the panel.toggleTerminal chords (Ctrl+J/Ctrl+`/F8) AND
  // the status-bar terminal button, so both are the same action with no divergent paths. It forward-
  // references `ensureTerminal` (declared below): the body only runs on a chord/click, long after
  // init completes, so the binding is resolved by then.
  const toggleTerminal = (): void => {
    ensureTerminal();
    // Symmetric with toggleAgent: activate + show THIS pane when hidden or showing the other pane; hide
    // only when the terminal is already the visible one. Without the activate(), the button just toggled
    // slot visibility and left whatever pane was active showing — so opening "terminal" while the agent
    // was active re-showed the AGENT (the two conflated into one slot). activate() differentiates them.
    if (panelHost.visible.value && panelHost.activeId.value === 'terminal') {
      panelHost.hide();
      return;
    }
    panelHost.activate('terminal');
    panelHost.show();
  };

  // The native agent (Claude) pane toggle — same bottom slot as the terminal. Show + activate when the
  // slot is hidden or showing another pane; hide when the agent is already the visible pane (VS Code
  // panel parity). Forward-references `ensureAgent` (declared below with ensureTerminal).
  const toggleAgent = (): void => {
    ensureAgent();
    if (panelHost.visible.value && panelHost.activeId.value === 'agent') {
      panelHost.hide();
      return;
    }
    panelHost.activate('agent');
    panelHost.show();
  };

  // Reveal through the bound pane target: source, Markdown preview, and each diff side keep their own
  // scroll/selection writer while FindBar retains independent engines for all of them.
  const revealFindMatch = (): void => {
    const match = findBar.engine?.currentMatch;
    if (!match || !findBar.target) return;
    findBar.target.revealMatch(match);
  };

  // Quick-open activation — the SINGLE path shared by the Enter key and a mouse click on a result row,
  // so the two can never diverge. Files mode opens the selected file; the path-navigator opens the
  // CURRENT input path as a workspace (folder rows are drilled into by a click, not opened here).
  const activateQuickOpenSelection = (): void => {
    const path = quickOpen.activate(); // files: a project-ROOT-relative path; workspacePath: an absolute path
    if (quickOpen.mode.value === 'workspacePath') {
      if (!path || !Files.Class.isDir(path)) {
        quickOpen.setError('Enter an existing folder path');
        return;
      }
      quickOpen.close();
      workspaceSet.open(path);
    } else {
      quickOpen.close();
      // Resolve against the workspace root — openFileInTab (like the tree) reads an ABSOLUTE path.
      if (path) workspaceSet.active.openFileInTab(Files.Class.join(workspaceSet.active.root, path));
    }
  };

  const view = RootView.Class.buildRootView(
    renderer,
    workspaceSet,
    bufferTabStrip,
    workspaceTabStrip,
    theme,
    keybindings,
    commands,
    app,
    contextMenu,
    tooltip,
    settingsPanel,
    findBar,
    quickOpen,
    shortcutHelp,
    overlayCoordinator,
    panelHost,
    toggleTerminal,
    toggleAgent,
    activateQuickOpenSelection,
    revealFindMatch,
  );

  // Lazily create + register the terminal PaneContent on first toggle (idle cost is zero until then).
  // The initial cols×rows seed from the laid-out panel region; the frame loop converges the true size.
  let terminalRegistered = false;
  const ensureTerminal = (): void => {
    if (terminalRegistered) return;
    terminalRegistered = true;
    const content = TerminalFactory.Class.create({
      columns: view.panelViewportColumns() || 80,
      rows: view.panelViewportRows() || 24,
      cwd: workspaceSet.active.root,
    });
    panelHost.register(content);
  };

  // The native agent (Claude) pane — a second PaneContent in the SAME bottom slot, registered lazily on
  // first toggle (idle cost zero). Tier S wires the local EchoAgentBackend; CliStreamBackend swaps in
  // later behind the one backend seam with no change here.
  let agentRegistered = false;
  // The audio narration projection over the agent transcript (the third projection: text→pane,
  // visual→decorations, audio→speech). Created alongside the agent pane so it subscribes to the SAME
  // AgentSession; null until the agent pane is ensured. Barge-in + dispose route through it.
  let narration: NarrationProjection.Instance | null = null;
  // The agent pane instance once ensured — the frame dump reads its view state (scroll/collapse) so the
  // driving smoke asserts the UX without pane-scraping. Null until the pane is first toggled.
  let agentPaneContent: AgentPaneContent.Model | null = null;
  // A one-shot TTS backend for the "Narration: Test Voice" audition — recreated per test in the current
  // selected voice; the previous one is disposed so repeated tests never pile up. Under
  // INVAR_TTS_BACKEND=mock (the gate) this is silent.
  let testVoiceBackend: TtsBackend | null = null;
  const testNarrationVoice = (): void => {
    testVoiceBackend?.dispose();
    testVoiceBackend = TtsFactory.Class.createBackend({ voice: settings.agentNarrationVoice.value, rate: settings.agentNarrationRate.value });
    testVoiceBackend.speak('Narration voice test — the quick brown fox jumps over the lazy dog.');
  };
  const ensureAgent = (): void => {
    if (agentRegistered) return;
    agentRegistered = true;
    // Real Claude (when `claude` is on PATH) runs in the workspace root so it operates in the project.
    const agentPane = AgentFactory.Class.create({
      cwd: workspaceSet.active.root,
      provider: settings.agentProvider.value,
      skipPermissions: settings.agentSkipPermissions.value,
      model: settings.agentModel.value,
    });
    panelHost.register(agentPane);
    if (agentPane instanceof AgentPaneContent.Class) {
      agentPaneContent = agentPane;
      narration = new NarrationProjection.Class(
        agentPane.agentSession,
        settings.agentAudioNarration,
        // LIVE voice + rate: read per utterance so changing them in settings applies to ongoing narration
        // without recreating the backend or restarting.
        TtsFactory.Class.createBackend({
          voiceProvider: () => settings.agentNarrationVoice.value,
          rateProvider: () => settings.agentNarrationRate.value,
        }),
      );
    }
  };
  app.onDispose(() => {
    narration?.dispose();
    testVoiceBackend?.dispose();
    panelHost.dispose();
  });

  // Toggle the bottom panel between one cell and two side-by-side cells — the AGENT pane on the LEFT,
  // the terminal on the RIGHT — and back. Both are ensured (lazily registered) first, then the panel
  // splits by id; F9 toggles split↔single. Proves the split slot end to end with the two real citizens:
  // independent sub-region render, per-cell click-to-focus, divider re-flow.
  const togglePanelSplit = (): void => {
    ensureTerminal();
    ensureAgent();
    if (!panelHost.visible.value) panelHost.show();
    if (panelHost.isSplit) {
      panelHost.unsplit();
      return;
    }
    panelHost.split(['agent', 'terminal']); // agent LEFT, terminal RIGHT
  };

  // Theme + glyph mode are settings-driven (single source): the panel edits settings.theme /
  // settings.glyphMode, and these reactive hooks PUSH the change into the Theme so it live-applies with
  // no restart. GOTCHA reconciled here: the panel's theme option strings ('dark'/'light') are NOT the
  // palette keys ('invar-dark'/'invar-light') — map explicitly, never by string concat.
  const THEME_OPTION_TO_PALETTE_KEY: Record<string, string> = { dark: 'invar-dark', light: 'invar-light' };
  app.$watchEffect(() => {
    const paletteKey = THEME_OPTION_TO_PALETTE_KEY[settings.theme.value] ?? settings.theme.value;
    theme.setPalette(paletteKey);
  });
  app.$watchEffect(() => {
    const mode = settings.glyphMode.value;
    theme.setGlyphLevel(mode === 'auto' ? TerminalCapabilities.Class.detectGlyphLevel() : mode);
  });
  app.$watch(
    () => settings.workspaceTabPosition.value,
    (position) => workspaceTabStrip.setOrientation(position === 'left' ? 'vertical' : 'horizontal'),
  );
  // Word wrap toggling (command OR settings panel) switches viewport.scrollTop between LOGICAL-line and
  // VISUAL-row units. Re-anchoring on the cursor sets a valid scrollTop in the new units — no fragile
  // conversion — so the cursor stays on screen. This MUST be a TARGETED watch on settings.wordWrap, NOT
  // a $watchEffect: revealCursor() READS viewport.scrollTop, so a $watchEffect would re-run on EVERY
  // scroll and re-reveal the cursor — snapping a wheel-scroll back to the cursor's line (the "opening a
  // file, wheel does nothing / can't leave the top" bug: cursor at line 0 pinned the viewport at 0).
  app.$watch(
    () => settings.wordWrap.value,
    () => workspaceSet.active.editor.revealCursor(),
  );
  // GitWatcher already reconciles into GitRepository.lastRefreshAt. Reuse that reactive completion
  // signal to refresh the active HEAD blob; no second filesystem watcher or diff-fetch path exists.
  app.$watch(
    () => workspaceSet.active.git.value?.lastRefreshAt.value ?? null,
    () => void workspaceSet.active.refreshActiveHeadText(),
  );
  // Language-server document sync: every edit bumps document.revision; this targeted watch pushes
  // the new text as a revision-idempotent full-text didChange (LanguageClient skips versions it
  // already sent). A TARGETED watch, not a $watchEffect — the handler must depend on the revision
  // signal only, never on the other state syncActiveDocumentWithLanguageServer reads.
  app.$watch(
    () => {
      const editor = workspaceSet.active.editor;
      return editor.hasDocument.value ? editor.document.revision.value : -1;
    },
    () => workspaceSet.active.syncActiveDocumentWithLanguageServer(),
  );

  // Last mouse event seen (for the observability side channel — proves the mouse path is live).
  let lastMouse: { type: string; x: number; y: number; button: number } | null = null;

  // Publish model state to the observability side channel (read-only over model state).
  const publish = (): void => {
    const editor = workspaceSet.active.editor;
    const diffView = view.activeDiffView();
    const markdownSplitView = view.activeMarkdownSplitView();
    const openInputOverlays = [
      ...(findBar.open.value ? ['findBar'] : []),
      ...(quickOpen.open.value ? ['quickOpen'] : []),
      ...(commands.open.value ? ['commandPalette'] : []),
      ...(settingsPanel.open.value ? ['settingsPanel'] : []),
      ...(contextMenu.open.value ? ['contextMenu'] : []),
      ...(shortcutHelp.open.value ? ['shortcutHelp'] : []),
    ];
    StatusChannel.Class.update({
      mouse: lastMouse,
      activeWorkspace: workspaceSet.active.name.value,
      workspaces: workspaceSet.tabs().map((workspaceTab) => workspaceTab.name),
      activeWorkspaceIndex: workspaceSet.activeWorkspaceIndex.value,
      activeWorkspaceRoot: workspaceSet.active.root,
      workspaceCount: workspaceSet.count,
      liveGitWatcherCount: workspaceSet.liveGitWatcherCount,
      workspaceLiveGitWatchers: workspaceSet.entries.value.map(
        (workspaceEntry) => workspaceEntry.hasLiveGitWatcher,
      ),
      workspaceTabPosition: settings.workspaceTabPosition.value,
      activeBuffer: editor.hasDocument.value ? editor.document.path : null,
      // The active file's LSP size-suppression state — the authoritative channel a driven gate reads
      // to assert a large file was NOT attached to the language server (the guard is never silent).
      lspSizeSuppressed: workspaceSet.active.languageSizeNotice() !== null,
      bufferRevision: editor.document.revision.value,
      dirty: editor.document.dirty.value,
      cursor: editor.hasDocument.value
        ? { line: editor.cursor.line.value, col: editor.cursor.col.value }
        : null,
      hasSelection: editor.cursor.hasSelection,
      selection: editor.cursor.selectionRange(),
      openBuffers: editor.hasDocument.value ? [editor.document.path] : [],
      overlay: commands.open.value ? 'palette' : null,
      inputOverlay: openInputOverlays[0] ?? null,
      inputOverlayCount: openInputOverlays.length,
      openInputOverlays,
      findOpen: findBar.open.value,
      findMode: findBar.mode.value,
      findTarget: findBar.target?.identifier ?? null,
      findQuery: findBar.engine?.query.value ?? '',
      findMatchCount: findBar.engine?.matchCount ?? 0,
      findCurrentMatchIndex: findBar.engine?.currentMatchIndex.value ?? -1,
      findCaseSensitive: findBar.caseSensitive,
      sourceFindQuery: editor.hasDocument.value
        ? findBar.engineFor(`source:${editor.document.path}`)?.query.value ?? ''
        : '',
      markdownPreviewFindQuery: markdownSplitView
        ? findBar.engineFor(markdownSplitView.previewFindTargetIdentifier())?.query.value ?? ''
        : '',
      quickOpenOpen: quickOpen.open.value,
      quickOpenSelected: quickOpen.selectedIndex.value,
      quickOpenHovered: quickOpen.hoveredIndex.value,
      quickOpenQuery: quickOpen.query.value,
      quickOpenMatches: quickOpen.matches.value.length,
      quickOpenMode: quickOpen.mode.value,
      quickOpenPathOpenable: quickOpen.workspacePathOpenable.value,
      paletteOpen: commands.open.value,
      paletteQuery: commands.open.value ? commands.query.value : '',
      paletteMatches: commands.open.value ? commands.filtered.length : 0,
      // Settings panel + voice picker (drives smoke-voice-picker): the selected row's label + displayed
      // value, and the live agentNarrationVoice setting. (settingsOpen is already exposed below.)
      settingsSelectedLabel: settingsPanel.open.value ? (settingsPanel.rows()[settingsPanel.selectedIndex.value]?.label ?? '') : '',
      settingsSelectedValue: settingsPanel.open.value ? (settingsPanel.rows()[settingsPanel.selectedIndex.value]?.valueText ?? '') : '',
      narrationVoice: settings.agentNarrationVoice.value,
      narrationRate: settings.agentNarrationRate.value,
      focus: workspaceSet.active.focus.value,
      // The activity bar's active view (files/git/extensions) — the authoritative channel a driven
      // contract reads to assert a click/chord switched the sidebar (paired with FrameProbe for the accent).
      sidebarView: workspaceSet.active.sidebarView.value,
      treeRows: workspaceSet.active.tree.rows.length,
      treeSelected: workspaceSet.active.tree.selectedIndex.value,
      treeScrollTop: workspaceSet.active.tree.scrollTop.value,
      treeHovered: workspaceSet.active.tree.hoveredIndex.value,
      editorScrollTop: editor.viewport.scrollTop.value,
      editorScrollLeft: editor.viewport.scrollLeft.value,
      wordWrap: editor.wordWrap.value,
      showActivityBar: settings.showActivityBar.value,
      changesScrollTop: workspaceSet.active.gitPanel.changesScrollTop.value,
      gitChangesIndex: workspaceSet.active.gitPanel.changesIndex.value,
      gitLogScrollTop: workspaceSet.active.gitPanel.logScrollTop.value,
      gitLogIndex: workspaceSet.active.gitPanel.logIndex.value,
      gitLogLoaded: workspaceSet.active.commitLog.value?.loadedCount ?? 0,
      gitLogExpanded: workspaceSet.active.commitExpansion.value?.entries.value.length ?? 0,
      gitRegion: workspaceSet.active.gitPanel.region.value,
      gitSelectedPaths: [...workspaceSet.active.gitPanel.selectedPaths.value],
      contextMenuOpen: contextMenu.open.value,
      tooltipVisible: tooltip.visible.value,
      // A diff is shown OVER the editor tabs (transient). Lets a driven contract confirm the diff
      // pane actually mounted, so pane-independence (editor extent survives the swap) is real-verified.
      showingDiff: workspaceSet.active.showingDiff.value,
      diffScrollTop: diffView?.alignedRowScrollOffset.value ?? 0,
      diffSelectionChars: diffView?.selectionCharacterCount() ?? 0,
      diffSelection: diffView?.selectionRange() ?? null,
      diffSplitRatio: settings.diffSplitRatio.value,
      markdownPreviewOpen: workspaceSet.active.showingMarkdownPreview,
      markdownPaneFocus: markdownSplitView?.focusedPane.value ?? 'source',
      markdownSplitRatio: settings.markdownSplitRatio.value,
      markdownPreviewScrollTop: markdownSplitView?.preview.scrollTop.value ?? 0,
      markdownPreviewSelectionChars: markdownSplitView?.selectionCharacterCount() ?? 0,
      markdownHoveredReference: markdownSplitView?.hoveredReferencePath.value ?? null,
      settingsOpen: settingsPanel.open.value,
      settingsSelected: settingsPanel.selectedIndex.value,
      shortcutHelpOpen: shortcutHelp.open.value,
      shortcutHelpScrollTop: shortcutHelp.scrollTop.value,
      shortcutHelpRowCount: shortcutHelp.open.value ? shortcutHelp.rows().length : 0,
      sidebarWidth: settings.sidebarWidth.value,
      // Total working-tree changes — proves the GitWatcher live-refreshes on EXTERNAL fs changes.
      gitChangedCount: (() => {
        const repository = workspaceSet.active.git.value;
        if (!repository) return 0;
        return (
          repository.staged.value.length + repository.unstaged.value.length + repository.untracked.value.length
        );
      })(),
      // Editor buffer tabs (item 10a). liveBufferCount proves the FLYWEIGHT: it must stay far below
      // tabCount (only the active + any dirty background buffer holds a live document).
      bufferTabCount: workspaceSet.active.buffers.count,
      bufferLiveCount: workspaceSet.active.buffers.liveCount,
      activeBufferIndex: workspaceSet.active.buffers.activeIndex.value,
      pendingCloseTab: workspaceSet.active.pendingCloseTabIndex.value,
      // Bottom panel / terminal state (drives smoke-terminal assertions without pane-scraping).
      terminalVisible: panelHost.visible.value,
      terminalFocused: panelHost.focused.value,
      panelActiveContent: panelHost.activeId.value,
      panelContentIds: panelHost.order.value,
      terminalColumns: view.panelViewportColumns(),
      terminalRows: view.panelViewportRows(),
      // Split state: which cells occupy the slot, which one has the keyboard, and each cell's converged
      // column width — the driving smoke reads this to prove 2-up render, focus routing, and re-flow.
      panelCellIds: panelHost.resolvedCells.map((cell) => cell.content.id),
      panelFocusedIndex: panelHost.focusedIndex.value,
      panelCellColumns: panelHost.cellSpans(view.panelViewportColumns()).map((span) => span.columns),
      // Active buffer is an image the editor renders as half-block cells (drives smoke-image-preview).
      activeFileIsImage: workspaceSet.active.activeFileIsImage,
      // Audio narration (third projection): the toggle, how many assistant turns have been spoken, and
      // the last spoken text — the driving smoke reads these to prove it speaks completed turns when ON
      // and NOTHING when off, all through the silent mock backend (no audio in CI).
      narrationEnabled: settings.agentAudioNarration.value,
      narrationSpokenCount: narration?.spokenCount.value ?? 0,
      narrationLastSpoken: narration?.lastSpoken.value ?? '',
      narrationBargeInCount: narration?.bargeInCount.value ?? 0,
      // Agent pane UX view state (drives smoke-agent-pane-ux): busy shows the spinner; stuckToBottom
      // flips false once the user scrolls up; expandedCount rises when a collapsed tool row is opened.
      agentBusy: agentPaneContent?.agentSession.busy ?? false,
      agentStuckToBottom: agentPaneContent?.stuckToBottom ?? true,
      agentExpandedCount: agentPaneContent?.expandedCount ?? 0,
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
    workspaceSet.active.editor.viewport.setSize(view.editorViewportWidth(), view.editorViewportHeight());
  };

  // The single coarse reactive frame effect: observe the load-bearing signals and repaint on ANY
  // change — keyboard input OR an async producer (syntax/LSP/git). This is what lets a git refresh
  // or an LSP diagnostic repaint the screen without a keypress.
  // invariant: Rendering is one coarse frame effect (app.invariants.md)
  app.$watchEffect(() => {
    const editor = workspaceSet.active.editor;
    // The whole paint pass is exception-isolated: a throw while projecting model→renderables must
    // degrade this one frame (logged to file) and request a repaint, never wedge the demand-driven
    // loop. The signal reads stay first so reactive dependency tracking is unaffected by the guard.
    // invariant: The render loop never wedges (project.invariants.md)
    // Explicit subscriptions to the load-bearing signals (document.revision in particular is only
    // read indirectly by update(), so touch it here to guarantee content changes repaint).
    void editor.document.revision.value;
    void editor.cursor.line.value;
    void editor.cursor.col.value;
    void editor.cursor.anchor.value;
    void editor.viewport.scrollTop.value;
    void editor.viewport.scrollLeft.value;
    void editor.wordWrap.value;
    void settings.diffSplitRatio.value;
    void settings.markdownSplitRatio.value;
    void settings.workspaceTabPosition.value;
    void workspaceSet.entries.value;
    void workspaceSet.activeWorkspaceIndex.value;
    void workspaceTabStrip.scrollOffset.value;
    void bufferTabStrip.scrollOffset.value;
    void workspaceSet.active.focus.value;
    void workspaceSet.active.sidebarView.value;
    // The breadcrumb's ‹ › history buttons re-colour (enabled/disabled) as the trail moves.
    void workspaceSet.active.navigationHistory.currentIndex.value;
    void workspaceSet.active.navigationHistory.entries.value;
    void workspaceSet.active.markdownPreviewPaths.value;
    void workspaceSet.active.tree.selectedIndex.value;
    void workspaceSet.active.tree.hoveredIndex.value;
    // Git state is produced asynchronously (refresh/log outlive boot); observe it so the sidebar
    // repaints — and the status side-channel flushes — when git data arrives.
    const git = workspaceSet.active.git.value;
    if (git) {
      void git.branch.value;
      void git.staged.value;
      void git.unstaged.value;
      void git.untracked.value;
      void git.refreshing.value;
    }
    // Inline commit expansion is produced asynchronously (the lazy name-status fetch lands after
    // Enter); observe the entries so the loading row is replaced by file rows without a keypress.
    void workspaceSet.active.commitExpansion.value?.entries.value;
    const gitPanel = workspaceSet.active.gitPanel;
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
    view.observeHoverRepaint(); // the LSP hover card projects on its reactive paint signal (async landing)
    void commands.open.value;
    void commands.query.value;
    void quickOpen.open.value; // repaint the quick-open modal on open/query/selection/hover change
    void quickOpen.query.value;
    void quickOpen.selectedIndex.value;
    void quickOpen.hoveredIndex.value;
    void quickOpen.workspacePathOpenable.value; // repaint the path-alert glyph live as the path changes
    void findBar.open.value;
    void findBar.engine?.query.value;
    void findBar.engine?.matches.value;
    void findBar.engine?.currentMatchIndex.value; // repaint the match counter on next/prev
    void findBar.caseSensitive; // repaint the case toggle on flip
    void shortcutHelp.open.value; // repaint the cheat-sheet on open/close and scroll
    void shortcutHelp.scrollTop.value;
    void commands.selectedIndex.value;
    void theme.paletteName.value;
    void app.quitChordArmed.value;
    void app.copyNotice.value;
    // Bottom panel: repaint on visibility/focus/switch AND on the active content's paint signal, so
    // async terminal output (PTY bytes) repaints without a keypress (idle shell bumps nothing → the
    // demand-driven loop stays at rest).
    void panelHost.visible.value;
    void panelHost.focused.value;
    void panelHost.activeId.value;
    void panelHost.order.value;
    void panelHost.layout.value;
    void panelHost.focusedIndex.value;
    // Repaint on ANY visible cell's paint signal — a split panel has two live panes, either of which
    // can emit async output (PTY bytes) that must repaint without a keypress.
    for (const content of panelHost.visibleContents()) void content.renderRevision.value;
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
  // Last panel geometry pushed to the terminal — so the resize ioctl fires only on a real change.
  // The panel converge signature: total rows + each cell's id=width. Keyed on the LAYOUT, not just the
  // total width, so splitting/un-splitting/dragging the divider (which redistributes the SAME total
  // width across cells) re-fires setViewportSize — otherwise a cell's child (a real terminal) keeps its
  // pre-split full width because the panel's outer width never changed.
  let lastPanelLayoutKey = '';
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
    animating = workspaceSet.active.tickScrollAnimations(deltaTimeSeconds) || animating;
    // Drag-edge auto-scroll: while a selection drag holds at a pane edge, keep scrolling +
    // extending the selection.
    animating = view.tickDragAutoScroll(deltaTimeSeconds) || animating;
    animating = view.tickDiffMomentum(deltaTimeSeconds) || animating; // the open diff's fling glide
    animating = view.tickMarkdownPreview(deltaTimeSeconds) || animating;
    // Tooltip dwell: the frame tick advances the timer; it's just another animation source, so it
    // folds into the SAME single-live-request model (holds a frame while counting, false at rest).
    animating = tooltip.tick(deltaTimeSeconds) || animating;
    // The LSP hover-card dwell advances on the SAME frame tick (holds a frame while counting or while a
    // hover request is in flight, false once the card is shown or disarmed).
    animating = view.tickHover(deltaTimeSeconds) || animating;
    syncAnimationLiveness(animating);
    // Converge the viewport size with the LAID-OUT layout (gutter width changes when a file opens
    // or its line count crosses a digit boundary; boot/resize alone goes stale). Mutating outside
    // the reactive effect: the write triggers one repaint and converges — no feedback loop.
    const editorViewport = workspaceSet.active.editor.viewport;
    const laidOutWidth = view.editorViewportWidth();
    const laidOutHeight = view.editorViewportHeight();
    if (editorViewport.width.value !== laidOutWidth || editorViewport.height.value !== laidOutHeight) {
      editorViewport.setSize(laidOutWidth, laidOutHeight);
      renderer.requestRender(); // one-shot convergence (not an animation — no live request)
    }
    // Converge the terminal's cols×rows with the laid-out panel region (like the editor viewport):
    // resize the emulator + child ONLY on a real change, so the ioctl fires on split/window resize,
    // never per frame. Drives the child's SIGWINCH so `stty size` reflects the new geometry.
    if (panelHost.visible.value) {
      const panelColumns = view.panelViewportColumns();
      const panelRows = view.panelViewportRows();
      const layoutKey = `${panelRows}:${panelHost
        .cellSpans(panelColumns)
        .map((span) => `${span.content.id}=${span.columns}`)
        .join(',')}`;
      if (panelColumns > 0 && panelRows > 0 && layoutKey !== lastPanelLayoutKey) {
        lastPanelLayoutKey = layoutKey;
        panelHost.setViewportSize(panelColumns, panelRows);
        renderer.requestRender();
      }
    }
    StatusChannel.Class.settle(frame);
    // Exact per-cell visual snapshot for tests (env-gated; no-op otherwise).
    FrameProbe.Class.dump(renderer, framePath);
  };
  // A throw in a frame tick (animation step, layout convergence) must not stop the pump: isolate it
  // and keep the loop alive. invariant: The render loop never wedges (project.invariants.md)
  const onFrame = (): void => {
    HandlerGuard.Class.run('frame', frameTick, () => renderer.requestRender());
  };
  renderer.on('frame', onFrame);
  app.onDispose(() => renderer.off('frame', onFrame));
  app.onDispose(() => workspaceSet.dispose()); // stop all working-tree watchers + dispose open buffers

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
    workspaceSet,
    theme,
    openWorkspaceFolder: () =>
      overlayCoordinator.openExclusiveOverlay('quickOpen', () =>
        quickOpen.showWorkspacePath(workspaceSet.active.root),
      ),
    quit: () => void shutdown(),
    requestRender: () => app.requestRender(),
    hasOpenDiff: () => workspaceSet.active.showingDiff.value && view.activeDiffView() !== null,
    nextDiffChange: () => view.activeDiffView()?.jumpToNextChange(),
    previousDiffChange: () => view.activeDiffView()?.jumpToPreviousChange(),
    toggleMarkdownPreview: () => workspaceSet.active.toggleMarkdownPreview(),
    toggleActivityBar: () => {
      settings.showActivityBar.value = !settings.showActivityBar.value;
      app.requestRender();
    },
    hasHoveredMarkdownReference: () =>
      Boolean(view.activeMarkdownSplitView()?.hoveredReferencePath.value),
    openHoveredMarkdownReference: () => view.activeMarkdownSplitView()?.openHoveredReference(),
    openShortcutHelp: () =>
      overlayCoordinator.openExclusiveOverlay('shortcutHelp', () => shortcutHelp.show()),
    testNarrationVoice,
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
  // Git-panel helpers shared by the git action handlers (region-aware continuous flow).
  const currentChangeRows = () => {
    const git = workspaceSet.active.git.value;
    return git ? GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
  };
  const normalizeChangesIndex = (): void => {
    const rows = currentChangeRows();
    if (rows[workspaceSet.active.gitPanel.changesIndex.value]?.kind !== 'file') {
      const firstFile = GitRows.Class.nextFileRow(rows, -1, 1);
      if (firstFile >= 0) workspaceSet.active.gitPanel.moveChangesSelection(firstFile);
    }
  };
  // Up/Down walk the FLAT log rows (commit headers AND expanded file rows are both selectable) —
  // logIndex is a flat-row index over the same row model the renderer draws.
  const moveLog = (delta: number): void => {
    const gitPanel = workspaceSet.active.gitPanel;
    workspaceSet.active.haltGitLogScroll(); // keyboard is precise — adopt-and-stop any glide (One-Writer)
    const end = workspaceSet.active.logFlatEnd();
    gitPanel.moveLogSelection(delta, end);
    workspaceSet.active.ensureLogWindow(gitPanel.logScrollTop.value);
  };
  const moveChanges = (direction: 1 | -1): void => {
    const gitPanel = workspaceSet.active.gitPanel;
    workspaceSet.active.haltGitChangesScroll(); // keyboard is precise — adopt-and-stop wheel glide
    const rows = currentChangeRows();
    const next = GitRows.Class.nextFileRow(rows, gitPanel.changesIndex.value, direction);
    if (next >= 0) gitPanel.moveChangesSelection(next);
    else if (direction === 1) gitPanel.region.value = 'log'; // flow into the log
  };

  // The ACTION TABLE: every binding's action id -> its handler. Handlers receive the raw KeyEvent
  // for parameters that compose (shift = extend; repeat runs = acceleration).
  const actionHandlers: Record<string, (key: KeyEvent) => void> = {
    'app.quit': () => void shutdown(),
    'find.open': () => {
      const target = view.findTarget();
      if (!target) return;
      overlayCoordinator.openExclusiveOverlay('findBar', () =>
        findBar.openForTarget(target, 'find'),
      );
      revealFindMatch();
    },
    'find.replace': () => {
      const target = view.findTarget();
      if (!target) return;
      overlayCoordinator.openExclusiveOverlay('findBar', () =>
        findBar.openForTarget(target, 'replace'),
      );
      revealFindMatch();
    },
    'quickopen.open': () =>
      overlayCoordinator.openExclusiveOverlay('quickOpen', () => void quickOpen.show(workspaceSet.active.root)),
    'workspace.openFolder': () =>
      overlayCoordinator.openExclusiveOverlay('quickOpen', () =>
        quickOpen.showWorkspacePath(workspaceSet.active.root),
      ),
    'workspace.close': () => workspaceSet.closeActive(),
    'workspace.next': () => workspaceSet.cycle(1),
    'workspace.previous': () => workspaceSet.cycle(-1),
    'palette.open': () =>
      overlayCoordinator.openExclusiveOverlay('commandPalette', () => commands.openPalette()),
    'palette.close': () => commands.closePalette(),
    'palette.run': () => commands.runSelected(),
    'palette.previous': () => commands.moveSelection(-1),
    'palette.next': () => commands.moveSelection(1),
    'palette.erase': () => commands.backspaceQuery(),
    'palette.eraseWord': () => commands.deletePreviousQueryWord(),
    'quickopen.eraseWord': () => quickOpen.deletePreviousWord(),
    'find.eraseWord': () => {
      findBar.deletePreviousWord();
      revealFindMatch();
    },
    'find.toggleCaseSensitive': () => {
      findBar.toggleCaseSensitive();
      revealFindMatch();
    },
    'focus.toggle': () => workspaceSet.active.toggleFocus(),
    'settings.toggle': () => {
      if (settingsPanel.open.value) settingsPanel.close();
      else overlayCoordinator.openExclusiveOverlay('settingsPanel', () => settingsPanel.toggle());
    },
    'settings.close': () => settingsPanel.close(),
    // The cheat-sheet: the same chord toggles; Esc closes; arrows/pages scroll the row window.
    // invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
    'help.shortcuts': () => {
      if (shortcutHelp.open.value) shortcutHelp.close();
      else overlayCoordinator.openExclusiveOverlay('shortcutHelp', () => shortcutHelp.show());
    },
    'help.close': () => shortcutHelp.close(),
    'help.up': () => shortcutHelp.scrollBy(-1, view.shortcutHelpViewportRows()),
    'help.down': () => shortcutHelp.scrollBy(1, view.shortcutHelpViewportRows()),
    'help.pageUp': () =>
      shortcutHelp.scrollBy(-view.shortcutHelpViewportRows(), view.shortcutHelpViewportRows()),
    'help.pageDown': () =>
      shortcutHelp.scrollBy(view.shortcutHelpViewportRows(), view.shortcutHelpViewportRows()),
    'settings.up': () => settingsPanel.moveSelection(-1),
    'settings.down': () => settingsPanel.moveSelection(1),
    'settings.increase': () => settingsPanel.adjust(1),
    'settings.decrease': () => settingsPanel.adjust(-1),
    'buffer.close': () => workspaceSet.active.closeActiveTab(),
    'buffer.next': () => workspaceSet.active.cycleTab(1),
    'buffer.previous': () => workspaceSet.active.cycleTab(-1),
    'diff.nextChange': () => view.activeDiffView()?.jumpToNextChange(),
    'diff.previousChange': () => view.activeDiffView()?.jumpToPreviousChange(),
    'markdown.togglePreview': () => workspaceSet.active.toggleMarkdownPreview(),
    'markdown.openHoveredReference': () => view.activeMarkdownSplitView()?.openHoveredReference(),
    // F12 parity with Ctrl/Cmd+click: definition of the symbol AT THE CURSOR.
    'go.definition': () => void workspaceSet.active.goToDefinition(),
    // Browser-style Go Back / Go Forward through the navigation trail (Alt+[ / Alt+]). Safe no-ops
    // at the ends of the history.
    'navigation.back': () => workspaceSet.active.navigateBack(),
    'navigation.forward': () => workspaceSet.active.navigateForward(),
    'git.togglePanel': () => {
      workspaceSet.active.toggleGit();
      if (workspaceSet.active.focus.value === 'git') {
        void workspaceSet.active.git.value?.refresh();
        void workspaceSet.active.commitLog.value?.ensureRange(0, 50);
      }
    },
    // Activity-bar view switchers (Ctrl+Shift+E/G/X) — the SAME single writer the bar's clicks call.
    'view.showFiles': () => workspaceSet.active.showSidebarView('files'),
    'view.showSourceControl': () => workspaceSet.active.showSidebarView('git'),
    'view.showExtensions': () => workspaceSet.active.showSidebarView('extensions'),
    // Ctrl+Shift+B shows/hides the whole activity bar (same setting-flip the palette command runs).
    'view.toggleActivityBar': () => {
      settings.showActivityBar.value = !settings.showActivityBar.value;
      app.requestRender();
    },
    'git.up': () => {
      normalizeChangesIndex();
      if (workspaceSet.active.gitPanel.region.value === 'changes') moveChanges(-1);
      else if (workspaceSet.active.gitPanel.logIndex.value === 0) {
        workspaceSet.active.haltGitChangesScroll();
        workspaceSet.active.gitPanel.region.value = 'changes'; // flow back up into the changes
        const rows = currentChangeRows();
        const last = GitRows.Class.nextFileRow(rows, rows.length, -1);
        if (last >= 0) workspaceSet.active.gitPanel.moveChangesSelection(last);
      } else moveLog(-1);
    },
    'git.down': () => {
      normalizeChangesIndex();
      if (workspaceSet.active.gitPanel.region.value === 'changes') moveChanges(1);
      else moveLog(1);
    },
    'git.pageUp': () => {
      if (workspaceSet.active.gitPanel.region.value === 'log') moveLog(-10);
    },
    'git.pageDown': () => {
      if (workspaceSet.active.gitPanel.region.value === 'log') moveLog(10);
    },
    'git.stageToggle': () => {
      // Enter in the LOG region activates the flat row: commit header = toggle inline expansion
      // (lazy fetch); file row = open that file's diff for that commit.
      if (workspaceSet.active.gitPanel.region.value === 'log') {
        workspaceSet.active.activateLogRow(workspaceSet.active.gitPanel.logIndex.value);
        return;
      }
      normalizeChangesIndex();
      void workspaceSet.active.toggleStageAtRow(workspaceSet.active.gitPanel.changesIndex.value);
    },
    'git.openFile': () => {
      if (workspaceSet.active.gitPanel.region.value === 'log') {
        workspaceSet.active.activateLogRow(workspaceSet.active.gitPanel.logIndex.value);
        return;
      }
      normalizeChangesIndex();
      void workspaceSet.active.openChangeAtRow(workspaceSet.active.gitPanel.changesIndex.value);
    },
    'git.expandRight': () => {
      // Right on a collapsed commit expands it; on an expanded one steps into its first file row
      // (tree parity). No-op outside the log region.
      if (workspaceSet.active.gitPanel.region.value !== 'log') return;
      const row = workspaceSet.active.logRowAt(workspaceSet.active.gitPanel.logIndex.value);
      if (row?.kind !== 'commit') return;
      if (row.expanded) moveLog(1);
      else workspaceSet.active.activateLogRow(workspaceSet.active.gitPanel.logIndex.value);
    },
    'git.collapseLeft': () => {
      if (workspaceSet.active.gitPanel.region.value === 'log')
        workspaceSet.active.collapseLogRow(workspaceSet.active.gitPanel.logIndex.value);
    },
    'git.discard': () => {
      normalizeChangesIndex();
      workspaceSet.active.requestDiscardAtRow(workspaceSet.active.gitPanel.changesIndex.value);
    },
    'git.leave': () => workspaceSet.active.focusFiles(),
    'tree.up': () => {
      workspaceSet.active.haltTreeScroll();
      workspaceSet.active.tree.moveSelection(-1);
    },
    'tree.down': () => {
      workspaceSet.active.haltTreeScroll();
      workspaceSet.active.tree.moveSelection(1);
    },
    'tree.activate': () => void workspaceSet.active.activate(),
    'tree.rightExpandOrOpen': () => {
      // Right on a FILE opens it; on a collapsed dir expands; on an expanded dir steps into it.
      workspaceSet.active.haltTreeScroll();
      if (workspaceSet.active.tree.selected?.isDir && workspaceSet.active.tree.selected.expanded)
        workspaceSet.active.tree.moveSelection(1);
      else workspaceSet.active.activate();
    },
    'tree.leftCollapse': () => {
      if (workspaceSet.active.tree.selected?.isDir && workspaceSet.active.tree.selected.expanded) workspaceSet.active.activate();
    },
    'editor.moveUp': (key) => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.moveByKeyboardRows(-movementAcceleration(key));
      else workspaceSet.active.editor.moveVertical(-movementAcceleration(key), key.shift);
    },
    'editor.moveDown': (key) => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.moveByKeyboardRows(movementAcceleration(key));
      else workspaceSet.active.editor.moveVertical(movementAcceleration(key), key.shift);
    },
    'editor.moveLeft': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) {
        workspaceSet.active.editor.moveHorizontal(-movementAcceleration(key), key.shift);
      }
    },
    'editor.moveRight': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) {
        workspaceSet.active.editor.moveHorizontal(movementAcceleration(key), key.shift);
      }
    },
    'editor.pageUp': (key) => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.pageByKeyboard(-1);
      else workspaceSet.active.editor.pageUp(key.shift);
    },
    'editor.pageDown': (key) => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.pageByKeyboard(1);
      else workspaceSet.active.editor.pageDown(key.shift);
    },
    'editor.lineStart': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveToLineStart(key.shift);
    },
    'editor.lineEnd': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveToLineEnd(key.shift);
    },
    'editor.jumpUp': (key) =>
      view.activeMarkdownSplitView()?.previewFocused
        ? view.activeMarkdownSplitView()?.moveByKeyboardRows(-ScrollPhysics.Class.jumpRows(movementRun(key)))
        : workspaceSet.active.editor.moveVertical(-ScrollPhysics.Class.jumpRows(movementRun(key)), key.shift),
    'editor.jumpDown': (key) =>
      view.activeMarkdownSplitView()?.previewFocused
        ? view.activeMarkdownSplitView()?.moveByKeyboardRows(ScrollPhysics.Class.jumpRows(movementRun(key)))
        : workspaceSet.active.editor.moveVertical(ScrollPhysics.Class.jumpRows(movementRun(key)), key.shift),
    'editor.wordLeft': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveWordHorizontal(-1, key.shift);
    },
    'editor.wordRight': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveWordHorizontal(1, key.shift);
    },
    'editor.documentStart': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveDocumentStart(key.shift);
    },
    'editor.documentEnd': (key) => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.moveDocumentEnd(key.shift);
    },
    'editor.newline': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.insertNewline();
    },
    'editor.backspace': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.backspace();
    },
    'editor.delete': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.deleteChar();
    },
    'editor.deleteToLineStart': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.deleteToLineStart();
    },
    'edit.deletePreviousWord': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) commands.run('edit.deletePreviousWord');
    },
    'editor.escape': () => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.focusSource();
      else if (workspaceSet.active.editor.hasSelection) workspaceSet.active.editor.cursor.clearSelection();
      else workspaceSet.active.focusFiles();
    },
    'editor.save': () => workspaceSet.active.saveActiveFile(),
    'editor.selectAll': () => {
      const markdownSplitView = view.activeMarkdownSplitView();
      if (markdownSplitView?.previewFocused) markdownSplitView.selectAll();
      else workspaceSet.active.editor.selectAll();
    },
    'editor.copy': () => {
      // Publish how many characters landed on the clipboard — the observable proof that copy
      // actually copied (the human-QA "cannot copy" bug's verification channel).
      const diffView = workspaceSet.active.showingDiff.value ? view.activeDiffView() : null;
      const markdownSplitView = view.activeMarkdownSplitView();
      // An engaged hover card with a selection owns Ctrl+C — copy ITS text, not the editor's beneath.
      const copyPromise = view.hoverHasSelection()
        ? view.hoverCopySelection()
        : diffView
          ? diffView.copySelection()
          : markdownSplitView?.previewFocused
            ? markdownSplitView.copySelection()
            : workspaceSet.active.editor.copySelection();
      void copyPromise.then((copiedCharacters) => {
        if (copiedCharacters > 0) {
          app.copyNotice.value = `Copied ${copiedCharacters} chars (${Clipboard.Class.lastBackend ?? 'no backend'})`;
        }
        StatusChannel.Class.update({
          lastCopyChars: copiedCharacters,
          lastCopyHash: Clipboard.Class.lastCopiedTextHash,
          clipboardBackend: Clipboard.Class.lastBackend,
        });
        StatusChannel.Class.flush();
      });
    },
    'editor.cut': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) void workspaceSet.active.editor.cutSelection();
    },
    'editor.paste': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) void workspaceSet.active.editor.pasteClipboard();
    },
    'editor.undo': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.performUndo();
    },
    'editor.redo': () => {
      if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.performRedo();
    },
    'editor.toggleWordWrap': () => workspaceSet.active.editor.toggleWordWrap(),
    // Toggle the bottom panel (terminal). Reserved so it fires from ANY mode — including from within a
    // focused terminal (to hide it) — exactly like the quit escape hatch. Same closure the status-bar
    // terminal button runs, so chord and click are one action.
    'panel.toggleTerminal': toggleTerminal,
    'panel.toggleAgent': toggleAgent,
    'panel.toggleSplit': togglePanelSplit,
    'menu.previous': () => contextMenu.moveSelection(-1),
    'menu.next': () => contextMenu.moveSelection(1),
    'menu.run': () => contextMenu.runSelected(),
    'menu.close': () => contextMenu.close(),
  };

  const inputOverlayOpeningActionIdentifiers = new Set([
    'find.open',
    'find.replace',
    'quickopen.open',
    'workspace.openFolder',
    'palette.open',
    'settings.toggle',
    'help.shortcuts',
  ]);

  const keyTick = (key: KeyEvent): void => {
    tooltip.clear(); // any keypress hides the tooltip (display-only affordance)
    if (key.name === 'escape') narration?.bargeIn(); // Escape is the EXPLICIT "stop narration"; ordinary typing/paste/navigation lets it play on, so you can read/compose/work while listening (barge-in should be intentional, not a side effect of every keystroke)
    // Escape always closes the hover card; any other key closes it too UNLESS the pointer is engaged
    // with it (over the card / dragging a selection) — so a sticky card lets Ctrl+C copy its selection.
    if (key.name === 'escape') view.dismissHover();
    else view.dismissHoverSoft();
    // RESERVED GLOBAL CHORDS (quit) are escape hatches that must fire from ANY mode — checked BEFORE
    // every modal/search branch below, or a focused find/quick-open/settings input would swallow the
    // quit key and TRAP the user with no way out (a hard no-dead-ends / learnability failure). The
    // check is stateless (single-chord match only), so it never disturbs the chord resolver below.
    // invariant: Reserved global chords fire from any mode (src/modules/keybindings/keybindings.invariants.md)
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
    if (workspaceSet.active.gitPanel.confirmDiscard.value) {
      if (key.name === 'y') void workspaceSet.active.confirmDiscard();
      else workspaceSet.active.cancelDiscard();
      return;
    }
    // Same MODAL contract for closing a tab with unsaved edits.
    if (workspaceSet.active.pendingCloseTabIndex.value >= 0) {
      if (key.name === 'y') workspaceSet.active.confirmCloseTab();
      else workspaceSet.active.cancelCloseTab();
      return;
    }

    // A focused bottom panel (the terminal) owns the keyboard: every non-reserved key is encoded to
    // terminal bytes and delivered to the active PaneContent's handleKey. Reserved globals (quit, panel
    // toggle) already fired above, so Ctrl+Q / F10 still quit and the toggle still hides the panel; an
    // unencodable key is swallowed so it never drives the hidden editor beneath.
    // invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
    if (panelHost.visible.value && panelHost.focused.value) {
      panelHost.handleKey(key);
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
      else if (menuResolution.action && inputOverlayOpeningActionIdentifiers.has(menuResolution.action)) {
        actionHandlers[menuResolution.action]?.(key);
      } else contextMenu.close();
      return;
    }

    // The cheat-sheet is an input-capturing overlay: while open, keys resolve in its 'help'
    // context (Esc closes, arrows scroll, global chords still work — opening another overlay
    // closes the sheet through the coordinator) and unbound keys are consumed.
    const context = shortcutHelp.open.value
      ? 'help'
      : settingsPanel.open.value
        ? 'settings'
        : commands.open.value
          ? 'palette'
          : quickOpen.open.value
            ? 'quickopen'
            : findBar.open.value
              ? 'find'
              : workspaceSet.active.focus.value;

    // Ctrl+H is the ASCII Backspace control byte (0x08); OpenTUI correctly decodes that legacy byte
    // as {name:'backspace', ctrl:false}. A physical Backspace is DEL (0x7f), so the byte sequences are
    // distinguishable. Normalize raw 0x08 back to the intent-addressed Ctrl+H chord before registry
    // resolution; the action remains DATA (`find.replace`), and ordinary Backspace remains editing.
    const rawControlH = key.name === 'backspace' && key.sequence === '\u0008';
    const normalizedChordEvent = {
      name: rawControlH ? 'h' : key.name,
      ctrl: rawControlH ? true : key.ctrl,
      shift: key.shift,
      option: key.option || key.meta,
      super: key.super,
    };

    // Quick-open (Ctrl+P) modal: type filters the fuzzy file list live, ↑/↓ move, Enter opens the
    // selected file as a tab (add-or-focus), Esc closes. Inline like the palette's query editing.
    if (context === 'quickopen') {
      const quickOpenResolution = keybindings.resolve(normalizedChordEvent, 'quickopen', Date.now());
      if (quickOpenResolution.action) {
        actionHandlers[quickOpenResolution.action]?.(key);
        return;
      }
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
        activateQuickOpenSelection(); // the SAME path a click on a result row runs
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
      const findResolution = keybindings.resolve(normalizedChordEvent, 'find', Date.now());
      if (findResolution.action) {
        actionHandlers[findResolution.action]?.(key);
        return;
      }
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
    if (context === 'editor' && !view.activeMarkdownSplitView()?.previewFocused && renderer.useKittyKeyboard && key.ctrl && key.name === 'a' && key.sequence === '\u0001') {
      workspaceSet.active.editor.moveToLineStart(key.shift);
      return;
    }

    // A diff is open OVER the tabs: editor-context keys drive the DiffView (synced aligned-row panes),
    // not the hidden buffer. n/p jump changes, Enter promotes to a real editable tab, Esc closes.
    if (context === 'editor' && workspaceSet.active.showingDiff.value) {
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
          case 'return':
            if (!key.ctrl) {
              diff.openFull();
              return;
            }
            break;
          case 'escape': workspaceSet.active.showingDiff.value = false; workspaceSet.active.diffRequest.value = null; return;
          default: break;
        }
      }
    }

    const resolution = keybindings.resolve(
      // Alt-family collapse: mac terminals surface Option as `option` OR `meta` (ESC-prefixed
      // forms); both mean the alt slot of a chord pattern.
      normalizedChordEvent,
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
    else if (
      context === 'editor' &&
      isTypedCharacter(key) &&
      !view.activeMarkdownSplitView()?.previewFocused
    ) workspaceSet.active.editor.insertText(key.sequence);
    // No explicit render here — any model mutation above triggers the frame effect.
  };
  // A throw while handling a keystroke must not wedge the loop: isolate + repaint so the app stays
  // responsive. invariant: The render loop never wedges (project.invariants.md)
  const onKey = (key: KeyEvent): void => {
    HandlerGuard.Class.run('keypress', () => keyTick(key), () => app.requestRender());
  };
  renderer.keyInput.on('keypress', onKey);
  app.onDispose(() => renderer.keyInput.off('keypress', onKey));

  // Bracketed paste. A clipboard paste or a dictation tool (e.g. Hex) injects text framed as
  // \e[200~…\e[201~; OpenTUI PARSES that framing into a single `paste` event but never ENABLES the
  // mode itself, so we request DECSET 2004 here (clipboard pastes then arrive framed too) and disable
  // it on teardown. Without this, framed paste bursts vanish — captured by OpenTUI's paste channel
  // that nothing listened to. A framed paste yields NO keypresses, so this is the ONLY delivery path.
  // invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
  process.stdout.write('\x1b[?2004h');
  app.onDispose(() => process.stdout.write('\x1b[?2004l'));
  // Route a paste to the same target the keyboard has: the focused panel pane (terminal PTY / agent
  // composer), else a focused single-line modal input (quick-open / find), else the editor. Mirrors
  // keyTick's dispatch order so paste lands exactly where typing would.
  const pasteTick = (text: string): void => {
    if (!text) return;
    if (panelHost.visible.value && panelHost.focused.value) {
      panelHost.handlePaste(text);
      return; // a focused panel owns paste even if its pane has no sink — never leak to the editor
    }
    const singleLine = text.replace(/[\r\n]+/g, ' ');
    if (quickOpen.open.value) { quickOpen.setQuery(quickOpen.query.value + singleLine); return; }
    if (findBar.open.value) { findBar.append(singleLine); return; }
    // Other overlays (palette, settings, help, menu) have no free-text paste target — consume it so a
    // paste never drives the editor hidden beneath an open overlay.
    if (commands.open.value || settingsPanel.open.value || shortcutHelp.open.value || contextMenu.open.value) return;
    if (!view.activeMarkdownSplitView()?.previewFocused) workspaceSet.active.editor.pasteText(text);
  };
  const onPaste = (event: { bytes: Uint8Array }): void => {
    HandlerGuard.Class.run('paste', () => pasteTick(new TextDecoder().decode(event.bytes)), () => app.requestRender());
  };
  renderer.keyInput.on('paste', onPaste);
  app.onDispose(() => renderer.keyInput.off('paste', onPaste));

  // Global mouse capture: events bubble to the root renderable. Records the last event to the
  // status channel (verification) and repaints. Per-region handlers (tree, sidebar, dividers) are
  // attached on their own renderables and run before this via propagation.
  const onMouse = (event: { type: string; x: number; y: number; button: number }): void => {
    HandlerGuard.Class.run('mouse', () => {
      lastMouse = { type: event.type, x: event.x, y: event.y, button: event.button };
      // Focus-follows-click for the bottom panel: a down OUTSIDE the visible panel blurs it (a down
      // inside is handled by the panel box, which focuses it). Keeps typing from going to a shell you
      // clicked away from.
      if (event.type === 'down' && panelHost.focused.value && !view.panelContainsPoint(event.x, event.y)) {
        panelHost.blur();
      }
      if (event.type === 'down') tooltip.clear(); // any click hides the tooltip, wherever it lands
      // A click hides the hover card UNLESS it lands ON the card (engaged): a down on the card begins a
      // drag-select and must not dismiss it; a down anywhere else closes it.
      if (event.type === 'down') view.dismissHoverSoft();
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
  // invariant: The render loop never wedges (project.invariants.md)
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
  return {
    app,
    get workspace() {
      return workspaceSet.active;
    },
    workspaceSet,
    theme,
    renderer,
    view,
    render,
    shutdown,
  };
}

// invariant: Construction goes through overridable seams (project.invariants.md)
class $Bootstrap {
  static boot = $boot;
}

export namespace Bootstrap {
  export const $Class = $Bootstrap;
  export const Class = Static($Bootstrap);
}
