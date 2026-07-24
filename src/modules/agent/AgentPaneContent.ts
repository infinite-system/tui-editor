// The agent session as a PaneContent — the adapter that makes an AgentSession a first-class occupant of
// the composable PanelHost. It owns the pane's VIEW state (the multi-line COMPOSER, the per-entry expand
// set, the transcript text selection, the spinner animator); the session below owns the transcript
// (single source of truth). None of this view state is a parallel history.
//
// TWO TEXT SURFACES, ONE SEAM: the transcript (read-only) and the composer (editable) both wrap through
// the shared WrapText, select through the shared TextSelectionModel, and highlight per-row. They differ
// only in SCROLL: the transcript delegates to the shared ScrollableTextViewport engine (momentum +
// vertical scrollbar + tail-anchor) via an injected AgentScrollPort; the composer keeps its caret line
// visible within a small row cap. LAYOUT (top→bottom): transcript body (flexes) · spinner (while busy) ·
// composer (1..cap rows). render() reads port.scrollTop to window the transcript; the host maps screen
// cells to each surface's selection through this pane's region helpers.
//
// invariant: The agent pane is a PaneContent citizen, not a special case (src/modules/agent/agent.invariants.md)
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import type { StyledText, KeyEvent } from '@opentui/core';
import { computed, ref, watch, type Ref } from 'vue';
import type { PaneContent, PaneRenderContext } from '../ui/PaneContent';
import type { GlyphLevel } from '../theme/TerminalCapabilities';
import { ThemeIcons } from '../theme/ThemeIcons';
import { TextSelectionModel, type SelectionPoint } from '../ui/TextSelectionModel';
import { WrapText } from '../ui/WrapText';
import { Clipboard } from '../system/Clipboard';
import { AgentPaneRenderer, type SelectionRange } from './AgentPaneRenderer';
import { AgentTranscriptProjection, type ProjectedLine } from './AgentTranscriptProjection';
import { AgentComposer } from './AgentComposer';
import { AgentSpinner } from './AgentSpinner';
import { AgentThinkingIndicator, type ThinkingSegment } from './AgentThinkingIndicator';
import type { AgentSession } from './AgentSession';

/** Transcript gutter: blank columns of breathing room on the left and right of the canvas (airier). */
const TRANSCRIPT_PAD_LEFT = 2;
const TRANSCRIPT_PAD_RIGHT = 2;
/** Fixed chrome rows around the composer: 2 blank spacers above the frame + top rule + bottom rule +
 *  mode line + 1 blank bottom pad (breathing room above and below the composer canvas). */
const COMPOSER_CHROME_ROWS = 6;
/** How long each pending tool is shown before the waiting-note cycles to the next one. */
const WAITING_CYCLE_MILLISECONDS = 1500;

/** The scroll seam the transcript drives: the host binds this to a ScrollableTextViewport so the pane
 *  stays a pure model (no renderer dependency) while gaining momentum + smooth glide + a real scrollbar. */
export interface AgentScrollPort {
  /** The current first-visible content line (top of the window). */
  readonly scrollTop: number;
  /** True while tail-anchored to the newest content (drives the pane's stuck-to-bottom UX + smoke). */
  readonly stuckToBottom: boolean;
  /** Scroll by whole content rows (negative = up/older). Halts momentum then clamps (engine-owned). */
  scrollRowsBy(deltaRows: number): void;
  /** Re-anchor to the newest content (used when a new turn is sent). */
  scrollToBottom(): void;
}

/** The engine seam: the host binds this so the pane can show the current engine + cycle it (claude⇄codex)
 *  mid-session. cycle() swaps the backend behind the same AgentSession (transcript preserved) and writes
 *  the provider setting back; it returns false when it can't (busy, or only one engine available). */
export interface AgentEnginePort {
  /** The current provider label ('claude' | 'codex'), shown in the mode line. */
  readonly provider: string;
  /** True when there are ≥2 engines to switch between (else the segment is a passive label). */
  readonly canCycle: boolean;
  /** Switch to the next available engine; false if it could not (busy / nothing to switch to). */
  cycle(): boolean;
}

