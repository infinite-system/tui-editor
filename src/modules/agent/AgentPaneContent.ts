// The agent session as a PaneContent — the adapter that makes an AgentSession a first-class occupant of
// the composable PanelHost. It owns the COMPOSER buffer and the pane's VIEW state (scroll position, the
// per-entry expand set, the spinner animator); the session below owns the transcript (single source of
// truth). None of this view state is a parallel history — the expand set holds entry INDICES, the scroll
// holds a line offset — so the renderer stays a pure projection.
//
// render() projects the transcript fresh each frame (AgentTranscriptProjection), windows it tail-anchored
// (auto-stick to newest unless the user scrolled up), and hands the already-windowed rows + spinner +
// composer to AgentPaneRenderer. handleKey() edits the composer AND scrolls (PageUp/Down always, arrows
// when the composer is empty); wheel + click route through onWheel/onPointerDown. renderRevision fuses the
// session pulse, composer edits, the spinner frame, and view-state bumps so all repaint through one frame
// effect.
//
// invariant: The agent pane is a PaneContent citizen, not a special case (src/modules/agent/agent.invariants.md)
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import type { StyledText, KeyEvent } from '@opentui/core';
import { computed, ref, watch, type Ref } from 'vue';
import type { PaneContent, PaneRenderContext } from '../ui/PaneContent';
import type { GlyphLevel } from '../theme/TerminalCapabilities';
import { AgentPaneRenderer, type SpinnerLine } from './AgentPaneRenderer';
import { AgentTranscriptProjection, type ProjectedLine } from './AgentTranscriptProjection';
import { AgentSpinner } from './AgentSpinner';
import { AgentSpinnerFrames } from './AgentSpinnerFrames';
import type { AgentSession } from './AgentSession';

/** A printable single character (no modifier, code ≥ 32, not DEL) — same test the editor input uses. */
function isTypedCharacter(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option) return false;
  const sequence = key.sequence;
  if (!sequence || sequence.length !== 1) return false;
  const code = sequence.charCodeAt(0);
  return code >= 32 && code !== 127;
}

class $AgentPaneContent implements PaneContent {
  readonly id = 'agent';
  readonly icon = '✦';

  private readonly composer = ref('');
  /** Fuses the session pulse, composer edits, the spinner frame, and view-state changes. */
  private readonly revision: Ref<number>;
  /** Bumped on scroll/collapse changes (which carry no session/composer change) so they repaint. */
  private readonly viewRevision = ref(0);
  /** The spinner animator — ticks only while the session is busy (idle quiescence at rest). */
  private readonly spinner = new AgentSpinner.Class();
  /** Stops the status→spinner watcher on dispose. */
  private readonly stopStatusWatch: () => void;

  /** Transcript indices the user has expanded (tool rows). Default (absent) = collapsed. View state,
   *  NOT a transcript copy. */
  private readonly expandedIndices = new Set<number>();
  /** True while the view auto-sticks to the newest line; false once the user scrolls up. */
  private stickToBottom = true;
  /** First visible line index while unstuck (absolute from the top of the projection). */
  private scrollTopLines = 0;

  /** Last render's geometry, so wheel/keys can clamp scroll without re-projecting. */
  private lastBodyHeight = 1;
  private lastTotalLines = 0;
  /** The pane height at last render, so caret() can pin the composer caret to the bottom row. */
  private lastHeight = 1;
  /** The body rows painted last frame (top-padded to bodyHeight) — the hit map for onPointerDown. */
  private lastBodyRows: readonly ProjectedLine[] = [];
  private lastGlyphLevel: GlyphLevel = 'unicode';

  constructor(private readonly session: AgentSession.Instance) {
    this.revision = computed(
      () =>
        this.session.renderRevision.value +
        this.composer.value.length +
        this.spinner.frame.value +
        this.viewRevision.value,
    );
    // The spinner ticks ONLY while busy: arm on the first busy status, tear down at idle/ended.
    this.stopStatusWatch = watch(
      () => this.session.busy,
      (busy) => {
        if (busy) this.spinner.start();
        else this.spinner.stop();
      },
      { immediate: true },
    );
  }

  /** Read-only access to the underlying session — so an additional PROJECTION of the same transcript
   *  (e.g. audio narration) can subscribe to the one source of truth without a second history. */
  get agentSession(): AgentSession.Instance {
    return this.session;
  }

  get title(): string {
    return this.session.busy ? 'Claude (working…)' : 'Claude';
  }

  get renderRevision(): Ref<number> {
    return this.revision;
  }

  /** True while the view auto-sticks to the newest line (drives the driving smoke's scroll assertion). */
  get stuckToBottom(): boolean {
    return this.stickToBottom;
  }

  /** How many transcript entries are currently expanded (drives the driving smoke's collapse assertion). */
  get expandedCount(): number {
    return this.expandedIndices.size;
  }

