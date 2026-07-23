// The reactive user-settings store (MODEL layer). Fields are ref-returning getters so every read is
// reactive and every change LIVE-APPLIES to consumers (`Settings.Class.<field>.value`). Values are
// layered defaults <- user <- project: a user file at `~/.config/invar/settings.json` overrides the
// built-in defaults, and a workspace file at `.invar/settings.json` overrides the user file. Loading
// a missing or corrupt file never throws — it silently falls back to the layer beneath it.
//
// The filesystem is reached through an overridable `createFileSystem()` seam (a constructor-injected
// `fileSystem` wins) so tests drive the whole load/merge/save cycle against an in-memory fake and
// never touch the real `~/.config`.
import { Reactive } from 'ivue';
import { ref, type Ref } from 'vue';
import { Files } from '../system/Files';
import { Logging } from '../system/Logging';
import { Environment } from '../system/Environment';

/** The modifier key that re-routes wheel input, or `none` to leave it unbound. */
export type ScrollModifier = 'alt' | 'shift' | 'ctrl' | 'none';

/** How glyphs are selected for rendering: automatic detection or a forced tier. */
export type GlyphMode = 'auto' | 'nerd' | 'unicode' | 'ascii';

/** Where the project-layer tab strip is mounted in the root frame. */
export type WorkspaceTabPosition = 'top' | 'left';

/** Which TypeScript language server backs LSP. `tsgo` (the native-Go `@typescript/native-preview`
 *  build — ~14 MB vs ~580 MB for the Node family) is the PRIMARY default; `typescript-language-server`
 *  is the fallback. If the chosen binary can't be resolved, resolve() falls back to the other so LSP
 *  still works. NOTE: tsgo (pull-model) does not push diagnostics yet, so RED-SQUIGGLY DIAGNOSTICS
 *  only appear under `typescript-language-server` until LanguageClient gains pull-diagnostics. */
export type TypeScriptServer = 'tsgo' | 'typescript-language-server';

/** The full set of settable values — one field per reactive getter on the store. */
export interface SettingsValues {
  // Scroll physics.
  verticalFlingCeiling: number;
  scrollAccelGain: number;
  scrollFriction: number;
  linesPerNotch: number;
  // Wheel routing.
  horizontalScrollModifier: ScrollModifier;
  fastScrollModifier: ScrollModifier;
  fastScrollMultiplier: number;
  // Chrome.
  scrollbarThickness: number;
  glyphMode: GlyphMode;
  theme: string;
  wordWrap: boolean;
  workspaceTabPosition: WorkspaceTabPosition;
  // Language intelligence.
  typescriptServer: TypeScriptServer;
  // Splitter geometry.
  sidebarWidth: number;
  gitSplitRatio: number;
  diffSplitRatio: number;
  markdownSplitRatio: number;
}

/** Narrow filesystem seam the store depends on — the whole surface a fake must satisfy. */
export interface SettingsFileSystem {
  /** Read a text file, or `null` when it is missing or unreadable (never throws). */
  readTextFile(path: string): string | null;
  /** Write a text file, creating parent directories as needed. */
  writeTextFile(path: string, content: string): void;
  /** The current user's home directory. */
  homeDirectory(): string;
}

/** Locations the store reads from and writes back to; any omitted field is derived from the OS. */
export interface SettingsPaths {
  /** User-level file (written back by `save()`). Default: `~/.config/invar/settings.json`. */
  userPath?: string;
  /** Project-override file. Default: `<workspaceRoot>/.invar/settings.json`. */
  projectPath?: string;
  /** Workspace root used to derive `projectPath`. Default: `Environment.cwd`. */
  workspaceRoot?: string;
}

export interface SettingsOptions {
  /** Inject a fake filesystem (tests); when absent the default Files/Environment-backed one is used. */
  fileSystem?: SettingsFileSystem;
}

const ALLOWED_SCROLL_MODIFIERS: ReadonlySet<ScrollModifier> = new Set<ScrollModifier>([
  'alt',
  'shift',
  'ctrl',
  'none',
]);
const ALLOWED_GLYPH_MODES: ReadonlySet<GlyphMode> = new Set<GlyphMode>([
  'auto',
  'nerd',
  'unicode',
  'ascii',
]);
const ALLOWED_WORKSPACE_TAB_POSITIONS: ReadonlySet<WorkspaceTabPosition> = new Set([
  'top',
  'left',
]);
const ALLOWED_TYPESCRIPT_SERVERS: ReadonlySet<TypeScriptServer> = new Set<TypeScriptServer>([
  'tsgo',
  'typescript-language-server',
]);

class $Settings {
  constructor(readonly options: SettingsOptions = {}) {}

  // ---- Reactive fields (ref-returning getters; read/write via `.value`) --------------------------

