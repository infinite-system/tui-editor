// The terminal is external session state the app does NOT own exclusively: a VS Code terminal tab
// (and others) resets that state when the tab is hidden and does not restore it — nor redraw — on
// return. Four symptoms follow a tab defocus→refocus, all from the same lost state:
//   1. TERMIOS raw mode reverts (IXON/flow-control back) → Ctrl+Q (XON) is eaten, the app can't quit.
//   2. SGR mouse tracking + focus reporting + alt-screen escape modes drop → wheel-scroll and
//      click-to-focus die.
//   3. The last painted frame is stale → the app looks frozen though it is alive.
//   4. Bracketed paste (DECSET 2004) drops → paste and Hex dictation silently vanish. OpenTUI's
//      resume() re-asserts ITS modes but knows nothing of this one, so this module owns the complete
//      app-mode bundle (enter/reenter/leave) — mode ownership split across files is how a recovery
//      path forgets one.
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
  /** DECSET 1004 focus reporting: the terminal emits \e[I on focus-in, \e[O on focus-out. */
  static readonly FOCUS_REPORTING_ON = '\x1b[?1004h';
  static readonly FOCUS_REPORTING_OFF = '\x1b[?1004l';
  /** DECSET 2004 bracketed paste: pastes arrive framed \e[200~…\e[201~ (OpenTUI parses the framing
   *  into its `paste` event but never enables the mode — the app owns it). */
  static readonly BRACKETED_PASTE_ON = '\x1b[?2004h';
  static readonly BRACKETED_PASTE_OFF = '\x1b[?2004l';

  /** Enter the APP-owned terminal modes — the ones OpenTUI's native setup does NOT manage: focus
   *  reporting (insurance, so the recovery-triggering focus-in always arrives) and bracketed paste
   *  (paste/dictation delivery). Idempotent; called at boot AND from every recovery path — a mode
   *  asserted only at boot silently dies on the first tab defocus→refocus.
   *  This method is the bundle's single home: a new app-owned mode is added HERE, never inline. */
  static enterAppModes(write: (sequence: string) => void): void {
    write(this.FOCUS_REPORTING_ON + this.BRACKETED_PASTE_ON);
  }

  /** Leave the app-owned modes on shutdown (reverse order) so the shell we return to is clean. */
  static leaveAppModes(write: (sequence: string) => void): void {
    write(this.BRACKETED_PASTE_OFF + this.FOCUS_REPORTING_OFF);
  }

  /**
   * Re-enter the full terminal setup after the session state was reset out from under us (tab
   * defocus→refocus, or a resize that dropped modes). suspend()+resume() is OpenTUI's own idempotent
   * routine: resume() re-applies termios raw (Ctrl+Q/XON restored), re-runs the native setup (mouse
   * SGR + focus reporting + alt-screen), re-enables mouse, and forces a FULL repaint of the true
   * current state. The app-owned modes are NOT in OpenTUI's routine, so they are re-entered here
   * too — recovery restores the COMPLETE bundle or paste dies silently until restart.
   */
  static reenterTerminalModes(control: TerminalControl, write: (sequence: string) => void): void {
    control.suspend();
    control.resume();
    this.enterAppModes(write);
  }
}

export namespace TerminalSession {
  export const $Class = $TerminalSession;
  export let Class = Static($TerminalSession);
}
