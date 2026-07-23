# Invar Build Brief: Lightweight AI-Era TUI Code Workspace

## Mission

Build a production-quality prototype of a lightweight terminal-native code workspace using:

- **Bun**
- **TypeScript**
- **iVue**
- **OpenTUI Core**
- **Tree-sitter**
- **TypeScript LSP**
- **Git CLI integration**

The product should feel familiar to a VS Code user while remaining dramatically lighter, faster to start, and efficient across many Git worktrees.

This is not a Vim clone.

This is not a modal editor.

This is not a full terminal emulator.

This is not a browser-like IDE.

The product is a fast terminal workspace for:

- observing code changes made by humans or AI
- reviewing staged and unstaged Git changes
- navigating Git history by branch
- browsing project files
- opening and editing code
- jumping to definitions
- previewing Markdown
- rapidly switching between project files and Git-centric views

The initial release should optimize for one visible workspace at a time while keeping the architecture ready for multiple worktrees and future AI-agent control-plane features.

---

# Core Product Thesis

The project has three equal, non-negotiable goals:

1. **Ultimate practical performance**
2. **Exceptional developer experience**
3. **Scalability across large files, large repositories, many worktrees, many plugins, and future AI-agent workloads**

iVue is not being selected merely for convenient state management.

Its class, namespace, lifecycle, flyweight, sparse-observation, and extensible-kernel patterns are expected to make these three goals reinforce each other:

```text
better developer ergonomics
→ more coherent ownership
→ fewer accidental reactive graphs
→ easier lifecycle enforcement
→ easier profiling and replacement
→ lower memory and background activity
→ better scalability
```

The architecture must prove this through measurements.

Do not stop when the system merely works.

Continue optimizing until profiling shows visible and repeatable improvements in:

- startup time
- idle resident memory
- active editing memory
- file-switch latency
- input-to-render latency
- scroll performance
- Git refresh cost
- LSP activation and shutdown behavior
- resource release after buffers, previews, workspaces, or plugins close
- idle CPU
- scaling across multiple projects and worktrees

Reduce the implementation to the minimum machinery required for correctness, clarity, extensibility, and speed.

Prefer fewer objects, fewer effects, fewer retained graphs, fewer background processes, fewer abstractions, and fewer allocations.

Every abstraction must justify its runtime and maintenance cost.

The interface should preserve familiar controls and make them fast enough that users do not need to memorize a movement language.

Primary interaction principles:

- arrow keys work normally
- held arrow keys accelerate
- mouse clicks place the cursor
- `Cmd + click` jumps to definitions
- standard shortcuts work where possible
- all commands are discoverable through a command palette
- shortcuts are configurable through the interface
- no essential feature requires plugins
- plugins should extend the product, not complete it
- hidden or inactive surfaces should consume minimal resources
- reactivity should scale with what is visible and observed, not with everything that exists

The default experience must be usable within five minutes of installation.

---

# Initial Scope

Build only the following core surfaces.

## 0. Multi-Project and Multi-Worktree Workspace Layer

The application must be able to open multiple independent projects and multiple Git worktrees inside one process.

Treat projects/worktrees as a first-class navigation layer above file buffers.

Required behavior:

- open multiple project roots
- open multiple worktrees from the same repository
- open unrelated repositories in the same application
- keep each project/worktree isolated in its own workspace model
- switch between workspaces without launching a new editor process
- preserve open buffers, cursor positions, sidebar mode, Git state, and navigation history per workspace
- show active, warm, and cold workspace state
- lazily activate expensive services only for the current or recently used workspace
- suspend or dispose LSP, syntax trees, watchers, and render effects for inactive workspaces according to lifecycle policy

The workspace layer should use two levels of tabs:

```text
Level 1: Project / Worktree tabs
Level 2: File / Buffer tabs within the active workspace
```

### Project / Worktree Tabs

This is the outer navigation layer.

It switches the entire active workspace, including:

- repository or project root
- Git worktree
- current branch context
- open file tabs
- sidebar mode
- cursor and viewport state
- navigation history
- Git state
- LSP lifecycle state

These tabs may be placed:

- across the top
- vertically on the left
- in a dedicated workspace strip
- in a configurable compact or expanded mode

Placement must be configurable in settings.

Do not imitate the single-line, heavily truncated multi-project tabs common in graphical editors.

Project/worktree tabs may be multiline and should provide enough context to remain understandable over long sessions.

A tab may show:

```text
payments-api
feature/auth-refresh
8 changed · review needed
```

Or:

```text
billing-web
main
clean · LSP warm
```

Useful contextual fields include:

- project name
- repository name
- worktree name
- branch
- relative path when names collide
- changed-file count
- staged/unstaged count
- agent or task status in future
- test state in future
- active/warm/cold indicator
- dirty-buffer indicator
- LSP state

Avoid showing every field at once.

Use a crisp hierarchy and allow compact, normal, and expanded presentations.

Required tab behavior:

- keyboard and mouse switching
- move to previous workspace/worktree tab
- move to next workspace/worktree tab
- wrap around at the beginning and end
- preserve manual tab order
- restore the selected workspace state immediately
- close workspace
- reopen recently closed workspace
- pin workspace
- reorder workspace tabs manually
- clear active-state indication
- overflow handling without losing context
- optional multiline wrapping instead of forced truncation
- optional vertical layout for many workspaces
- optional grouping by repository
- clearly distinguish two worktrees from the same repository

Suggested labels:

```text
repo-name
branch-or-worktree
status summary
```

When the workspace bar is vertical, allow richer labels.

When it is horizontal, permit two-line tabs and wrapping into multiple rows.

Do not reorder project/worktree tabs automatically unless explicitly enabled.

Default ordering must remain the user's opening/manual order.

### File / Buffer Tabs

This is the inner navigation layer.

Within each active workspace, show a second tab layer for files and special views.

Switching file tabs must not change the active project or worktree.

Switching project/worktree tabs must restore that workspace's own file-tab collection and active file tab.

Examples:

- source files
- diffs
- commit details
- Markdown preview
- references
- diagnostics

File tabs should remain scoped to their workspace.

Switching workspace tabs restores that workspace's file-tab set.

The distinction between the two tab layers must always be visually obvious.

---

## 1. Left Sidebar

The left sidebar must support two main modes:

### Files View

Displays the project file tree.

Requirements:

- project root shown clearly
- directories can expand and collapse
- files can be opened with keyboard or mouse
- current file is highlighted
- Git status decorations may appear next to files
- ignored and generated directories should be excluded by default
- support switching to Git view without leaving the workspace

### Git View

Displays:

- current branch
- staged files
- unstaged files
- untracked files
- branch history
- recent commits for the selected branch
- changed-file counts
- automatic refresh when files change
- automatic refresh after stage, unstage, save, checkout, or commit operations

Required actions:

- open changed file
- open diff
- stage file
- unstage file
- stage all
- unstage all
- inspect commit
- inspect branch history
- show current branch prominently

The initial prototype does not need a graphical branch management system, rebase UI, merge UI, or push/pull interface unless they are trivial to add without expanding scope.

---

## 2. Main Editor Area

The right side contains the editor.

Requirements:

- open and edit text files
- save files
- normal cursor movement with arrow keys
- accelerated cursor movement when an arrow key is held
- mouse click positions cursor
- mouse drag selects text where OpenTUI supports it cleanly
- seamless real-time syntax highlighting while typing
- incremental syntax updates after every edit
- line numbers
- current-line highlight
- selection rendering
- horizontal and vertical scrolling
- multiple open buffers
- switch between buffers
- dirty-state indicator
- undo and redo
- search within current file
- project-wide file picker
- command palette
- TypeScript go-to-definition
- TypeScript find references if the selected LSP makes this straightforward
- `Cmd + mouse click` for go-to-definition
- keyboard fallback for definition navigation
- return-to-previous-location navigation
- diagnostics display
- Markdown preview in split pane

The editor must use a specialized high-performance viewport rather than a general component-per-line or component-per-character design.

---

## 3. Source Structure Map

Build a source structure outline for TypeScript and JavaScript files.

The structure map should make it easy to jump through a file without memorizing editor motions.

It should be available as:

- a sidebar mode
- an optional narrow outline pane
- a command-palette search source
- a quick overlay
- a breadcrumb or compact current-symbol indicator

Required recognized structures where parsing supports them:

- classes
- interfaces
- type aliases
- enums
- namespaces
- functions
- methods
- constructors
- getters
- setters
- properties
- static members
- private members
- protected members
- public members
- exported declarations
- nested functions where useful

