// Property tests over the ONE scrollbar-geometry source: track within the region, corner free,
// exact extremes, min-thumb — across region shapes (split positions, tiny panes, huge content).
import { test, expect, describe } from 'bun:test';
import { ScrollbarGeometry, MINIMUM_THUMB_CELLS, type RegionRect } from './scrollbar-geometry';

const shapes: Array<{ name: string; region: RegionRect }> = [
  { name: 'editor pane', region: { top: 0, left: 6, width: 80, height: 37 } },
  { name: 'log region low split', region: { top: 20, left: 0, width: 30, height: 17 } },
  { name: 'log region high split', region: { top: 7, left: 0, width: 30, height: 30 } },
  { name: 'changes region', region: { top: 1, left: 0, width: 30, height: 6 } },
  { name: 'tiny pane', region: { top: 3, left: 3, width: 4, height: 3 } },
];

describe('track placement', () => {
  for (const { name, region } of shapes) {
    test(`vertical track hugs the right edge within the region (${name})`, () => {
      const geometry = ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, { scrollSize: 1000, viewportSize: region.height, scrollPosition: 0 });
      expect(geometry).not.toBeNull();
      expect(geometry!.trackLeft).toBe(region.left + region.width - 1);
      expect(geometry!.trackTop).toBe(region.top);
      expect(geometry!.trackLength).toBeLessThanOrEqual(region.height - 1); // corner cell free
      expect(geometry!.trackLength).toBeGreaterThanOrEqual(1);
    });
    test(`horizontal track hugs the bottom edge within the region (${name})`, () => {
      const geometry = ScrollbarGeometry.Class.scrollbarGeometry('horizontal', region, { scrollSize: 500, viewportSize: region.width, scrollPosition: 0 });
      expect(geometry).not.toBeNull();
      expect(geometry!.trackTop).toBe(region.top + region.height - 1);
      expect(geometry!.trackLeft).toBe(region.left);
      expect(geometry!.trackLength).toBeLessThanOrEqual(region.width - 1);
    });
  }
});

describe('hidden when content fits', () => {
  test('returns null when scrollSize <= viewportSize', () => {
    expect(ScrollbarGeometry.Class.scrollbarGeometry('vertical', shapes[0]!.region, { scrollSize: 10, viewportSize: 37, scrollPosition: 0 })).toBeNull();
    expect(ScrollbarGeometry.Class.scrollbarGeometry('vertical', shapes[0]!.region, { scrollSize: 0, viewportSize: 37, scrollPosition: 0 })).toBeNull();
  });
});

describe('exact extremes round-trip through the reported scale', () => {
  for (const { name, region } of shapes) {
    test(`position 0 and max map to reported 0 and reported max (${name})`, () => {
      const scrollSize = 5000;
      const viewportSize = region.height;
      const trueMax = scrollSize - viewportSize;
      const atStart = ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, { scrollSize, viewportSize, scrollPosition: 0 })!;
      const atEnd = ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, { scrollSize, viewportSize, scrollPosition: trueMax })!;
      expect(atStart.reportedPosition).toBe(0);
      expect(atEnd.reportedPosition).toBe(scrollSize - atEnd.reportedViewportSize); // reported max
      const reportedRange = scrollSize - atEnd.reportedViewportSize;
      if (reportedRange > 0) {
        // Round-trip: reported max * scale recovers the true max exactly (within rounding).
        expect(Math.round(atEnd.reportedPosition * atEnd.reportedToTrueScale)).toBe(trueMax);
      } else {
        // Degenerate: the track is too small for any drag range (min-thumb fills it) — the bar
        // is display-only there, and the scale is explicitly 0 (never NaN/Infinity).
        expect(atEnd.reportedToTrueScale).toBe(0);
      }
    });
  }
});

describe('minimum thumb', () => {
  test('the reported ratio never yields a thumb below the minimum, even on huge content', () => {
    const region = shapes[1]!.region; // 17-cell log region
    const geometry = ScrollbarGeometry.Class.scrollbarGeometry('vertical', region, { scrollSize: 100000, viewportSize: 17, scrollPosition: 0 })!;
    const thumbCells = Math.max(1, Math.round((geometry.reportedViewportSize / 100000) * geometry.trackLength));
    expect(thumbCells).toBeGreaterThanOrEqual(MINIMUM_THUMB_CELLS);
  });
});
