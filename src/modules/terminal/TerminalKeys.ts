// Keystroke → terminal byte encoding. A focused terminal must turn an OpenTUI KeyEvent back into the
// raw bytes a real terminal would send to the child — canonical VT sequences derived from the PARSED
// key fields, NOT the incoming `sequence` (under the Kitty keyboard protocol `sequence`/`raw` carry
// Kitty-encoded escapes the shell cannot read). Pure, allocation-light, and unit-tested against the
// control-byte and arrow cases.
//
// invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
import { Static } from 'ivue/extras';
import type { KeyEvent } from '@opentui/core';

// CSI = ESC [ — the introducer for cursor/navigation sequences.
const CSI = '[';

/** Named keys → their canonical terminal bytes (unmodified). */
const NAMED_KEY_BYTES: Record<string, string> = {
  return: '\r',
  enter: '\r',
  tab: '\t',
  backspace: '', // DEL — what a terminal sends for Backspace
  escape: '',
  space: ' ',
  up: `${CSI}A`,
  down: `${CSI}B`,
  right: `${CSI}C`,
  left: `${CSI}D`,
  home: `${CSI}H`,
  end: `${CSI}F`,
  pageup: `${CSI}5~`,
  pagedown: `${CSI}6~`,
  delete: `${CSI}3~`,
  insert: `${CSI}2~`,
};

function $encode(key: KeyEvent): string {
  const name = key.name;
  // Ctrl+<letter> → the C0 control byte (Ctrl+A = 0x01 … Ctrl+Z = 0x1a). Ctrl+C, Ctrl+D, Ctrl+Z etc.
  // reach the child so job control and interrupts work.
  if (key.ctrl && !key.meta && !key.option && name && name.length === 1) {
    const code = name.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  // Shift+Tab is the back-tab sequence.
  if (name === 'tab' && key.shift) return `${CSI}Z`;
  const named = NAMED_KEY_BYTES[name];
  if (named) return named;
  // A plain printable character rides its own sequence (a single byte, no modifiers).
  const sequence = key.sequence;
  if (sequence && sequence.length >= 1 && !key.ctrl && !key.meta && !key.option) {
    const firstCode = sequence.charCodeAt(0);
    if (firstCode >= 0x20 && firstCode !== 0x7f) return sequence;
  }
  return '';
}

class $TerminalKeys {
  static encode = $encode;
}

export namespace TerminalKeys {
  export const $Class = $TerminalKeys;
  export const Class = Static($TerminalKeys);
}
