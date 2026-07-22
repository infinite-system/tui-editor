// The terminal is external session state the app does NOT own exclusively: a VS Code terminal tab
// (and others) resets that state when the tab is hidden and does not restore it — nor redraw — on
// return. Three symptoms follow a tab defocus→refocus, all from the same lost state:
//   1. TERMIOS raw mode reverts (IXON/flow-control back) → Ctrl+Q (XON) is eaten, the app can't quit.
//   2. SGR mouse tracking + focus reporting + alt-screen escape modes drop → wheel-scroll and
//      click-to-focus die.
//   3. The last painted frame is stale → the app looks frozen though it is alive.
//
// The fix is to re-assert the FULL terminal setup on return. OpenTUI already owns a complete,
// idempotent routine for this: suspend()+resume(). resume() re-applies termios raw mode
// (stdin.setRawMode(true) → IXON off, Ctrl+Q reaches the app), re-runs the native terminal setup
// (mouse SGR + focus reporting + alt-screen), re-enables mouse, and forces a full repaint. We reuse
// that rather than hand-writing escape sequences + tcsetattr, which would duplicate and desync
// OpenTUI's own terminal ownership.
//
// To RECEIVE the focus-in event that triggers the re-assert, focus reporting (DECSET 1004) must be
// on. OpenTUI's native setup enables it, but we also assert it explicitly at startup so a focus-in
// always arrives — without it the app gets no event and cannot self-heal.
//
// invariant: The render loop never wedges (project.invariants.md)
import { Static } from 'ivue/extras';

/** The minimal terminal-control surface the re-assert needs (a CliRenderer satisfies it). */
export interface TerminalControl {
  suspend(): void;
  resume(): void;
}

class $TerminalSession {
  /** DECSET 2004-style focus reporting: the terminal emits \e[I on focus-in, \e[O on focus-out. */
  static readonly FOCUS_REPORTING_ON = '\x1b[?1004h';
  static readonly FOCUS_REPORTING_OFF = '\x1b[?1004l';

  /** Enable focus reporting so the app RECEIVES focus-in (\e[I) — the trigger for the re-assert. */
  static enableFocusReporting(write: (sequence: string) => void): void {
    write(this.FOCUS_REPORTING_ON);
  }

  /** Disable focus reporting on shutdown so the shell we return to is not left in reporting mode. */
  static disableFocusReporting(write: (sequence: string) => void): void {
    write(this.FOCUS_REPORTING_OFF);
  }

  /**
   * Re-enter the full terminal setup after the session state was reset out from under us (tab
   * defocus→refocus, or a resize that dropped modes). suspend()+resume() is OpenTUI's own idempotent
   * routine: resume() re-applies termios raw (Ctrl+Q/XON restored), re-runs the native setup (mouse
   * SGR + focus reporting + alt-screen), re-enables mouse, and forces a FULL repaint of the true
   * current state. One routine restores all three post-defocus symptoms at once.
   */
  static reenterTerminalModes(control: TerminalControl): void {
    control.suspend();
    control.resume();
  }
}

export namespace TerminalSession {
  export const $Class = $TerminalSession;
  export let Class = Static($TerminalSession);
}
