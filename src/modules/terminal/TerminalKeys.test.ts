// Keystroke → terminal byte encoding: the control-byte, named-key, and printable cases a focused
// terminal must reproduce for the child.
import { test, expect } from 'bun:test';
import { TerminalKeys } from './TerminalKeys';
import type { KeyEvent } from '@opentui/core';

function key(partial: Partial<KeyEvent>): KeyEvent {
  return { name: '', ctrl: false, shift: false, meta: false, option: false, sequence: '', ...partial } as KeyEvent;
}

test('a printable character rides its own sequence', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'a', sequence: 'a' }))).toBe('a');
});

test('Ctrl+C encodes the interrupt control byte 0x03', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'c', ctrl: true, sequence: '\x03' }))).toBe('\x03');
});

test('Ctrl+D encodes EOF 0x04', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'd', ctrl: true }))).toBe('\x04');
});

test('Enter encodes carriage return', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'return' }))).toBe('\r');
});

test('Backspace encodes DEL 0x7f', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'backspace' }))).toBe('\x7f');
});

test('arrow keys encode CSI cursor sequences', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'up' }))).toBe('\x1b[A');
  expect(TerminalKeys.Class.encode(key({ name: 'left' }))).toBe('\x1b[D');
});

test('Escape encodes ESC', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'escape' }))).toBe('\x1b');
});

test('Shift+Tab encodes the back-tab sequence', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'tab', shift: true }))).toBe('\x1b[Z');
});

test('an unmapped modified key yields no bytes (not consumed)', () => {
  expect(TerminalKeys.Class.encode(key({ name: 'f5' }))).toBe('');
});
