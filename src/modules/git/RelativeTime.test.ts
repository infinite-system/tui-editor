// The pure relative-time formatter: deterministic buckets, singular/plural, and clock-skew safety.
import { test, expect } from 'bun:test';
import { RelativeTime } from './RelativeTime';

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => RelativeTime.Class.format(NOW - ms, NOW);

test('under 45s reads "just now"', () => {
  expect(ago(0)).toBe('just now');
  expect(ago(30 * SECOND)).toBe('just now');
});

test('minutes, singular and plural', () => {
  expect(ago(60 * SECOND)).toBe('1 minute ago');
  expect(ago(5 * MINUTE)).toBe('5 minutes ago');
});

test('hours', () => {
  expect(ago(HOUR)).toBe('1 hour ago');
  expect(ago(3 * HOUR)).toBe('3 hours ago');
});

test('days', () => {
  expect(ago(DAY)).toBe('1 day ago');
  expect(ago(3 * DAY)).toBe('3 days ago');
});

test('weeks', () => {
  expect(ago(14 * DAY)).toBe('2 weeks ago');
});

test('months', () => {
  expect(ago(40 * DAY)).toBe('1 month ago');
  expect(ago(90 * DAY)).toBe('3 months ago');
});

test('years', () => {
  expect(ago(400 * DAY)).toBe('1 year ago');
  expect(ago(800 * DAY)).toBe('2 years ago');
});

test('a future instant (clock skew) never goes negative — reads "just now"', () => {
  expect(RelativeTime.Class.format(NOW + 10 * SECOND, NOW)).toBe('just now');
});