For classes, differentiate clearly between:

- public methods
- protected methods
- private methods
- static methods
- constructors
- getters
- setters
- fields/properties

Use restrained icons, prefixes, or typography rather than visual clutter.

Example:

```text
UserService
  constructor
  + findById()
  + save()
  # validate()
  - loadSecrets()
  ↳ get status
  ↳ set status
```

The exact symbols may change, but the distinction must remain clear.

### Ordering Rule

By default, preserve source order exactly as items appear in the file or class.

Do not alphabetize.

Do not group all getters, methods, or fields together by default.

The structure map should reflect the author's real file organization.

Optional settings may allow:

- alphabetical order
- grouped by kind
- grouped by visibility
- public-first ordering
- static-first ordering

These are opt-in.

Default is always source order.

### Navigation

Required behavior:

- click or press Enter to jump to symbol
- preserve previous cursor location in navigation history
- current symbol highlighted
- structure map follows cursor optionally
- filter symbols by typing
- collapse and expand classes/namespaces
- show line numbers optionally
- show visibility and kind
- update incrementally after edits
- preserve scroll position where possible

Use Tree-sitter for fast structural extraction.

Use LSP document symbols when available for richer semantic information.

Prefer a merged model:

```text
Tree-sitter
→ immediate local structure

LSP document symbols
→ richer semantic detail when ready
```

Do not block outline display while waiting for LSP.

The source structure model must use compact storage and virtualized visible rows.

Do not create a permanently reactive model for every symbol in very large files.

---

## 4. Markdown Preview

Markdown files must support:

- normal source editing
- preview in a split pane
- synchronized refresh when the document changes
- headings
- paragraphs
- lists
- links
- code blocks
- emphasis
- block quotes
- tables if practical

The preview should render into terminal cells. It does not need browser-perfect Markdown layout.

The preview must be lazy:

- no preview model exists until opened
- no preview effects remain active when preview is closed
- expensive parsing should be incremental or debounced
- only visible preview lines should be rendered

---

# Explicit Non-Goals

Do not implement these in the initial prototype:

- integrated terminal
- debugger
- notebooks
- remote SSH development
- containers UI
- database tools
- extension marketplace UI
- collaborative editing
- AI chat interface
- autonomous agent execution
- cloud sync
- project-wide semantic index beyond what the selected LSP provides
- visual Git graph with complex merge topology
- full VS Code settings compatibility
- Vim emulation
- modal editing
- Electron
- browser DOM rendering

The user will use a separate terminal.

The application should leave clear extension points for future agent sessions, worktree orchestration, review queues, and AI activity timelines.

---

# Required iVue Reading Before Implementation

Before designing or generating the application architecture, browse and study the iVue documentation rather than relying only on prior Vue knowledge.

Required starting points:

- iVue guide introduction: https://ivue.dev/guide/introduction
- Flyweight guide: https://ivue.dev/guide/flyweight
- Flyweight grid example: https://ivue.dev/examples/flyweight-grid
- Extensible kernel example: https://ivue.dev/examples/extensible-kernel
- Full examples index: https://ivue.dev/examples/

The entire guide section must be explored through the pages listed in the left-side documentation navigation.

Do not read only the introduction page.

Review all relevant guide pages available from the left sidebar, including pages covering:

- standard architecture
- modules
- namespace pattern
- inheritance
- state
- computed values and watchers
- lifecycle and teardown
- flyweight architecture
- static runtime and backend class patterns where available
- experimental pages when they materially affect the architecture

The examples section must also be browsed beyond the index page.

Review all examples that may clarify:

- module organization
- class inheritance
- reactive state ownership
- lazy allocation
- lifecycle disposal
- high-cardinality flyweight storage
- sparse reactive overlays
- class-graph composition
- extension kernels
- plugin-safe architecture
- large virtualized datasets
- backend/static class patterns

Treat these pages as architecture specifications, not optional inspiration.

When implementation choices conflict with conventional Vue composable patterns, prefer the documented iVue class, namespace, lifecycle, and flyweight conventions unless benchmarks or correctness clearly justify a deviation.

Record important conclusions from the documentation in `ARCHITECTURE.md` and `DECISIONS.md`.

At minimum, document:

1. why durable application state uses iVue domain classes
2. why high-cardinality data uses compact storage and flyweight views
3. why cheap derived values use plain getters instead of defaulting to `computed()`
4. how effects are owned and disposed
5. how namespace `Class` bindings create replaceable extension seams
6. how the extensible kernel composes class graphs before application construction
7. why plain classes and static capability classes remain distinct from reactive models
8. how late dependency reads avoid circular initialization failures
9. how inactive workspaces, panes, buffers, parsers, and LSP processes are cooled or disposed
10. which documented iVue patterns are used directly and which are adapted for OpenTUI

Do not claim compliance with iVue patterns without reading the source documentation and examples.

---

# Technology Choices

## Runtime

Use Bun as the primary runtime and build tool.

Goals:

- TypeScript-first development
- fast startup
- single-command development
- standalone binary packaging where practical
- Bun subprocess APIs for Git and LSP
- Bun file APIs where useful

Do not assume that compilation to a Bun executable makes the application native-sized. Measure startup time, resident memory, and idle CPU.

---

## Reactive Architecture

Use iVue as the application-state and lifecycle system.

Install and use the iVue agent skill:

```bash
npm install ivue
npx ivue skill --all
```

Follow iVue's standard architecture consistently.

Use iVue for durable application models whose state must be observed declaratively.

Examples:

- App
- Workspace
- Sidebar
- FileTree
- GitRepository
- GitStatus
- GitHistory
- Buffer
- Cursor
- Selection
- Viewport
- Editor
- CommandPalette
- KeybindingSettings
- MarkdownPreview
- DiagnosticState
- NavigationHistory

Do not use Vue composable-style architecture as the main organization model.

Each domain should have one clear logic owner.

---

## Terminal Rendering

Use OpenTUI Core.

Use OpenTUI for:

- terminal initialization and cleanup
- keyboard input
- mouse input
- focus
- layout
- frame scheduling
- terminal capability handling
- optimized terminal drawing
- ordinary panels, lists, text, dialogs, and overlays

Use custom OpenTUI renderables for:

- code viewport
- Markdown preview viewport if needed
- diff view if general-purpose widgets are not fast enough

Do not use a Vue template renderer for the main editor viewport.

iVue owns application state.

OpenTUI owns terminal projection.

The direction of data flow is:

```text
OpenTUI input event
→ iVue model method
→ state or compact storage mutation
→ reactive invalidation
→ OpenTUI renderable requestRender()
→ frame render
```

Avoid two competing state systems.

---

# Class and Namespace Architecture

Every major module must follow a namespace-based extension pattern.

The invariant is:

```text
canonical raw class
+ mutable selected Class binding
+ late dependency access
```

Each module should expose a stable raw class and a mutable live class.

---

## 1. Reactive iVue Domain Models

Use for observable application state.

Example:

```ts
class $Buffer {
  readonly text: PieceTable.Model;
  readonly lines: LineIndex.Model;

  constructor(options: BufferOptions) {
    this.text = this.createText(options.initialText);
    this.lines = this.createLineIndex(this.text);
  }

  protected createText(initialText: string): PieceTable.Model {
    return new PieceTable.Class(initialText);
  }

  protected createLineIndex(
    text: PieceTable.Model,
  ): LineIndex.Model {
    return new LineIndex.Class(text);
  }

  get revision() {
    return ref(0);
  }

  get dirty() {
    return ref(false);
  }

  applyEdit(edit: TextEdit): void {
    this.text.apply(edit);
    this.lines.update(edit);
    this.revision.value++;
    this.dirty.value = true;
  }
}

export namespace Buffer {
  export const $Class = $Buffer;
  export let Class = Reactive($Class);

  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
```

Use:

- ref-returning getters for mutable reactive state
- shallow refs for large replaceable collections
- plain getters for cheap derived state
- computed values only when caching is clearly justified
- model methods for behavior
- owned effects for long-lived reactions
- explicit teardown for watchers and resources

Aim for a nearly computed-free architecture.

Do not create computed nodes by default.

---

## 2. Plain Stateful Classes

Use for algorithms, packed storage, handles, and resources that do not need direct reactive observation.

Examples:

- PieceTable
- Rope
- LineIndex
- PackedSyntaxStore
- FrameBuffer
- RingBuffer
- LspTransport
- TreeSitterParser
- SyntaxTreeHandle
- ProcessHandle
- FileWatcherHandle
- UndoStore
- DiffEngine

Example:

