// The permission flag must be resolved LIVE at each send, not frozen at agent creation — otherwise the
// Shift+Tab mode-line toggle lies (it flips the label while the running agent keeps its creation-time
// flag). These lock in the getter-is-read-now behavior shared by CliStreamBackend + CodexStreamBackend.
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { expect, test } from 'bun:test';
import { resolveLivePermission } from '../AgentBackend';

test('a plain boolean passes through; undefined is false', () => {
  expect(resolveLivePermission(true)).toBe(true);
  expect(resolveLivePermission(false)).toBe(false);
  expect(resolveLivePermission(undefined)).toBe(false);
});

test('a getter is read LIVE each call — a toggle since creation is honored on the next turn', () => {
  let bypass = true; // as if the agent was created with bypass ON (the default)
  const live = () => bypass;
  expect(resolveLivePermission(live)).toBe(true); // first turn: ON
  bypass = false; // user presses Shift+Tab → mode line flips to OFF
  expect(resolveLivePermission(live)).toBe(false); // next turn re-reads: now OFF (the fixed bug)
  bypass = true; // toggle back ON
  expect(resolveLivePermission(live)).toBe(true);
});
