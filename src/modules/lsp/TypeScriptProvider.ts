import { Files } from '../system/Files';
import type {
  LanguageCapabilities,
  LanguageProvider,
  LanguageServerCommand,
} from './LanguageProvider';

const TYPESCRIPT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

interface ServerCandidate {
  command: string;
  args: readonly string[];
}

class $TypeScriptProvider implements LanguageProvider {
  readonly id = 'typescript';
  readonly capabilities: LanguageCapabilities = {
    diagnostics: true,
    definition: true,
    hover: true,
    references: true,
  };

  supportsPath(path: string): boolean {
    return TYPESCRIPT_EXTENSIONS.has(Files.Class.extname(path).toLowerCase());
  }

  async resolve(rootPath: string): Promise<LanguageServerCommand | null> {
    const candidates: readonly ServerCandidate[] = [
      { command: 'vtsls', args: ['--stdio'] },
      { command: 'typescript-language-server', args: ['--stdio'] },
    ];
    for (const candidate of candidates) {
      const command = this.findExecutable(candidate.command, rootPath);
      if (command) return { command, args: candidate.args };
    }
    return null;
  }

  protected findExecutable(command: string, rootPath: string): string | null {
    const local = Files.Class.join(rootPath, 'node_modules', '.bin', command);
    if (Files.Class.exists(local)) return local;
    try {
      return Bun.which(command);
    } catch {
      return null;
    }
  }
}

export namespace TypeScriptProvider {
  export const $Class = $TypeScriptProvider;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
