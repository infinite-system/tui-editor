// Graphics-tier detection over the REAL env matrix (the truecolor-detection lesson: env-branching
// detection ships inverted unless every branch is pinned by a test). The precedence under test:
// forced env override → tmux guard → OpenTUI's reported capabilities → env heuristics → half-block
// floor. The report, when present, is the terminal's own answer and is never second-guessed by env.
// invariant: Graphics tier prefers the reported capability and degrades to cells (src/modules/theme/theme.invariants.md)
import { afterEach, expect, test } from 'bun:test';
import {
  TerminalCapabilities,
  type GraphicsTier,
  type ReportedGraphicsCapabilities,
} from '../TerminalCapabilities';

const managedKeys = ['TUI_GRAPHICS_TIER', 'TMUX', 'TERM', 'KITTY_WINDOW_ID', 'TERM_PROGRAM'] as const;
type ManagedKey = (typeof managedKeys)[number];
const originalValues = new Map<ManagedKey, string | undefined>(
  managedKeys.map((key) => [key, process.env[key]]),
);

function withEnv(
  env: Partial<Record<ManagedKey, string>>,
  reported: ReportedGraphicsCapabilities | null,
): GraphicsTier {
  for (const key of managedKeys) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return TerminalCapabilities.Class.detectGraphicsTier(reported);
}

afterEach(() => {
  for (const [key, value] of originalValues) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const reportedAll: ReportedGraphicsCapabilities = { kitty_graphics: true, sixel: true, multiplexer: 'none' };
const reportedSixelOnly: ReportedGraphicsCapabilities = { kitty_graphics: false, sixel: true, multiplexer: 'none' };
const reportedNone: ReportedGraphicsCapabilities = { kitty_graphics: false, sixel: false, multiplexer: 'none' };

test('the reported capabilities decide the tier: kitty over sixel over half-block', () => {
  expect(withEnv({}, reportedAll)).toBe('kitty');
  expect(withEnv({}, reportedSixelOnly)).toBe('sixel');
  expect(withEnv({}, reportedNone)).toBe('halfblock');
});

test('a report beats contradicting env hints in both directions', () => {
  // Env screams kitty but the terminal reports no graphics: believe the terminal.
  expect(withEnv({ TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' }, reportedNone)).toBe('halfblock');
  // Env is silent but the terminal reports sixel: believe the terminal.
  expect(withEnv({ TERM: 'xterm-256color' }, reportedSixelOnly)).toBe('sixel');
});

test('tmux forces half-block regardless of reported riches (passthrough is unreliable)', () => {
  expect(withEnv({ TMUX: '/tmp/tmux-1000/default,123,0' }, reportedAll)).toBe('halfblock');
  expect(withEnv({}, { kitty_graphics: true, sixel: true, multiplexer: 'tmux' })).toBe('halfblock');
  expect(withEnv({}, { kitty_graphics: true, sixel: true, multiplexer: 'screen' })).toBe('halfblock');
  // 'unknown' is the struct default, not a detected multiplexer — it must NOT trip the guard.
  expect(withEnv({}, { kitty_graphics: true, sixel: true, multiplexer: 'unknown' })).toBe('kitty');
});

test('no report yet: conservative env heuristics, kitty terms first', () => {
  expect(withEnv({ TERM: 'xterm-kitty' }, null)).toBe('kitty');
  expect(withEnv({ TERM: 'xterm-ghostty' }, null)).toBe('kitty');
  expect(withEnv({ TERM: 'xterm-256color', KITTY_WINDOW_ID: '2' }, null)).toBe('kitty');
  expect(withEnv({ TERM: 'xterm-256color', TERM_PROGRAM: 'WezTerm' }, null)).toBe('sixel');
  expect(withEnv({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }, null)).toBe('sixel');
});

test('no report and no hints: the universal half-block floor (never flash a rich tier)', () => {
  expect(withEnv({ TERM: 'xterm-256color' }, null)).toBe('halfblock');
  expect(withEnv({}, null)).toBe('halfblock');
  expect(withEnv({ TERM: 'dumb' }, null)).toBe('halfblock');
});

test('TUI_GRAPHICS_TIER forces any tier, beating the report AND the tmux guard (the smoke seam)', () => {
  expect(withEnv({ TUI_GRAPHICS_TIER: 'kitty', TMUX: '/tmp/tmux-1000/default,1,0' }, reportedNone)).toBe('kitty');
  expect(withEnv({ TUI_GRAPHICS_TIER: 'sixel', TMUX: '/tmp/tmux-1000/default,1,0' }, reportedNone)).toBe('sixel');
  expect(withEnv({ TUI_GRAPHICS_TIER: 'halfblock' }, reportedAll)).toBe('halfblock');
  // An invalid override is ignored, not honored.
  expect(withEnv({ TUI_GRAPHICS_TIER: 'iterm' }, reportedAll)).toBe('kitty');
});