  render(context: PaneRenderContext): StyledText {
    this.lastHeight = context.height;
    this.lastGlyphLevel = context.glyphLevel;
    const busy = this.session.busy;
    const bodyHeight = Math.max(1, context.height - 1 - (busy ? 1 : 0)); // composer + (optional spinner)

    const lines = AgentTranscriptProjection.Class.project(
      this.session.transcript,
      context.palette,
      context.glyphLevel,
      context.width,
      this.expandedIndices,
    );
    this.lastBodyHeight = bodyHeight;
    this.lastTotalLines = lines.length;

    const firstLine = AgentTranscriptProjection.Class.firstVisibleLine(
      lines.length,
      bodyHeight,
      this.scrollTopLines,
      this.stickToBottom,
    );
    // Keep scrollTopLines coherent with the resolved window, so a later wheel step continues smoothly.
    this.scrollTopLines = firstLine;

    const visible = lines.slice(firstLine, firstLine + bodyHeight);
    // Tail-anchor: a short transcript pads with blank lines at the TOP so newest sits above the composer.
    const bodyRows: ProjectedLine[] = [];
    for (let blank = visible.length; blank < bodyHeight; blank += 1)
      bodyRows.push({ text: '', color: context.palette.fg, bold: false, entryIndex: -1, toggleable: false });
    for (const line of visible) bodyRows.push(line);
    this.lastBodyRows = bodyRows;

    const spinner: SpinnerLine | null = busy
      ? {
          glyph: AgentSpinnerFrames.Class.glyphFor(this.spinner.frame.value, context.glyphLevel),
          label: AgentSpinnerFrames.Class.labelFor(this.session.status.value, this.runningToolName(), context.glyphLevel),
          color: context.palette.func,
        }
      : null;

    return AgentPaneRenderer.Class.render({
      palette: context.palette,
      bodyRows,
      spinner,
      composer: this.composer.value,
      focused: context.focused,
    });
  }

  /** The name of the tool whose result is still pending, for the "Running <tool>…" label. */
  private runningToolName(): string | null {
    const transcript = this.session.transcript;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const entry = transcript[index];
      if (entry?.role === 'tool-use') return entry.name;
      if (entry?.role === 'tool-result') return null;
    }
    return null;
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === 'return') {
      this.session.send(this.composer.value);
      this.composer.value = '';
      this.stickToBottom = true; // sending re-anchors to the newest output
      return true;
    }
    if (key.name === 'pageup') {
      this.scrollByRows(-(this.lastBodyHeight - 1));
      return true;
    }
    if (key.name === 'pagedown') {
      this.scrollByRows(this.lastBodyHeight - 1);
      return true;
    }
    // Arrow scroll only when the composer is empty, so typing/editing keeps the arrows.
    if (key.name === 'up' && this.composer.value.length === 0) {
      this.scrollByRows(-1);
      return true;
    }
    if (key.name === 'down' && this.composer.value.length === 0) {
      this.scrollByRows(1);
      return true;
    }
    if (key.name === 'backspace') {
      this.composer.value = this.composer.value.slice(0, -1);
      return true;
    }
    if (isTypedCharacter(key)) {
      this.composer.value += key.sequence;
      return true;
    }
    return false;
  }

  /** A wheel gesture over the pane — signed content rows (negative = up/older). */
  onWheel(rowDelta: number): boolean {
    this.scrollByRows(rowDelta);
    return true;
  }

  /** A pointer-down inside the pane at content-local (column, row): toggle a tool row's expand state. */
  onPointerDown(_column: number, row: number): boolean {
    const line = this.lastBodyRows[row];
    if (!line || !line.toggleable || line.entryIndex < 0) return false;
    if (this.expandedIndices.has(line.entryIndex)) this.expandedIndices.delete(line.entryIndex);
    else this.expandedIndices.add(line.entryIndex);
    this.viewRevision.value += 1;
    return true;
  }

  /** Move the scroll window by whole rows and re-resolve tail-anchoring, then request a repaint. */
  private scrollByRows(deltaRows: number): void {
    const maximumTop = Math.max(0, this.lastTotalLines - this.lastBodyHeight);
    const base = this.stickToBottom ? maximumTop : this.scrollTopLines;
    const next = Math.max(0, Math.min(base + deltaRows, maximumTop));
    this.scrollTopLines = next;
    this.stickToBottom = next >= maximumTop; // reaching the bottom re-arms auto-stick
    this.viewRevision.value += 1;
  }

  /** A paste into the composer: insert the text at the caret. Newlines collapse to spaces — the
   *  single-line composer sends on Enter, so a literal newline must never be stored (it would break
   *  the caret and could look like a pending send). */
  handlePaste(text: string): boolean {
    const flattened = text.replace(/\r\n?|\n/g, ' ');
    if (!flattened) return false;
    this.composer.value += flattened;
    return true;
  }

  caret(): { column: number; row: number } | null {
    // The composer sits on the last row, after the '❯ ' prompt (2 cells).
    return { column: 2 + [...this.composer.value].length, row: Math.max(0, this.lastHeight - 1) };
  }

  onResize(_columns: number, _rows: number): void {
    /* the transcript reflows purely from width at render time; nothing to push down a seam */
  }

  onFocus(): void {
    /* no focus-specific state; the composer caret follows context.focused */
  }

  onBlur(): void {
    /* no-op */
  }

  dispose(): void {
    this.stopStatusWatch();
    this.spinner.dispose();
    this.session.dispose();
  }
}

export namespace AgentPaneContent {
  export const $Class = $AgentPaneContent;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
