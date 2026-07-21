// Movement/scroll feel — the HAND-TUNED product values and the curves that deliver them.
// "Speed is product, delivery is physics": what feels right is a product decision recorded here;
// the mechanisms (key-repeat runs, momentum) just deliver it. Stateless capability (Static).
import { Static } from 'ivue/extras';

class $ScrollPhysics {
  /** Key repeats within this window continue an acceleration run; a gap resets it. */
  static readonly KEY_RUN_WINDOW_MS = 150;

  /** Held-arrow ramp: near-immediate onset, steep build (user-tuned 2026-07-21: the ramp kicks in
   *  after ~2 fast repeats and climbs hard — holding feels fast almost immediately, while a single
   *  press or slow taps still move exactly 1 row). */
  static readonly KEY_ACCEL_START_RUN = 2; // presses before any acceleration (was 3)
  static readonly KEY_ACCEL_QUADRATIC = 0.4; // rows += this * (run - start)^2 (was 0.15)
  static readonly KEY_ACCEL_CAP_ROWS = 50; // max rows per repeat (was 45)

  /** Ctrl+Up/Down big-jump traversal: a screenful-ish stride that also ramps. Hand-tuned. */
  static readonly JUMP_BASE_ROWS = 15;
  static readonly JUMP_RAMP_ROWS = 5; // + per repeat in a run
  static readonly JUMP_CAP_ROWS = 120;

  /**
   * Rows a plain held arrow moves on the `runLength`-th repeat: 1 while tapping, then a
   * noticeably building quadratic ramp up to the cap.
   */
  static keyAcceleration(runLength: number): number {
    if (runLength < this.KEY_ACCEL_START_RUN) return 1;
    const ramp = this.KEY_ACCEL_QUADRATIC * (runLength - this.KEY_ACCEL_START_RUN + 1) ** 2;
    return Math.min(this.KEY_ACCEL_CAP_ROWS, Math.floor(1 + ramp));
  }

  /** Rows a Ctrl+arrow big jump moves on the `runLength`-th repeat. */
  static jumpRows(runLength: number): number {
    return Math.min(this.JUMP_CAP_ROWS, this.JUMP_BASE_ROWS + this.JUMP_RAMP_ROWS * runLength);
  }
}

export namespace ScrollPhysics {
  export const $Class = $ScrollPhysics;
  export const Class = Static($ScrollPhysics);
}
