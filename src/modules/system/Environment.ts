import { Static } from './Static';
// System environment capability — static, allocation-free (namespace pattern).
// invariant: Imported dependencies are read late (project.invariants.md)

class $Environment {
  static get cwd(): string {
    return process.cwd();
  }

  static get isTTY(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  static get columns(): number {
    return process.stdout.columns ?? 80;
  }

  static get rows(): number {
    return process.stdout.rows ?? 24;
  }

  static env(key: string): string | undefined {
    return process.env[key];
  }
}

export namespace Environment {
  export const $Class = $Environment;
  export let Class = Static($Environment);
}