```ts
class $PieceTable {
  constructor(initialText: string) {}

  insert(offset: number, text: string): void {}

  delete(start: number, end: number): void {}

  slice(start: number, end: number): string {
    return "";
  }
}

export namespace PieceTable {
  export const $Class = $PieceTable;
  export let Class = $Class;

  export type Model = InstanceType<typeof Class>;
}
```

These classes may be plugin-extensible through the mutable `Class` binding.

Their internal fields should not be made reactive unless an observer truly needs them.

Reactive models should bridge these engines through small revision refs.

---

## 3. Static Capability Classes

Use static classes for stateless backend operations.

Examples:

- Files
- Paths
- Processes
- GitCommands
- Environment
- Clock
- Ids
- JsonRpc
- ProjectDetection
- ConfigurationIO
- Logging
- UnicodeUtilities

Use the experimental iVue static runtime when appropriate.

Example:

```ts
class $Files {
  static async read(path: string): Promise<string> {
    return Bun.file(path).text();
  }

  static async write(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }
}

export namespace Files {
  export const $Class = $Files;
  export let Class = Static($Class);
}
```

Static capabilities must remain replaceable in tests and plugins.

Cross-module dependencies must be read late.

---

# Dependency Construction Rule

Every meaningful dependency or policy decision should be behind an overridable method or getter.

Constructors assemble objects.

Constructors should not contain hidden dependency decisions.

Preferred pattern:

```ts
class $Buffer {
  readonly id: string;
  readonly createdAt: number;
  readonly text: PieceTable.Model;
  readonly lines: LineIndex.Model;

  constructor(options: BufferOptions) {
    this.id = this.createId();
    this.createdAt = this.createCreatedAt();
    this.text = this.createText(options.initialText);
    this.lines = this.createLineIndex(this.text);
  }

  protected createId(): string {
    return Ids.Class.v7();
  }

  protected createCreatedAt(): number {
    return Clock.Class.now();
  }

  protected createText(initialText: string): PieceTable.Model {
    return new PieceTable.Class(initialText);
  }

  protected createLineIndex(
    text: PieceTable.Model,
  ): LineIndex.Model {
    return new LineIndex.Class(text);
  }
}
```

This allows:

- tests to replace IDs and clocks
- plugins to replace storage engines
- specialized subclasses to tune policy
- future migrations from UUID v4 to UUID v7
- project-specific date formats
- alternate process runners
- alternate Git backends
- alternate syntax parsers
- alternate LSP providers

Prefer `createX()` for constructing owned values.

Prefer `get XClass()` when exposing the selected implementation itself is useful.

---

# Circular Dependency Rule

The architecture must be designed to avoid module-initialization circularity errors.

Rules:

- never construct imported classes at module top level
- never eagerly read another module's mutable `Class` binding at module top level
- never construct imported classes in static field initializers
- never create application singletons during module evaluation
- dependency reads happen inside constructors, methods, or getters
- kernel composition happens during an explicit boot phase
- application instances are created only after the kernel is sealed

Allowed:

```ts
constructor() {
  this.text = this.createText();
}

protected createText() {
  return new PieceTable.Class();
}
```

Avoid:

```ts
const sharedText = new PieceTable.Class();
```

Avoid:

```ts
class $Buffer {
  static defaultText = new PieceTable.Class();
}
```

Imports may be circular.

Runtime values must not be eagerly read across circular module boundaries.

---

# Constructor Virtual Dispatch Safety

Calling overridable methods from a base constructor is intentional, but must follow strict rules.

Constructor-time factory methods may depend only on:

- constructor arguments
- base fields initialized earlier
- static capabilities
- stable immutable constants

They must not depend on subclass fields because subclass initialization happens after `super()` returns.

For complex initialization, use a second phase:

```ts
const buffer = new Buffer.Class(options);
buffer.initialize();
```

Or:

```ts
const buffer = Buffer.Class.create(options);
```

Document every constructor-time extension method accordingly.

---

# Plugin Architecture

Prepare the application for two plugin levels.

## Contribution Plugins

Safer, additive plugins.

May register:

- commands
- keybindings
- themes
- panels
- language definitions
- status items
- file decorators
- Git actions
- Markdown render extensions

Example API:

```ts
api.commands.register(...)
api.keybindings.register(...)
api.panels.register(...)
api.languages.register(...)
api.themes.register(...)
```

## Kernel Plugins

Trusted, boot-time plugins that can deeply modify class behavior.

Use the iVue extensible-kernel pattern.

Allow registration like:

```ts
kernel.registerClass(
  "core/Buffer",
  Base =>
    class extends Base {
      override applyEdit(edit: TextEdit): void {
        Audit.Class.recordEdit(edit);
        super.applyEdit(edit);
      }
    },
  "edit-audit",
);
```

The kernel should:

1. register extension-point classes
2. capture inheritance relationships
3. register plugin factories
4. sort classes topologically
5. compose plugins in deterministic order
6. reparent descendants onto composed parents
7. apply `Reactive()` or `Static()` as appropriate
8. replace namespace `Class` bindings
9. seal before application construction

Existing instances should not be hot-mutated into new classes.

Plugin enable or disable may require:

- application restart
- workspace reload
- controlled reconstruction of affected models

Do not implement a full marketplace yet.

Create the architecture and one demonstration plugin.

Suggested demonstration:

- a plugin that adds Git-change navigation commands
- or a plugin that changes arrow acceleration policy

---

# Flyweight and Active-Set Architecture

The editor must not create one reactive object per:

- character
- line
- syntax token
- terminal cell
- Git history entry in a large repository
- file in a huge project
- Markdown token

Use:

- compact ground-truth storage
- packed arrays
- plain records
- viewport-only temporary facades
- sparse reactive revision signals
- explicit eviction

The governing principle is:

> Memory and reactive cost should scale with what is visible and actively observed, not with everything that exists.

---

## Editor Buffer Storage

Use a piece table or rope.

Do not use one string per keystroke as the main storage strategy.

The buffer model owns:

- compact text store
- line index
- undo history
- syntax parser handle
- revision ref
- dirty ref
- file metadata

The text engine remains plain and non-reactive.

The buffer increments a small revision ref after edits.

---

## Editor Viewport

The editor viewport should:

- render only visible lines
- request line slices from the text store
- obtain compact syntax spans
- use temporary line-view facades only when useful
- draw directly into an OpenTUI framebuffer
- avoid a retained object per line
- avoid a retained object per terminal cell
- avoid a component tree for every token
- batch output into frame renders

A terminal screen may use packed arrays such as:

```ts
class ScreenBuffer {
  readonly codepoints: Uint32Array;
  readonly styles: Uint32Array;
  readonly widths: Uint8Array;
}
```

Use previous and next framebuffers where OpenTUI does not already handle this optimally.

---

## File Tree

The file tree may be large.

Use:

- lazy directory expansion
- compact metadata
- virtualized visible rows
- no reactive model per file unless the file is visible or selected
- cached directory reads with bounded retention
- exclusion of ignored/generated directories

Use `.gitignore` and sensible defaults.

---

## Git History

Git history can become large.

Use:

- paged commit loading
- compact commit records
- virtualized visible rows
- no retained rich model for every historical commit
- lazy commit detail loading
- branch-specific history queries
- bounded caches

---

# Lifecycle and Resource Tiers

Implement explicit lifecycle states.

Suggested states:

```text
Hot
- visible and interactive
- effects active
- parser active
- LSP active if needed
- file watcher active
- full rendering active

Warm
- recently used
- compact state retained
- minimal watchers
- syntax tree may remain
- LSP may idle

Cold
- serialized metadata only
- no render effects
- no parser
- no LSP
- no expensive watcher

Disposed
- resources released
- effects stopped
- handles closed
```

Even in the first single-workspace prototype, write models so they can later be cooled and rehydrated.

Hidden panels must stop rendering effects.

Closed buffers must release parser trees and file watchers.

Inactive Markdown previews must be destroyed.

LSP servers must be lazily started.

No plugin may leave background work alive after disposal.

---

# Git Integration

Use Git CLI subprocesses initially.

Prefer stable porcelain formats.

Suggested commands:

```bash
git status --porcelain=v2 --branch
git diff --name-status
git diff --cached --name-status
git log --decorate --date=iso-strict
git show
git branch --show-current
```

Create a `GitCommands` static capability.

Create a `GitRepository` reactive model.

Create plain parsing helpers for Git output.

Refresh strategy:

- initial scan on workspace open
- filesystem watcher invalidates Git state
- debounce repeated file events
- manual refresh command
- refresh after Git operations
- refresh after save
- periodic safety refresh at a low frequency only if necessary

