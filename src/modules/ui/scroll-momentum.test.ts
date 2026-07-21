import { test, expect, describe } from 'bun:test';
import {
  addImpulse,
  stepMomentum,
  halt,
  isMoving,
  AT_REST,
  type MomentumOptions,
} from './scroll-momentum';

// No-decay options: isolate the crossing-regularity property from the decay curve.
const NO_DECAY: MomentumOptions = { impulse: 10, max: 100, decayPerSec: 1, stopVelocity: 0.0001 };

describe('scroll-momentum', () => {
  test('at rest emits no rows', () => {
    expect(stepMomentum(AT_REST, 1 / 30).rows).toBe(0);
    expect(isMoving(AT_REST)).toBe(false);
  });

  test('an impulse sets velocity in the wheel direction and accumulates', () => {
    let m = addImpulse(AT_REST, 1, NO_DECAY); // +1 notch
    expect(m.velocity).toBe(10);
    m = addImpulse(m, 1, NO_DECAY); // same direction accumulates
    expect(m.velocity).toBe(20);
    m = addImpulse(m, -3, NO_DECAY); // opposite reverses
    expect(m.velocity).toBe(-10);
  });

  test('velocity is capped', () => {
    const m = addImpulse(AT_REST, 100, NO_DECAY);
    expect(m.velocity).toBe(100); // max
  });

  test('CROSSING REGULARITY: constant velocity crosses rows at a constant frame interval', () => {
    // velocity 15 rows/s, dt = 1/30 s → 0.5 rows/frame → exactly one row every 2 frames, forever.
    let m: typeof AT_REST = { velocity: 15, residual: 0 };
    const crossFrames: number[] = [];
    for (let frame = 1; frame <= 12; frame++) {
      const r = stepMomentum(m, 1 / 30, NO_DECAY);
      m = r.momentum;
      if (r.rows > 0) crossFrames.push(frame);
    }
    // Rows cross on frames 2,4,6,8,10,12 — a constant interval of 2 (regular, no judder).
    expect(crossFrames).toEqual([2, 4, 6, 8, 10, 12]);
  });

  test('total rows moved equals velocity*time (no rows lost or gained)', () => {
    let m: typeof AT_REST = { velocity: 30, residual: 0 };
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const r = stepMomentum(m, 1 / 30, NO_DECAY); // 1s total
      m = r.momentum;
      total += r.rows;
    }
    expect(total).toBe(30); // 30 rows/s * 1s
  });

  test('decay glides to a halt with no slow sub-row tail', () => {
    let m = addImpulse(AT_REST, 3); // real decay defaults
    let frames = 0;
    while (isMoving(m) && frames < 1000) {
      m = stepMomentum(m, 1 / 30).momentum;
      frames++;
    }
    expect(isMoving(m)).toBe(false); // it stops
    expect(m.residual).toBe(0); // residual dropped at halt (no lingering sub-row)
    expect(frames).toBeLessThan(120); // halts within a few seconds, not forever
  });

  test('halt() immediately stops (adopt-and-stop for a programmatic jump)', () => {
    const moving = addImpulse(AT_REST, 5);
    expect(isMoving(moving)).toBe(true);
    expect(isMoving(halt())).toBe(false);
  });
});
