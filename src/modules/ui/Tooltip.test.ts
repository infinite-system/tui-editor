// State-machine tests for the display-only hover tooltip (dwell timer driven by the frame tick).
// invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
import { test, expect, describe } from 'bun:test';
import { Tooltip, TOOLTIP_DWELL_SECONDS } from './Tooltip';

const FRAME = 1 / 30;

describe('Tooltip', () => {
  test('idle tick needs no frames and shows nothing', () => {
    const tooltip = new Tooltip.Class();
    expect(tooltip.tick(FRAME)).toBe(false);
    expect(tooltip.visible.value).toBe(false);
  });

  test('does not show before the dwell completes; shows after it, then needs no more frames', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Open diff', 10, 5);
    let elapsedSeconds = 0;
    while (elapsedSeconds + FRAME < TOOLTIP_DWELL_SECONDS) {
      expect(tooltip.tick(FRAME)).toBe(true); // still counting: caller keeps frames coming
      expect(tooltip.visible.value).toBe(false);
      elapsedSeconds += FRAME;
    }
    expect(tooltip.tick(FRAME)).toBe(false); // dwell completed on this tick
    expect(tooltip.visible.value).toBe(true);
    expect(tooltip.text.value).toBe('Open diff');
    expect(tooltip.anchorX.value).toBe(10);
    expect(tooltip.anchorY.value).toBe(5);
    expect(tooltip.tick(FRAME)).toBe(false); // visible: no further frames needed
  });

  test('pointer jitter on the SAME target keeps the accumulated dwell and tracks the anchor', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS / 2);
    tooltip.point('Stage', 11, 5); // jitter within the target
    tooltip.tick(TOOLTIP_DWELL_SECONDS / 2);
    expect(tooltip.visible.value).toBe(true);
    expect(tooltip.anchorX.value).toBe(11); // the latest anchor
  });

  test('pointing at a DIFFERENT target restarts the dwell', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS * 0.9);
    tooltip.point('Discard…', 12, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS * 0.9);
    expect(tooltip.visible.value).toBe(false); // the old dwell did not carry over
    tooltip.tick(TOOLTIP_DWELL_SECONDS * 0.2);
    expect(tooltip.visible.value).toBe(true);
    expect(tooltip.text.value).toBe('Discard…');
  });

  test('moving to a different target while VISIBLE hides and re-dwells', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS);
    expect(tooltip.visible.value).toBe(true);
    tooltip.point('Unstage', 10, 6);
    expect(tooltip.visible.value).toBe(false); // hidden immediately
    tooltip.tick(TOOLTIP_DWELL_SECONDS);
    expect(tooltip.visible.value).toBe(true);
    expect(tooltip.text.value).toBe('Unstage');
  });

  test('re-pointing the SAME text while visible only tracks the anchor', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS);
    tooltip.point('Stage', 14, 7);
    expect(tooltip.visible.value).toBe(true);
    expect(tooltip.anchorX.value).toBe(14);
    expect(tooltip.anchorY.value).toBe(7);
  });

  test('clear disarms a pending dwell', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS / 2);
    tooltip.clear();
    expect(tooltip.tick(TOOLTIP_DWELL_SECONDS)).toBe(false); // nothing pending anymore
    expect(tooltip.visible.value).toBe(false);
  });

  test('clear hides a visible tooltip immediately', () => {
    const tooltip = new Tooltip.Class();
    tooltip.point('Stage', 10, 5);
    tooltip.tick(TOOLTIP_DWELL_SECONDS);
    expect(tooltip.visible.value).toBe(true);
    tooltip.clear();
    expect(tooltip.visible.value).toBe(false);
    expect(tooltip.text.value).toBe('');
  });
});
