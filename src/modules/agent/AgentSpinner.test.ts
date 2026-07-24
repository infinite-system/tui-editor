import { describe, expect, test } from 'bun:test';
import { AgentSpinner, type SpinnerScheduler } from './AgentSpinner';
import { AgentSpinnerFrames } from './AgentSpinnerFrames';

/** A controllable clock: capture the interval callback so a test can tick it deterministically. */
function fakeScheduler(): { scheduler: SpinnerScheduler; tick: () => void; armed: () => boolean; advance: (ms: number) => void } {
  let callback: (() => void) | null = null;
  let clock = 0;
  return {
    scheduler: {
      setInterval: (fn) => {
        callback = fn;
        return 1;
      },
      clearInterval: () => {
        callback = null;
      },
      now: () => clock,
    },
    tick: () => callback?.(),
    armed: () => callback !== null,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('AgentSpinnerFrames', () => {
  test('the braille cycle advances and wraps by frame index (unicode tier)', () => {
    const first = AgentSpinnerFrames.Class.glyphFor(0, 'unicode');
    const second = AgentSpinnerFrames.Class.glyphFor(1, 'unicode');
    expect(first).not.toBe(second);
    expect(AgentSpinnerFrames.Class.glyphFor(8, 'unicode')).toBe(first); // 8-frame cycle wraps
  });

  test('the ascii tier animates with a rotating bar (no braille)', () => {
    const frames = [0, 1, 2, 3].map((index) => AgentSpinnerFrames.Class.glyphFor(index, 'ascii'));
    expect(frames).toEqual(['|', '/', '-', '\\']);
    expect(AgentSpinnerFrames.Class.glyphFor(4, 'ascii')).toBe('|'); // 4-frame cycle wraps
  });

  test('the label is "Thinking…" while streaming and "Running <tool>…" while a tool runs', () => {
    expect(AgentSpinnerFrames.Class.labelFor('streaming', null, 'unicode')).toBe('Thinking…');
    expect(AgentSpinnerFrames.Class.labelFor('awaiting-tool', 'Bash', 'unicode')).toBe('Running Bash…');
    expect(AgentSpinnerFrames.Class.labelFor('awaiting-tool', null, 'unicode')).toBe('Running…');
    expect(AgentSpinnerFrames.Class.labelFor('streaming', null, 'ascii')).toBe('Thinking...');
  });
});

describe('AgentSpinner (injected clock)', () => {
  test('start arms the timer and each tick advances the frame; stop tears it down and resets', () => {
    const clock = fakeScheduler();
    const spinner = new AgentSpinner.Class(clock.scheduler);

    expect(spinner.running.value).toBe(false);
    expect(clock.armed()).toBe(false);

    spinner.start();
    expect(spinner.running.value).toBe(true);
    expect(clock.armed()).toBe(true);

    clock.tick();
    clock.tick();
    expect(spinner.frame.value).toBe(2);

    spinner.stop();
    expect(spinner.running.value).toBe(false);
    expect(clock.armed()).toBe(false);
    expect(spinner.frame.value).toBe(0); // reset so the next busy spell starts clean
  });

  test('start is idempotent (no second timer) and stop-at-rest is a no-op', () => {
    const clock = fakeScheduler();
    const spinner = new AgentSpinner.Class(clock.scheduler);
    spinner.start();
    spinner.start(); // must not arm a second interval
    clock.tick();
    expect(spinner.frame.value).toBe(1);
    spinner.stop();
    spinner.stop(); // idempotent
    expect(spinner.running.value).toBe(false);
  });

  test('dispose stops the timer (no ticking at rest)', () => {
    const clock = fakeScheduler();
    const spinner = new AgentSpinner.Class(clock.scheduler);
    spinner.start();
    spinner.dispose();
    expect(clock.armed()).toBe(false);
  });

  test('elapsedSeconds counts whole seconds since start; 0 at rest', () => {
    const clock = fakeScheduler();
    const spinner = new AgentSpinner.Class(clock.scheduler);
    expect(spinner.elapsedSeconds()).toBe(0); // at rest
    spinner.start();
    clock.advance(2500);
    expect(spinner.elapsedSeconds()).toBe(2);
    clock.advance(1000);
    expect(spinner.elapsedSeconds()).toBe(3);
    spinner.stop();
    expect(spinner.elapsedSeconds()).toBe(0); // torn down at rest
  });
});
