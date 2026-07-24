// The ONE scroll surface every scrollable text pane composes — the repeatable pattern. It owns the
// mechanics that used to be re-assembled (and drift) per pane: momentum on both axes, wheel routing
// through the settings-sourced gesture (incl. modifier→horizontal), a vertical + horizontal scrollbar
// whose thickness comes from ONE setting (never freestyled), and drag-select with edge auto-scroll.
// A host pane supplies only its IDENTITY via deps — content extent, viewport extent, the selection
// model, and how a screen cell maps to a content position — and gets the whole behaviour uniformly.
// Consumers today: the hover card, the editor/diff surfaces, and the agent transcript (wrap mode:
// disableHorizontal + followBottom tail-anchor).
//
// invariant: A scrollable text surface is drag-selectable with edge auto-scroll (src/modules/ui/ui.invariants.md)
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { ScrollBarRenderable, type MouseEvent, type CliRenderer } from '@opentui/core';
import { Reactive } from 'ivue';
import {
  Momentum,
  DEFAULT_MOMENTUM,
  VERTICAL_MOMENTUM,
  AT_REST,
  type ScrollMomentum,
  type MomentumOptions,
} from '../system/Momentum';
import { ScrollGesture } from './ScrollGesture';
import { ScrollbarGeometry } from './ScrollbarGeometry';
import { SelectionDragBehavior, type SelectionDragPosition } from './SelectionDragBehavior';
import type { Settings } from '../settings/Settings';

/** Total content size and how much of it is visible — supplied by the host each frame (cells). */
export interface ViewportExtent {
  contentRows: number;
  contentColumns: number;
  viewportRows: number;
  viewportColumns: number;
}

/** The interior cell rect the bars derive from (relative to the frame the host positions bars in),
 *  plus the absolute screen origin of the content's first cell (for pointer→content mapping). */
export interface ViewportRegion {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ScrollableTextViewportDeps {
  renderer: CliRenderer;
  settings: Settings.Instance;
  /** The renderable the scrollbars mount into (the host's content box). */
  parent: { add(child: ScrollBarRenderable): void };
  id: string;
  /** Live content/viewport sizes; clamps scroll and drives the bars. */
  extent: () => ViewportExtent;
  /** Bar track + thumb colours (usually panel bg + dim). */
  colors: () => { track: string; thumb: string };
  /** Repaint hook — a scroll change carries no keypress/mouse event, so the host must re-project. */
  onScroll: () => void;
  /** WRAP MODE: the content wraps to the viewport width, so there is no horizontal overflow — never
   *  route a horizontal wheel and never show the horizontal scrollbar. Used by the agent transcript. */
  disableHorizontal?: boolean;
  /** TAIL-ANCHOR: while the scroll sits at the bottom, keep it pinned to the newest content as the
   *  content grows (a log/transcript tail). Auto-derives from position: any scroll that lands at the
   *  bottom re-arms it, any scroll above releases it. `followContentTail()` applies the pin each frame. */
  followBottom?: boolean;
  /** z-index for the bars — raise it above a parent whose CONTENT is mounted AFTER this viewport (the
   *  panel adds its cell bodies later, so the bar would otherwise render beneath them). Defaults to 0. */
  scrollbarZIndex?: number;
  /** Selection model hooks (the host owns the selection; the drag only drives it + the scroll). */
  selection: {
    positionAtCell: (screenColumn: number, screenRow: number) => SelectionDragPosition | null;
    begin: (position: SelectionDragPosition, pointerDisplayColumn: number) => void;
    extend: (position: SelectionDragPosition, pointerDisplayColumn: number) => void;
    finish: () => void;
    viewportRectangle: () => { leftColumn: number; rightColumn: number; topRow: number; bottomRow: number };
    /** Grapheme count of a content line — lets a rightward drag include the char under the release cell. */
    lineGraphemeCount?: (lineIndex: number) => number;
  };
}

class $ScrollableTextViewport {
  private scrollTopValue = 0;
  private scrollLeftValue = 0;
  private verticalMomentum: ScrollMomentum = AT_REST;
  private horizontalMomentum: ScrollMomentum = AT_REST;
  private readonly verticalBar: ScrollBarRenderable;
  private readonly horizontalBar: ScrollBarRenderable;
  private readonly drag: SelectionDragBehavior.Model;
  /** True while update() writes a bar's reported position, so its onChange ignores our own sync. */
  private applyingBarGeometry = false;
  private verticalBarScale = 1;
  private horizontalBarScale = 1;

