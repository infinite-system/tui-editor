// The LSP hover card: a pane CONTROLLER that OWNS its renderables (a bordered box, a text body, and
// a vertical scrollbar) plus the dwell + async + layout state. VS-Code-style — the pointer must
// DWELL on ONE document position for HOVER_DWELL_SECONDS before the card shows the language server's
// type/documentation for that symbol. The card is display-only over the panes (like a tooltip it
// never intercepts the clicks/keys that drive the code beneath) EXCEPT that its own box receives its
// own vertical scroll so long content is reachable. This is the StatusBar/OverlayLayer idiom (a
// Reactive class holding plain renderable fields), instantiated `new HoverCard.Class(deps)`.
//
// invariant: A hover card reflects the language server's type at the pointed symbol (src/modules/ui/ui.invariants.md)
import {
  BoxRenderable,
  StyledText,
  fg,
  type MouseEvent,
  type TextChunk,
  type CliRenderer,
} from '@opentui/core';
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { HitTransparentText } from './HitTransparentText';
import { SelectableText } from './SelectableText';
import { ScrollableTextViewport } from './ScrollableTextViewport';
import { Clipboard } from '../system/Clipboard';
import { Highlighter, type LangId, type Role } from '../syntax/Highlighter';
import type { Palette } from '../theme/ThemePalettes';
import type { Theme } from '../theme/Theme';
import type { Settings } from '../settings/Settings';
import type { LanguageHover, TextPosition, TextRange } from '../lsp/LanguageClient';

/** The pointer must rest on ONE document position this long before the card shows (VS Code uses ~0.5s). */
export const HOVER_DWELL_SECONDS = 0.5;
/** Grace after the pointer leaves the TRIGGER symbol but has NOT yet entered the card — short, so a
 *  card you're moving away from dismisses promptly (VS Code feel), yet long enough to cross the one
 *  row onto the adjacent card when you ARE heading for it. */
export const HOVER_SYMBOL_OFF_DISMISS_SECONDS = 0.5;
/** Grace after the pointer leaves the CARD, once it has been entered — longer, because you were
 *  actively reading/scrolling it and a brief drift off its edge should not yank it away. */
export const HOVER_IDLE_DISMISS_SECONDS = 2.5;
/** Largest interior COLUMN count the card shows at once; wider content scrolls under a horizontal
 *  scrollbar (content is no longer truncated — the full line is reachable by scrolling). */
const MAX_CARD_COLUMNS = 64;
/** Largest interior row count the card renders before the vertical scrollbar takes over. */
const MAX_CARD_ROWS = 16;
/** Columns to nudge the card RIGHT of the pointed cell so the mouse cursor doesn't sit over the
 *  card's left edge when it opens just below the symbol (a small breathing gap, VS Code-like). */
const ANCHOR_OFFSET_COLUMNS = 2;

export interface HoverCardDeps {
  renderer: CliRenderer;
  theme: Theme.Instance;
  /** Scroll feel + scrollbar thickness come from the one settings source (via ScrollableTextViewport). */
  settings: Settings.Instance;
  /** Resolve the language server's hover for a document position (Workspace.hoverAt). */
  requestHover: (position: TextPosition) => Promise<LanguageHover | null>;
  /** The syntax language of the active document — colours a fenced code block with no explicit tag. */
  languageForActive: () => LangId;
}

/** Map a syntax role to its palette colour (mirrors EditorPaneRenderer.roleColor so the fenced code
 *  in a hover card reads with the SAME colours as the editor). */
function roleColor(role: Role, palette: Palette): string {
  switch (role) {
    case 'keyword': return palette.keyword;
    case 'string': return palette.string;
    case 'number': return palette.number;
    case 'comment': return palette.comment;
    case 'func': return palette.func;
    case 'type': return palette.type;
    case 'operator': return palette.operator;
    case 'added': return palette.added;
    case 'removed': return palette.deleted;
    default: return palette.fg;
  }
}

