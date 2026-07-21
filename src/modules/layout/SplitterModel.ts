// A reusable draggable-divider MODEL — the shared logic behind BOTH resizable dividers: the vertical
// bar that sets the sidebar WIDTH (resizes the pane to its LEFT) and the horizontal bar that sets the
// git-panel SPLIT (resizes the pane ABOVE). One pointer axis, one clamp, one persist seam.
//
// PURE MODEL BY CONSTRUCTION: pointer positions arrive as plain numbers (cells along the drag axis),
// the size leaves as a plain number, and there is NO renderable, OpenTUI, or terminal dependency —
// the host mounts the bar, does the hit-testing/cursor, and reads `size` to lay panes out. That
// purity is what lets the whole begin/drag/end + clamp behaviour be unit-tested with plain numbers.
//
// Two report UNITS via `mode`: 'cells' reports the size directly in cells (sidebar width); 'ratio'
// reports the pane's share of the axis extent in [0,1] (git split). A pointer moves in cells either
// way; ratio mode converts a cell delta to a ratio delta through the configured axis extent.
//
// invariant: A reported size never leaves its configured bounds (src/modules/layout/layout.invariants.md)
// invariant: Only a drag in progress moves the size (src/modules/layout/layout.invariants.md)
// invariant: A split ratio stays within zero and one (src/modules/layout/layout.invariants.md)
// invariant: The splitter model carries no renderable dependency (src/modules/layout/layout.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';

/** Which physical bar this is: a vertical bar resizes the pane to its LEFT (drag along X); a
 *  horizontal bar resizes the pane ABOVE (drag along Y). The model only ever sees the scalar
 *  position along that axis — the host projects the pointer onto the axis before calling. */
export type SplitterOrientation = 'vertical' | 'horizontal';

/** The unit the size is reported (and bounded) in: raw cells, or a [0,1] ratio of the axis extent. */
export type SplitterReportUnit = 'cells' | 'ratio';

export interface SplitterModelOptions {
  /** Drag axis. 'vertical' → sidebar-width divider; 'horizontal' → git-split divider. */
  orientation: SplitterOrientation;
  /** Report unit. Defaults to 'cells' for a vertical bar and 'ratio' for a horizontal bar. */
  mode?: SplitterReportUnit;
  /** Starting size in the report unit (cells, or a [0,1] ratio). */
  initialSize: number;
  /** Lower bound in the report unit. Defaults to 0. */
  minimumSize?: number;
  /** Upper bound in the report unit. Defaults to Infinity for cells, 1 for ratio. */
  maximumSize?: number;
  /** Total cells along the drag axis — required for 'ratio' mode to convert a cell delta into a
   *  ratio delta (one dragged cell shifts the ratio by 1/extent). Ignored in 'cells' mode. */
  extentCells?: number;
  /** Persist seam: called with the new size on every change (host writes it to the Settings store).
   *  Overridable via the `onSizeChange` method instead, for subclasses. */
  onSizeChange?: (size: number) => void;
}

class $SplitterModel {
  constructor(readonly options: SplitterModelOptions) {
    this.totalExtentCells = options.extentCells ?? 1;
  }

  /** The current divider size in the report unit — cells, or a [0,1] ratio. The host reads this to
   *  lay out the two panes; it is always inside [minimumSize, maximumSize] (the seed is pre-clamped
   *  so even an out-of-range initialSize starts valid). */
  get size() {
    return ref(this.clamp(this.options.initialSize));
  }

  /** True while a drag is in progress (between beginDrag and endDrag) — the host highlights the bar
   *  and routes pointer moves to dragTo only while this holds. */
  get dragging() {
    return ref(false);
  }

  /** Total cells along the drag axis, used only in ratio mode. Mutable so the host can update it on a
   *  window/pane resize; a drag reads it live through unitsPerCell. */
  private totalExtentCells = 1;
  /** Pointer position (cells along the axis) captured at beginDrag. */
  private dragStartPointerPosition = 0;
  /** The size (report unit) captured at beginDrag — the anchor the delta is applied to. */
  private dragStartSize = 0;

  get mode(): SplitterReportUnit {
    return this.options.mode ?? (this.options.orientation === 'vertical' ? 'cells' : 'ratio');
  }

  get minimumSize(): number {
    return this.options.minimumSize ?? 0;
  }

  get maximumSize(): number {
    if (this.options.maximumSize !== undefined) return this.options.maximumSize;
    return this.mode === 'ratio' ? 1 : Number.POSITIVE_INFINITY;
  }

  /** Update the axis extent (total cells) — the host calls this when the window/pane resizes so a
   *  ratio drag stays calibrated. No-op effect in cells mode. */
  setExtentCells(totalExtentCells: number): void {
    this.totalExtentCells = totalExtentCells;
  }

  /** How much one dragged CELL moves the reported size: 1:1 in cells mode; 1/extent in ratio mode
   *  (a zero-or-negative extent yields 0 so a ratio drag with no extent simply cannot move). */
  private get unitsPerCell(): number {
    if (this.mode === 'cells') return 1;
    return this.totalExtentCells > 0 ? 1 / this.totalExtentCells : 0;
  }

  /** Begin a drag: anchor the pointer and the current size. Later dragTo calls apply the pointer
   *  delta to THIS anchored size (never accumulating rounding across the drag). */
  beginDrag(pointerPosition: number): void {
    this.dragStartPointerPosition = pointerPosition;
    this.dragStartSize = this.size.value;
    this.dragging.value = true;
  }

  /** Continue a drag: move the size by the pointer delta since beginDrag, clamped to bounds. A call
   *  before beginDrag or after endDrag is IGNORED — only an in-progress drag moves the size. */
  // invariant: Only a drag in progress moves the size (src/modules/layout/layout.invariants.md)
  dragTo(pointerPosition: number): void {
    if (!this.dragging.value) return;
    const pointerDeltaCells = pointerPosition - this.dragStartPointerPosition;
    const sizeDelta = pointerDeltaCells * this.unitsPerCell;
    this.applySize(this.clamp(this.dragStartSize + sizeDelta));
  }

  /** End the drag: stop tracking. The size keeps its last value; the host may persist it. */
  endDrag(): void {
    this.dragging.value = false;
  }

  private applySize(nextSize: number): void {
    if (nextSize === this.size.value) return;
    this.size.value = nextSize;
    this.onSizeChange(nextSize);
  }

  /** Persist seam — fires on every size change. Defaults to the constructor callback; override to
   *  persist differently. */
  // invariant: Size changes flow through the onSizeChange seam (src/modules/layout/layout.invariants.md)
  protected onSizeChange(size: number): void {
    this.options.onSizeChange?.(size);
  }

  /** Clamp to [minimumSize, maximumSize]; ratio mode additionally pins into [0,1] so a mis-configured
   *  bound can never report an out-of-range ratio. */
  // invariant: A reported size never leaves its configured bounds (src/modules/layout/layout.invariants.md)
  // invariant: A split ratio stays within zero and one (src/modules/layout/layout.invariants.md)
  private clamp(size: number): number {
    let lowerBound = this.minimumSize;
    let upperBound = this.maximumSize;
    if (this.mode === 'ratio') {
      lowerBound = Math.max(0, lowerBound);
      upperBound = Math.min(1, upperBound);
    }
    return Math.max(lowerBound, Math.min(upperBound, size));
  }
}

export namespace SplitterModel {
  export const $Class = $SplitterModel;
  export let Class = Reactive($SplitterModel);
  export type Instance = typeof Class.Instance;
  export type Model = InstanceType<typeof Class>;
}
