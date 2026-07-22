import { test, expect, describe } from 'bun:test';
import { Momentum, AT_REST, type MomentumOptions } from './Momentum';

// No-decay options: isolate the crossing-regularity property from the decay curve.
const NO_DECAY: MomentumOptions = { impulse: 10, max: 100, decayPerSec: 1, stopVelocity: 0.0001 };

describe('scroll-momentum', () => {
  test('at rest emits no rows', () => {
    expect(Momentum.Class.stepMomentum(AT_REST, 1 / 30).rows).toBe(0);
    expect(Momentum.Class.isMoving(AT_REST)).toBe(false);
  });

  test('an impulse sets velocity in the wheel direction and accumulates', () => {
    let momentum = Momentum.Class.addImpulse(AT_REST, 1, NO_DECAY); // +1 notch
    expect(momentum.velocity).toBe(10);
    momentum = Momentum.Class.addImpulse(momentum, 1, NO_DECAY); // same direction accumulates
    expect(momentum.velocity).toBe(20);
    momentum = Momentum.Class.addImpulse(momentum, -3, NO_DECAY); // opposite reverses
    expect(momentum.velocity).toBe(-10);
  });

  test('velocity is capped', () => {
    const momentum = Momentum.Class.addImpulse(AT_REST, 100, NO_DECAY);
    expect(momentum.velocity).toBe(100); // max
  });

  test('CROSSING REGULARITY: constant velocity crosses rows at a constant frame interval', () => {
    // velocity 15 rows/s, dt = 1/30 s → 0.5 rows/frame → exactly one row every 2 frames, forever.
    let momentum: typeof AT_REST = { velocity: 15, residual: 0 };
    const crossFrames: number[] = [];
    for (let frame = 1; frame <= 12; frame++) {
      const result = Momentum.Class.stepMomentum(momentum, 1 / 30, NO_DECAY);
      momentum = result.momentum;
      if (result.rows > 0) crossFrames.push(frame);
    }
    // Rows cross on frames 2,4,6,8,10,12 — a constant interval of 2 (regular, no judder).
    expect(crossFrames).toEqual([2, 4, 6, 8, 10, 12]);
  });

  test('total rows moved equals velocity*time (no rows lost or gained)', () => {
    let momentum: typeof AT_REST = { velocity: 30, residual: 0 };
    let total = 0;
    for (let index = 0; index < 30; index++) {
      const result = Momentum.Class.stepMomentum(momentum, 1 / 30, NO_DECAY); // 1s total
      momentum = result.momentum;
      total += result.rows;
    }
    expect(total).toBe(30); // 30 rows/s * 1s
  });

  test('decay glides to a halt with no slow sub-row tail', () => {
    let momentum = Momentum.Class.addImpulse(AT_REST, 3); // real decay defaults
    let frames = 0;
    while (Momentum.Class.isMoving(momentum) && frames < 1000) {
      momentum = Momentum.Class.stepMomentum(momentum, 1 / 30).momentum;
      frames++;
    }
    expect(Momentum.Class.isMoving(momentum)).toBe(false); // it stops
    expect(momentum.residual).toBe(0); // residual dropped at halt (no lingering sub-row)
    expect(frames).toBeLessThan(120); // halts within a few seconds, not forever
  });

  test('Momentum.Class.halt() immediately stops (adopt-and-stop for a programmatic jump)', () => {
    const moving = Momentum.Class.addImpulse(AT_REST, 5);
    expect(Momentum.Class.isMoving(moving)).toBe(true);
    expect(Momentum.Class.isMoving(Momentum.Class.halt())).toBe(false);
  });
});