/** Fenced-code tags the markdown may carry, mapped to the highlighter's language ids. */
const FENCE_LANGUAGE: Record<string, LangId> = {
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  javascript: 'javascript', js: 'javascript', jsx: 'javascript',
  json: 'json', markdown: 'markdown', md: 'markdown', diff: 'diff',
};

class $HoverCard {
  // Display state — plain (non-reactive) fields, the Tooltip/StatusBar idiom.
  private visible = false;
  /** Rendered content lines (each a list of styled chunks), the window of which is painted each frame. */
  private contentLines: TextChunk[][] = [];
  /** The plain text of each content line (chunk texts joined) — the source for a copied selection. */
  private contentPlain: string[] = [];
  private rawContents: string | null = null;
  private contentMaxWidth = 0;
  /** The screen CELL of the pointed symbol the card anchors to (placed below, flipping above). */
  private anchorX = 0;
  private anchorY = 0;
  /** Interior column count painted this frame (the horizontal viewport width) — the drag/select map. */
  private interiorColumns = 1;
  private dwellSeconds = 0;
  /** The dwell in progress (null when the pointer is off the code); key = `line:column`. A dwell can
   *  run WHILE a card is shown (a new symbol under it) — the shown card persists until this dwell lands
   *  a hover to replace it. Carries the anchor to apply only when it does. */
  private pending: { position: TextPosition; key: string; anchorX: number; anchorY: number } | null = null;
  /** The document range the SHOWN hover covers (the symbol's extent, from the server). While the
   *  pointer roams anywhere inside it the SAME card stays — moving within a symbol must not re-dwell. */
  private shownRange: TextRange | null = null;
  /** Bumped on every NEW dwell — an async hover response whose captured generation no longer matches
   *  is stale (the pointer moved) and is dropped. */
  private generation = 0;
  /** The generation whose hover has already been requested — each dwell fires the async EXACTLY once. */
  private requestedGeneration = -1;
  /** True while the pointer is over the card's own box (so moving in to scroll never dismisses it). */
  pointerOverCard = false;
  /** True while the pointer rests on the card's own symbol (kept engaged while re-pointing the same key). */
  private onSymbol = false;
  /** Grace elapsed since the pointer left BOTH the symbol and the card (drives the idle auto-dismiss). */
  private idleSeconds = 0;
  /** True once the pointer has entered the card at least once — selects the LONGER leave-grace (you
   *  were reading it) versus the SHORTER grace for a card you never touched (you're moving away). */
  private cardWasEntered = false;
  /** The card's text selection in ABSOLUTE content coordinates (row = index into contentLines, column
   *  = display cell). Null ends when the pointer drags off with no span. Anchor is where the drag began,
   *  focus tracks the pointer — normalized only when the selection is read/painted. */
  private selectionAnchor: { row: number; column: number } | null = null;
  private selectionFocus: { row: number; column: number } | null = null;

  /**
   * The ONE reactive signal on this otherwise-plain controller: the frame paint effect observes it so
   * a display change re-projects the renderables. The card can turn visible from an ASYNC hover
   * response (no keypress/mouse-move to piggyback on), and `update()` runs only inside `paint()`; this
   * ref makes that async transition trigger a paint, exactly as `Tooltip.visible` does for the tooltip.
   */
  get paintRevision() {
    return ref(0);
  }

  // Owned renderables (constructed + mounted here).
  private readonly backdrop: HitTransparentText;
  private readonly box: BoxRenderable;
  private readonly content: SelectableText;
  /** The unified scroll surface — momentum, wheel (incl. alt→horizontal), both scrollbars (thickness
   *  from Settings), and drag-select with edge autoscroll. The card is a thin adapter over it, owning
   *  only its content windowing + selection MODEL. invariant: A scrollable text surface is
   *  drag-selectable with edge auto-scroll (src/modules/ui/ui.invariants.md) */
  private readonly viewport: ScrollableTextViewport.Instance;

