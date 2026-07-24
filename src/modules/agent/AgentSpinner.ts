// The thinking-spinner animator: a reactive `frame` counter advanced by a ~10 Hz timer ONLY while the
// session is busy. It is demand-driven — start() arms the timer, stop() tears it down, so at rest no
// timer ticks (idle quiescence holds) and the frame effect that fuses `frame` repaints on its own while
// busy. The scheduler is injected so a unit test drives the sequence with a fake clock (no real timer).
// Demand-driven by construction: no timer exists at rest, so idle quiescence holds.
import { Reactive } from 'ivue';
import { ref } from 'vue';

/** The timer seam — real globals in the app, a controllable pair in tests. */
export interface SpinnerScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  /** Wall clock for the elapsed-time counter (injected so a test drives it deterministically). */
  now(): number;
}

/** ~10 Hz: fast enough to read as motion, slow enough to cost nothing. */
const FRAME_INTERVAL_MILLISECONDS = 100;

const DEFAULT_SCHEDULER: SpinnerScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

class $AgentSpinner {
  private timerHandle: unknown = null;
  /** Wall-clock ms captured when the busy spell began (for the elapsed counter). */
  private startMilliseconds = 0;

  constructor(
    private readonly scheduler: SpinnerScheduler = DEFAULT_SCHEDULER,
    private readonly intervalMilliseconds: number = FRAME_INTERVAL_MILLISECONDS,
  ) {}

  /** The current animation frame index — fused into the pane's render revision so a tick repaints. */
  get frame() {
    return ref(0);
  }

  /** True while the timer is armed. */
  get running() {
    return ref(false);
  }

  /** Arm the ~10 Hz timer (idempotent). Each tick advances `frame`, driving the repaint. */
  start(): void {
    if (this.running.value) return;
    this.running.value = true;
    this.startMilliseconds = this.scheduler.now();
    this.timerHandle = this.scheduler.setInterval(() => {
      this.frame.value += 1;
    }, this.intervalMilliseconds);
  }

  /** Whole seconds elapsed since the busy spell began (0 at rest). Re-read each frame off the clock. */
  elapsedSeconds(): number {
    if (!this.running.value) return 0;
    return Math.max(0, Math.floor((this.scheduler.now() - this.startMilliseconds) / 1000));
  }

  /** The current wall-clock ms (the same injected clock) — for surfaces timing their own sub-intervals
   *  (e.g. how long a specific tool call has been pending) off the busy-only animation loop. */
  nowMilliseconds(): number {
    return this.scheduler.now();
  }

  /** Tear the timer down and reset the frame so the next busy spell starts clean (idempotent). */
  stop(): void {
    if (!this.running.value) return;
    this.running.value = false;
    if (this.timerHandle !== null) {
      this.scheduler.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    this.frame.value = 0;
  }

  dispose(): void {
    this.stop();
  }
}

export namespace AgentSpinner {
  export const $Class = $AgentSpinner;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
  export type Model = InstanceType<typeof Class>;
}
