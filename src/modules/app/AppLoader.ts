// The process shell: everything between "the module graph is loaded" and "the app owns the terminal" —
// argv → BootOptions, the boot call, signal wiring, and the fatal path. A Static capability so the entry
// orchestration is overridable and the fatal path is unit-testable — it was neither while this logic sat
// as bare functions in main.ts, and the one real entry bug (the fatal handler depending on a dynamic
// import that could itself be the failure) lived exactly in that untested residue. The src/main.ts shim
// keeps only what a class cannot own: NODE_ENV set before the module graph loads, and the dynamic import
// that enforces that ordering.
//
// Distinct from Bootstrap by generator: Bootstrap COMPOSES the app (renderer, modules, frame loop);
// AppLoader owns the PROCESS around it (argv, signals, exit, fatal).
// invariant: Construction goes through overridable seams (project.invariants.md)
import { Static } from 'ivue/extras';
import { Bootstrap, type BootedApp } from './Bootstrap';
import { Logging } from '../system/Logging';

class $AppLoader {
  /** Boot the app from process state: argv → options, wire the signal handlers, and route any boot
   *  failure through the fatal path. The whole entry orchestration, swappable and testable. */
  static async main(): Promise<void> {
    try {
      const booted = await AppLoader.Class.bootApp();
      AppLoader.Class.wireSignals(booted);
    } catch (error) {
      AppLoader.Class.handleFatal(error);
    }
  }

  /** Assemble BootOptions from process state and boot — the overridable construction seam (a test
   *  swaps this to inject a scripted boot or a failure). */
  static bootApp(): Promise<BootedApp> {
    return Bootstrap.Class.boot({
      root: AppLoader.Class.rootArgument(),
      // Give the renderer a tick to restore the terminal, then exit.
      onQuit: () => setTimeout(() => AppLoader.Class.exitProcess(0), 20),
    });
  }

  /** The workspace root from argv (`invar <root>`), or undefined for the cwd default. */
  static rootArgument(): string | undefined {
    return process.argv[2];
  }

  /** Keep the process alive; the renderer owns the event loop via stdin. Signals route to the app's
   *  own shutdown so the terminal is restored before exit. */
  static wireSignals(booted: BootedApp): void {
    process.on('SIGINT', () => void booted.shutdown());
    process.on('SIGTERM', () => void booted.shutdown());
  }

  /** Fatal boot failure: stderr FIRST and unconditionally — the message must survive even when the
   *  module graph (and thus file logging) is broken; the file log is best-effort after. */
  static handleFatal(error: unknown): void {
    const detail = String((error as { stack?: unknown })?.stack ?? error);
    process.stderr.write(`fatal: ${detail}\n`);
    try {
      Logging.Class.error(`fatal: ${detail}`);
    } catch {
      /* logging unavailable — stderr already carries the message */
    }
    AppLoader.Class.exitProcess(1);
  }

  /** The one exit point — overridable so tests can assert exit codes without dying. */
  static exitProcess(code: number): void {
    process.exit(code);
  }
}

export namespace AppLoader {
  export const $Class = $AppLoader;
  export let Class = Static($AppLoader);
}