  constructor(private readonly deps: ScrollableTextViewportDeps) {
    const { renderer, id } = deps;
    this.followBottomActive = deps.followBottom === true;
    const scrollbarZIndex = deps.scrollbarZIndex ?? 0;
    this.verticalBar = new ScrollBarRenderable(renderer, {
      id: `${id}-scrollbar-v`, orientation: 'vertical', position: 'absolute', width: 1,
      showArrows: false, visible: false, zIndex: scrollbarZIndex,
      onChange: (position) => {
        if (this.applyingBarGeometry) return;
        this.setScrollTop(Math.round(position * this.verticalBarScale));
      },
    });
    this.horizontalBar = new ScrollBarRenderable(renderer, {
      id: `${id}-scrollbar-h`, orientation: 'horizontal', position: 'absolute', height: 1,
      showArrows: false, visible: false, zIndex: scrollbarZIndex,
      onChange: (position) => {
        if (this.applyingBarGeometry) return;
        this.setScrollLeft(Math.round(position * this.horizontalBarScale));
      },
    });
    deps.parent.add(this.verticalBar);
    deps.parent.add(this.horizontalBar);

    // One shared drag/autoscroll behaviour — the same module the editor and diff use. The host owns
    // the selection MODEL; this only writes it and scrolls when the pointer drags past an edge.
    this.drag = new SelectionDragBehavior.Class({
      viewportRectangle: () => deps.selection.viewportRectangle(),
      positionAtCell: (screenColumn, screenRow) => deps.selection.positionAtCell(screenColumn, screenRow),
      horizontalScrollPosition: () => this.scrollLeftValue,
      horizontalScrollingEnabled: () => this.maximumScrollLeft() > 0,
      beginSelection: (position, pointerDisplayColumn) => deps.selection.begin(position, pointerDisplayColumn),
      extendSelection: (position, pointerDisplayColumn) => deps.selection.extend(position, pointerDisplayColumn),
      finishSelection: () => deps.selection.finish(),
      lineGraphemeCount: deps.selection.lineGraphemeCount,
      scrollColumns: (columnDelta) => this.scrollColumnsBy(columnDelta),
      scrollRows: (rowDelta) => this.scrollRowsBy(rowDelta),
      haltCompetingScroll: () => this.haltMomentum(),
    });
  }

  /** Tail-anchor state (followBottom mode only): true while the scroll is pinned to the newest content.
   *  Set in the constructor (after `deps` is assigned) so the initializer never reads deps too early. */
  private followBottomActive = false;

  get scrollTop(): number { return this.scrollTopValue; }
  get scrollLeft(): number { return this.scrollLeftValue; }
  get dragActive(): boolean { return this.drag.active; }
  /** True while tail-anchored to the bottom (followBottom mode) — drives the pane's stuck-to-bottom UX. */
  get stuckToBottom(): boolean { return this.followBottomActive; }

  /** Apply the tail-anchor pin: while followBottom is active, snap to the current bottom so content that
   *  grew since last frame stays in view. A no-op when already at the bottom (no repaint churn). */
  followContentTail(): void {
    if (this.deps.followBottom && this.followBottomActive) this.setScrollTop(this.maximumScrollTop());
  }

  private maximumScrollTop(): number {
    const extent = this.deps.extent();
    return Math.max(0, extent.contentRows - extent.viewportRows);
  }
  private maximumScrollLeft(): number {
    const extent = this.deps.extent();
    return Math.max(0, extent.contentColumns - extent.viewportColumns);
  }

  /** Momentum tuning from Settings so every surface flings identically (mirrors Workspace). */
  private verticalMomentumOptions(): MomentumOptions {
    const settings = this.deps.settings;
    return {
      impulse: settings.scrollAccelGain.value,
      max: settings.verticalFlingCeiling.value,
      decayPerSec: settings.scrollFriction.value,
      stopVelocity: VERTICAL_MOMENTUM.stopVelocity,
    };
  }

