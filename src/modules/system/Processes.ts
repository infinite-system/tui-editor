import { Static } from 'ivue/extras';
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
   * The parent environment with every GIT_* variable removed. A subprocess run here is scoped to an
   * explicit `cwd`; an ambient GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE (set, for example, when the
   * app or the test suite is spawned from inside a git hook) would OVERRIDE that cwd and make `git`
   * operate on the parent repo instead of the one at `cwd` — a hermeticity break. No subprocess the
   * app runs (git, ripgrep, language servers) wants the ambient git context, so strip it once here.
   */
  private static hermeticEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith('GIT_')) continue;
      environment[key] = value;
    }
    return environment;
  }

  /**
   * Run `argv` (no shell) in `cwd`, capturing output. Never throws on non-zero exit or a
   * missing binary — returns a RunResult with ok=false so callers degrade gracefully.
   */
  static async run(argv: string[], cwd?: string, input?: string): Promise<RunResult> {
    try {
      const subprocess = Bun.spawn(argv, {
        cwd,
        env: this.hermeticEnvironment(),
        stdin: input ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (input && subprocess.stdin) {
        subprocess.stdin.write(input);
        await subprocess.stdin.end();
      }
      const [stdout, stderr, code] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      return { code, stdout, stderr, ok: code === 0 };
    } catch (error) {
      return { code: -1, stdout: '', stderr: String(error), ok: false };
    }
  }
}

export namespace Processes {
  export const $Class = $Processes;
  export let Class = Static($Processes);
}
