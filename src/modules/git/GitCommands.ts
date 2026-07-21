// Git CLI capability. Arguments are always passed as an argv array through Processes, never
// through a shell, and every process outcome is returned as data.
//
// invariant: Git command failures stay data (src/modules/git/git.invariants.md)
import { Processes } from '../system/Processes';
import { LOG_FORMAT } from './git.parsers';

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DiffNameStatusOptions {
  cached?: boolean;
}

export interface GitLogOptions {
  cwd: string;
  branch?: string;
  limit?: number;
  cursor?: string;
  /** Offset paging: skip this many commits before the page (for a virtualized window). */
  skip?: number;
}

class $GitCommands {
  protected static get Processes() {
    return Processes.Class;
  }

  private static async run(cwd: string, arguments_: string[]): Promise<GitCommandResult> {
    const result = await this.Processes.run(['git', ...arguments_], cwd);
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  static statusPorcelainV2Branch(cwd: string): Promise<GitCommandResult> {
    return this.run(cwd, [
      '-c',
      'core.quotepath=false',
      'status',
      '--porcelain=v2',
      '--branch',
    ]);
  }

  static diffNameStatus(
    cwd: string,
    options: DiffNameStatusOptions = {},
  ): Promise<GitCommandResult> {
    const arguments_ = ['diff', '--no-ext-diff', '--name-status'];
    if (options.cached) arguments_.push('--cached');
    return this.run(cwd, arguments_);
  }

  static log(options: GitLogOptions): Promise<GitCommandResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const arguments_ = [
      'log',
      '--decorate=short',
      '--date=iso-strict',
      `--max-count=${limit}`,
      `--format=${LOG_FORMAT}`,
    ];

    if (options.skip && options.skip > 0) {
      // Offset window: skip N from the branch/HEAD tip (for a virtualized commit list).
      arguments_.push(`--skip=${Math.floor(options.skip)}`);
      if (options.branch) arguments_.push(options.branch);
    } else if (options.cursor) {
      arguments_.push('--skip=1', options.cursor);
    } else if (options.branch) {
      arguments_.push(options.branch);
    }

    return this.run(options.cwd, arguments_);
  }

  /** Unified diff for one file: staged -> index vs HEAD; unstaged -> worktree vs index;
   *  untracked -> the whole file as additions (--no-index exits 1 on differences: not an error). */
  static diffFile(cwd: string, filePath: string, bucket: 'staged' | 'unstaged' | 'untracked'): Promise<GitCommandResult> {
    if (bucket === 'staged') return this.run(cwd, ['diff', '--no-ext-diff', '--no-color', '--cached', '--', filePath]);
    if (bucket === 'untracked')
      return this.run(cwd, ['diff', '--no-ext-diff', '--no-color', '--no-index', '--', '/dev/null', filePath]);
    return this.run(cwd, ['diff', '--no-ext-diff', '--no-color', '--', filePath]);
  }

  /**
   * Discard a file's changes in the working tree — DESTRUCTIVE (guarded by an explicit user
   * confirmation upstream; see 'Destructive working-tree operations require confirmation' in
   * git.invariants.md). untracked -> clean; staged -> restore index+worktree from HEAD;
   * unstaged -> restore worktree.
   */
  static discard(cwd: string, filePath: string, bucket: 'staged' | 'unstaged' | 'untracked'): Promise<GitCommandResult> {
    if (bucket === 'untracked') return this.run(cwd, ['clean', '-f', '--', filePath]);
    if (bucket === 'staged')
      return this.run(cwd, ['restore', '--staged', '--worktree', '--source=HEAD', '--', filePath]);
    return this.run(cwd, ['restore', '--', filePath]);
  }

  static show(cwd: string, ref: string): Promise<GitCommandResult> {
    return this.run(cwd, ['show', '--no-ext-diff', '--no-color', '--decorate=short', ref, '--']);
  }

  /** One commit's changed files as name-status lines (lazy commit expansion in the log). */
  static showNameStatus(cwd: string, sha: string): Promise<GitCommandResult> {
    return this.run(cwd, [
      '-c',
      'core.quotepath=false',
      'show',
      '--name-status',
      '--format=',
      '--no-ext-diff',
      '--no-color',
      sha,
      '--',
    ]);
  }

  /** Unified diff of ONE file as of ONE commit (parent → commit). Exits nonzero on a root commit
   *  (`<sha>^` does not exist) — callers fall back to `showCommitFile`. */
  static diffCommitFile(cwd: string, sha: string, filePath: string): Promise<GitCommandResult> {
    return this.run(cwd, ['diff', '--no-ext-diff', '--no-color', `${sha}^`, sha, '--', filePath]);
  }

  /** Root-commit fallback for `diffCommitFile`: the commit's own patch for one file. */
  static showCommitFile(cwd: string, sha: string, filePath: string): Promise<GitCommandResult> {
    return this.run(cwd, ['show', '--no-ext-diff', '--no-color', '--format=', sha, '--', filePath]);
  }

  static branchShowCurrent(cwd: string): Promise<GitCommandResult> {
    return this.run(cwd, ['branch', '--show-current']);
  }

  static stage(cwd: string, paths: string[]): Promise<GitCommandResult> {
    if (paths.length === 0) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return this.run(cwd, ['add', '--', ...paths]);
  }

  static unstage(cwd: string, paths: string[]): Promise<GitCommandResult> {
    if (paths.length === 0) return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    return this.run(cwd, ['restore', '--staged', '--', ...paths]);
  }
}

export namespace GitCommands {
  export const $Class = $GitCommands;
  export let Class = $GitCommands;
}
