// Verifies the terminal session-state recovery: the app re-enters the FULL terminal setup on
// focus-in so a VS Code tab-return restores termios raw mode (Ctrl+Q), mouse tracking, and a fresh
// frame. suspend()+resume() is OpenTUI's own idempotent re-setup; these tests gate that the routine
// is driven and that focus reporting is (dis)enabled with the right sequences.
import { test, expect } from 'bun:test';
import { TerminalSession } from '../TerminalSession';
import { HandlerGuard } from '../HandlerGuard';

test('reenterTerminalModes suspends, resumes, then re-enters the APP modes (2004 included)', () => {
  const calls: string[] = [];
  const control = {
    suspend: () => calls.push('suspend'),
    resume: () => calls.push('resume'),
  };

  TerminalSession.Class.reenterTerminalModes(control, (sequence) => calls.push(sequence));

  // Order matters: suspend records mouse state + tears down; resume re-applies OpenTUI's modes;
  // the app-owned bundle (focus reporting + bracketed paste) comes back LAST — this is the
  // regression gate for "recovery reasserted everything except bracketed paste".
  expect(calls).toEqual(['suspend', 'resume', '\x1b[?1004h\x1b[?2004h']);
});

test('enter/leaveAppModes write the complete bundle: focus reporting AND bracketed paste', () => {
  const entered: string[] = [];
  TerminalSession.Class.enterAppModes((sequence) => entered.push(sequence));
  expect(entered.join('')).toBe('\x1b[?1004h\x1b[?2004h');

  const left: string[] = [];
  TerminalSession.Class.leaveAppModes((sequence) => left.push(sequence));
  expect(left.join('')).toBe('\x1b[?2004l\x1b[?1004l'); // reverse order, shell left clean
});

test('the focus-in handler re-enters the terminal setup and forces a repaint', () => {
  // Mirror the Bootstrap focus handler: reenter (suspend+resume+app modes) then a repaint. A
  // regression that drops the re-setup on focus-in would leave the app dead after a tab switch.
  const events: string[] = [];
  const renderer = {
    suspend: () => events.push('suspend'),
    resume: () => events.push('resume'),
  };
  const onFocus = () => {
    HandlerGuard.Class.run('focus', () => {
      TerminalSession.Class.reenterTerminalModes(renderer, (sequence) => events.push(sequence));
      events.push('repaint');
    });
  };

  onFocus();

  expect(events).toEqual(['suspend', 'resume', '\x1b[?1004h\x1b[?2004h', 'repaint']);
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