  constructor(private readonly deps: HoverCardDeps) {
    const { renderer } = deps;
    const root = renderer.root;
    // A full-screen, GENUINELY hit-transparent, non-drawing backdrop visible exactly while the card is.
    // OpenTUI composites incrementally: hiding a small overlay does NOT repaint the panes beneath, so a
    // dismiss with no other change would leave the card's glyphs stale. A full-screen renderable
    // toggling visible→false invalidates the WHOLE screen, forcing a full repaint that clears the card.
    // It MUST be hit-transparent (HitTransparentText masks addToHitGrid) so the pointer passes THROUGH
    // it to the editor beneath — otherwise a plain BoxRenderable captures every wheel/move and the card
    // traps the doc: you couldn't scroll the code or hover a different symbol while a card was open.
    this.backdrop = new HitTransparentText(renderer, {
      id: 'hover-card-backdrop', content: '', position: 'absolute', left: 0, top: 0,
      width: '100%', height: '100%', visible: false, zIndex: 134, selectable: false,
    });
    root.add(this.backdrop);
    this.box = new BoxRenderable(renderer, {
      id: 'hover-card', position: 'absolute', border: true, borderStyle: 'rounded',
      flexDirection: 'column', visible: false, zIndex: 135,
    });
    this.content = new SelectableText(renderer, { id: 'hover-card-content', content: '', selectable: true });
    this.box.add(this.content);
    // The card composes the ONE scroll surface: momentum + wheel (incl. alt→horizontal) + both bars
    // (thickness from Settings) + drag-select with edge autoscroll. The card supplies only its IDENTITY
    // — content extent, bar colours, and its own selection MODEL + cell↔content mapping.
    this.viewport = new ScrollableTextViewport.Class({
      renderer,
      settings: deps.settings,
      parent: this.box,
      id: 'hover-card',
      extent: () => ({
        contentRows: this.contentLines.length,
        contentColumns: this.contentMaxWidth,
        viewportRows: this.viewportRows(),
        viewportColumns: this.viewportColumns(),
      }),
      // Track blends with the card bg (kills the black half-block lines); thumb is a subtle dim grey.
      colors: () => ({ track: deps.theme.palette.panel, thumb: deps.theme.palette.dim }),
      onScroll: () => this.requestPaint(),
      selection: {
        positionAtCell: (screenColumn, screenRow) => this.contentPositionAtCell(screenColumn, screenRow),
        viewportRectangle: () => ({
          leftColumn: this.content.x,
          rightColumn: this.content.x + Math.max(1, this.interiorColumns) - 1,
          topRow: this.content.y,
          bottomRow: this.content.y + Math.max(1, this.viewportRows()) - 1,
        }),
        begin: (position) => {
          this.selectionAnchor = { row: position.line, column: position.column };
          this.selectionFocus = { row: position.line, column: position.column };
          this.requestPaint();
        },
        extend: (position) => {
          this.selectionFocus = { row: position.line, column: position.column };
          this.requestPaint();
        },
        finish: () => {
          // A bare click (anchor === focus) leaves no span: drop it so update() paints no highlight.
          if (this.selectionAnchor && this.selectionFocus
            && this.selectionAnchor.row === this.selectionFocus.row
            && this.selectionAnchor.column === this.selectionFocus.column) {
            this.selectionAnchor = null;
            this.selectionFocus = null;
          }
          this.requestPaint();
        },
      },
    });
    root.add(this.box);

    // The card receives its OWN pointer: moving into it (to scroll/select) must NOT dismiss it, and a
    // wheel over it scrolls the content (through the viewport). It never touches the editor's cursor.
    this.box.onMouseMove = () => { this.pointerOverCard = true; this.cardWasEntered = true; this.idleSeconds = 0; };
    this.box.onMouseOut = () => { this.pointerOverCard = false; this.idleSeconds = 0; this.requestPaint(); };
    this.box.onMouseScroll = (event: MouseEvent) => this.viewport.handleWheel(event);
    this.content.onMouseDown = (event: MouseEvent) => { this.pointerOverCard = true; this.cardWasEntered = true; this.viewport.beginDrag(event.x, event.y); };
    this.content.onMouseDrag = (event: MouseEvent) => this.viewport.dragTo(event.x, event.y);
    this.content.onMouseUp = () => this.viewport.endDrag();
    this.content.onMouseDragEnd = () => this.viewport.endDrag();
  }

