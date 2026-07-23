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

/** The two supported TypeScript servers keyed by `typescriptServer` setting value. `tsgo` is the
 *  native `@typescript/native-preview` build — invoked with BOTH double-dash flags (`--lsp --stdio`). */
const SERVER_CANDIDATES: Record<string, ServerCandidate> = {
  tsgo: { command: 'tsgo', args: ['--lsp', '--stdio'] },
  'typescript-language-server': { command: 'typescript-language-server', args: ['--stdio'] },
};

/** Default preference order — tsgo primary, typescript-language-server fallback. */
const DEFAULT_ORDER: readonly string[] = ['tsgo', 'typescript-language-server'];

export interface TypeScriptProviderOptions {
  /** Late-read of the `typescriptServer` setting — the server to prefer ('tsgo' by default). */
  preferredServer?: () => string;
}

class $TypeScriptProvider implements LanguageProvider {
  readonly id = 'typescript';
  readonly capabilities: LanguageCapabilities = {
    diagnostics: true,
    definition: true,
    hover: true,
    references: true,
  };

  constructor(private readonly options: TypeScriptProviderOptions = {}) {}

  supportsPath(path: string): boolean {
    return TYPESCRIPT_EXTENSIONS.has(Files.Class.extname(path).toLowerCase());
  }

  async resolve(rootPath: string): Promise<LanguageServerCommand | null> {
    for (const server of this.candidateOrder()) {
      const candidate = SERVER_CANDIDATES[server];
      if (!candidate) continue;
      const command = this.findExecutable(candidate.command, rootPath);
      if (command) return { command, args: candidate.args };
    }
    return null;
  }

  /** Resolution order: the chosen server FIRST, then the other supported server as a graceful fallback
   *  (so a chosen-but-uninstalled server never disables LSP). Defaults to tsgo-primary when unset. */
  protected candidateOrder(): readonly string[] {
    const preferred = this.options.preferredServer?.() ?? 'tsgo';
    if (!SERVER_CANDIDATES[preferred]) return DEFAULT_ORDER;
    return [preferred, ...DEFAULT_ORDER.filter((server) => server !== preferred)];
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
