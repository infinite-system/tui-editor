// A pure, dependency-free "N units ago" formatter — the GitLens-style relative date the blame part
// shows. It takes an explicit `nowMs` so it is deterministic and unit-testable (no ambient clock). The
// thresholds mirror the familiar coarse buckets (just now → minutes → hours → days → weeks → months →
// years); precision beyond the largest fitting unit is noise for a status-bar hint.
//
// invariant: A relative time reads in the largest fitting unit (src/modules/git/git.invariants.md)
import { Static } from 'ivue/extras';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** "1 day ago" / "3 days ago" — singular when the count is exactly one. */
function agoPhrase(count: number, unit: string): string {
  const whole = Math.max(1, Math.round(count));
  return `${whole} ${unit}${whole === 1 ? '' : 's'} ago`;
}

class $RelativeTime {
  /** Format the gap between `fromMs` and `nowMs` in the largest fitting unit. A future or equal instant
   *  reads "just now" (a clock skew never produces a negative age). */
  static format(fromMs: number, nowMs: number): string {
    const elapsed = nowMs - fromMs;
    if (elapsed < 45 * SECOND_MS) return 'just now';
    if (elapsed < 45 * MINUTE_MS) return agoPhrase(elapsed / MINUTE_MS, 'minute');
    if (elapsed < 24 * HOUR_MS) return agoPhrase(elapsed / HOUR_MS, 'hour');
    if (elapsed < 7 * DAY_MS) return agoPhrase(elapsed / DAY_MS, 'day');
    if (elapsed < 30 * DAY_MS) return agoPhrase(elapsed / WEEK_MS, 'week');
    if (elapsed < 365 * DAY_MS) return agoPhrase(elapsed / MONTH_MS, 'month');
    return agoPhrase(elapsed / YEAR_MS, 'year');
  }
}

export namespace RelativeTime {
  export const $Class = $RelativeTime;
  export const Class = Static($RelativeTime);
}
