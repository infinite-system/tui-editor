// The real terminal backend: a shell running in a pseudo-terminal, wired per the proven Bun path
// (project.terminal-feasibility.md). node-pty does NOT work under Bun (instant EOF); the working
// decomposition is `openpty` via bun:ffi + `Bun.spawn` onto the slave fd. I/O rides node:fs (async
// push reads, no FFI polling); FFI is used ONLY for openpty, the resize ioctl, and the master write.
//
// Job control needs a controlling tty: on Linux we wrap the child in `setsid --ctty` (proven). macOS
// has no setsid, so job control is absent there for tier S (baseline interactivity + resize still
// work) — a tier-M follow-up (a login_tty helper) closes that gap.
//
// invariant: Terminal bytes cross exactly one backend seam (src/modules/terminal/terminal.invariants.md)
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { createReadStream, closeSync, type ReadStream } from 'node:fs';
import { Environment } from '../system/Environment';
import { Logging } from '../system/Logging';
import type { TerminalBackend } from './TerminalBackend';

// TIOCSWINSZ (Linux): the ioctl that sets a tty's window size. struct winsize is {u16 rows, cols,
// xpixels, ypixels}; changing it delivers SIGWINCH to the foreground process group.
const TIOCSWINSZ = 0x5414n;

/** openpty lives in libc on glibc systems and in libutil elsewhere — try libc first, fall back. The
 *  resize ioctl and the master write are always libc. */
function openPtyLibrary(): {
  openpty: (master: unknown, slave: unknown, name: unknown, termios: unknown, winsize: unknown) => number;
} {
  const openptySymbol = {
    openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  } as const;
  for (const libraryName of ['libc.so.6', 'libutil.so.1', 'libutil.so']) {
    try {
      // dlopen throws if the symbol is absent from this library, so a successful open means openpty
      // resolved here — glibc keeps it in libc; other libcs keep it in libutil.
      const library = dlopen(libraryName, openptySymbol);
      return library.symbols as never;
    } catch {
      /* try the next candidate library */
    }
  }
  throw new Error('openpty not found in libc or libutil');
}

const libraryControl = dlopen('libc.so.6', {
  ioctl: { args: [FFIType.int, FFIType.u64, FFIType.ptr], returns: FFIType.int },
  write: { args: [FFIType.int, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
});

class $OpenPtyBackend implements TerminalBackend {
  private readonly masterFileDescriptor: number;
  private readonly child: ReturnType<typeof Bun.spawn>;
  private readonly readStream: ReadStream;
  private dataCallback: ((bytes: Uint8Array) => void) | null = null;
  private exitCallback: ((exitCode: number | null) => void) | null = null;
  private killed = false;
  readonly title: string;
  readonly cwd: string;

  constructor(options: { columns?: number; rows?: number; shell?: string; cwd?: string } = {}) {
    const columns = options.columns ?? 80;
    const rows = options.rows ?? 24;
    const shell = options.shell ?? Environment.Class.env('SHELL') ?? 'bash';
    this.cwd = options.cwd ?? Environment.Class.cwd;
    this.title = shell.split('/').pop() ?? 'shell';

    const openptyLibrary = openPtyLibrary();
    const masterFileDescriptor = new Int32Array(1);
    const slaveFileDescriptor = new Int32Array(1);
    const openResult = openptyLibrary.openpty(
      ptr(masterFileDescriptor), ptr(slaveFileDescriptor), null, null, null,
    );
    if (openResult !== 0) throw new Error(`openpty failed (rc=${openResult})`);
    this.masterFileDescriptor = masterFileDescriptor[0] ?? -1;
    const slave = slaveFileDescriptor[0] ?? -1;
    this.applyWindowSize(columns, rows);

    // Linux gets a controlling tty (job control) via setsid --ctty; elsewhere spawn the shell bare.
    const command = process.platform === 'linux'
      ? ['setsid', '--ctty', shell, '-i']
      : [shell, '-i'];
    this.child = Bun.spawn(command, {
      cwd: this.cwd,
      stdio: [slave, slave, slave],
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    // The slave fd is owned by the child now; close our copy so the master sees EOF when the child exits.
    try { closeSync(slave); } catch { /* already closed */ }

    // Async push reads off the master fd (node:fs, no FFI polling). autoClose:false — we own the fd.
    this.readStream = createReadStream('', { fd: this.masterFileDescriptor, autoClose: false });
    this.readStream.on('data', (chunk: Buffer) => this.dataCallback?.(new Uint8Array(chunk)));
    this.readStream.on('error', () => { /* master closed on kill — expected, not an error to surface */ });

    void this.child.exited.then((exitCode) => {
      if (!this.killed) this.exitCallback?.(exitCode ?? null);
    });
  }

  write(data: string): void {
    if (this.killed) return;
    const buffer = Buffer.from(data, 'utf8');
    libraryControl.symbols.write(this.masterFileDescriptor, ptr(buffer), BigInt(buffer.length));
  }

  onData(callback: (bytes: Uint8Array) => void): void {
    this.dataCallback = callback;
  }

  onExit(callback: (exitCode: number | null) => void): void {
    this.exitCallback = callback;
  }

  resize(columns: number, rows: number): void {
    if (this.killed) return;
    this.applyWindowSize(columns, rows);
  }

  private applyWindowSize(columns: number, rows: number): void {
    const windowSize = new Uint16Array([Math.max(1, rows), Math.max(1, columns), 0, 0]);
    libraryControl.symbols.ioctl(this.masterFileDescriptor, TIOCSWINSZ, ptr(windowSize));
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    try { this.readStream.destroy(); } catch { /* already gone */ }
    try { this.child.kill(); } catch { /* already exited */ }
    try { closeSync(this.masterFileDescriptor); } catch { /* already closed */ }
    Logging.Class.info('OpenPtyBackend killed');
  }
}

export namespace OpenPtyBackend {
  export const $Class = $OpenPtyBackend;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
