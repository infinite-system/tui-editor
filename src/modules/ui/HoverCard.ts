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
  TextRenderable,
  fg,
  type MouseEvent,
  type TextChunk,
  type CliRenderer,
} from '@opentui/core';
import { Reactive } from 'ivue';
import { Logging } from '../system/Logging';
import { ref } from 'vue';
import { HitTransparentText } from './HitTransparentText';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Highlighter, type LangId, type Role } from '../syntax/Highlighter';
import type { Palette } from '../theme/ThemePalettes';
import type { Theme } from '../theme/Theme';
import type { LanguageHover, TextPosition } from '../lsp/LanguageClient';

/** The pointer must rest on ONE document position this long before the card shows (VS Code uses ~0.5s). */
export const HOVER_DWELL_SECONDS = 0.5;
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
  private readonly backdrop: BoxRenderable;
  private readonly box: BoxRenderable;
  private readonly content: TextRenderable;
  private readonly scrollbar: ScrollBarRenderable;
  /** True while update() writes the bar's reported position, so the bar's onChange ignores our own sync. */
  private applyingBarGeometry = false;
  /** Maps a bar-reported position back to a true content row (ScrollbarGeometry's inflate scale). */
  private barScale = 1;

  constructor(private readonly deps: HoverCardDeps) {
    const { renderer } = deps;
    const root = renderer.root;
    // A full-screen, hit-transparent, non-drawing backdrop that is visible exactly while the card is.
    // OpenTUI composites incrementally: hiding a small overlay does NOT repaint the panes beneath, so a
    // keypress/click dismiss with no other change would leave the card's glyphs stale. A full-screen
    // renderable toggling visible→false invalidates the WHOLE screen (the same mechanism the shortcut
    // sheet uses), forcing a full repaint that clears the card. Hit-transparent so the card stays
    // display-only — the pointer still reaches the editor beneath to move/dismiss the hover.
    this.backdrop = new BoxRenderable(renderer, {
      id: 'hover-card-backdrop', position: 'absolute', left: 0, top: 0,
      width: '100%', height: '100%', visible: false, zIndex: 134,
    });
    root.add(this.backdrop);
    this.box = new BoxRenderable(renderer, {
      id: 'hover-card', position: 'absolute', border: true, borderStyle: 'rounded',
      flexDirection: 'column', visible: false, zIndex: 135,
    });
    this.content = new TextRenderable(renderer, { id: 'hover-card-content', content: '', selectable: false });
    this.box.add(this.content);
    this.scrollbar = new ScrollBarRenderable(renderer, {
      id: 'hover-card-scrollbar', orientation: 'vertical', position: 'absolute', width: 1,
      showArrows: false, visible: false,
      onChange: (position) => {
        if (this.applyingBarGeometry) return; // ignore our own per-frame scrollPosition sync
        this.scrollTop = Math.max(0, Math.round(position * this.barScale));
        this.requestPaint();
      },
    });
    this.box.add(this.scrollbar);
    root.add(this.box);

    // The card receives its OWN pointer: moving into it (to scroll) must NOT dismiss it, and a wheel
    // over it scrolls the content. It never touches the editor's cursor/selection.
    this.box.onMouseMove = () => { this.pointerOverCard = true; };
    this.box.onMouseOut = () => { this.pointerOverCard = false; };
    this.box.onMouseScroll = (event: MouseEvent) =>
      this.scrollBy(event.scroll?.direction === 'up' ? -1 : 1);
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
    this.pending = { position, key };
    this.anchorX = screenX;
    this.anchorY = screenY;
    this.requestPaint();
  }

  /** Any disqualifying input (pointer off the code, a click, a keypress): hide now and disarm the dwell. */
  clear(): void {
    this.pending = null;
    this.dwellSeconds = 0;
    this.pointerOverCard = false;
    if (this.visible) {
      this.visible = false;
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
    if (!this.pending) return false;
    if (this.visible) return false;
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
    this.contentMaxWidth = Math.max(1, Math.min(widest, MAX_CONTENT_WIDTH));
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