Do not poll aggressively.

Git model state should include:

- current branch
- head commit
- staged files
- unstaged files
- untracked files
- commit history page
- refresh status
- last refresh timestamp
- error state

The UI should never freeze while Git refreshes.

Run Git asynchronously.

Cancel or supersede stale refreshes.

---

# File Watching

Use a replaceable file-watching capability.

The watcher should:

- observe project file changes
- detect AI or human edits
- invalidate file metadata
- refresh Git state
- refresh visible buffers when safe
- detect external modification conflicts
- debounce event storms
- avoid watching ignored/generated directories where possible

Do not automatically overwrite dirty in-memory buffers.

If a file changes externally while dirty, surface a clear conflict warning.

---

# Diagnostics, Squiggles, and ESLint

The editor must show diagnostics directly in code.

Required diagnostic sources:

- TypeScript LSP
- Tree-sitter/parser errors where useful
- ESLint when enabled
- future plugin-provided diagnostics

Required severities:

- error
- warning
- information
- hint

## Visual Presentation

Render terminal-friendly squiggles or underlines under affected ranges.

Because terminal capabilities differ, support graceful fallback styles:

```text
preferred
→ undercurl when supported

fallback
→ underline or dotted underline

minimal fallback
→ colored range + gutter marker
```

Also show:

- gutter marker next to affected lines
- diagnostics count in status bar
- inline message optionally
- diagnostic details on hover, click, or keyboard command
- Problems/Diagnostics list as a view or overlay
- next/previous diagnostic commands

Recommended commands:

```text
diagnostic.next
diagnostic.previous
diagnostic.show
diagnostic.openList
diagnostic.toggleInlineMessage
```

Diagnostics must update as the user types without freezing the editor.

Use debounce where appropriate, but do not make the UI feel stale.

## Diagnostic Storage

Store diagnostics as compact records.

Do not create a full reactive class per diagnostic.

Use:

- plain compact records
- interval/range indexing
- buffer-level diagnostic revision
- visible-range flyweight views
- source-specific collections

Every diagnostic result must include:

- source
- severity
- message
- code when available
- range
- buffer revision or document version
- related information when available

Discard stale diagnostics that target an older document version.

## ESLint Integration

ESLint is valuable, but must remain optional and lazy.

Do not run ESLint continuously for every inactive workspace.

Support one or both of these providers:

1. ESLint language server
2. project-local ESLint CLI invoked on save or on demand

Preferred behavior:

```text
active JS/TS editing workspace
→ optionally start ESLint language server

inactive workspace
→ stop or suspend ESLint process

save
→ optional lint-on-save

manual command
→ lint current file or workspace
```

Settings:

- ESLint enabled
- provider: language server / CLI / disabled
- lint on type
- lint on save
- lint debounce
- use project-local ESLint
- fix on save
- show warnings
- show hints
- idle shutdown timeout

Defaults should avoid excess background cost.

Suggested default:

```text
ESLint enabled when project config exists
provider: language server if installed
lint on type: enabled with debounce
lint on save: enabled
fix on save: disabled
inactive workspace: stop after timeout
```

Do not bundle a second JavaScript parser architecture unnecessarily.

Use the project's own ESLint configuration and local dependency when possible.

## Problems View

Add a compact diagnostics/problems view.

Group by:

- workspace
- file
- severity

Default ordering:

- source/file order
- then line order

Do not alphabetize diagnostics by default.

Required actions:

- jump to diagnostic
- filter by severity
- filter by source
- show only current file
- show only current workspace
- refresh
- apply code action/fix when supplied by LSP

## Verification

Tests must cover:

- TypeScript error squiggle appears
- warning style differs from error
- diagnostic moves after edits
- stale diagnostic is rejected
- diagnostic disappears after fix
- Problems view jumps to correct location
- ESLint config detection
- ESLint unavailable fallback
- ESLint process starts lazily
- ESLint process stops for cold workspace
- lint-on-save
- optional fix-on-save
- no duplicate diagnostic when LSP and ESLint report the same issue unless sources differ meaningfully
- Unicode range correctness

The tmux harness must:

```text
open a TypeScript fixture with an error
→ verify gutter marker
→ verify squiggle/underline
→ open diagnostic details
→ fix the error
→ verify diagnostic disappears
```

For ESLint:

```text
open fixture with ESLint violation
→ verify ESLint diagnostic appears
→ save or invoke lint
→ apply fix when available
→ verify diagnostic clears
```

---

# TypeScript Language Intelligence

Provide TypeScript LSP support.

Architecture must allow multiple providers.

Suggested provider order:

1. experimental native TypeScript/Go LSP when stable and available
2. `vtsls`
3. `typescript-language-server`

Do not hardwire the entire editor to one server.

Create:

- `LanguageProvider` interface
- `LspProcess` plain resource owner
- `LspTransport` plain JSON-RPC transport
- `LanguageClient` reactive model
- `TypeScriptLanguageProvider` implementation

Required initial features:

- diagnostics
- go to definition
- jump back
- hover if straightforward
- find references if straightforward

Required interaction:

- `Cmd + mouse click` over a symbol invokes definition
- keyboard shortcut fallback
- command palette entry
- destination opens in current or split editor according to user action
- navigation history allows return

LSP startup must be lazy.

Start it when:

- a TypeScript or JavaScript file is opened and semantic features are enabled
- or the user invokes a semantic command

Do not start it for every project file at launch.

Shut it down on workspace disposal.

Prepare for future worktree suspension.

---

# Real-Time Syntax Highlighting

Syntax highlighting is part of the interactive editing loop, not a background decoration.

It must remain visually synchronized with the text while the user:

- types continuously
- inserts or deletes multiple lines
- pastes large blocks
- uses undo and redo
- changes brackets, strings, comments, regexes, and template literals
- edits temporarily invalid or incomplete code
- scrolls while parsing is occurring
- switches rapidly between buffers

Required flow:

```text
text edit
→ update compact text storage
→ update line index
→ apply Tree-sitter edit coordinates
→ incrementally reparse affected syntax
→ update compact highlight spans
→ invalidate affected visible regions
→ render the next frame
```

The editor must not wait for LSP or ESLint before updating ordinary syntax highlighting.

Tree-sitter provides the immediate syntactic layer.

LSP semantic tokens may enrich highlighting later, but they must never block typing or replace the immediate Tree-sitter result.

## Responsiveness Targets

```text
ordinary keystroke to updated syntax frame   < 16 ms when warm
small incremental parse                      < 8 ms where practical
no visible full-file highlighting flash
no temporary loss of all highlighting
no blocked input while parsing
```

For parsing work that exceeds the frame budget:

1. apply the text edit immediately
2. preserve unaffected highlighting
3. mark only changed regions dirty
4. perform bounded or asynchronous parsing work
5. discard stale parse results
6. apply only results matching the latest buffer revision
7. redraw only affected visible lines

Every parse/highlight result must carry:

- buffer ID
- buffer revision
- changed range
- parser generation when needed

Never allow an old parse result to overwrite highlighting for newer text.

## Highlight Storage

Store highlighting as compact spans, not reactive token objects.

Suggested representation:

```ts
type HighlightBatch = {
  starts: Uint32Array;
  ends: Uint32Array;
  styles: Uint16Array;
};
```

Do not create:

- one reactive object per token
- one component per token
- one effect per line
- one effect per syntax node

Use coarse revisions and affected-range invalidation.

## Coordinate Correctness

Explicitly distinguish:

- UTF-8 byte offsets
- UTF-16 offsets used by some LSP operations
- logical character offsets
- line/column positions
- terminal display columns
- tab-expanded columns

Test:

- Unicode
- tabs
- CRLF and LF
- combining characters
- wide characters
- multiline strings
- nested template literals
- comments
- incomplete syntax

## Semantic Highlight Enrichment

Recommended visual layering:

```text
base theme
→ Tree-sitter syntax
→ optional LSP semantic token overrides
→ diagnostics
→ Git decorations
→ selection
→ cursor/current line
```

Semantic tokens must be:

- asynchronous
- revision-aware
- independently configurable
- discarded when stale
- never required for basic highlighting

## Large Files

Degrade gracefully:

```text
normal file
→ full incremental Tree-sitter + optional semantic tokens

large file
→ visible-region queries + reduced retained spans

extreme file
→ limited syntax or lexical highlighting with a visible notice
```

Never freeze editing.

## Required Syntax Verification

Add tests for:

