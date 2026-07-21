import type { LanguageServerCommand } from './LanguageProvider';

export interface LspWritable {
  write(data: Uint8Array): number | Promise<number>;
  flush?(): unknown;
  end?(): unknown;
}

export interface LspProcessLike {
  readonly stdin: LspWritable | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly pid: number | null;
  readonly running: boolean;
  readonly error: string | null;
  start(command: LanguageServerCommand, cwd: string): boolean;
  dispose(): void;
}

interface SpawnedLspProcess {
  stdin: {
    write(data: Uint8Array): number | Promise<number>;
    flush(): unknown;
    end(): unknown;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
}

class $LspProcess implements LspProcessLike {
  private child: SpawnedLspProcess | null = null;
  private input: LspWritable | null = null;
  private output: ReadableStream<Uint8Array> | null = null;
  private exitPromise: Promise<number> = Promise.resolve(-1);
  private processError: string | null = null;
  private isRunning = false;
  private generation = 0;
  private stderrText = '';

  get stdin(): LspWritable | null {
    return this.input;
  }
  get stdout(): ReadableStream<Uint8Array> | null {
    return this.output;
  }
  get exited(): Promise<number> {
    return this.exitPromise;
  }
  get pid(): number | null {
    return this.child?.pid ?? null;
  }
  get running(): boolean {
    return this.isRunning;
  }
  get error(): string | null {
    return this.processError;
  }
  get stderr(): string {
    return this.stderrText;
  }

  /**
   * Spawn never throws across the editor boundary. A missing command becomes `false` plus
   * `error`, leaving the caller free to continue without semantic features.
   *
   * invariant: Server failures remain contained (src/modules/lsp/lsp.invariants.md)
   */
  start(command: LanguageServerCommand, cwd: string): boolean {
    if (this.isRunning) return true;
    this.processError = null;
    this.stderrText = '';
    const generation = ++this.generation;
    try {
      const child = Bun.spawn([command.command, ...command.args], {
        cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }) as unknown as SpawnedLspProcess;
      this.child = child;
      this.input = child.stdin;
      this.output = child.stdout;
      this.isRunning = true;
      this.exitPromise = child.exited.then(
        (code) => this.onExit(generation, code),
        (reason) => this.onExitError(generation, reason),
      );
      void this.readStderr(child.stderr, generation);
      return true;
    } catch (reason) {
      this.child = null;
      this.input = null;
      this.output = null;
      this.isRunning = false;
      this.processError = String(reason);
      this.exitPromise = Promise.resolve(-1);
      return false;
    }
  }

  /**
   * Close stdin and kill the owned child. Repeated disposal is harmless.
   *
   * invariant: Client disposal releases the server (src/modules/lsp/lsp.invariants.md)
   */
  dispose(): void {
    const child = this.child;
    ++this.generation;
    this.child = null;
    this.output = null;
    this.isRunning = false;
    try {
      this.input?.end?.();
    } catch {
      // The process may already have closed its input after a crash.
    }
    this.input = null;
    try {
      child?.kill();
    } catch {
      // Killing an already-exited process is a successful disposal outcome.
    }
  }

  private onExit(generation: number, code: number): number {
    if (generation !== this.generation) return code;
    this.isRunning = false;
    if (code !== 0) {
      const detail = this.stderrText.trim();
      this.processError = detail ? `Language server exited ${code}: ${detail}` : `Language server exited ${code}`;
    }
    return code;
  }

  private onExitError(generation: number, reason: unknown): number {
    if (generation === this.generation) {
      this.isRunning = false;
      this.processError = String(reason);
    }
    return -1;
  }

  private async readStderr(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (generation === this.generation) {
        const result = await reader.read();
        if (result.done) break;
        this.stderrText += decoder.decode(result.value, { stream: true });
        if (this.stderrText.length > 16 * 1024) this.stderrText = this.stderrText.slice(-16 * 1024);
      }
      this.stderrText += decoder.decode();
      reader.releaseLock();
    } catch {
      // stderr is diagnostic-only and cannot be allowed to destabilize the client.
    }
  }
}

export namespace LspProcess {
  export const $Class = $LspProcess;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