  /** Map a screen cell to an ABSOLUTE content position (row into contentLines, display column). Rows
   *  outside the painted window clamp to the content extent so an edge drag still resolves a position. */
  private contentPositionAtCell(screenColumn: number, screenRow: number): { line: number; column: number } | null {
    if (!this.visible || this.contentLines.length === 0) return null;
    const start = Math.max(0, Math.min(this.viewport.scrollTop, this.maximumScrollTop()));
    const row = Math.max(0, Math.min(start + (screenRow - this.content.y), this.contentLines.length - 1));
    const column = Math.max(0, this.viewport.scrollLeft + (screenColumn - this.content.x));
    return { line: row, column };
  }

  /** Bump the reactive paint signal AND request a render — a display change that no keypress/mouse
   *  event accompanies (the async hover landing, a scroll) must still re-project the renderables. */
  private requestPaint(): void {
    this.paintRevision.value += 1;
    this.deps.renderer.requestRender();
  }

  /** Interior rows the card can show at once (bounded by MAX_CARD_ROWS and the screen). */
  private maxInteriorRows(): number {
    return Math.max(1, Math.min(MAX_CARD_ROWS, this.deps.renderer.height - 4));
  }
  private viewportRows(): number {
    return Math.max(1, Math.min(this.contentLines.length, this.maxInteriorRows()));
  }
  private maximumScrollTop(): number {
    return Math.max(0, this.contentLines.length - this.viewportRows());
  }
  /** Interior columns the card can show at once (bounded by MAX_CARD_COLUMNS and the screen). */
  private maxInteriorColumns(): number {
    return Math.max(1, Math.min(MAX_CARD_COLUMNS, this.deps.renderer.width - 4));
  }
  private viewportColumns(): number {
    return Math.max(1, Math.min(this.contentMaxWidth, this.maxInteriorColumns()));
  }
  private maximumScrollLeft(): number {
    return Math.max(0, this.contentMaxWidth - this.viewportColumns());
  }
  /** True when a document position falls within a hover's range (inclusive), so roaming the symbol keeps the card. */
  private positionInRange(position: TextPosition, range: TextRange): boolean {
    const afterStart = position.line > range.start.line
      || (position.line === range.start.line && position.column >= range.start.column);
    const beforeEnd = position.line < range.end.line
      || (position.line === range.end.line && position.column <= range.end.column);
    return afterStart && beforeEnd;
  }

  /**
   * The pointer is over a document CELL. Pointing at the SAME position keeps the accumulated dwell
   * (pointer jitter within one cell must not reset the timer) and tracks the anchor; a DIFFERENT
   * position bumps the generation, hides any shown card, and restarts the dwell for the new symbol.
   */
  pointAt(position: TextPosition, screenX: number, screenY: number): void {
    // The pointer is on a symbol → engaged; reset the idle grace either way.
    this.onSymbol = true;
    this.idleSeconds = 0;
    // While a card is SHOWN, roaming anywhere within the symbol's own range keeps it (VS Code): the
    // card stays put and never re-dwells, so a small move over the same identifier can't hide it.
    if (this.visible && this.shownRange && this.positionInRange(position, this.shownRange)) {
      return;
    }
    const key = `${position.line}:${position.column}`;
    if (this.pending && this.pending.key === key) {
      this.pending.anchorX = screenX;
      this.pending.anchorY = screenY;
      return;
    }
    // A NEW symbol: start a fresh dwell but do NOT hide any shown card — it persists (so a slow move
    // from the trigger toward the card, crossing other tokens, never blanks it) until this dwell lands
    // a hover to REPLACE it, or the pointer leaves everything and the idle grace dismisses it. The new
    // anchor is carried on `pending` and applied only when the replacement actually shows.
    this.generation += 1;
    this.dwellSeconds = 0;
    this.requestedGeneration = -1;
    this.pending = { position, key, anchorX: screenX, anchorY: screenY };
    this.requestPaint();
  }