- highlighting after each typed character
- entering/leaving strings
- entering/leaving comments
- bracket insertion/deletion
- incomplete TypeScript
- multiline paste
- undo/redo restoration
- stale parse rejection
- rapid edits while parsing
- Unicode edits
- switching buffers mid-parse
- large-file degradation
- semantic-token enrichment arriving later

The tmux harness must visibly verify syntax updates while typing.

Where `tmux capture-pane` does not preserve style metadata, capture raw ANSI or render terminal screenshots.

---

# Tree-sitter

Use Tree-sitter for:

- syntax highlighting
- structural parsing
- folding
- bracket awareness
- code-block navigation
- syntax-aware selection where practical

Use an existing JS/native or WASM binding first.

Do not write a Rust bridge unless profiling proves it necessary.

Keep syntax trees only for active or warm buffers.

Release them for cold buffers.

Do not expose the full syntax tree as thousands of retained reactive JavaScript objects.

Return compact highlight spans.

Use packed ranges where practical.

---

# Arrow-Key Acceleration

This is a signature feature.

Terminals usually report repeated key events rather than true key-down and key-up events.

Infer continuous holding from repeat timing.

Required behavior:

```text
tap
→ one line or character

short hold
→ normal repeat

longer hold
→ gradual acceleration

release or pause
→ immediate reset

direction change
→ reset momentum
```

Suggested stepped vertical curve:

```text
0–300 ms       → 1 line per repeat
300–650 ms     → 2 lines
650–1000 ms    → 3 lines
1000–1500 ms   → 5 lines
1500 ms+       → 8 lines
```

Prefer time-normalized movement so behavior is less dependent on OS repeat settings.

Vertical acceleration may be stronger than horizontal acceleration.

Suggested controls:

- arrow tap: precise movement
- arrow hold: accelerated movement
- `Alt + arrow`: word or semantic boundary
- `Cmd + arrow`: line or document edge
- `Shift + arrow`: selection
- `Shift + held arrow`: accelerated selection
- page keys: viewport jump

Do not make acceleration surprising.

Add:

- configurable delay
- configurable curve
- configurable maximum speed
- immediate stop
- optional status feedback such as `↓ ×5`
- off switch

A future semantic-braking system may slow near:

- function headers
- Git changes
- diagnostics
- search matches
- code block boundaries

Do not overbuild semantic braking in the first milestone.

---

# Line Numbers and Gutter

The editor must provide a crisp, stable gutter.

Required:

- absolute line numbers by default
- optional relative line numbers
- current-line emphasis
- width adapts to document line count
- Git change markers
- diagnostic severity markers
- breakpoint space reserved only if future architecture needs it
- folding indicators where supported
- no jitter while scrolling or editing

Suggested gutter layers:

```text
fold marker
Git marker
diagnostic marker
line number
```

Keep the gutter compact.

Settings:

- line numbers: off / absolute / relative / hybrid
- current line number emphasis
- Git gutter enabled
- diagnostic gutter enabled
- folding markers enabled
- minimum gutter width

The line-number system must use viewport math, not one retained model per line.

Test:

- files crossing 9/99/999/9999 lines
- insert/delete changing line count
- relative numbering after cursor movement
- Git and diagnostic markers on same line
- wide terminal and narrow terminal layouts

---

# Mouse Interaction

Required:

- click to position cursor
- click files and Git items
- click sidebar tabs
- click command-palette entries
- scroll with mouse wheel
- `Cmd + click` symbol definition
- drag selection if reliable

Map terminal coordinates carefully through:

- sidebar offset
- split boundaries
- viewport scroll offset
- line-number gutter
- Unicode display width

---

# Keyboard and Command System

Every core action must exist as a command.

Examples:

- open file
- save file
- close buffer
- next buffer
- previous buffer
- switch sidebar view
- open command palette
- stage file
- unstage file
- stage all
- refresh Git
- go to definition
- go back
- preview Markdown
- toggle Markdown split
- search in file
- project file picker

Shortcuts are accelerators, not the only discoverable path.

Use familiar defaults where terminals permit them:

```text
Cmd/Ctrl + P         file picker
Cmd/Ctrl + F         search
Cmd/Ctrl + S         save
Cmd/Ctrl + K         command palette
Cmd/Ctrl + G         Git view
Ctrl + [             previous project/worktree tab
Ctrl + ]             next project/worktree tab
Cmd/Ctrl + Shift + [ previous file/editor tab
Cmd/Ctrl + Shift + ] next file/editor tab
F12                  definition
Shift + F12          references
```

The two tab layers must always use distinct commands and distinct shortcut families.

Required commands:

```text
workspace.previous
workspace.next
workspace.open
workspace.close
workspace.reopenClosed
workspace.moveLeft
workspace.moveRight

editorTab.previous
editorTab.next
editorTab.close
editorTab.reopenClosed
editorTab.moveLeft
editorTab.moveRight
```

Default behavior:

- `Ctrl + [` and `Ctrl + ]` walk through project/worktree tabs
- `Cmd + Shift + [` and `Cmd + Shift + ]` walk through file/editor tabs on macOS where the terminal forwards them
- provide `Ctrl`-based fallbacks when `Cmd` combinations are unavailable
- shortcuts must be reconfigurable
- command-palette entries must exist for every navigation action
- visible shortcut hints should make the distinction discoverable

Do not overload one shortcut to switch between both layers based on focus.

Workspace navigation and editor-tab navigation must remain semantically separate.

Account for terminal limitations on macOS `Cmd` keys.

Detect extended keyboard protocol support where OpenTUI exposes it.

Allow fallback bindings.

Build an in-app shortcut editor eventually, but for the prototype it is acceptable to provide:

- command palette
- visible shortcut hints
- a clean configuration file
- conflict detection

Do not require users to edit Lua.

---

# Suggested Screen Layout

Initial layout with two navigation layers:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Project / Worktree tabs                                                  │
│ payments-api · auth-refresh · 8 changed | billing-web · main · clean     │
├──────────────────────────┬───────────────────────────────────────────────┤
│ Project / Git / Outline  │ File / Buffer tabs                            │
│                          ├───────────────────────────────────────────────┤
│ [Files] [Git] [Outline]  │ Editor                                        │
│                          │                                               │
│ file tree                │ code viewport                                 │
│ or                       │                                               │
│ staged/unstaged          │ optional Markdown preview split               │
│ or                       │                                               │
│ source structure        │                                               │
│                          │                                               │
├──────────────────────────┴───────────────────────────────────────────────┤
│ Status: workspace · branch · file · cursor · diagnostics · LSP · Git    │
└──────────────────────────────────────────────────────────────────────────┘
```

Alternative vertical workspace layout:

```text
┌─────────────────────┬──────────────────────────┬─────────────────────────┐
│ Workspaces          │ Files / Git / Outline    │ Editor                  │
│                     │                          │                         │
│ payments-api        │                          │                         │
│ auth-refresh        │                          │                         │
│ 8 changed           │                          │                         │
│                     │                          │                         │
│ billing-web         │                          │                         │
│ main · clean        │                          │                         │
└─────────────────────┴──────────────────────────┴─────────────────────────┘
```

The workspace-tab location must be configurable.

Regardless of placement, the hierarchy must remain obvious:

```text
outer tabs
→ projects and worktrees