  get verticalFlingCeiling(): Ref<number> {
    return ref(220);
  }
  get scrollAccelGain(): Ref<number> {
    return ref(34);
  }
  get scrollFriction(): Ref<number> {
    return ref(0.015);
  }
  get linesPerNotch(): Ref<number> {
    return ref(1);
  }
  get horizontalScrollModifier(): Ref<ScrollModifier> {
    return ref<ScrollModifier>('alt');
  }
  get fastScrollModifier(): Ref<ScrollModifier> {
    return ref<ScrollModifier>('none');
  }
  get fastScrollMultiplier(): Ref<number> {
    return ref(3);
  }
  get scrollbarThickness(): Ref<number> {
    return ref(1);
  }
  get glyphMode(): Ref<GlyphMode> {
    return ref<GlyphMode>('auto');
  }
  get theme(): Ref<string> {
    return ref('dark');
  }
  get wordWrap(): Ref<boolean> {
    return ref(false);
  }
  get workspaceTabPosition(): Ref<WorkspaceTabPosition> {
    return ref<WorkspaceTabPosition>('top');
  }
  get typescriptServer(): Ref<TypeScriptServer> {
    return ref<TypeScriptServer>('tsgo');
  }
  get sidebarWidth(): Ref<number> {
    return ref(32);
  }
  get gitSplitRatio(): Ref<number> {
    return ref(0.5);
  }
  get diffSplitRatio(): Ref<number> {
    return ref(0.5);
  }
  get markdownSplitRatio(): Ref<number> {
    return ref(0.5);
  }

  /** Every field keyed by name — the one place each name maps to its reactive cell. */
  private get fields(): { [Key in keyof SettingsValues]: Ref<SettingsValues[Key]> } {
    return {
      verticalFlingCeiling: this.verticalFlingCeiling,
      scrollAccelGain: this.scrollAccelGain,
      scrollFriction: this.scrollFriction,
      linesPerNotch: this.linesPerNotch,
      horizontalScrollModifier: this.horizontalScrollModifier,
      fastScrollModifier: this.fastScrollModifier,
      fastScrollMultiplier: this.fastScrollMultiplier,
      scrollbarThickness: this.scrollbarThickness,
      glyphMode: this.glyphMode,
      theme: this.theme,
      wordWrap: this.wordWrap,
      workspaceTabPosition: this.workspaceTabPosition,
      typescriptServer: this.typescriptServer,
      sidebarWidth: this.sidebarWidth,
      gitSplitRatio: this.gitSplitRatio,
      diffSplitRatio: this.diffSplitRatio,
      markdownSplitRatio: this.markdownSplitRatio,
    };
  }

  // ---- Filesystem seam ---------------------------------------------------------------------------

  private fileSystemInstance: SettingsFileSystem | undefined;

  /** Overridable owned construction of the filesystem capability. */
  protected createFileSystem(): SettingsFileSystem {
    return this.options.fileSystem ?? $Settings.defaultFileSystem();
  }

  protected get fileSystem(): SettingsFileSystem {
    return (this.fileSystemInstance ??= this.createFileSystem());
  }

  /** The default Files/Environment-backed filesystem (dependencies read late, inside each method). */
  static defaultFileSystem(): SettingsFileSystem {
    return {
      readTextFile(path: string): string | null {
        if (!Files.Class.exists(path)) return null;
        try {
          return Files.Class.read(path);
        } catch {
          return null;
        }
      },
      writeTextFile(path: string, content: string): void {
        Files.Class.write(path, content);
      },
      homeDirectory(): string {
        return (
          Environment.Class.env('HOME') ?? Environment.Class.env('USERPROFILE') ?? Environment.Class.cwd
        );
      },
    };
  }

  // ---- Path resolution ---------------------------------------------------------------------------

  private storedUserPath: string | undefined;

  /** Where `save()` writes — the resolved user path from the last `load()`, else the OS default. */
  get userSettingsPath(): string {
    return this.storedUserPath ?? this.resolvePaths().userPath;
  }

  private resolvePaths(paths: SettingsPaths = {}): { userPath: string; projectPath: string } {
    const home = this.fileSystem.homeDirectory();
    const workspaceRoot = paths.workspaceRoot ?? Environment.Class.cwd;
    return {
      userPath: paths.userPath ?? Files.Class.join(home, '.config', 'invar', 'settings.json'),
      projectPath: paths.projectPath ?? Files.Class.join(workspaceRoot, '.invar', 'settings.json'),
    };
  }

  // ---- Load / merge / save -----------------------------------------------------------------------

  /**
   * Load the store: merge defaults <- user file <- project file and apply the result to the reactive
   * fields. Missing or corrupt files fall back to the layer beneath them and never throw. Remembers
   * the resolved user path so a later `save()` writes back to the right place.
   */
  load(paths: SettingsPaths = {}): void {
    const resolved = this.resolvePaths(paths);
    this.storedUserPath = resolved.userPath;
    const userValues = this.readSettingsFile(resolved.userPath);
    const projectValues = this.readSettingsFile(resolved.projectPath);
    this.applyValues({ ...$Settings.defaults, ...userValues, ...projectValues });
  }

