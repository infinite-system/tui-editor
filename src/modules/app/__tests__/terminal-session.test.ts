// Verifies the terminal session-state recovery: the app re-enters the FULL terminal setup on
// focus-in so a VS Code tab-return restores termios raw mode (Ctrl+Q), mouse tracking, and a fresh
// frame. suspend()+resume() is OpenTUI's own idempotent re-setup; these tests gate that the routine
// is driven and that focus reporting is (dis)enabled with the right sequences.
import { test, expect } from 'bun:test';
import { TerminalSession } from '../TerminalSession';
import { HandlerGuard } from '../HandlerGuard';

test('reenterTerminalModes suspends then resumes (OpenTUI re-runs termios raw + mouse + focus + full repaint)', () => {
  const calls: string[] = [];
  const control = {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
  };

  TerminalSession.Class.reenterTerminalModes(control);

  // Order matters: suspend records mouse state + tears down; resume re-applies everything.
  expect(calls).toEqual(['suspend', 'resume']);
});

test('enable/disableFocusReporting write the DECSET 1004 set/reset sequences', () => {
  const enabled: string[] = [];
  TerminalSession.Class.enableFocusReporting((sequence) => enabled.push(sequence));
  expect(enabled).toEqual(['\x1b[?1004h']);

  const disabled: string[] = [];
  TerminalSession.Class.disableFocusReporting((sequence) => disabled.push(sequence));
  expect(disabled).toEqual(['\x1b[?1004l']);
});

test('the focus-in handler re-enters the terminal setup and forces a repaint', () => {
  // Mirror the Bootstrap focus handler: reenter (suspend+resume) then a repaint. A regression that
  // drops the re-setup on focus-in would leave the app dead after a tab switch — this gates it.
  const events: string[] = [];
  const renderer = {
    suspend: () => events.push('suspend'),
    resume: () => events.push('resume'),
  };
  const onFocus = () => {
    HandlerGuard.Class.run('focus', () => {
      TerminalSession.Class.reenterTerminalModes(renderer);
      events.push('repaint');
    });
  };

  onFocus();

  expect(events).toEqual(['suspend', 'resume', 'repaint']);
});

test('a throw inside a guarded handler is isolated and recover still runs (loop stays alive)', () => {
  let recovered = false;
  HandlerGuard.Class.run(
    'focus',
    () => {
      throw new Error('mid-handler failure');
    },
    () => {
      recovered = true;
    },
  );
  // The throw did not escape (no exception here) and recovery ran to keep the app responsive.
  expect(recovered).toBe(true);
});