  /** A wheel over the surface: routed through the SAME settings-sourced gesture as every pane —
   *  notch size + fast multiplier, and modifier (e.g. Alt) OR a native left/right wheel → horizontal. */
  handleWheel(event: MouseEvent): void {
    const direction = event.scroll?.direction;
    const step = ScrollGesture.Class.wheelStep(event, this.deps.settings);
    const modifierHorizontal = ScrollGesture.Class.modifierHeld(event, this.deps.settings.horizontalScrollModifier.value);
    // Wrap mode: the content has no horizontal overflow, so a horizontal wheel is meaningless — treat
    // every wheel as vertical (never fling sideways).
    const horizontal = !this.deps.disableHorizontal &&
      (direction === 'left' || direction === 'right' || modifierHorizontal);
    if (horizontal && this.maximumScrollLeft() > 0) {
      const backward = direction === 'left' || direction === 'up';
      this.horizontalMomentum = Momentum.Class.addImpulse(this.horizontalMomentum, (backward ? -1 : 1) * step, DEFAULT_MOMENTUM);
    } else if (!horizontal) {
      // An upward wheel releases the tail-anchor IMMEDIATELY (before any momentum step), so
      // followContentTail() stops snapping the glide back to the bottom.
      if (direction === 'up' && this.deps.followBottom) this.followBottomActive = false;
      this.verticalMomentum = Momentum.Class.addImpulse(this.verticalMomentum, (direction === 'up' ? -1 : 1) * step, this.verticalMomentumOptions());
    }
    this.deps.onScroll();
  }

  /** Advance both momenta + the drag edge-autoscroll one frame. True keeps the demand-driven loop
   *  alive (a glide is still decaying, or a drag is auto-scrolling). */
  tick(deltaSeconds: number): boolean {
    let keepAlive = false;
    const vertical = Momentum.Class.stepMomentum(this.verticalMomentum, deltaSeconds, this.verticalMomentumOptions());
    this.verticalMomentum = vertical.momentum;
    if (vertical.rows !== 0) this.setScrollTop(this.scrollTopValue + vertical.rows);
    if (Momentum.Class.isMoving(this.verticalMomentum)) keepAlive = true;

    const horizontal = Momentum.Class.stepMomentum(this.horizontalMomentum, deltaSeconds, DEFAULT_MOMENTUM);
    this.horizontalMomentum = horizontal.momentum;
    if (horizontal.rows !== 0) this.setScrollLeft(this.scrollLeftValue + horizontal.rows);
    if (Momentum.Class.isMoving(this.horizontalMomentum)) keepAlive = true;

    if (this.drag.active) keepAlive = this.drag.tick(deltaSeconds) || keepAlive;
    return keepAlive;
  }

  /** Programmatic/drag scroll by whole rows — halts momentum (One-Writer-Per-Regime), then clamps. */
  scrollRowsBy(deltaRows: number): void {
    this.verticalMomentum = Momentum.Class.halt();
    this.setScrollTop(this.scrollTopValue + deltaRows);
  }
  scrollColumnsBy(deltaColumns: number): void {
    this.horizontalMomentum = Momentum.Class.halt();
    this.setScrollLeft(this.scrollLeftValue + deltaColumns);
  }
  /** Jump to the bottom (re-arms tail-anchor in followBottom mode). Halts momentum. */
  scrollToBottom(): void {
    this.verticalMomentum = Momentum.Class.halt();
    this.setScrollTop(this.maximumScrollTop());
  }
  haltMomentum(): void {
    this.verticalMomentum = Momentum.Class.halt();
    this.horizontalMomentum = Momentum.Class.halt();
  }

  private setScrollTop(value: number): void {
    const maximum = this.maximumScrollTop();
    const clamped = Math.max(0, Math.min(value, maximum));
    if (clamped !== this.scrollTopValue) { this.scrollTopValue = clamped; this.deps.onScroll(); }
    if (clamped === 0 || clamped === maximum) this.verticalMomentum = Momentum.Class.halt();
    // Tail-anchor re-derives from position: landing at the bottom re-arms the pin, any position above
    // it releases the pin (so a scroll-up holds and a scroll-back-to-bottom resumes following).
    if (this.deps.followBottom) this.followBottomActive = clamped >= maximum;
  }
  private setScrollLeft(value: number): void {
    const clamped = Math.max(0, Math.min(value, this.maximumScrollLeft()));
    if (clamped !== this.scrollLeftValue) { this.scrollLeftValue = clamped; this.deps.onScroll(); }
    if (clamped === 0 || clamped === this.maximumScrollLeft()) this.horizontalMomentum = Momentum.Class.halt();
  }

