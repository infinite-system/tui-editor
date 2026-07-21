import { Static } from 'ivue/extras';
// Time capability. Isolated so tests can inject deterministic time and undo-coalescing is
// reproducible. Static.
let override: (() => number) | null = null;

class $Clock {
  static now(): number {
    return override ? override() : Date.now();
  }

  /** Test hook: force `now()` to return a fixed/scripted value. */
  static freeze(timeSource: (() => number) | null): void {
    override = timeSource;
  }
}

export namespace Clock {
  export const $Class = $Clock;
  export let Class = Static($Clock);
}
