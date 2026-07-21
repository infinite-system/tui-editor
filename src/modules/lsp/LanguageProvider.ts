export interface LanguageServerCommand {
  command: string;
  args: readonly string[];
}

export interface LanguageCapabilities {
  diagnostics: boolean;
  definition: boolean;
  hover: boolean;
  references: boolean;
}

export interface LanguageProvider {
  readonly id: string;
  readonly capabilities: LanguageCapabilities;
  supportsPath(path: string): boolean;
  resolve(rootPath: string): Promise<LanguageServerCommand | null>;
}
