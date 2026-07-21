// THE scrollbar geometry — one pure function every bar consumes (geometry drift between bars is
// impossible when there is one source). A track occupies exactly the trailing edge of its region's
// CONTENT rect (right column for vertical, bottom row for horizontal), derived per frame from the
// region's ACTUAL rendered layout — never cached boot-time numbers, never hardcoded guesses. The
// corner cell where two bars would meet stays free. Thumbs have a minimum size; because inflating
// the thumb shrinks the reported range, the mapping carries a scale so positions round-trip to the
// TRUE scroll range with exact extremes.
//
// invariant: A scrollbar track is derived per frame from its region rect (ui.invariants.md)

import { Static } from 'ivue/extras';

export interface RegionRect {
  /** Content-box cells of the region the bar scrolls (relative to whatever frame the caller uses —
   *  consistency is the caller's job; this function never mixes frames). */
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ScrollState {
  scrollSize: number;
  viewportSize: number;
  scrollPosition: number;
}

export interface BarGeometry {
  /** Track placement, same coordinate frame as the region rect. */
  trackTop: number;
  trackLeft: number;
  trackLength: number;
  /** What to REPORT to a proportional scrollbar widget so the thumb never shrinks below the
   *  minimum: reported viewport (inflated) + reported position (scaled). */
  reportedViewportSize: number;
  reportedPosition: number;
  /** Multiply a reported position by this to recover the TRUE scroll position. */
  reportedToTrueScale: number;
}

export const MINIMUM_THUMB_CELLS = 2;

/**
 * Geometry for one bar. Returns null when the content fits (bar hidden). The track runs the
 * region's trailing edge minus one corner cell (shared with a perpendicular bar).
 */
function $scrollbarGeometry(
  orientation: 'vertical' | 'horizontal',
  region: RegionRect,
  scroll: ScrollState,
  minimumThumbCells = MINIMUM_THUMB_CELLS,
): BarGeometry | null {
  if (scroll.scrollSize <= scroll.viewportSize || scroll.scrollSize <= 0) return null;
  const trackLength = Math.max(1, (orientation === 'vertical' ? region.height : region.width) - 1);
  const trackTop = orientation === 'vertical' ? region.top : region.top + region.height - 1;
  const trackLeft = orientation === 'vertical' ? region.left + region.width - 1 : region.left;

  let reportedViewportSize = scroll.viewportSize;
  const minimumViewportForThumb = Math.ceil((minimumThumbCells * scroll.scrollSize) / trackLength);
  reportedViewportSize = Math.min(scroll.scrollSize, Math.max(reportedViewportSize, minimumViewportForThumb));

  const trueRange = Math.max(0, scroll.scrollSize - scroll.viewportSize);
  const reportedRange = Math.max(0, scroll.scrollSize - reportedViewportSize);
  const reportedToTrueScale = reportedRange > 0 ? trueRange / reportedRange : 0;
  const clampedPosition = Math.max(0, Math.min(scroll.scrollPosition, trueRange));
  const reportedPosition =
    trueRange > 0 ? Math.round((clampedPosition / trueRange) * reportedRange) : 0;

  return { trackTop, trackLeft, trackLength, reportedViewportSize, reportedPosition, reportedToTrueScale };
}

class $ScrollbarGeometry {
  /** Geometry for one bar; null when the content fits (bar hidden). */
  static scrollbarGeometry = $scrollbarGeometry;
  static readonly MINIMUM_THUMB_CELLS = MINIMUM_THUMB_CELLS;
}

export namespace ScrollbarGeometry {
  export const $Class = $ScrollbarGeometry;
  export const Class = Static($ScrollbarGeometry);
}