inner tabs
→ files, diffs, previews, and editor views inside the selected workspace
```

Default ordering must remain manual/opening order.

The interface must never hide which repository, worktree, and branch are active.


```text
┌──────────────────────────┬─────────────────────────────────────────────┐
│ Project / Git Sidebar    │ Editor                                      │
│                          │                                             │
│ [Files] [Git]            │ Tabs / Buffers                              │
│                          │                                             │
│ file tree                │ code viewport                               │
│ or                       │                                             │
│ staged                   │ optional Markdown preview split             │
│ unstaged                 │                                             │
│ untracked                │                                             │
│ branch history           │                                             │
│                          │                                             │
├──────────────────────────┴─────────────────────────────────────────────┤
│ Status: branch · file · cursor · diagnostics · LSP · Git refresh       │
└────────────────────────────────────────────────────────────────────────┘
```

The status bar should show:

- current branch
- active file
- dirty state
- line and column
- diagnostics count
- LSP status
- Git refresh status

Keep the interface calm and dense.

Do not imitate every VS Code panel.

---

# Suggested Module Layout

```text
src/
├── app/
│   ├── App.ts
│   ├── Bootstrap.ts
│   └── Lifecycle.ts
│
├── kernel/
│   ├── Kernel.ts
│   ├── Plugin.ts
│   ├── ExtensionPoints.ts
│   └── ContributionRegistry.ts
│
├── system/
│   ├── Files.ts
│   ├── Paths.ts
│   ├── Processes.ts
│   ├── Environment.ts
│   ├── Clock.ts
│   ├── Ids.ts
│   ├── Watchers.ts
│   └── Logging.ts
│
├── storage/
│   ├── PieceTable.ts
│   ├── LineIndex.ts
│   ├── UndoStore.ts
│   ├── RingBuffer.ts
│   ├── PackedSpans.ts
│   └── ScreenBuffer.ts
│
├── workspace/
│   ├── Workspace.ts
│   ├── WorkspaceManager.ts
│   ├── WorkspaceTabs.ts
│   ├── WorkspaceSnapshot.ts
│   ├── Project.ts
│   ├── Worktree.ts
│   ├── ProjectFiles.ts
│   ├── FileEntry.ts
│   └── FileTree.ts
│
├── editor/
│   ├── Editor.ts
│   ├── Buffer.ts
│   ├── Cursor.ts
│   ├── Selection.ts
│   ├── Viewport.ts
│   ├── MovementController.ts
│   ├── NavigationHistory.ts
│   ├── Search.ts
│   └── EditorRenderable.ts
│
├── syntax/
│   ├── SyntaxModel.ts
│   ├── TreeSitterParser.ts
│   ├── HighlightStore.ts
│   ├── SymbolOutline.ts
│   ├── SymbolStore.ts
│   ├── SymbolView.ts
│   └── LanguageRegistry.ts
│
├── lsp/
│   ├── LanguageClient.ts
│   ├── LanguageProvider.ts
│   ├── LspProcess.ts
│   ├── LspTransport.ts
│   ├── JsonRpc.ts
│   └── TypeScriptProvider.ts
│
├── git/
│   ├── GitCommands.ts
│   ├── GitRepository.ts
│   ├── GitStatus.ts
│   ├── GitHistory.ts
│   ├── GitParsers.ts
│   └── GitWatcher.ts
│
├── markdown/
│   ├── MarkdownDocument.ts
│   ├── MarkdownParser.ts
│   ├── MarkdownPreview.ts
│   └── MarkdownRenderable.ts
│
├── commands/
│   ├── Command.ts
│   ├── CommandRegistry.ts
│   ├── CommandPalette.ts
│   └── DefaultCommands.ts
│
├── keybindings/
│   ├── Keybinding.ts
│   ├── KeybindingRegistry.ts
│   ├── KeyboardInput.ts
│   └── DefaultKeybindings.ts
│
├── ui/
│   ├── RootView.ts
│   ├── Sidebar.ts
│   ├── FilesView.ts
│   ├── GitView.ts
│   ├── StatusBar.ts
│   ├── Tabs.ts
│   └── Overlay.ts
│
└── main.ts
```

Modify this structure only when a simpler coherent structure is clearly better.

Do not collapse unrelated domains into generic stores.

---

# Rendering and Reactivity Rules

## Ordinary Panels

Files view, Git view, status bar, tabs, and command palette may use ordinary OpenTUI renderables bound through small iVue effects.

Example:

```ts
this.$watchEffect(() => {
  title.content = this.workspace.name.value;
});
```

## High-Frequency Views

Editor viewport and large lists should use one coarse invalidation effect rather than many per-item effects.

Example:

```ts
this.$watchEffect(() => {
  this.buffer.revision.value;
  this.viewport.top.value;
  this.viewport.left.value;
  this.cursor.line.value;
  this.cursor.column.value;
  this.selection.revision.value;

  this.renderable.requestRender();
});
```

The custom renderable then pulls visible compact data during the render pass.

Do not create an effect per line.

Do not create an effect per token.

Do not create an effect per cell.

---

# Performance Mandate and Budgets

Performance is a primary product feature, not a later cleanup phase.

These are initial targets, not excuses to stop.

Measure them continuously.

For every major milestone:

1. record a baseline
2. profile CPU, memory, allocations, and subprocesses
3. identify the largest real bottleneck
4. change one architecture or implementation choice
5. rerun the same benchmark
6. record the before-and-after result
7. keep the change only when it improves the relevant metric without damaging correctness or developer experience

Continue this loop until the improvement is visible, repeatable, and documented.

Do not optimize based only on intuition.

Do not claim that flyweights, plain getters, lazy services, or OpenTUI are faster without demonstrating the effect in benchmarks.

Required evidence should include:

- process RSS before and after opening files
- process RSS after closing files and forcing normal cleanup opportunities
- LSP process memory separated from editor memory
- startup timing across multiple runs
- keypress-to-frame latency
- scrolling throughput
- idle CPU after activity stops
- Git refresh duration on small and large repositories
- workspace switch time between hot, warm, and cold states
- memory growth while opening and closing many buffers repeatedly
- memory growth while switching among many worktrees
- plugin activation and disposal costs

The final implementation should be reduced to the bone:

- no duplicate state
- no duplicate caches
- no permanent polling when event-driven invalidation is possible
- no effect that can be replaced by a plain method call
- no `computed()` that is not measurably worth caching
- no rich model where compact storage plus a flyweight view is enough
- no active LSP for an unobserved workspace
- no syntax tree retained without a clear warm-state reason
- no background watcher without an owner and disposal path
- no component tree for editor cells or source tokens
- no retained UI model for invisible high-cardinality items
- no abstraction layer that only renames another abstraction

If a simpler implementation benchmarks equally or better, use the simpler implementation.

If an iVue pattern adds overhead without delivering clarity, extensibility, lifecycle safety, or measurable scalability, adapt or remove it and document why.

The intended outcome is not theoretical elegance.

The intended outcome is a visibly fast, low-memory, comprehensible system that remains easy for humans and coding agents to extend.


Suggested prototype targets:

```text
Cold startup                 < 150 ms
Idle editor memory           < 100 MB
Typical project session      < 150 MB excluding LSP
Idle CPU                     approximately 0%
Input-to-screen latency      < 16 ms
Viewport render              < 8 ms when warm
Git refresh                  non-blocking
File switch                  visually immediate
```

Stretch targets:

```text
Cold startup                 < 75 ms
Idle editor memory           < 60 MB
Typical project session      < 100 MB excluding LSP
```

Always report editor process memory separately from:

- LSP processes
- Git subprocesses
- test runners
- AI agents
- development servers

---

# Bounded Resource Policies

Implement limits for:

- undo history
- Git history pages
- file tree cache
- Markdown preview cache
- syntax tree cache
- diagnostics retention
- log buffers
- command history

Use:

- LRU caches
- ring buffers
- pagination
- cold-state serialization
- explicit disposal

Do not leave unbounded arrays of events or snapshots.

---

# Error Handling

The TUI must recover cleanly from:

- failed Git command
- missing Git repository
- missing LSP executable
- LSP crash
- invalid project file permissions
- file deleted externally
- file modified externally
- syntax parser failure
- terminal resize
- unsupported key sequence
- plugin initialization failure

Errors should appear in a non-destructive status or notification surface.

The editor must restore terminal state on crash or exit.

---

# Testing Strategy

## Unit Tests

Required for:

- piece table edits
- line index updates
- cursor movement
- arrow acceleration
- selection
- undo and redo
- Git porcelain parsing
- commit log parsing
- path filtering
- command registration
- keybinding conflict detection
- LSP JSON-RPC framing
- navigation history
- flyweight eviction

## Integration Tests

Required for:

- open file, edit, save
- external file modification
- Git status refresh after edit
- stage and unstage
- branch detection
- commit history loading
- TypeScript definition jump
- Markdown split preview
- terminal resize
- plugin class composition
- disposal of watchers and subprocesses

## Performance Tests

Create benchmarks for:

- opening a large file
- scrolling through a large file
- repeated arrow movement
- 10,000-line syntax rendering
- continuous typing with incremental syntax updates
- rapid edits while stale parse work is in flight
- diagnostic update latency while typing
- project tree with many files
- Git history with thousands of commits
- memory before and after closing buffers
- memory before and after stopping LSP
- idle CPU after all activity stops

---

# Milestones

## Milestone 1: Boot and Frame

Deliver:

- Bun project
- iVue skill installed
- OpenTUI root renderer
- clean terminal startup and shutdown
- basic two-pane layout
- status bar
- command registry
- keybinding registry
- namespace conventions in place
- kernel boot phase

Acceptance:

- application starts
- terminal restores correctly
- resize works
- no idle render loop when nothing changes

---

## Milestone 2: Multi-Workspace Navigation, File Browser, and Read-Only Editor

Deliver:

- multiple project/worktree roots
- project/worktree tab layer
- configurable top or left workspace tabs
- multiline contextual workspace labels
- isolated per-workspace state restoration
- project root loading
- file tree
- file filtering
- open text file
- line numbers
- scrolling
- mouse file selection
- flyweight editor viewport
- Tree-sitter highlighting

Acceptance:

- multiple unrelated projects can be opened
- multiple worktrees from the same repository remain distinguishable
- switching workspaces restores its file tabs, active file, sidebar mode, cursor, viewport, and navigation history
- `Ctrl + [` and `Ctrl + ]` navigate workspace/worktree tabs
- a separate shortcut family navigates file/editor tabs
- workspace and file tabs never become ambiguous or share one navigation command
- workspace labels remain understandable without forced one-line truncation
- large files remain responsive
- no per-line reactive models
- only visible lines render
- syntax highlighting updates continuously while typing
- line numbers remain stable
- diagnostics render without blocking input

---

## Milestone 3: Editing

Deliver:

- cursor
- insertion
- deletion
- selection
- save
- dirty state
- undo and redo
- accelerated arrows
- mouse cursor placement
- file search
- command palette

Acceptance:

- normal editing works without modal commands
- held arrows accelerate predictably
- editor remains responsive under repeated input

---

## Milestone 4: Git

Deliver:

- current branch
- staged
- unstaged
- untracked
- stage
- unstage
- auto refresh
- branch history
- commit detail view
- open changed file
- diff view

Acceptance:

- AI or external edits appear automatically
- Git refresh never freezes editor
- current branch always visible
- staged and unstaged groups stay accurate

---

## Milestone 5: TypeScript LSP

Deliver:

- lazy LSP start
- diagnostics
- definition jump
- `Cmd + click`
- keyboard definition command
- navigation back
- find references if practical

Acceptance:

- editor works without LSP installed
- LSP failure does not crash editor
- LSP shuts down on disposal
- semantic navigation opens the correct file and location

---

## Milestone 6: Markdown Preview

Deliver:

- split editor layout
- Markdown preview
- live refresh
- close/dispose preview

Acceptance:

- preview opens and closes cleanly
- closed preview leaves no active render effect
- editing remains responsive

---

## Milestone 7: Plugin Demonstration

Deliver:

- class-graph kernel
- contribution registry
- one trusted kernel plugin
- one simple contribution plugin
- deterministic plugin order
- plugin boot errors surfaced clearly

Acceptance:

- plugin modifies behavior without changing core source
- disabling plugin restores default behavior after reload
- descendant class composition remains correct

---

# Autonomous Work Rules

Work autonomously.

Do not pause for routine clarification.

Make reasonable decisions that preserve the architecture and scope.

Prefer a complete vertical slice over many unfinished abstractions.

Keep the system runnable after every milestone.

Commit after meaningful milestones.

Use clear commit messages.

Maintain:

- `ARCHITECTURE.md`
- `DECISIONS.md`
- `BENCHMARKS.md`
- `KNOWN_LIMITATIONS.md`
- `TODO.md`

In `ARCHITECTURE.md` and `DECISIONS.md`, include direct links to the relevant iVue guide or example pages that informed each major architectural choice.

Document every deviation from this brief.

When uncertain, prefer:

1. measured performance over assumed performance
2. lower memory
3. lower idle activity
4. explicit ownership
5. simple runtime behavior
6. fewer allocations and retained objects
7. late dependency binding
8. replaceable construction seams
9. compact storage
10. viewport-only reactivity
11. standard familiar interactions
12. a smaller complete feature over a larger incomplete feature

Do not declare a milestone complete only because the feature works.

Every UI milestone must be exercised through the real tmux interaction harness and produce captured evidence.

A milestone is complete only when:

- it works
- it has tests
- its resources dispose correctly
- its benchmark is recorded
- its largest obvious waste has been removed
- its architecture remains understandable to a new contributor or coding agent

---

# Architectural Invariants

These must not be violated.

1. iVue owns observable application state.
2. OpenTUI owns terminal rendering and input projection.
3. Large datasets remain compact and non-reactive at rest.
4. Reactivity is an active observation overlay.
5. No per-character, per-token, or per-cell reactive objects.
6. Every long-lived effect has an owner.
7. Every subprocess and watcher has a disposal path.
8. Hidden surfaces stop active work.
9. Imported class dependencies are read late.
10. Constructors assemble dependencies through overridable seams.
11. The application is constructed only after plugin composition is sealed.
12. Plugins extend a complete product rather than supplying missing basics.
13. LSP is optional and lazy.
14. Git refresh is asynchronous and debounced.
15. Terminal rendering is event-driven, not a permanent busy loop.
16. Familiar controls are the default.
17. Shortcuts remain discoverable and reconfigurable.
18. The editor must remain useful when all plugins are disabled.
19. The first release has no integrated terminal.
20. Measure performance rather than assuming it.
21. Project/worktree tabs and file tabs remain separate navigation layers.
22. Workspace tab labels preserve enough context to identify repository, worktree, and branch.
23. Workspace ordering remains user-controlled by default.
24. Source outlines preserve source order by default.
25. Structure-map rendering is virtualized and non-blocking.
26. Every major subsystem has a reproducible benchmark.
27. Architectural performance claims require before-and-after measurements.
28. The editor must release inactive resources rather than merely hiding them.
29. Developer experience and runtime performance must improve together.
30. Prefer the smallest coherent architecture that meets the product requirements.
31. Workspace/worktree navigation and file-tab navigation are separate command domains.
32. Switching workspace tabs restores that workspace's complete inner editor-tab state.
33. Default shortcuts for outer and inner tab navigation remain distinct and reconfigurable.
34. Syntax highlighting remains incremental and revision-aware during typing.
35. Diagnostics never block editing and stale results are rejected.
36. ESLint is optional, lazy, project-aware, and disposable.
37. Line numbers and gutter markers are viewport-rendered without per-line reactive models.

---


# Verification Protocol

Verification is a primary deliverable.

Invar must prove that every requested subsystem exists, works together, disposes resources correctly, and meets the intended architecture.

Create and maintain:

- `VERIFICATION_PLAN.md`
- `project.verification-results.md`
- `project.performance-baselines.md`
- `RESOURCE_LIFECYCLE_AUDIT.md`
- `ARCHITECTURE_COMPLIANCE.md`
- `UX_REVIEW.md`

Every requirement in this brief must map to:

1. implementation location
2. automated test or manual verification procedure
3. expected result
4. actual result
5. evidence
6. pass/fail status
7. follow-up action when failed

Build a traceability matrix covering all major systems.

## Required Automated Checks

Run:

- TypeScript type checking
- linting
- unit tests
- integration tests
- rendering snapshot tests
- Git fixture tests
- LSP protocol tests
- plugin composition tests
- lifecycle/disposal tests
- benchmark suite
- repeated open/close stress tests
- repeated workspace-switch stress tests

No ignored test failures.

No unexplained flaky tests.

## Resource Leak Verification

For every owned resource type, test creation and disposal:

- iVue effects
- OpenTUI renderables
- filesystem watchers
- Git subprocesses
- LSP subprocesses
- Tree-sitter parser/tree handles
- timers
- event listeners
- Markdown preview models
- buffer caches
- plugin resources

Run repeated cycles and verify memory stabilizes.

## Adversarial Scenarios

Verify behavior under:

- external file deletion
- external file modification while clean
- external file modification while dirty
- Git command failure
- detached HEAD
- repository with no commits
- very large repository
- very large file
- binary file
- unusual Unicode
- LSP unavailable
- LSP crash
- Tree-sitter parser failure
- terminal resize during editing
- rapid arrow repeats
- file watcher event storms
- plugin initialization failure
- malformed settings
- conflicting keybindings


# Real Terminal UI Verification Harness

Invar must not verify the TUI only through unit tests or static inspection.

It must launch the built application inside a real terminal session and interact with it programmatically.

Use **tmux** as the preferred automation harness when available.

The harness must be able to:

- create an isolated tmux session
- set a known terminal size
- launch the TUI inside the pane
- wait for startup
- send keyboard input
- send repeated arrow-key sequences
- switch workspace tabs
- switch file tabs
- open Help
- open Settings
- open Files, Git, and Outline views
- open and edit files
- save changes
- stage and unstage files
- trigger definition navigation
- open Markdown preview
- resize the terminal
- exit cleanly
- capture the pane contents after each meaningful step
- inspect whether expected subprocesses are alive or stopped
- record failures and artifacts

Suggested commands:

```bash
tmux new-session -d -s tui-test -x 160 -y 48
tmux send-keys -t tui-test './dist/editor ./fixtures/project' Enter
tmux send-keys -t tui-test C-p
tmux capture-pane -p -t tui-test
tmux resize-window -t tui-test -x 100 -y 30
tmux kill-session -t tui-test
```

Use `tmux capture-pane -p` for text-based assertions.

Where visual fidelity needs verification, render captured ANSI output or terminal recordings into image artifacts.

Possible tools, if available:

- `tmux capture-pane`
- terminal ANSI snapshot parser
- `asciinema`
- `agg`
- headless terminal emulators
- screenshot utilities for a visible terminal session

Do not require screenshots for every test when text capture is sufficient.

Use screenshots or rendered terminal frames for:

- workspace-tab hierarchy
- multiline workspace labels
- active/inactive pane emphasis
- Git groups
- source outline
- Markdown preview
- Help UI
- Settings UI
- command palette
- diagnostics and selection rendering

Store verification artifacts under:

```text
artifacts/
├── terminal-captures/
├── screenshots/
├── recordings/
├── benchmark-results/
└── process-snapshots/
```

## Interaction Assertions

The tmux harness must assert visible state transitions.

Examples:

```text
launch
→ current branch appears
→ Files view appears
→ active workspace label appears
```

```text
send Ctrl+]
→ next workspace becomes active
→ file-tab row changes to that workspace's tabs
→ previous workspace state is preserved
```

```text
send Cmd/Ctrl+Shift+]
→ next file tab becomes active
→ workspace remains unchanged
```

```text
edit file externally
→ Git view refreshes
→ changed-file count updates
→ open clean buffer reloads or reports change
```

```text
stage file
→ file moves from unstaged to staged
→ Git count updates
```

```text
open Help
→ current shortcut bindings appear
```

```text
change setting
→ effective source appears
→ UI updates
→ persistence survives restart when applicable
```

## Visual Regression Baselines

Create stable terminal-frame baselines for core screens.

Normalize unstable values before comparison:

- timestamps
- process IDs
- temporary paths
- machine-specific usernames
- terminal capability differences

Compare semantic screen regions rather than requiring byte-identical ANSI output when that would create brittle tests.

## Process and Lifecycle Observation

During tmux tests, also inspect:

- editor PID
- child LSP PID
- Git subprocesses
- watcher handles where observable
- RSS
- CPU
- open file descriptors where practical

Verify:

- LSP starts only when expected
- inactive workspace LSP shuts down after policy timeout or explicit cooling
- no orphan subprocess remains after exit
- terminal state is restored after normal exit
- terminal state is restored after forced error handling paths

## Autonomous UI Repair Loop

When a terminal interaction test fails:

1. capture the current pane
2. save the input sequence
3. save logs and process state
4. identify whether the failure is model, input, layout, rendering, or timing
5. patch the smallest responsible subsystem
6. rerun the exact same interaction
7. compare before and after
8. add the scenario permanently to the regression suite

Invar must visibly operate the TUI it built.

It must not claim completion without demonstrating the real application through automated terminal interactions and captured evidence.


# Five-Pass Final Refinement and Verification Gauntlet

After all milestones are implemented, perform five complete refinement passes.

Each pass must begin from a fresh review of the whole repository.

Each pass must produce:

- findings
- severity
- modules involved
- proposed corrections
- applied corrections
- tests added or changed
- before/after measurements where relevant
- unresolved risks

### Pass 1 — Architecture and iVue Compliance

Review as an iVue framework architect.

Verify:

- correct reactive/plain/static/flyweight distinctions
- namespace pattern consistency
- late dependency reads
- overridable construction seams
- no eager circular runtime reads
- minimal `computed()` use
- effect ownership and teardown
- extensible-kernel correctness
- deterministic plugin ordering
- no drift into generic stores or composables
- no object-per-item high-cardinality models

### Pass 2 — Correctness and Failure Modes

Review as a senior editor, Git, and LSP engineer.

Verify:

- editing invariants
- line indexing
- undo/redo
- cursor and selection behavior
- Unicode width handling
- external file changes
- Git parsing and refresh races
- stale async cancellation
- LSP JSON-RPC correctness
- definition navigation
- navigation history
- Markdown rendering
- settings inheritance
- command/keybinding conflicts
- terminal restoration

Add regression tests for every defect found.

### Pass 3 — Performance and Scalability

Review as a performance engineer.

Profile:

- startup
- idle memory
- idle CPU
- rendering
- large-file scrolling
- file-tree virtualization
- outline virtualization
- Git refresh
- workspace switching
- parser retention
- LSP lifecycle
- repeated buffer cycles
- plugin activation
- allocations in hot paths

Remove unnecessary allocations, caches, effects, eager services, polling, retained invisible models, and redundant parsing.

Document at least one meaningful before/after performance improvement, or prove with measurements that no safe improvement was available.

### Pass 4 — UX and Discoverability

Review as a developer moving from VS Code or Nano, not as a Vim expert.

Verify:

- obvious two-level tab hierarchy
- understandable multiline workspace labels
- top/left workspace-tab layouts
- clear Files/Git/Outline switching
- discoverable shortcuts
- useful Help UI
- understandable Settings UI
- natural arrow acceleration
- mouse behavior
- no modal-editing assumptions
- crisp visual hierarchy
- no excessive clutter

Perform realistic end-to-end user journeys.

### Pass 5 — Adversarial Independent Review

Perform an independent whole-system review that assumes the previous four passes missed important issues.

Where the environment supports subagents, use separate independent reviewers with different roles, for example:

- one high-capability architecture reviewer
- one high-capability correctness reviewer
- one performance-focused reviewer
- one UX-focused reviewer
- one adversarial reviewer

If Opus and Sonnet-class subagents are available, use them as independent cross-reviewers rather than asking one agent to confirm its own work.

Do not ask subagents leading questions.

Give each reviewer:

- this brief
- the repository
- test results
- benchmark results
- known limitations

Require each reviewer to produce independent findings before sharing findings from other reviewers.

Then cross-compare:

- agreements
- contradictions
- missing coverage
- false assumptions
- unresolved risks

Resolve all critical and high-severity findings.

Document medium findings explicitly if deferred.

A pass is not complete merely because a reviewer says “looks good.”

Evidence is required.

---

# Definition of Done

The prototype is done when a user can:

1. run the TUI from a project directory
2. see the current Git branch
3. switch between multiple projects or worktrees with dedicated previous/next workspace shortcuts
4. switch between file/editor tabs with a separate shortcut family
5. distinguish repository, worktree, and branch from the workspace tab
6. restore each workspace's own file-tab state when switching back
7. switch between Files, Git, and Outline views
8. browse and open files
9. edit and save files
10. move naturally with normal and accelerated arrows
11. click to place the cursor
12. see staged, unstaged, and untracked changes update automatically
13. stage and unstage files
14. inspect history for the current branch
15. open TypeScript files with syntax highlighting
16. browse a source-order class/function structure map
17. distinguish public, protected, private, static, getter, and setter members
18. jump from the structure map to a symbol
19. use `Cmd + click` or a keyboard command to jump to a definition
20. jump back to the previous location
21. preview Markdown in a split pane
22. use a command palette
23. exit with the terminal restored cleanly

The architecture must also demonstrate:

- tmux-driven end-to-end UI verification artifacts
- captured terminal panes and visual baselines for core screens
- documented five-pass independent refinement results
- cross-review findings from independent subagents where supported
- documented before-and-after performance improvements
- stable memory after repeated open/close and workspace-switch cycles
- near-zero idle CPU after background work settles
- resource release for inactive buffers, workspaces, previews, watchers, plugins, parsers, and LSP processes
- iVue reactive domain models
- plain algorithm/resource classes
- static capability classes
- namespace `Class` bindings
- late dependency access
- overridable dependency factories
- plugin class composition
- viewport flyweights
- explicit lifecycle teardown
- lazy LSP startup
- bounded background activity

---

# Final Product Standard

The prototype should feel like:

> VS Code's familiarity, Nano's immediacy, Neovim's lightness, and a game-like sense of movement—built as a terminal-native foundation for future AI-driven development.

Do not recreate VS Code's architecture.

Recreate only the parts of its user experience that remain valuable:

- understandable layout
- familiar navigation
- discoverable actions
- strong file and Git workflows
- reliable code intelligence

The long-term direction is an AI-era code control plane.

The first release is the focused foundation:

> Files, Git, code editing, semantic navigation, and Markdown review—fast, coherent, extensible, and lightweight.
