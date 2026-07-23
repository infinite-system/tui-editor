// The terminal I/O seam — the honest minimal shape of "a source of terminal I/O". A terminal is
// bytes out (write), bytes in (onData), a size (resize), and a lifetime (kill/onExit); nothing about
// HOW those bytes are produced belongs here. This is the swap seam (parallel to the LSP
// LanguageProvider): OpenPtyBackend drives a real shell through a PTY; MockBackend scripts bytes for
// deterministic tests. The emulator and TerminalInstance depend ONLY on this interface, so the two
// implementations are interchangeable with zero change above the seam.
//
// invariant: Terminal bytes cross exactly one backend seam (src/modules/terminal/terminal.invariants.md)

/** A source of terminal I/O. The single boundary between the VT emulator and whatever produces the
 *  byte stream (a real PTY child, or a scripted test double). */
export interface TerminalBackend {
  /** Send bytes toward the child (keystrokes, and the emulator's device-report replies). */
  write(data: string): void;
  /** Register the sink for bytes coming FROM the child. Called once by the owning TerminalInstance. */
  onData(callback: (bytes: Uint8Array) => void): void;
  /** Push a new window size to the child (drives SIGWINCH / TIOCSWINSZ for a real PTY). */
  resize(columns: number, rows: number): void;
  /** Terminate the child and release every owned resource (fds, streams). Idempotent. */
  kill(): void;
  /** Register the sink for the child's exit. `exitCode` is null when the child was signalled. */
  onExit(callback: (exitCode: number | null) => void): void;
  /** Optional advertised title (e.g. the shell name) — display only. */
  readonly title?: string;
  /** Optional working directory — display only. */
  readonly cwd?: string;
}
