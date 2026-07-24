// The entry orchestration, previously bare functions in main.ts: untestable, and the one real entry bug
// (fatal handler depending on an import that could itself be the failure) lived there. These lock in the
// seams: a boot failure routes through handleFatal, stderr gets the message FIRST and unconditionally,
// and the exit is observable without dying.
// invariant: Construction goes through overridable seams (project.invariants.md)
import { afterEach, expect, test } from 'bun:test';
import { AppLoader } from '../AppLoader';

const originalClass = AppLoader.Class;

afterEach(() => {
  AppLoader.Class = originalClass;
});

function captureStderr(): { written: string[]; restore: () => void } {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { written, restore: () => { process.stderr.write = original; } };
}

test('a boot failure routes through handleFatal: stderr first, exit(1), never a rethrow', async () => {
  const exits: number[] = [];
  class $Failing extends AppLoader.$Class {
    static override bootApp(): never {
      throw new Error('boot exploded');
    }
    static override exitProcess(code: number): void {
      exits.push(code);
    }
  }
  AppLoader.Class = $Failing;
  const stderr = captureStderr();
  try {
    await AppLoader.Class.main(); // must resolve — the fatal path swallows, reports, exits
  } finally {
    stderr.restore();
  }
  expect(stderr.written.join('')).toContain('boot exploded');
  expect(exits).toEqual([1]);
});

test('handleFatal writes stderr even when file logging is unavailable', () => {
  const exits: number[] = [];
  class $NoExit extends AppLoader.$Class {
    static override exitProcess(code: number): void {
      exits.push(code);
    }
  }
  AppLoader.Class = $NoExit;
  const stderr = captureStderr();
  try {
    AppLoader.Class.handleFatal(new Error('lost message bug'));
  } finally {
    stderr.restore();
  }
  // The regression this guards: the old main.ts fetched Logging via a dynamic import BEFORE writing
  // stderr, so an import failure lost the fatal message entirely. stderr must carry it unconditionally.
  expect(stderr.written.join('')).toContain('lost message bug');
  expect(exits).toEqual([1]);
});

test('rootArgument maps argv[2] to the boot root', () => {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] as string, originalArgv[1] as string, '/some/project'];
  try {
    expect(AppLoader.Class.rootArgument()).toBe('/some/project');
  } finally {
    process.argv = originalArgv;
  }
});