  /** Serialize the current values to the user-level file (best-effort; write errors are swallowed). */
  save(): void {
    const serialized = JSON.stringify(this.snapshot(), null, 2);
    try {
      this.fileSystem.writeTextFile(this.userSettingsPath, serialized + '\n');
    } catch {
      // Best-effort persistence — a failed write must never crash the app.
    }
    // save() is a SYNCHRONOUS disk write and MUST be infrequent (persist-on-settle, never per drag/scroll
    // tick — that stalls the frame). This trace lets the perf smoke assert exactly one save per drag.
    Logging.Class.info('settings-save');
  }

  /** Set one field and live-apply it; type-checked per key. */
  set<Key extends keyof SettingsValues>(key: Key, value: SettingsValues[Key]): void {
    this.applyValues({ [key]: value } as Partial<SettingsValues>);
  }

  /** A plain snapshot of every current value. */
  snapshot(): SettingsValues {
    const values = {} as SettingsValues;
    const fields = this.fields;
    for (const key of Object.keys(fields) as (keyof SettingsValues)[]) {
      (values[key] as SettingsValues[typeof key]) = fields[key].value;
    }
    return values;
  }

  /** Assign the provided fields to their reactive cells. */
  private applyValues(values: Partial<SettingsValues>): void {
    const fields = this.fields;
    for (const key of Object.keys(values) as (keyof SettingsValues)[]) {
      const value = values[key];
      if (value === undefined) continue;
      (fields[key] as Ref<SettingsValues[typeof key]>).value = value as SettingsValues[typeof key];
    }
  }

  /** Read + parse a settings file, returning only recognized, well-typed keys (never throws). */
  private readSettingsFile(path: string): Partial<SettingsValues> {
    const text = this.fileSystem.readTextFile(path);
    if (text === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    return $Settings.sanitize(parsed);
  }

  // ---- Static helpers ----------------------------------------------------------------------------

  static get defaults(): SettingsValues {
    return {
      verticalFlingCeiling: 220,
      scrollAccelGain: 34,
      scrollFriction: 0.015,
      linesPerNotch: 1,
      horizontalScrollModifier: 'alt',
      fastScrollModifier: 'none',
      fastScrollMultiplier: 3,
      scrollbarThickness: 1,
      glyphMode: 'auto',
      theme: 'dark',
      wordWrap: false,
      workspaceTabPosition: 'top',
      typescriptServer: 'tsgo',
      sidebarWidth: 32,
      gitSplitRatio: 0.5,
      diffSplitRatio: 0.5,
      markdownSplitRatio: 0.5,
    };
  }

  /** Keep only recognized keys whose value has the right shape — corrupt entries are dropped. */
  static sanitize(parsed: unknown): Partial<SettingsValues> {
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const result: Partial<SettingsValues> = {};
    const readNumber = (key: keyof SettingsValues): void => {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value as never;
    };
    const readModifier = (key: keyof SettingsValues): void => {
      const value = record[key];
      if (typeof value === 'string' && ALLOWED_SCROLL_MODIFIERS.has(value as ScrollModifier)) {
        result[key] = value as never;
      }
    };
    readNumber('verticalFlingCeiling');
    readNumber('scrollAccelGain');
    readNumber('scrollFriction');
    readNumber('linesPerNotch');
    readModifier('horizontalScrollModifier');
    readModifier('fastScrollModifier');
    readNumber('fastScrollMultiplier');
    readNumber('scrollbarThickness');
    if (typeof record.glyphMode === 'string' && ALLOWED_GLYPH_MODES.has(record.glyphMode as GlyphMode)) {
      result.glyphMode = record.glyphMode as GlyphMode;
    }
    if (typeof record.theme === 'string') result.theme = record.theme;
    if (typeof record.wordWrap === 'boolean') result.wordWrap = record.wordWrap;
    if (
      typeof record.workspaceTabPosition === 'string' &&
      ALLOWED_WORKSPACE_TAB_POSITIONS.has(record.workspaceTabPosition as WorkspaceTabPosition)
    ) {
      result.workspaceTabPosition = record.workspaceTabPosition as WorkspaceTabPosition;
    }
    if (
      typeof record.typescriptServer === 'string' &&
      ALLOWED_TYPESCRIPT_SERVERS.has(record.typescriptServer as TypeScriptServer)
    ) {
      result.typescriptServer = record.typescriptServer as TypeScriptServer;
    }
    readNumber('sidebarWidth');
    readNumber('gitSplitRatio');
    readNumber('diffSplitRatio');
    readNumber('markdownSplitRatio');
    return result;
  }
}

export namespace Settings {
  export const $Class = $Settings;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