  /** The pointer moved off the symbol (to an empty cell / out of the code) without a hard dismiss: a
   *  shown card is NOT killed immediately — it enters the idle grace and auto-dismisses if the pointer
   *  does not return to it or another symbol. A card that isn't showing yet just disarms its dwell. */
  pointerOffSymbol(): void {
    this.onSymbol = false;
    // Moving off any symbol disarms a not-yet-shown dwell (a card only appears if you actually rest ON
    // a symbol). A card that IS shown persists into its idle grace instead of being killed here.
    this.pending = null;
    this.dwellSeconds = 0;
    if (this.visible) {
      // Start the grace FRESH from the moment the pointer leaves the symbol — the frame loop was
      // quiescing while the pointer rested on the symbol (tick returned false), so idleSeconds must
      // reset here rather than inherit stale accumulation.
      this.idleSeconds = 0;
      this.requestPaint(); // kick the frame loop so tick() can run the idle countdown
    }
  }

  /** Any disqualifying input (a click, a keypress, a doc scroll): hide now and disarm the dwell. */
  clear(): void {
    this.pending = null;
    this.dwellSeconds = 0;
    this.pointerOverCard = false;
    this.onSymbol = false;
    this.idleSeconds = 0;
    this.cardWasEntered = false;
    this.shownRange = null;
    this.viewport.endDrag();
    this.viewport.reset();
    this.selectionAnchor = null;
    this.selectionFocus = null;
    if (this.visible) {
      this.visible = false;
      // invariant: An overlay's dismissal clears its cells in the same frame (src/modules/ui/ui.invariants.md)
      // Hide the renderables IMMEDIATELY here — do NOT rely on a subsequent reactive update() call.
      // The show path runs while the dwell tick keeps frames coming, so update() re-runs each frame;
      // but once the card is shown the tick loop goes idle, so a dismiss (keypress/click) has no
      // active frame in which update() would run. Hiding the OpenTUI renderables here + a forced
      // paint makes the dismiss deterministic without the reactive round-trip.
      this.box.visible = false;
      this.viewport.hideBars();
      this.backdrop.visible = false;
      this.requestPaint();
    }
  }

  /**
   * Frame tick: advance the dwell; once it completes, fire the hover request EXACTLY once and show
   * the card when a non-empty response lands for the STILL-CURRENT dwell. Returns true while a dwell
   * is counting OR a request is in flight (the caller keeps frames coming — the momentum/auto-scroll
   * contract), and false once the card is shown or the dwell is disarmed.
   */
  tick(deltaSeconds: number): boolean {
    // The viewport advances momentum (a wheel glide keeps decaying) AND the selection drag's
    // edge-autoscroll, and keeps the card engaged (the pointer may be past the card's edge mid-drag).
    const dragging = this.viewport.dragActive;
    const viewportKeepAlive = this.viewport.tick(deltaSeconds);

    // Idle auto-dismiss for a SHOWN card: while the pointer is over the card / its symbol / dragging it
    // is engaged and the grace resets; when it leaves all three, count the grace and dismiss at the
    // limit (longer once the card was entered — you were reading it — than for one never touched).
    let idleCounting = false;
    if (this.visible) {
      if (this.pointerOverCard) {
        // The pointer is reading the card, not dwelling a symbol under it — abandon any pending swap.
        this.pending = null;
        this.dwellSeconds = 0;
      }
      if (this.pointerOverCard || this.onSymbol || dragging) {
        this.idleSeconds = 0;
      } else {
        // The demand-driven loop quiesces while the pointer rests engaged; the first tick after that has
        // a huge wall-clock delta, so clamp it or the grace would elapse in one frame.
        this.idleSeconds += Math.min(deltaSeconds, 0.1);
        const dismissLimit = this.cardWasEntered ? HOVER_IDLE_DISMISS_SECONDS : HOVER_SYMBOL_OFF_DISMISS_SECONDS;
        if (this.idleSeconds >= dismissLimit) {
          this.clear();
          return false;
        }
        idleCounting = true;
      }
    }

    // Advance a pending dwell — for the FIRST show, or a NEW symbol under an already-shown card (the
    // shown card persists until this lands and REPLACES it). Runs regardless of `visible`.
    let dwellKeepAlive = false;
    if (this.pending) {
      this.dwellSeconds += deltaSeconds;
      if (this.dwellSeconds >= HOVER_DWELL_SECONDS && this.requestedGeneration !== this.generation) {
        this.requestedGeneration = this.generation;
        const capturedGeneration = this.generation;
        const requestPosition = this.pending.position;
        const capturedAnchorX = this.pending.anchorX;
        const capturedAnchorY = this.pending.anchorY;
        void this.deps.requestHover(requestPosition).then((hover) => {
          if (capturedGeneration !== this.generation) return; // stale: the pointer moved on
          if (!hover || !hover.contents.trim()) {
            // No hover here — disarm so the frame loop can quiesce (no card, no re-request until a move).
            if (capturedGeneration === this.generation) this.pending = null;
            this.requestPaint();
            return;
          }
          // Show / REPLACE the card, applying the dwell's carried anchor now (never before).
          this.renderContents(hover.contents);
          this.shownRange = hover.range;
          this.anchorX = capturedAnchorX;
          this.anchorY = capturedAnchorY;
          this.cardWasEntered = false;
          this.selectionAnchor = null;
          this.selectionFocus = null;
          this.visible = true;
          this.pending = null; // dwell satisfied — stop counting
          this.requestPaint();
        });
      }
      dwellKeepAlive = true;
    }

    return viewportKeepAlive || dwellKeepAlive || idleCounting;
  }

