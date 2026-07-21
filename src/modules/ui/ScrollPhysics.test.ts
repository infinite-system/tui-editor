import { test, expect } from 'bun:test';
import { ScrollPhysics } from './ScrollPhysics';

test('key acceleration: quiet start, monotonic build, capped', () => {
  expect(ScrollPhysics.Class.keyAcceleration(0)).toBe(1);
  expect(ScrollPhysics.Class.keyAcceleration(2)).toBe(1); // tapping stays 1:1
  let previous = 1;
  for (let run = 3; run < 60; run++) {
    const rows = ScrollPhysics.Class.keyAcceleration(run);
    expect(rows).toBeGreaterThanOrEqual(previous); // monotonic
    previous = rows;
  }
  expect(previous).toBe(ScrollPhysics.Class.KEY_ACCEL_CAP_ROWS); // reaches the cap
  expect(ScrollPhysics.Class.keyAcceleration(15)).toBeGreaterThanOrEqual(20); // NOTICEABLE mid-hold
});

test('a two-second hold traverses ~1000 lines (feel target)', () => {
  // Key repeat ≈ 28/s after the initial delay -> ~56 repeats in 2s.
  let lines = 0;
  for (let run = 0; run < 56; run++) lines += ScrollPhysics.Class.keyAcceleration(run);
  expect(lines).toBeGreaterThan(900);
});

test('jump rows ramp from base to cap', () => {
  expect(ScrollPhysics.Class.jumpRows(0)).toBe(ScrollPhysics.Class.JUMP_BASE_ROWS);
  expect(ScrollPhysics.Class.jumpRows(50)).toBe(ScrollPhysics.Class.JUMP_CAP_ROWS);
});