/** Which surface a pane-local row belongs to (for pointer/selection routing). */
export type AgentPaneRegion =
  | { readonly kind: 'transcript'; readonly localRow: number }
  | { readonly kind: 'composer'; readonly visibleRow: number }
  | { readonly kind: 'other' };

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

  /** The editable, wrapping, cap-scrolled composer (the second text surface). */
  private readonly composer = new AgentComposer.Class();
  /** Fuses the session pulse, composer edits, the spinner frame, and view-state changes. */
  private readonly revision: Ref<number>;
  /** Bumped on scroll/collapse/selection changes (which carry no session/composer change) so they repaint. */
  private readonly viewRevision = ref(0);
  /** The spinner animator — ticks only while the session is busy (idle quiescence at rest). */
  private readonly spinner = new AgentSpinner.Class();
  /** Stops the status→spinner watcher on dispose. */
  private readonly stopStatusWatch: () => void;
  /** True while the pane is actually painted (host-reported) — gates the spinner timer. */
  private readonly paneVisible = ref(false);

  /** Transcript indices the user has expanded (tool rows). Default (absent) = collapsed. View state. */
  private readonly expandedIndices = new Set<number>();
  /** The transcript text selection (read-only surface; shares the model with the composer's own). */
  private readonly transcriptSelection = new TextSelectionModel.Class();
  /** Per pending-tool start times (tool-use id → ms), for the waiting-note's per-call elapsed. */
  private readonly toolStartMilliseconds = new Map<string, number>();

  /** The shared scroll engine (bound by the host). Null until attached — then render tail-anchors. */
  private scrollPort: AgentScrollPort | null = null;
  /** The engine seam (bound by the host) — current provider + cycle. Null until attached. */
  private enginePort: AgentEnginePort | null = null;
  /** The mode-line engine segment's click region, resolved last render (for the click-to-cycle hit-test). */
  private lastEngineSegment: { row: number; startColumn: number; endColumn: number } | null = null;
  /** The permission-mode setting (bound by the host) — drives the mode line + Shift+Tab toggle. */
  private permissionMode: Ref<boolean> | null = null;

  /** Last render's geometry, so keys clamp scroll, the host reads the viewport extent, and pointer rows
   *  route to the right surface. */
  private lastBodyHeight = 1;
  private lastSpinnerRows = 0;
  private lastComposerRows = 1;
  /** Pane-local row where the composer's first visible line sits (below body + spinner + blank + rule). */
  private lastComposerStart = 3;
  private lastTotalLines = 0;
  private lastFirstLine = 0;
  private lastHeight = 1;
  private lastWidth = 0;
  /** The transcript body rows painted last frame (top-padded) — the hit map for onPointerDown. */
  private lastBodyRows: readonly ProjectedLine[] = [];
  /** The FULL projected transcript lines last frame — the source for reconstructing selected text. */
  private lastProjectedLines: readonly ProjectedLine[] = [];
  /** The composer caret cell (viewport-local) resolved last frame. */
  private lastCaret = { column: 2, row: 0 };
  private lastGlyphLevel: GlyphLevel = 'unicode';

  constructor(private readonly session: AgentSession.Instance) {
    // MONOTONIC fuse: read every repaint source, then return a strictly increasing counter. An
    // arithmetic SUM here could cancel (spinner-stop −1 + session-bump +1 = net 0 → a finished turn
    // stuck rendering "working…", the reviewed repaint bug); a recompute now ALWAYS yields a new value.
    // Reading composer TEXT (string identity), not its length, also kills same-length-edit cancels.
    let fuseCounter = 0;
    this.revision = computed(() => {
      void this.session.renderRevision.value;
      void this.composer.text.value;
      void this.spinner.frame.value;
      void this.spinner.running.value;
      void this.viewRevision.value;
      void this.permissionMode?.value;
      fuseCounter += 1;
      return fuseCounter;
    });
    // The spinner timer lives only while BUSY *AND VISIBLE*: a hidden pane awaiting a permission
    // (busy indefinitely) must not keep a 10 Hz timer alive — a resource lives only while observed
    // (the reviewed hidden-animation breach). Re-showing a busy pane re-arms it.
    this.stopStatusWatch = watch(
      () => this.session.busy && this.paneVisible.value,
      (shouldSpin) => {
        if (shouldSpin) this.spinner.start();
        else this.spinner.stop();
      },
      { immediate: true, flush: 'sync' }, // a timer gate must arm/disarm exactly on the flip
    );
  }

  /** The host reports whether this pane is actually on screen (panel visible AND the agent is a visible
   *  cell). Drives the spinner's busy∧visible gate. */
  setPaneVisible(visible: boolean): void {
    if (this.paneVisible.value !== visible) this.paneVisible.value = visible;
  }
  /** True while the spinner timer is armed (tests + the visibility-gate smoke read this). */
  get spinnerActive(): boolean {
    return this.spinner.running.value;
  }

  get agentSession(): AgentSession.Instance {
    return this.session;
  }
  get title(): string {
    return this.session.busy ? 'Claude (working…)' : 'Claude';
  }
  get renderRevision(): Ref<number> {
    return this.revision;
  }

  attachScrollPort(port: AgentScrollPort): void {
    this.scrollPort = port;
  }
  /** Bind the permission-mode setting (reactive) so the mode line reflects it and Shift+Tab toggles it. */
  attachPermissionMode(mode: Ref<boolean>): void {
    this.permissionMode = mode;
  }
  /** Bind the engine seam so the mode line shows the engine + click/Ctrl+E cycle it. */
  attachEnginePort(port: AgentEnginePort): void {
    this.enginePort = port;
  }
  /** The current engine label (for the frame dump / smoke), or '' when unbound. */
  get currentEngine(): string {
    return this.enginePort?.provider ?? '';
  }
  /** Cycle to the next engine (click or Ctrl+E); reveals the switch note. Returns whether it switched. */
  private cycleEngine(): boolean {
    if (!this.enginePort?.cycle()) return false;
    this.transcriptSelection.clear();
    this.scrollPort?.scrollToBottom(); // reveal the "switched to X" system note
    this.viewRevision.value += 1;
    return true;
  }

  /** The engine changed the scroll position (wheel/momentum/keys) — bump the reactive paint signal so
   *  the frame effect re-projects the window (the viewport's scrollTop is not itself reactive). */
  notifyScrolled(): void {
    this.viewRevision.value += 1;
  }

  /** Content rows the host feeds the viewport's extent() (drives scroll clamp + scrollbar geometry). */
  get contentLineCount(): number {
    return this.lastTotalLines;
  }
  /** Visible transcript body rows the host feeds the viewport's extent(). */
  get viewportRows(): number {
    return this.lastBodyHeight;
  }
  get expandedCount(): number {
    return this.expandedIndices.size;
  }
  /** True while the view auto-sticks to the newest line (from the engine; drives the scroll smoke). */
  get stuckToBottom(): boolean {
    return this.scrollPort?.stuckToBottom ?? true;
  }
  /** The current transcript scroll position (from the engine) — drives the momentum-glide smoke. */
  get scrollTop(): number {
    return this.scrollPort?.scrollTop ?? 0;
  }

  render(context: PaneRenderContext): StyledText {
    // A width change reflows both surfaces' wrap, so any selection's coords are stale — drop them.
    if (context.width !== this.lastWidth) {
      this.transcriptSelection.clear();
      this.composer.clearSelection();
    }
    this.lastHeight = context.height;
    this.lastWidth = context.width;
    this.lastGlyphLevel = context.glyphLevel;
    const busy = this.session.busy;

    // The animated thinking indicator (busy) + the calm waiting-note (≥1 pending tool). The note adds a
    // blank gap + its own row, so the indicator block is 1 or 3 rows.
    const thinking: ThinkingSegment[] | null = busy
      ? AgentThinkingIndicator.Class.compose({
          frameIndex: this.spinner.frame.value,
          elapsedSeconds: this.spinner.elapsedSeconds(),
          glyphLevel: context.glyphLevel,
          colorDepth: context.colorDepth,
          palette: context.palette,
        })
      : null;
    const waitingNote = busy ? this.composeWaitingNote(context) : null;
    const indicatorRows = busy ? (waitingNote ? 3 : 1) : 0;

    // Layout top→bottom: transcript body (flex, padded L/R) · thinking · [blank · note] · blank · blank ·
    // rule · composer (1..cap) · rule · mode line · blank(bottom pad). Chrome takes fixed rows; body flexes.
    // The composer is indented by the same left gutter, so it wraps to width − padLeft.
    const composerLayout = this.composer.layout(context.width - TRANSCRIPT_PAD_LEFT);
    const composerRows = composerLayout.rowCount;
    const bodyHeight = Math.max(1, context.height - COMPOSER_CHROME_ROWS - composerRows - indicatorRows);
    this.lastSpinnerRows = indicatorRows;
    this.lastComposerRows = composerRows;
    this.lastComposerStart = bodyHeight + indicatorRows + 3; // below body + indicator + 2 blanks + top rule

    // The transcript text wraps inside its L/R padding (the scrollbar column is already reserved by the
    // host via context.width).
    const textWidth = Math.max(1, context.width - TRANSCRIPT_PAD_LEFT - TRANSCRIPT_PAD_RIGHT);
    const lines = AgentTranscriptProjection.Class.project(
      this.session.transcript,
      context.palette,
      context.glyphLevel,
      textWidth,
      this.expandedIndices,
    );
    this.lastBodyHeight = bodyHeight;
    this.lastTotalLines = lines.length;
    this.lastProjectedLines = lines;

    // While tail-anchored, window at the FRESH maximum (this projection's own line count) — the engine's
    // scrollTop can lag one frame behind a synchronous whole-turn append (its extent reads the PREVIOUS
    // render's geometry), which would show the top of the log instead of the newest turn. Unstuck, honor
    // the engine's position clamped into the fresh range.
    const maximumTop = Math.max(0, lines.length - bodyHeight);
    const firstLine = this.scrollPort
      ? this.scrollPort.stuckToBottom
        ? maximumTop
        : Math.max(0, Math.min(this.scrollPort.scrollTop, maximumTop))
      : maximumTop;
    this.lastFirstLine = firstLine;

    const visible = lines.slice(firstLine, firstLine + bodyHeight);
    const padCount = Math.max(0, bodyHeight - visible.length);
    const bodyRows: ProjectedLine[] = [];
    for (let blank = 0; blank < padCount; blank += 1)
      bodyRows.push({ text: '', color: context.palette.fg, bold: false, entryIndex: -1, toggleable: false });
    for (const line of visible) bodyRows.push(line);
    this.lastBodyRows = bodyRows;

    const selectionRanges: (SelectionRange | null)[] = bodyRows.map((row, rowIndex) => {
      if (rowIndex < padCount) return null;
      const absoluteLine = firstLine + (rowIndex - padCount);
      return this.transcriptSelection.rangeForLine(absoluteLine, WrapText.Class.displayWidth(row.text));
    });

    // The rule is inset by the L/R gutter too (side margins → airier canvas).
    const ruleWidth = Math.max(1, context.width - TRANSCRIPT_PAD_LEFT - TRANSCRIPT_PAD_RIGHT);
    const rule = ThemeIcons.Class.agentTranscriptIconsFor(context.glyphLevel).rule.repeat(ruleWidth);

    // The composer caret sits on its last visible row inside the frame, shifted right by the left gutter.
    this.lastCaret = {
      column: TRANSCRIPT_PAD_LEFT + composerLayout.caretColumn,
      row: this.lastComposerStart + composerLayout.caretRow,
    };

    const modeLineRow = this.lastComposerStart + composerLayout.rowCount + 1; // below composer + bottom rule
    return AgentPaneRenderer.Class.render({
      palette: context.palette,
      padLeft: TRANSCRIPT_PAD_LEFT,
      bodyRows,
      selectionRanges,
      thinking,
      waitingNote,
      rule,
      composer: composerLayout.rows,
      modeLine: this.modeLineSegments(context, modeLineRow),
      focused: context.focused,
    });
  }

  /** The mode line: an ENGINE segment (claude⇄codex, click / Ctrl+E cycles) followed by the PERMISSION
   *  segment ("⏵⏵ bypass permissions on" ↔ "? ask permissions", Shift+Tab cycles). Records the engine
   *  segment's cell range so onPointerDown can hit-test a click on it. */
  private modeLineSegments(context: PaneRenderContext, modeLineRow: number): ThinkingSegment[] {
    const bypass = this.permissionMode?.value ?? false;
    const arrow = context.glyphLevel === 'ascii' ? '>>' : '⏵⏵';
    const askSupported = this.session.permissionPromptsSupported;
    const permissionText = bypass
      ? `${arrow} bypass permissions on`
      : askSupported
        ? '? ask permissions'
        : 'bypass permissions off (prompts unavailable on this backend)';

    const segments: ThinkingSegment[] = [{ text: ' '.repeat(TRANSCRIPT_PAD_LEFT), color: context.palette.dim, bold: false }];
    // Engine segment (only when bound). The cycle affordance shows when >1 engine is switchable.
    this.lastEngineSegment = null;
    if (this.enginePort) {
      const cyclable = this.enginePort.canCycle;
      const cycleGlyph = cyclable ? (context.glyphLevel === 'ascii' ? ' <->' : ' ⇄') : '';
      const engineText = `engine: ${this.enginePort.provider}${cycleGlyph}`;
      const startColumn = TRANSCRIPT_PAD_LEFT;
      const endColumn = startColumn + Array.from(engineText).length;
      this.lastEngineSegment = { row: modeLineRow, startColumn, endColumn };
      segments.push({ text: engineText, color: cyclable ? context.palette.accent : context.palette.dim, bold: cyclable });
      segments.push({ text: '  ·  ', color: context.palette.dim, bold: false });
    }
    segments.push({
      text: permissionText,
      color: bypass ? context.palette.accent : askSupported ? context.palette.info : context.palette.dim,
      bold: bypass,
    });
    const hint = this.enginePort?.canCycle ? '  (shift+tab · ctrl+e)' : '  (shift+tab to cycle)';
    segments.push({ text: hint, color: context.palette.dim, bold: false });
    return segments;
  }

  /** Pending tool calls = tool-use entries with no matching tool-result yet, in emission order.
   *  Derived PURELY from the transcript (real session state) — no invented flags. */
  private pendingTools(): { id: string; name: string }[] {
    const pending = new Map<string, string>();
    for (const entry of this.session.transcript) {
      if (entry.role === 'tool-use') pending.set(entry.id, entry.name);
      else if (entry.role === 'tool-result') pending.delete(entry.id);
    }
    return [...pending].map(([id, name]) => ({ id, name }));
  }

  /** Compose the calm waiting-note: CYCLE through the pending tools (~1.5s each), each with its own
   *  elapsed time (tracked from when its tool-use first appeared), with a gentle pulse on switch. */
  private composeWaitingNote(context: PaneRenderContext): ThinkingSegment[] | null {
    const pending = this.pendingTools();
    const now = this.spinner.nowMilliseconds();
    // Track per-tool start times; add newcomers, prune resolved ones (so elapsed is per-call, honest).
    const liveIds = new Set(pending.map((tool) => tool.id));
    for (const id of [...this.toolStartMilliseconds.keys()]) if (!liveIds.has(id)) this.toolStartMilliseconds.delete(id);
    for (const tool of pending) if (!this.toolStartMilliseconds.has(tool.id)) this.toolStartMilliseconds.set(tool.id, now);
    if (pending.length === 0) return null;

    const cycleIndex = Math.floor(now / WAITING_CYCLE_MILLISECONDS) % pending.length;
    const active = pending[cycleIndex]!;
    const startMilliseconds = this.toolStartMilliseconds.get(active.id) ?? now;
    const elapsedSeconds = Math.max(0, Math.floor((now - startMilliseconds) / 1000));
    // Pulse for the first ~300ms of each cycle window (the switch moment), only when there is >1 to cycle.
    const highlight = pending.length > 1 && now % WAITING_CYCLE_MILLISECONDS < 300;
    return AgentThinkingIndicator.Class.composeWaitingNote({
      toolName: active.name,
      elapsedSeconds,
      pendingCount: pending.length,
      highlight,
      glyphLevel: context.glyphLevel,
      palette: context.palette,
    });
  }

  handleKey(key: KeyEvent): boolean {
    // Shift+Tab cycles the permission mode (a boolean → on↔off); the mode line updates live.
    if ((key.name === 'tab' && key.shift) || key.name === 'backtab') {
      if (this.permissionMode) {
        this.permissionMode.value = !this.permissionMode.value;
        this.viewRevision.value += 1;
      }
      return true;
    }
    // Ctrl+E cycles the engine (claude ⇄ codex), swapping the backend behind the same transcript. No-op
    // while busy (the session guards the swap) — so it never disrupts an in-flight turn.
    if (key.ctrl && !key.meta && !key.option && key.name === 'e') {
      this.cycleEngine();
      return true;
    }
    // A PENDING PERMISSION owns the keyboard: y = allow · a = always-allow (session) · n / Escape =
    // deny. Scroll keys (PageUp/Down) stay live so the user can review context; every other key is
    // swallowed while the prompt is up (the composer is suspended — no accidental typing answers it).
    const pendingPermission = this.session.pendingPermission;
    if (pendingPermission) {
      if (key.name === 'pageup') {
        this.scrollPort?.scrollRowsBy(-(this.lastBodyHeight - 1));
        return true;
      }
      if (key.name === 'pagedown') {
        this.scrollPort?.scrollRowsBy(this.lastBodyHeight - 1);
        return true;
      }
      if (!key.ctrl && !key.meta && !key.option && !key.super) {
        if (key.name === 'y') {
          this.session.respondToPermission(pendingPermission.id, 'allow');
          return true;
        }
        if (key.name === 'a') {
          this.session.respondToPermission(pendingPermission.id, 'always-allow');
          return true;
        }
        if (key.name === 'n' || key.name === 'escape') {
          this.session.respondToPermission(pendingPermission.id, 'deny');
          return true;
        }
      }
      return true; // swallow everything else while the prompt is up
    }
    if (key.name === 'return') {
      // Clear the draft ONLY when the session accepted it — Enter while busy must keep the follow-up
      // draft intact (unconditional clearing destroyed it, the reviewed data loss).
      if (this.session.send(this.composer.value)) {
        this.composer.clear();
        this.transcriptSelection.clear();
        this.scrollPort?.scrollToBottom(); // sending re-anchors to the newest output
      }
      return true;
    }
    // Transcript paging always works (the composer keeps the arrow keys for cursor motion).
    if (key.name === 'pageup') {
      this.scrollPort?.scrollRowsBy(-(this.lastBodyHeight - 1));
      return true;
    }
    if (key.name === 'pagedown') {
      this.scrollPort?.scrollRowsBy(this.lastBodyHeight - 1);
      return true;
    }
    // Alt/Option/Ctrl → move by WORD (mac overlay uses Option); super/Cmd → jump to line start/end.
    const byWord = key.ctrl || key.option || key.meta;
    if (key.name === 'left') {
      if (key.super) this.composer.moveHome();
      else if (byWord) this.composer.moveWordLeft();
      else this.composer.moveLeft();
      return this.composerHandled();
    }
    if (key.name === 'right') {
      if (key.super) this.composer.moveEnd();
      else if (byWord) this.composer.moveWordRight();
      else this.composer.moveRight();
      return this.composerHandled();
    }
    if (key.name === 'home') {
      this.composer.moveHome();
      return this.composerHandled();
    }
    if (key.name === 'end') {
      this.composer.moveEnd();
      return this.composerHandled();
    }
    // Up/Down move the composer cursor between its visual lines; at the first/last line they fall
    // through to transcript scroll (an empty single-line composer therefore scrolls, as before).
    if (key.name === 'up') {
      if (this.composer.moveUp()) return this.composerHandled();
      this.scrollPort?.scrollRowsBy(-1);
      return true;
    }
    if (key.name === 'down') {
      if (this.composer.moveDown()) return this.composerHandled();
      this.scrollPort?.scrollRowsBy(1);
      return true;
    }
    if (key.name === 'backspace') {
      // Ctrl/Cmd+Backspace clears the whole line; Alt/Option+Backspace deletes the word BEFORE the
      // cursor; plain Backspace deletes the grapheme before the cursor.
      if (key.ctrl || key.super) this.composer.deleteLine();
      else if (key.option || key.meta) this.composer.deletePreviousWord();
      else this.composer.backspace();
      return this.composerHandled();
    }
    if (key.name === 'delete') {
      this.composer.deleteForward();
      return this.composerHandled();
    }
    if (isTypedCharacter(key)) {
      this.composer.insert(key.sequence);
      return this.composerHandled();
    }
    return false;
  }

  /** A composer edit/motion happened: bump the paint signal (a cursor-only move changes no observed ref,
   *  so the caret would not repaint otherwise) and report the key handled. */
  private composerHandled(): boolean {
    this.viewRevision.value += 1;
    return true;
  }

  /** A pointer-down inside the pane at content-local (column, row): click the mode-line ENGINE segment to
   *  cycle engines, or toggle a tool row's expand state. Called by the host for a BARE click in the
   *  transcript region AND for any click on the inert 'other' rows (so the mode-line segment is reachable). */
  onPointerDown(column: number, row: number): boolean {
    const engine = this.lastEngineSegment;
    if (engine && this.enginePort?.canCycle && row === engine.row && column >= engine.startColumn && column < engine.endColumn) {
      return this.cycleEngine();
    }
    const line = this.lastBodyRows[row];
    if (!line || !line.toggleable || line.entryIndex < 0) return false;
    if (this.expandedIndices.has(line.entryIndex)) this.expandedIndices.delete(line.entryIndex);
    else this.expandedIndices.add(line.entryIndex);
    this.transcriptSelection.clear(); // expand/collapse reflows lines, invalidating selection coords
    this.viewRevision.value += 1;
    return true;
  }

  // --- region routing + selection (host maps screen cells; this pane owns the models) ----------------

  /** Which surface a pane-local row (0 at the pane's top) belongs to. Rows outside the transcript body
   *  and composer input (spinner, blank, rules, mode line) are inert 'other'. */
  regionAtRow(localRow: number): AgentPaneRegion {
    if (localRow < this.lastBodyHeight) return { kind: 'transcript', localRow };
    const composerEnd = this.lastComposerStart + this.lastComposerRows;
    if (localRow >= this.lastComposerStart && localRow < composerEnd) {
      return { kind: 'composer', visibleRow: localRow - this.lastComposerStart };
    }
    return { kind: 'other' };
  }

  /** Map a transcript-region local row to an absolute projected-line index (clamped). */
  private transcriptLineAtRow(localRow: number): number {
    const visibleCount = Math.min(this.lastBodyHeight, Math.max(0, this.lastTotalLines - this.lastFirstLine));
    const padCount = Math.max(0, this.lastBodyHeight - visibleCount);
    const absolute = this.lastFirstLine + (localRow - padCount);
    return Math.max(0, Math.min(absolute, Math.max(0, this.lastTotalLines - 1)));
  }

  // Transcript selection (driven by the ScrollableTextViewport drag through the host). The transcript
  // text is inset by TRANSCRIPT_PAD_LEFT, so the pointer column subtracts that gutter.
  transcriptPointAt(localColumn: number, localRow: number): SelectionPoint {
    return { line: this.transcriptLineAtRow(localRow), column: Math.max(0, localColumn - TRANSCRIPT_PAD_LEFT) };
  }
  beginTranscriptSelection(point: SelectionPoint): void {
    this.composer.clearSelection();
    this.transcriptSelection.begin(point);
    this.viewRevision.value += 1;
  }
  extendTranscriptSelection(point: SelectionPoint): void {
    this.transcriptSelection.extend(point);
    this.viewRevision.value += 1;
  }
  finishTranscriptSelection(): void {
    this.transcriptSelection.finish();
    this.viewRevision.value += 1;
  }
  transcriptLineGraphemeCount(lineIndex: number): number {
    // DISPLAY cells (the drag's inclusive-head clamp works in the pointer's own unit).
    return WrapText.Class.displayWidth(this.lastProjectedLines[lineIndex]?.text ?? '');
  }

  // Composer selection (a small manual drag through the host — no momentum/edge-autoscroll). The composer
  // is inset by the left gutter too, so the pointer column subtracts it before mapping into composer space.
  composerPointAt(localColumn: number, visibleRow: number): SelectionPoint {
    return this.composer.pointAt(localColumn - TRANSCRIPT_PAD_LEFT, visibleRow);
  }
  beginComposerSelection(point: SelectionPoint): void {
    this.transcriptSelection.clear();
    this.composer.beginSelection(point);
    this.viewRevision.value += 1;
  }
  extendComposerSelection(point: SelectionPoint): void {
    this.composer.extendSelection(point);
    this.viewRevision.value += 1;
  }
  finishComposerSelection(): void {
    this.composer.finishSelection();
    this.viewRevision.value += 1;
  }

  /** True when either surface holds a non-empty selection (routes Ctrl+C / Cmd+C to it). */
  hasSelection(): boolean {
    return this.composer.hasSelection() || this.transcriptSelection.hasSelection();
  }
  /** Copy whichever surface has a selection (composer wins when both, but only one is ever set at a
   *  time). Resolves to the character count copied — the observable proof channel. */
  async copySelection(): Promise<number> {
    if (this.composer.hasSelection()) return this.composer.copySelection();
    if (!this.transcriptSelection.hasSelection()) return 0;
    // Surface-owned reconstruction: transcript rows are separate visual lines joined with newlines;
    // each line slice is grapheme-safe over DISPLAY cells through the shared WrapText slicer.
    const text = this.transcriptSelection.selectedText((line, startCell, endCell) => {
      const rowText = this.lastProjectedLines[line]?.text;
      if (rowText === undefined) return null;
      return WrapText.Class.sliceByDisplayCells(rowText, startCell, endCell ?? Number.MAX_SAFE_INTEGER);
    }, '\n');
    if (!text) return 0;
    await Clipboard.Class.copy(text);
    return text.length;
  }
  /** Drop any selection on either surface. */
  clearSelection(): void {
    const cleared = this.transcriptSelection.clear();
    const composerCleared = this.composer.clearSelection();
    if (cleared || composerCleared) this.viewRevision.value += 1;
  }

  /** A paste into the composer: insert at the caret (newlines flatten to spaces). */
  handlePaste(text: string): boolean {
    if (!text) return false;
    this.composer.insert(text);
    return true;
  }

  caret(): { column: number; row: number } | null {
    return { column: this.lastCaret.column, row: Math.max(0, Math.min(this.lastCaret.row, this.lastHeight - 1)) };
  }

  onResize(_columns: number, _rows: number): void {
    /* the surfaces reflow purely from width at render time; nothing to push down a seam */
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
