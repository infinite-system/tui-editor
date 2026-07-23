// A deterministic TerminalBackend test double: no real shell, no PTY. Scripted bytes are pushed
// through onData via feed(); every write() is recorded so a test can assert the exact keystrokes /
// device-report replies the emulator produced. This is what keeps the terminal gate shell-free and
// non-flaky — scripted ANSI in, asserted cells out — while OpenPtyBackend proves real liveness.
//
// invariant: Terminal bytes cross exactly one backend seam (src/modules/terminal/terminal.invariants.md)
import type { TerminalBackend } from './TerminalBackend';

class $MockBackend implements TerminalBackend {
  private dataCallback: ((bytes: Uint8Array) => void) | null = null;
  private exitCallback: ((exitCode: number | null) => void) | null = null;
  /** Every string written toward the "child" — keystrokes and emulator replies, in order. */
  readonly writes: string[] = [];
  /** Every size pushed via resize(), in order. */
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  killed = false;
  readonly title = 'mock';

  write(data: string): void {
    this.writes.push(data);
  }

  onData(callback: (bytes: Uint8Array) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (exitCode: number | null) => void): void {
    this.exitCallback = callback;
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  kill(): void {
    this.killed = true;
  }

  /** Push scripted child output into the emulator (the inverse of write). */
  feed(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.dataCallback?.(bytes);
  }

  /** Simulate the child exiting. */
  exit(exitCode: number | null = 0): void {
    this.killed = true;
    this.exitCallback?.(exitCode);
  }
}

export namespace MockBackend {
  export const $Class = $MockBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
