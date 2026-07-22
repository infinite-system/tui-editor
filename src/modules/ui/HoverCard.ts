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
  ScrollBarRenderable,
  StyledText,
  fg,
  type MouseEvent,
  type TextChunk,
  type CliRenderer,
} from '@opentui/core';
import { Reactive } from 'ivue';
import { Logging } from '../system/Logging';
import { ref } from 'vue';
import { HitTransparentText } from './HitTransparentText';
import { SelectableText } from './SelectableText';
import { SelectionDragBehavior } from './SelectionDragBehavior';
import { Clipboard } from '../system/Clipboard';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Highlighter, type LangId, type Role } from '../syntax/Highlighter';
import type { Palette } from '../theme/ThemePalettes';
import type { Theme } from '../theme/Theme';
import type { LanguageHover, TextPosition } from '../lsp/LanguageClient';

/** The pointer must rest on ONE document position this long before the card shows (VS Code uses ~0.5s). */
export const HOVER_DWELL_SECONDS = 0.5;
/** Grace after the pointer leaves the TRIGGER symbol but has NOT yet entered the card — short, so a
 *  card you're moving away from dismisses promptly (VS Code feel), yet long enough to cross the one
 *  row onto the adjacent card when you ARE heading for it. */
export const HOVER_SYMBOL_OFF_DISMISS_SECONDS = 0.8;
/** Grace after the pointer leaves the CARD, once it has been entered — longer, because you were
 *  actively reading/scrolling it and a brief drift off its edge should not yank it away. */
export const HOVER_IDLE_DISMISS_SECONDS = 2.5;
/** Longest content line (display cells) the card renders; longer lines are truncated. */
const MAX_CONTENT_WIDTH = 64;
/** Largest interior row count the card renders before the vertical scrollbar takes over. */
const MAX_CARD_ROWS = 16;

export interface HoverCardDeps {
  renderer: CliRenderer;
  theme: Theme.Instance;
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
  private scrollTop = 0;
  private dwellSeconds = 0;
  /** The dwell in progress (null when the pointer is off the code); key = `line:column`. */
  private pending: { position: TextPosition; key: string } | null = null;
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
  private readonly scrollbar: ScrollBarRenderable;
  /** The SAME drag+edge-autoscroll behaviour the editor and diff use — dragging a selection past the
   *  card's top/bottom edge auto-scrolls the content (its scrollRows callback is this.scrollBy). */
  private readonly drag: SelectionDragBehavior;
  /** True while update() writes the bar's reported position, so the bar's onChange ignores our own sync. */
  private applyingBarGeometry = false;
  /** Maps a bar-reported position back to a true content row (ScrollbarGeometry's inflate scale). */
  private barScale = 1;

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
    // Colour the bar's TRACK the card's own background so the sub-cell half-block glyphs (▀/▄) drawn
    // at the thumb's fractional ends blend into the card instead of showing the default near-black
    // track as dark lines cutting across the thumb. update() re-applies these from the live palette.
    this.scrollbar = new ScrollBarRenderable(renderer, {
      id: 'hover-card-scrollbar', orientation: 'vertical', position: 'absolute', width: 1,
      showArrows: false, visible: false,
      trackOptions: { backgroundColor: deps.theme.palette.panel, foregroundColor: deps.theme.palette.dim },
      onChange: (position) => {
        if (this.applyingBarGeometry) return; // ignore our own per-frame scrollPosition sync
        this.scrollTop = Math.max(0, Math.round(position * this.barScale));
        this.requestPaint();
      },
    });
    this.box.add(this.scrollbar);
    root.add(this.box);

    // The card receives its OWN pointer: moving into it (to scroll/select) must NOT dismiss it, and a
    // wheel over it scrolls the content. It never touches the editor's cursor/selection.
    this.box.onMouseMove = () => { this.pointerOverCard = true; this.cardWasEntered = true; this.idleSeconds = 0; };
    this.box.onMouseOut = () => { this.pointerOverCard = false; this.idleSeconds = 0; this.requestPaint(); };
    this.box.onMouseScroll = (event: MouseEvent) =>
      this.scrollBy(event.scroll?.direction === 'up' ? -1 : 1);