  /** True while the pointer is over the card or a drag is in flight — the card is STICKY: a stray
   *  keypress or a click on it must not dismiss it (so Ctrl+C copies the selection, drag selects). */
  engaged(): boolean {
    return this.visible && (this.pointerOverCard || this.viewport.dragActive);
  }

  /** True when the card holds a non-empty selection span. */
  hasSelection(): boolean {
    const [start, end] = this.normalizedSelection() ?? [null, null];
    return start !== null && end !== null && !(start.row === end.row && start.column === end.column);
  }

  /** Copy the card's selected text to the OS clipboard; resolves to the character count copied (0 when
   *  nothing is selected). Mirrors Editor.copySelection so the same Ctrl+C proof channel applies. */
  async copySelection(): Promise<number> {
    const text = this.selectedText();
    if (!text) return 0;
    await Clipboard.Class.copy(text);
    return text.length;
  }

  /** The selection ordered (start ≤ end) by row then column, or null when there is no active span. */
  private normalizedSelection(): [{ row: number; column: number }, { row: number; column: number }] | null {
    const anchor = this.selectionAnchor;
    const focus = this.selectionFocus;
    if (!anchor || !focus) return null;
    const anchorFirst = anchor.row < focus.row || (anchor.row === focus.row && anchor.column <= focus.column);
    return anchorFirst ? [anchor, focus] : [focus, anchor];
  }

  /** Reconstruct the selected plain text from the content rows between the normalized ends. */
  private selectedText(): string {
    const span = this.normalizedSelection();
    if (!span) return '';
    const [start, end] = span;
    const startRow = Math.max(0, Math.min(start.row, this.contentPlain.length - 1));
    const endRow = Math.max(0, Math.min(end.row, this.contentPlain.length - 1));
    if (startRow === endRow) {
      return (this.contentPlain[startRow] ?? '').slice(start.column, end.column);
    }
    const parts: string[] = [(this.contentPlain[startRow] ?? '').slice(start.column)];
    for (let row = startRow + 1; row < endRow; row += 1) parts.push(this.contentPlain[row] ?? '');
    parts.push((this.contentPlain[endRow] ?? '').slice(0, end.column));
    return parts.join('\n');
  }

