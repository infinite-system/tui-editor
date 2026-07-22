// The editor content-area mount controller: owns WHAT occupies the editor column — the plain editor,
// the side-by-side DiffView, or the Markdown source+preview split — and the lifecycle of the diff and
// markdown instances (construct on request-change, dispose when replaced). Extracted from RootView's
// closure; RootView constructs the container renderables and calls sync()/tickDiff()/tickMarkdown().
//
// The active diff and markdown instances are exposed via getters because several RootView readers need
// them (the caret block and status bar read previewFocused; the find target and the frame loop read
// both; the editor pane focuses the markdown source on click).
import type { BoxRenderable, CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import { DiffView } from '../diff/DiffView';
import { MarkdownSplitView } from '../markdown/MarkdownSplitView';
import { Files } from '../system/Files';
import type { WorkspaceSet } from '../workspace/WorkspaceSet';
import type { Theme } from '../theme/Theme';
import type { Settings } from '../settings/Settings';
import type { FindBar } from '../search/FindBar';
import type { Tooltip } from './Tooltip';
import type { KeybindingRegistry } from '../keybindings/KeybindingRegistry';

export interface EditorContentMountDeps {
  renderer: CliRenderer;
  theme: Theme.Instance;
  settings: Settings.Instance;
  findBar: FindBar.Instance;
  workspaceSet: WorkspaceSet.Instance;
  keybindings: KeybindingRegistry.Instance;
  tooltip: Tooltip.Instance;
  editorColumn: BoxRenderable;
  editorArea: BoxRenderable;
  diffContainer: BoxRenderable;
  markdownContainer: BoxRenderable;
}

class $EditorContentMount {
  private diff: DiffView.Instance | null = null;
  private shownDiffIdentifier = '';
  private markdown: MarkdownSplitView.Instance | null = null;
  private shownMarkdownIdentifier = '';
  private mounted: 'editor' | 'diff' | 'markdown' | null = 'editor';
  private lastDiffLaidHeight = -1;

  constructor(private readonly deps: EditorContentMountDeps) {}

  /** The active DiffView (or null); read by the find target and the frame loop. */
  get diffView(): DiffView.Instance | null {
    return this.diff;
  }
  /** The active MarkdownSplitView (or null); read by the caret, status bar, find target, editor pane. */
  get markdownSplitView(): MarkdownSplitView.Instance | null {
    return this.markdown;
  }

  private unmount(): void {
    const { editorColumn, editorArea, diffContainer, markdownContainer } = this.deps;
    if (this.mounted === 'editor') editorColumn.remove(editorArea);
    else if (this.mounted === 'diff') editorColumn.remove(diffContainer);
    else if (this.mounted === 'markdown') editorColumn.remove(markdownContainer);
    this.mounted = null;
  }

  private mount(content: 'editor' | 'diff' | 'markdown'): void {
    const { editorColumn, editorArea, diffContainer, markdownContainer } = this.deps;
    if (this.mounted === content) return;
    this.unmount();
    if (content === 'editor') editorColumn.add(editorArea);
    else if (content === 'diff') editorColumn.add(diffContainer);
    else editorColumn.add(markdownContainer);
    this.mounted = content;
  }

  sync(): void {
    // invariant: A Markdown file offers a live source preview split (src/modules/markdown/markdown.invariants.md)
    const { renderer, theme, settings, findBar, workspaceSet, keybindings, tooltip, editorArea, diffContainer, markdownContainer } = this.deps;
    const request = workspaceSet.active.diffRequest.value;
    const diffIdentifier = `${workspaceSet.active.root}:${request?.token ?? 'none'}`;
    if (diffIdentifier !== this.shownDiffIdentifier) {
      this.shownDiffIdentifier = diffIdentifier;
      this.lastDiffLaidHeight = -1; // the frame loop re-renders once the new instance has a laid-out height
      if (this.diff) {
        this.diff.dispose();
        this.diff = null;
      }
      if (request) {
        this.diff = new DiffView.Class(renderer, theme, {
          previousVersionText: request.previousVersionText,
          currentVersionText: request.currentVersionText,
          previousVersionPath: request.previousVersionPath,
          currentVersionPath: request.currentVersionPath,
          parentRenderable: diffContainer, // definite-size host (added below in place of editorArea)
          onOpenFull: () => {
            // Git diff requests carry workspace-relative paths. Resolve through the existing
            // confinement seam before promoting the working side to a real editable tab.
            const currentWorkingPath = Files.Class.confineToRoot(workspaceSet.active.root, request.currentVersionPath);
            if (currentWorkingPath) workspaceSet.active.openFileInTab(currentWorkingPath);
          },
          onNextChange: () => renderer.requestRender(),
          onPrevChange: () => renderer.requestRender(),
        });
        this.diff.attachSettings(settings); // live scroll physics, same as the editor
        this.diff.attachFindBar(findBar, diffIdentifier);
      }
    }
    const diffActive = this.diff !== null && workspaceSet.active.showingDiff.value;
    const markdownIdentifier = workspaceSet.active.showingMarkdownPreview
      ? `${workspaceSet.active.root}:${workspaceSet.active.editor.document.path}`
      : '';

    if (diffActive) {
      if (this.markdown) {
        if (this.mounted === 'markdown') this.unmount();
        this.markdown.dispose();
        this.markdown = null;
        this.shownMarkdownIdentifier = '';
      }
      this.mount('diff');
    } else if (markdownIdentifier) {
      if (this.shownMarkdownIdentifier !== markdownIdentifier || !this.markdown) {
        if (this.markdown) {
          if (this.mounted === 'markdown') this.unmount();
          this.markdown.dispose();
        }
        this.shownMarkdownIdentifier = markdownIdentifier;
        this.unmount();
        this.markdown = new MarkdownSplitView.Class(renderer, theme, {
          source: workspaceSet.active.editor.document,
          sourcePath: workspaceSet.active.editor.document.path,
          sourceRenderable: editorArea,
          parentRenderable: markdownContainer,
          settings,
          findBar,
          resolveReference: (reference) => workspaceSet.active.resolveFileReference(reference),
          openReference: (path) => workspaceSet.active.openFileInTab(path),
          showReferenceTooltip: (path, screenColumn, screenRow) => {
            const label = Files.Class.relative(workspaceSet.active.root, path);
            const bindingHint = keybindings.bindingHint('markdown.openHoveredReference', 'editor');
            tooltip.point(
              `Open ${label} (Ctrl/Cmd+click${bindingHint ? ` · ${bindingHint}` : ''})`,
              screenColumn,
              screenRow,
            );
          },
          clearReferenceTooltip: () => tooltip.clear(),
        });
      }
      this.mount('markdown');
      this.markdown.update();
    } else {
      if (this.markdown) {
        if (this.mounted === 'markdown') this.unmount();
        this.markdown.dispose();
        this.markdown = null;
        this.shownMarkdownIdentifier = '';
      }
      this.mount('editor');
    }
    // NOTE: the DiffView's first paint at its real laid-out height is driven from the FRAME LOOP
    // (tickDiff), NOT here — sync() runs in the reactive paint (fires only on signal changes), which
    // happens BEFORE OpenTUI lays out the freshly-swapped container, so root height is still 0 here.
  }

  // Frame-loop hook: advance the diff's momentum glide AND repaint the diff once its container has laid
  // out to full height (root height goes 0 -> real a frame or two after the swap). Keeps frames live
  // until the layout settles, then stops so idle-quiescence holds.
  tickDiff(deltaTimeSeconds: number): boolean {
    if (!this.diff) return false;
    let live = this.diff.tickScrollMomentum(deltaTimeSeconds);
    const laidHeight = Number(this.diff.rootRenderable.height) || 0;
    if (laidHeight !== this.lastDiffLaidHeight) {
      this.lastDiffLaidHeight = laidHeight;
      this.diff.update(); // now at the real height -> renders the full window
      live = true; // keep frames coming until the height stabilizes
    }
    return live;
  }

  tickMarkdown(deltaTimeSeconds: number): boolean {
    return this.markdown?.tick(deltaTimeSeconds) ?? false;
  }

  dispose(): void {
    this.markdown?.dispose();
    this.diff?.dispose();
  }
}

export namespace EditorContentMount {
  export const $Class = $EditorContentMount;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
