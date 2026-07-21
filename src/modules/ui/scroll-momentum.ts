// Pure momentum physics for smooth scrolling on a CELL GRID. A terminal cannot render sub-row
// positions, so "smooth" means regular ROW-crossings at a steady cadence (the reparameterized
// crossing-regularity invariant: device-pixel → cell-row). We model velocity (rows/sec) that
// decays over time; a constant velocity emits row-crossings at a constant frame interval (regular),
// and we HALT below a threshold rather than creep the last rows slowly (sub-row ticking is
// impossible per the invariant — don't chase it). Pure: dt is passed in, so it is unit-testable
// with no clock and no renderer.

export interface ScrollMomentum {
  velocity: number; // rows per second (sign = direction); 0 = at rest
  residual: number; // fractional rows carried between frames [0,1)
}

export interface MomentumOptions {
  impulse: number; // velocity (rows/sec) added per unit of wheel delta
  max: number; // velocity cap (rows/sec)
  decayPerSec: number; // velocity multiplier applied per second (0..1); lower = shorter glide
  stopVelocity: number; // halt (and discard residual) once |velocity| drops below this
}

export const DEFAULT_MOMENTUM: MomentumOptions = {
  impulse: 22,
  max: 80,
  decayPerSec: 0.015,
  stopVelocity: 3,
};

// Vertical axis wants a HIGHER fast-scroll ceiling than horizontal: a hard fling should cover a long
// file/tree quickly. Same decay curve + stop threshold (so a gentle wheel is still precise and the
// One-Writer halt behaviour is unchanged) — only the top speed and per-notch gain are raised.
export const VERTICAL_MOMENTUM: MomentumOptions = {
  impulse: 34,
  max: 220,
  decayPerSec: 0.015,
  stopVelocity: 3,
};

export const AT_REST: ScrollMomentum = { velocity: 0, residual: 0 };

/** Add a wheel/flick impulse in the direction of `deltaRows`; same-direction impulses accumulate. */
export function addImpulse(momentum: ScrollMomentum, deltaRows: number, options: MomentumOptions = DEFAULT_MOMENTUM): ScrollMomentum {
  const velocity = momentum.velocity + deltaRows * options.impulse;
  return { velocity: Math.max(-options.max, Math.min(options.max, velocity)), residual: momentum.residual };
}

/**
 * Advance one frame by `dtSec`. Returns the next momentum and the WHOLE number of rows to move this
 * frame (signed). Under constant velocity the row-crossings land at a constant frame interval
 * (regular cadence); velocity decays geometrically; once it falls below `stopVelocity` we halt and
 * drop the residual so there is no slow sub-row tail.
 */
export function stepMomentum(
  momentum: ScrollMomentum,
  dtSec: number,
  options: MomentumOptions = DEFAULT_MOMENTUM,
): { momentum: ScrollMomentum; rows: number } {
  if (momentum.velocity === 0 || dtSec <= 0) return { momentum, rows: 0 };
  const advanced = momentum.residual + momentum.velocity * dtSec;
  const rows = Math.trunc(advanced);
  let residual = advanced - rows;
  let velocity = momentum.velocity * Math.pow(options.decayPerSec, dtSec);
  if (Math.abs(velocity) < options.stopVelocity) {
    velocity = 0;
    residual = 0;
  }
  return { momentum: { velocity, residual }, rows };
}

/** Immediately halt (adopt-and-stop for a programmatic jump — One-Writer-Per-Regime). */
export function halt(): ScrollMomentum {
  return AT_REST;
}

export function isMoving(momentum: ScrollMomentum): boolean {
  return momentum.velocity !== 0;
}
