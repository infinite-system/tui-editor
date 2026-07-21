// A reusable hover tooltip — DISPLAY-ONLY overlay state driven by a dwell timer that the frame
// tick advances (the same pattern as drag auto-scroll: `tick(dtSeconds)` returns true while it
// still needs frames). The pointer must DWELL on one target for TOOLTIP_DWELL_SECONDS before the
// tooltip shows; any disqualifying input (pointer moved off the target, any click, any keypress)
// clears it immediately. The tooltip never receives input itself: the view renders it
// hit-transparent, and this model only ever writes its own display refs — it can never consume a
// click or alter routing.
//
// invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';

export const TOOLTIP_DWELL_SECONDS = 0.4;

/** Where the tooltip sits relative to its anchor row. 'auto' = above, flipping below near the top. */
export type TooltipPlacement = 'above' | 'below' | 'auto';

interface PendingTooltip {
  text: string;
  anchorX: number;
  anchorY: number;
  placement: TooltipPlacement;
}

class $Tooltip {
  get visible() {
    return ref(false);
  }
  get text() {
    return ref('');
  }
  /** The anchor CELL the tooltip points at (the view places above/below + clamps to the screen). */
  get anchorX() {
    return ref(0);
  }
  get anchorY() {
    return ref(0);
  }
  /** Placement relative to the anchor row; the view honours it (default 'auto' = above-then-flip). */
  get placement() {
    return ref<TooltipPlacement>('auto');
  }

  private pending: PendingTooltip | null = null;
  private dwellSeconds = 0;

  /**
   * The pointer is over a tooltip target. Pointing at the SAME text keeps the accumulated dwell
   * (pointer jitter within one target must not reset the timer) and tracks the anchor; a
   * DIFFERENT text hides any visible tooltip and restarts the dwell for the new target.
   * Identity is the text itself — two targets with equal labels behave as one, which is harmless.
   */
  point(text: string, anchorX: number, anchorY: number, placement: TooltipPlacement = 'auto'): void {
    if (this.visible.value && this.text.value === text) {
      this.anchorX.value = anchorX;
      this.anchorY.value = anchorY;
      this.placement.value = placement;
      return;
    }
    if (this.pending?.text === text) {
      this.pending.anchorX = anchorX;
      this.pending.anchorY = anchorY;
      this.pending.placement = placement;
      return;
    }
    this.clear();
    this.pending = { text, anchorX, anchorY, placement };
    this.dwellSeconds = 0;
  }

  /** Any disqualifying input (move away, click, key): hide now and disarm the dwell. */
  clear(): void {
    this.pending = null;
    this.dwellSeconds = 0;
    if (this.visible.value) {
      this.visible.value = false;
      this.text.value = '';
    }
  }

  /**
   * Frame tick: advance the dwell timer; show the tooltip when the dwell completes.
   * Returns true while a dwell is still counting — the caller keeps frames coming (exactly the
   * momentum/auto-scroll contract), and false once idle (visible or disarmed needs no frames).
   */
  tick(dtSeconds: number): boolean {
    if (!this.pending || this.visible.value) return false;
    this.dwellSeconds += dtSeconds;
    if (this.dwellSeconds < TOOLTIP_DWELL_SECONDS) return true;
    this.text.value = this.pending.text;
    this.anchorX.value = this.pending.anchorX;
    this.anchorY.value = this.pending.anchorY;
    this.placement.value = this.pending.placement;
    this.visible.value = true;
    this.pending = null;
    return false;
  }
}

export namespace Tooltip {
  export const $Class = $Tooltip;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