    // The content text is drag-selectable with edge auto-scroll, the SAME contract every scrollable
    // text surface upholds (editor, diff). The drag maps screen cells to absolute content rows/columns,
    // writes this card's own selection model, and scrolls the card by rows when the pointer drags past
    // an edge. invariant: A scrollable text surface is drag-selectable with edge auto-scroll (src/modules/ui/ui.invariants.md)
    this.drag = new SelectionDragBehavior({
      viewportRectangle: () => ({
        leftColumn: this.content.x,
        rightColumn: this.content.x + Math.max(1, this.contentMaxWidth) - 1,
        topRow: this.content.y,
        bottomRow: this.content.y + Math.max(1, this.viewportRows()) - 1,
      }),
      positionAtCell: (screenColumn, screenRow) => this.contentPositionAtCell(screenColumn, screenRow),
      horizontalScrollPosition: () => 0,
      horizontalScrollingEnabled: () => false, // the card never scrolls horizontally (content is truncated)
      beginSelection: (position) => {
        this.selectionAnchor = { row: position.line, column: position.column };
        this.selectionFocus = { row: position.line, column: position.column };
        this.requestPaint();
      },
      extendSelection: (position) => {
        this.selectionFocus = { row: position.line, column: position.column };
        this.requestPaint();
      },
      finishSelection: () => {
        // A bare click (anchor === focus) leaves no span: drop it so update() paints no highlight.
        if (this.selectionAnchor && this.selectionFocus
          && this.selectionAnchor.row === this.selectionFocus.row
          && this.selectionAnchor.column === this.selectionFocus.column) {
          this.selectionAnchor = null;
          this.selectionFocus = null;
        }
        this.requestPaint();
      },
      scrollColumns: () => {}, // no horizontal scroll on the card
      scrollRows: (rowDelta) => this.scrollBy(rowDelta),
      haltCompetingScroll: () => {},
    });
    this.content.onMouseDown = (event: MouseEvent) => { this.pointerOverCard = true; this.cardWasEntered = true; this.drag.begin(event.x, event.y); };
    this.content.onMouseDrag = (event: MouseEvent) => this.drag.drag(event.x, event.y);
    this.content.onMouseUp = () => this.drag.end();
    this.content.onMouseDragEnd = () => this.drag.end();
  }

  /** Map a screen cell to an ABSOLUTE content position (row into contentLines, display column). Rows
   *  outside the painted window clamp to the content extent so an edge drag still resolves a position. */
  private contentPositionAtCell(screenColumn: number, screenRow: number): { line: number; column: number } | null {
    if (!this.visible || this.contentLines.length === 0) return null;
    const start = Math.max(0, Math.min(this.scrollTop, this.maximumScrollTop()));
    const row = Math.max(0, Math.min(start + (screenRow - this.content.y), this.contentLines.length - 1));
    const column = Math.max(0, screenColumn - this.content.x);
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

  /**
   * The pointer is over a document CELL. Pointing at the SAME position keeps the accumulated dwell
   * (pointer jitter within one cell must not reset the timer) and tracks the anchor; a DIFFERENT
   * position bumps the generation, hides any shown card, and restarts the dwell for the new symbol.
   */
  pointAt(position: TextPosition, screenX: number, screenY: number): void {
    // The pointer is on a symbol → engaged; reset the idle grace either way.
    this.onSymbol = true;
    this.idleSeconds = 0;
    const key = `${position.line}:${position.column}`;
    if (this.pending && this.pending.key === key) {
      this.anchorX = screenX;
      this.anchorY = screenY;
      return;
    }
    this.generation += 1;
    this.dwellSeconds = 0;
    this.requestedGeneration = -1;
    this.visible = false;
    this.cardWasEntered = false;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.pending = { position, key };
    this.anchorX = screenX;
    this.anchorY = screenY;
    this.requestPaint();
  }

  /** The pointer moved off the symbol (to an empty cell / out of the code) without a hard dismiss: a
   *  shown card is NOT killed immediately — it enters the idle grace and auto-dismisses if the pointer
   *  does not return to it or another symbol. A card that isn't showing yet just disarms its dwell. */
  pointerOffSymbol(): void {
    this.onSymbol = false;
    if (this.visible) {
      // Start the grace FRESH from the moment the pointer leaves the symbol — the frame loop was
      // quiescing while the pointer rested on the symbol (tick returned false), so idleSeconds must
      // reset here rather than inherit stale accumulation.
      this.idleSeconds = 0;
      this.requestPaint(); // kick the frame loop so tick() can run the idle countdown
    } else {
      this.pending = null;
      this.dwellSeconds = 0;
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
    this.drag.end();
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
      this.scrollbar.visible = false;
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
    // Once shown, run the idle auto-dismiss: while the pointer is over the card or its symbol the card
    // is engaged and idle time resets; when it leaves both, count the grace and dismiss at the limit.
    // (Returning true keeps the frame loop alive through the countdown; false lets it quiesce.)
    if (this.visible) {
      // An in-flight selection drag advances the shared edge-autoscroll and keeps the card engaged
      // (the pointer may have dragged past the card's edge, so pointerOverCard can be false mid-drag).
      const dragging = this.drag.active;
      const dragKeepAlive = dragging ? this.drag.tick(deltaSeconds) : false;
      if (this.pointerOverCard || this.onSymbol || dragging) {
        this.idleSeconds = 0;
        return dragKeepAlive;
      }
      // The demand-driven loop quiesces while the pointer rests engaged; the first tick after that has
      // a huge wall-clock delta, so clamp it or the grace would elapse in one frame.
      this.idleSeconds += Math.min(deltaSeconds, 0.1);
      // A card the pointer once entered gets the longer read-grace; one it never touched dismisses fast.
      const dismissLimit = this.cardWasEntered ? HOVER_IDLE_DISMISS_SECONDS : HOVER_SYMBOL_OFF_DISMISS_SECONDS;
      if (this.idleSeconds >= dismissLimit) {
        this.clear();
        return false;
      }
      return true;
    }
    if (!this.pending) return false;
    this.dwellSeconds += deltaSeconds;
    if (this.dwellSeconds < HOVER_DWELL_SECONDS) return true;
    if (this.requestedGeneration !== this.generation) {
      this.requestedGeneration = this.generation;
      const capturedGeneration = this.generation;
      const requestPosition = this.pending.position;
      void this.deps.requestHover(requestPosition).then((hover) => {
        if (capturedGeneration !== this.generation) return; // stale: the pointer moved on
        if (!hover || !hover.contents.trim()) {
          // No hover here — disarm so the frame loop can quiesce (no card, no re-request until a move).
          if (capturedGeneration === this.generation) this.pending = null;
          this.requestPaint();
          return;
        }
        this.renderContents(hover.contents);
        this.visible = true;
        this.scrollTop = 0;
        this.requestPaint();
      });
    }
    return true; // keep frames coming until the response lands
  }

  /** Scroll the card's content by whole rows, clamped to the content extent. */
  scrollBy(deltaRows: number): void {
    if (!this.visible) return;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + deltaRows, this.maximumScrollTop()));
    this.requestPaint();
  }

  /** True while the pointer is over the card or a drag is in flight — the card is STICKY: a stray
   *  keypress or a click on it must not dismiss it (so Ctrl+C copies the selection, drag selects). */
  engaged(): boolean {
    return this.visible && (this.pointerOverCard || this.drag.active);
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
  private paintSelection(windowStart: number, viewportRows: number): void {
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
    const anchorY = Math.max(0, Math.min(start.row - windowStart, viewportRows - 1));
    const anchorX = start.row >= windowStart ? start.column : 0;
    const focusY = Math.max(0, Math.min(end.row - windowStart, viewportRows - 1));
    const focusX = end.row <= windowEnd ? end.column : this.contentMaxWidth;
    this.content.setSelectionRange(Math.max(0, anchorX), anchorY, Math.max(0, focusX), focusY);
  }

  /**
   * Parse the hover markdown into styled content lines. A fenced code block (```lang … ```) is
   * syntax-highlighted with the fence's language (falling back to the active document's language);
   * prose is dimmed. The ``` fence markers themselves are dropped, and each line is truncated to
   * MAX_CONTENT_WIDTH display cells.
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
      const truncated = EditorCoordinates.Class.displayColumnWindow(rawLine, 0, MAX_CONTENT_WIDTH);
      widest = Math.max(widest, EditorCoordinates.Class.lineWidth(truncated));
      if (insideFence) {
        const language = fenceLanguage ?? this.deps.languageForActive();
        const chunks = Highlighter.Class.highlightLine(truncated, language).map((span) =>
          fg(roleColor(span.role, palette))(span.text),
        );
        lines.push(chunks.length ? chunks : [fg(palette.fg)(truncated || ' ')]);
      } else {
        lines.push([fg(palette.dim)(truncated || ' ')]);
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
    this.contentMaxWidth = Math.max(1, Math.min(widest, MAX_CONTENT_WIDTH));
    // A freshly-rendered card starts with no selection.
    this.selectionAnchor = null;
    this.selectionFocus = null;
  }

  private isBlankLine(chunks: TextChunk[]): boolean {
    return chunks.every((chunk) => chunk.text.trim() === '');
  }

  /** Re-sync the card's renderables from state each frame. Hidden when not visible. */
  update(palette: Palette): void {
    if (!this.visible) {
      this.box.visible = false;
      this.scrollbar.visible = false;
      this.backdrop.visible = false;
      return;
    }
    this.backdrop.visible = true;
    const { renderer } = this.deps;
    const totalRows = this.contentLines.length;
    const viewportRows = this.viewportRows();
    const scrollable = totalRows > viewportRows;
    if (this.scrollTop > this.maximumScrollTop()) this.scrollTop = this.maximumScrollTop();

    const interiorWidth = Math.max(1, this.contentMaxWidth + (scrollable ? 1 : 0));
    const interiorHeight = viewportRows;
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
    const left = Math.max(0, Math.min(this.anchorX, Math.max(0, renderer.width - boxWidth)));

    this.box.visible = true;
    this.box.left = left;
    this.box.top = top;
    this.box.width = boxWidth;
    this.box.height = boxHeight;
    this.box.backgroundColor = palette.panel;
    this.box.borderColor = palette.borderActive;

    // Paint the visible window of content lines as one StyledText (rows joined by newlines).
    const start = Math.max(0, Math.min(this.scrollTop, this.maximumScrollTop()));
    const chunks: TextChunk[] = [];
    const visibleLines = this.contentLines.slice(start, start + viewportRows);
    visibleLines.forEach((lineChunks, index) => {
      chunks.push(...lineChunks);
      if (index < visibleLines.length - 1) chunks.push(fg(palette.fg)('\n'));
    });
    this.content.content = new StyledText(chunks);
    this.paintSelection(start, viewportRows);

    // Drive the vertical scrollbar off the SAME per-frame geometry every pane bar uses; its interior
    // region is the card's content box (top/left relative to the bordered box's first inner cell).
    if (scrollable) {
      const geometry = ScrollbarGeometry.Class.scrollbarGeometry(
        'vertical',
        { top: 0, left: 0, width: interiorWidth, height: interiorHeight },
        { scrollSize: totalRows, viewportSize: viewportRows, scrollPosition: start },
      );
      if (geometry) {
        this.scrollbar.visible = true;
        // Track blends with the card bg (kills the black half-block lines); thumb is a subtle dim grey.
        this.scrollbar.slider.backgroundColor = palette.panel;
        this.scrollbar.slider.foregroundColor = palette.dim;
        this.scrollbar.top = geometry.trackTop;
        this.scrollbar.left = geometry.trackLeft;
        this.scrollbar.height = geometry.trackLength;
        this.scrollbar.width = 1;
        this.applyingBarGeometry = true;
        try {
          this.scrollbar.scrollSize = totalRows;
          this.scrollbar.viewportSize = geometry.reportedViewportSize;
          this.scrollbar.scrollPosition = geometry.reportedPosition;
        } finally {
          this.applyingBarGeometry = false;
        }
        this.barScale = geometry.reportedToTrueScale;
      } else {
        this.scrollbar.visible = false;
      }
    } else {
      this.scrollbar.visible = false;
    }
  }
}

export namespace HoverCard {
  export const $Class = $HoverCard;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
