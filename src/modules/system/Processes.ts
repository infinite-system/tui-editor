// Subprocess capability (Bun.spawn). All external-process access is confined here so the
// argument-injection boundary (L9) has one home: callers pass an ARGV ARRAY, never a shell
// string, so filenames/branches can never be interpreted as arguments or shell syntax.
//
// invariant: Language and git tools are separate failable processes (project.invariants.md)
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

class $Processes {
  /**
   * Run `argv` (no shell) in `cwd`, capturing output. Never throws on non-zero exit or a
   * missing binary — returns a RunResult with ok=false so callers degrade gracefully.
   */
  static async run(argv: string[], cwd?: string, input?: string): Promise<RunResult> {
    try {
      const proc = Bun.spawn(argv, {
        cwd,
        stdin: input ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (input && proc.stdin) {
        proc.stdin.write(input);
        await proc.stdin.end();
      }
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr, ok: code === 0 };
    } catch (e) {
      return { code: -1, stdout: '', stderr: String(e), ok: false };
    }
  }
}

export namespace Processes {
  export const $Class = $Processes;
  export let Class = $Processes;
}