  // Pointer selection lifecycle — the host wires its content renderable's mouse events to these.
  beginDrag(screenColumn: number, screenRow: number): void { this.drag.begin(screenColumn, screenRow); }
  dragTo(screenColumn: number, screenRow: number): void { this.drag.drag(screenColumn, screenRow); }
  endDrag(): void { this.drag.end(); }

  /** Reset scroll (a fresh content load) without a momentum glide. */
  reset(): void {
    this.scrollTopValue = 0;
    this.scrollLeftValue = 0;
    this.haltMomentum();
  }

  /** Hide both bars (host not visible). */
  hideBars(): void {
    this.verticalBar.visible = false;
    this.horizontalBar.visible = false;
  }

  /**
   * Drive both scrollbars off the SAME per-frame geometry every pane bar uses — thickness from the
   * ONE settings value, so vertical and horizontal are identical and no window freestyles its own.
   * `region` is the interior content rect (bars take its trailing column/row, sharing the corner).
   */
  updateScrollbars(region: ViewportRegion): void {
    const extent = this.deps.extent();
    const { track, thumb } = this.deps.colors();
    const thickness = Math.max(1, Math.round(this.deps.settings.scrollbarThickness.value));
    const verticalOverflow = extent.contentRows > extent.viewportRows;
    // Wrap mode never shows the horizontal bar (there is no horizontal overflow to scroll).
    const horizontalOverflow = !this.deps.disableHorizontal && extent.contentColumns > extent.viewportColumns;
    const rect = { top: region.top, left: region.left, width: region.width, height: region.height };

    if (verticalOverflow) {
      const geometry = ScrollbarGeometry.Class.scrollbarGeometry('vertical', rect, {
        scrollSize: extent.contentRows, viewportSize: extent.viewportRows, scrollPosition: this.scrollTopValue,
      });
      if (geometry) {
        this.verticalBar.visible = true;
        this.verticalBar.slider.backgroundColor = track;
        this.verticalBar.slider.foregroundColor = thumb;
        this.verticalBar.top = geometry.trackTop;
        this.verticalBar.left = geometry.trackLeft;
        this.verticalBar.height = geometry.trackLength;
        this.verticalBar.width = thickness;
        this.applyingBarGeometry = true;
        try {
          this.verticalBar.scrollSize = extent.contentRows;
          this.verticalBar.viewportSize = geometry.reportedViewportSize;
          this.verticalBar.scrollPosition = geometry.reportedPosition;
        } finally { this.applyingBarGeometry = false; }
        this.verticalBarScale = geometry.reportedToTrueScale;
      } else { this.verticalBar.visible = false; }
    } else { this.verticalBar.visible = false; }

    if (horizontalOverflow) {
      const geometry = ScrollbarGeometry.Class.scrollbarGeometry('horizontal', rect, {
        scrollSize: extent.contentColumns, viewportSize: extent.viewportColumns, scrollPosition: this.scrollLeftValue,
      });
      if (geometry) {
        this.horizontalBar.visible = true;
        this.horizontalBar.slider.backgroundColor = track;
        this.horizontalBar.slider.foregroundColor = thumb;
        this.horizontalBar.top = geometry.trackTop;
        this.horizontalBar.left = geometry.trackLeft;
        this.horizontalBar.width = geometry.trackLength;
        this.horizontalBar.height = thickness;
        this.applyingBarGeometry = true;
        try {
          this.horizontalBar.scrollSize = extent.contentColumns;
          this.horizontalBar.viewportSize = geometry.reportedViewportSize;
          this.horizontalBar.scrollPosition = geometry.reportedPosition;
        } finally { this.applyingBarGeometry = false; }
        this.horizontalBarScale = geometry.reportedToTrueScale;
      } else { this.horizontalBar.visible = false; }
    } else { this.horizontalBar.visible = false; }
  }
}

export namespace ScrollableTextViewport {
  export const $Class = $ScrollableTextViewport;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