  /** Drive the native text selection on the content renderable, mapped from ABSOLUTE content rows to
   *  the painted window's local cells (y = row − windowStart), clamping ends off the window to its
   *  edges — the same window-local projection the editor uses. */
  private paintSelection(windowStart: number, viewportRows: number, windowStartColumn: number, viewportColumns: number): void {
    const span = this.normalizedSelection();
    if (!span || (span[0].row === span[1].row && span[0].column === span[1].column)) {
      this.content.clearSelectionRange();
      return;
    }
    const [start, end] = span;
    const windowEnd = windowStart + viewportRows - 1;
    if (end.row < windowStart || start.row > windowEnd) {
      this.content.clearSelectionRange();
      return;
    }
    // Columns map through the horizontal window too: local x = absoluteColumn − windowStartColumn,
    // clamped to the viewport so an end scrolled off-screen pins to the card's left/right edge.
    const toLocalColumn = (column: number) => Math.max(0, Math.min(column - windowStartColumn, viewportColumns));
    const anchorY = Math.max(0, Math.min(start.row - windowStart, viewportRows - 1));
    const anchorX = start.row >= windowStart ? toLocalColumn(start.column) : 0;
    const focusY = Math.max(0, Math.min(end.row - windowStart, viewportRows - 1));
    const focusX = end.row <= windowEnd ? toLocalColumn(end.column) : viewportColumns;
    this.content.setSelectionRange(anchorX, anchorY, focusX, focusY);
  }

  /**
   * Parse the hover markdown into styled content lines. A fenced code block (```lang … ```) is
   * syntax-highlighted with the fence's language (falling back to the active document's language);
   * prose is dimmed. The ``` fence markers themselves are dropped. Lines are kept in FULL — content
   * wider than the viewport scrolls horizontally under the horizontal scrollbar rather than truncating.
   */
  private renderContents(markdown: string): void {
    this.rawContents = markdown;
    const palette = this.deps.theme.palette;
    const lines: TextChunk[][] = [];
    let insideFence = false;
    let fenceLanguage: LangId | null = null;
    let widest = 0;
    for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
      const fenceMatch = rawLine.match(/^\s*```(\S*)/);
      if (fenceMatch) {
        if (!insideFence) {
          insideFence = true;
          const tag = fenceMatch[1]?.toLowerCase() ?? '';
          fenceLanguage = FENCE_LANGUAGE[tag] ?? null;
        } else {
          insideFence = false;
          fenceLanguage = null;
        }
        continue; // never render the fence marker itself
      }
      widest = Math.max(widest, rawLine.length);
      if (insideFence) {
        const language = fenceLanguage ?? this.deps.languageForActive();
        const chunks = Highlighter.Class.highlightLine(rawLine, language).map((span) =>
          fg(roleColor(span.role, palette))(span.text),
        );
        lines.push(chunks.length ? chunks : [fg(palette.fg)(rawLine || ' ')]);
      } else {
        lines.push([fg(palette.dim)(rawLine || ' ')]);
      }
    }
    // Drop leading/trailing blank lines so the card hugs its content.
    while (lines.length) {
      const first = lines[0];
      if (!first || !this.isBlankLine(first)) break;
      lines.shift();
    }
    while (lines.length) {
      const last = lines[lines.length - 1];
      if (!last || !this.isBlankLine(last)) break;
      lines.pop();
    }
    this.contentLines = lines.length ? lines : [[fg(palette.fg)(' ')]];
    // The plain text of each row (chunk texts joined) is the source a copied selection slices from.
    this.contentPlain = this.contentLines.map((chunks) => chunks.map((chunk) => chunk.text).join(''));
    this.contentMaxWidth = Math.max(1, widest);
    // A freshly-rendered card starts unscrolled (both axes, momentum halted) with no selection.
    this.viewport.reset();
    this.selectionAnchor = null;
    this.selectionFocus = null;
  }

  private isBlankLine(chunks: TextChunk[]): boolean {
    return chunks.every((chunk) => chunk.text.trim() === '');
  }

  /** Slice a line's styled chunks to the display-column window [startColumn, startColumn+width),
   *  preserving each chunk's colour/attributes (columns are char indices — hover text is code/prose,
   *  effectively one cell per char). Empty windows yield a single blank chunk so the row still paints. */
  private windowChunks(lineChunks: TextChunk[], startColumn: number, width: number): TextChunk[] {
    const out: TextChunk[] = [];
    let column = 0;
    for (const chunk of lineChunks) {
      const text = chunk.text;
      const chunkStart = column;
      const chunkEnd = column + text.length;
      column = chunkEnd;
      const from = Math.max(startColumn, chunkStart);
      const to = Math.min(startColumn + width, chunkEnd);
      if (to <= from) continue;
      out.push({ ...chunk, text: text.slice(from - chunkStart, to - chunkStart) });
    }
    if (out.length) return out;
    const base = lineChunks[0];
    return [base ? { ...base, text: ' ' } : ({ __isChunk: true, text: ' ' } as TextChunk)];
  }

  /** Re-sync the card's renderables from state each frame. Hidden when not visible. */
  update(palette: Palette): void {
    if (!this.visible) {
      this.box.visible = false;
      this.viewport.hideBars();
      this.backdrop.visible = false;
      return;
    }
    this.backdrop.visible = true;
    const { renderer } = this.deps;
    const totalRows = this.contentLines.length;
    const viewportRows = this.viewportRows();
    const verticalScrollable = totalRows > viewportRows;

    const interiorContentWidth = this.viewportColumns();
    const horizontalScrollable = this.contentMaxWidth > interiorContentWidth;
    this.interiorColumns = interiorContentWidth; // the viewport clamps its own scroll against extent()

    // The vertical bar takes the trailing column, the horizontal bar the trailing row (shared corner).
    const interiorWidth = interiorContentWidth + (verticalScrollable ? 1 : 0);
    const interiorHeight = viewportRows + (horizontalScrollable ? 1 : 0);
    const boxWidth = interiorWidth + 2;
    const boxHeight = interiorHeight + 2;

    // Anchor below the pointed row, flipping above when there is no room; clamp onto the screen.
    const below = this.anchorY + 1;
    let top = below;
    if (below + boxHeight > renderer.height) {
      const above = this.anchorY - boxHeight;
      top = above >= 0 ? above : Math.max(0, renderer.height - boxHeight);
    }
    top = Math.max(0, Math.min(top, Math.max(0, renderer.height - boxHeight)));
    // Nudge the card right of the pointed cell so the mouse cursor doesn't overlap its left edge.
    const left = Math.max(0, Math.min(this.anchorX + ANCHOR_OFFSET_COLUMNS, Math.max(0, renderer.width - boxWidth)));

    this.box.visible = true;
    this.box.left = left;
    this.box.top = top;
    this.box.width = boxWidth;
    this.box.height = boxHeight;
    this.box.backgroundColor = palette.panel;
    this.box.borderColor = palette.borderActive;

    // Paint the visible window (vertical AND horizontal) of content as one StyledText.
    const start = Math.max(0, Math.min(this.viewport.scrollTop, this.maximumScrollTop()));
    const startColumn = Math.max(0, Math.min(this.viewport.scrollLeft, this.maximumScrollLeft()));
    const chunks: TextChunk[] = [];
    const visibleLines = this.contentLines.slice(start, start + viewportRows);
    visibleLines.forEach((lineChunks, index) => {
      chunks.push(...this.windowChunks(lineChunks, startColumn, interiorContentWidth));
      if (index < visibleLines.length - 1) chunks.push(fg(palette.fg)('\n'));
    });
    this.content.content = new StyledText(chunks);
    this.paintSelection(start, viewportRows, startColumn, interiorContentWidth);

    // One call drives BOTH bars off the shared geometry with the settings-sourced thickness — the
    // vertical bar on the interior's trailing column, the horizontal on its trailing row (shared corner).
    this.viewport.updateScrollbars({ top: 0, left: 0, width: interiorWidth, height: interiorHeight });
  }
}

export namespace HoverCard {
  export const $Class = $HoverCard;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
