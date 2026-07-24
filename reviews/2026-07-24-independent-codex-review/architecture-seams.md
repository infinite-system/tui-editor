## Findings

1. **FATAL — The agent subprocess pump is copy-adapted three times.**  
   Files: [CliStreamBackend.ts](/home/parallels/dev/tui-editor/src/modules/agent/CliStreamBackend.ts:63), [CodexStreamBackend.ts](/home/parallels/dev/tui-editor/src/modules/agent/CodexStreamBackend.ts:52), [CodexAppServerBackend.ts](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:93).  
   Shared generator: spawn an NDJSON child, incrementally frame UTF-8 lines, concurrently retain a bounded stderr tail, observe exit, interrupt/dispose, and synthesize terminal events. The Claude/Codex mappings are honestly distinct; the transport is not.  
   Extraction: introduce a raw stateful `NdjsonSubprocessTransport`; each backend retains only argv, protocol mapping, resume IDs, and terminal-event policy.

2. **FATAL — The process boundary claims one home, but streaming consumers bypass its launch policy.**  
   Files: [Processes.ts](/home/parallels/dev/tui-editor/src/modules/system/Processes.ts:2), [LspProcess.ts](/home/parallels/dev/tui-editor/src/modules/lsp/LspProcess.ts:77), [CliStreamBackend.ts](/home/parallels/dev/tui-editor/src/modules/agent/CliStreamBackend.ts:63), [CodexAppServerBackend.ts](/home/parallels/dev/tui-editor/src/modules/agent/CodexAppServerBackend.ts:93), [SystemTtsBackend.ts](/home/parallels/dev/tui-editor/src/modules/narration/SystemTtsBackend.ts:175).  
   Shared generator: shell-free, guarded external-tool creation with the hermetic environment that strips ambient `GIT_*`. `Processes.run` over-couples launching to full output capture, so long-lived and streaming tools call `Bun.spawn` directly and lose that policy.  
   Extraction: add a low-level `Processes.spawn(argv, options)` and layer `run` over it; explicitly exempt the interactive PTY, whose environment generator is different.

3. **FATAL — Provider resolution has two authorities and can report a different engine from the one running.**  
   Files: [AgentFactory.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentFactory.ts:40), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:256), [agent.invariants.md](/home/parallels/dev/tui-editor/src/modules/agent/agent.invariants.md:98).  
   Shared generator: provider inventory, availability, fallback, construction, current-provider identity, and cycling. For example, configured `codex` with Codex absent and Claude present makes Bootstrap report `codex` while `AgentFactory` silently creates Claude; with neither installed Bootstrap reports Claude while the factory creates Echo. Adding a provider also requires changes outside the promised factory/enum seam.  
   Extraction: create an `AgentProviderRegistry` returning one resolved provider record used for labels, construction, availability, fallback, and cycling.

4. **FATAL — `WrapText` shares emitted strings but not the geometry that generates cursor and selection behavior.**  
   Files: [WrapText.ts](/home/parallels/dev/tui-editor/src/modules/ui/WrapText.ts:1), [AgentComposer.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentComposer.ts:169), [AgentTranscriptProjection.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentTranscriptProjection.ts:48).  
   Shared generator: hard-wrap segmentation plus forward/inverse buffer-position mapping. `WrapText` segments code points, while Composer independently maps graphemes using `index / width`; neither measures terminal display cells. A probe with `éx` at width 1 produced three rendered rows but a two-grapheme geometry and placed the end caret on row 1 rather than row 2.  
   Extraction: return grapheme-safe, display-width-aware segment descriptors with point↔offset mapping; do not fold this into `EditorWrap`, whose word-breaking generator is different.

5. **FATAL — `TextSelectionModel` over-unifies span geometry with text reconstruction.**  
   Files: [TextSelectionModel.ts](/home/parallels/dev/tui-editor/src/modules/ui/TextSelectionModel.ts:1), [AgentComposer.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentComposer.ts:273), [AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:589).  
   False shared generator: anchor/focus ordering and per-line highlight geometry are shared; reconstruction is surface-specific because transcript visual rows introduce newlines while composer wraps do not. Composer consequently suppresses the seam’s `selectedText` core and reimplements it. The shared method also calls UTF-16 `slice` with documented grapheme columns; selecting grapheme 1–2 of `😀x` returned an isolated low surrogate rather than `x`.  
   Extraction: keep a small selection-span model and inject a surface-specific, grapheme-safe position-to-text resolver.

6. **FATAL — Diff and Markdown use full mutable Editors as hidden selection/find stores.**  
   Files: [MarkdownSplitView.ts](/home/parallels/dev/tui-editor/src/modules/markdown/MarkdownSplitView.ts:45), [MarkdownSplitView.ts](/home/parallels/dev/tui-editor/src/modules/markdown/MarkdownSplitView.ts:126), [DiffView.ts](/home/parallels/dev/tui-editor/src/modules/diff/DiffView.ts:175), [DiffView.ts](/home/parallels/dev/tui-editor/src/modules/diff/DiffView.ts:1000).  
   False shared generator: “selectable/searchable read-only text is an Editor.” Markdown constructs one Editor; Diff constructs two find Editors and recreates another Editor whenever selection begins. Editing, undo, persistence, and editor viewport behavior are all intentionally suppressed through `openDiff`—the codebase’s own tell for a wrong seam.  
   Extraction: introduce a raw `ReadOnlyTextBuffer` composed from document, cursor/selection, copy, and find-target behavior; let Editor add mutation and undo above that seam.

7. **FATAL — Bootstrap’s editor action table treats Markdown preview as an Editor and repeatedly suppresses editing.**  
   Files: [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1143), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1200), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1497), [MarkdownSplitView.ts](/home/parallels/dev/tui-editor/src/modules/markdown/MarkdownSplitView.ts:199).  
   False shared generator: one `editor` context/action table for editable buffers, Markdown preview, and Diff. More than twenty handlers test `previewFocused` to suppress mutation or substitute scrolling, while Diff bypasses registry dispatch through a raw-key switch.  
   Extraction: resolve focus to a surface-owned action-handler table—Editor, Diff, and Markdown preview expose only actions their actual generators support.

8. **FATAL — Terminal mode ownership is split, so session recovery is incomplete.**  
   Files: [TerminalSession.ts](/home/parallels/dev/tui-editor/src/modules/app/TerminalSession.ts:30), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1553), [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:1608).  
   Shared generator: owned terminal modes across enter, re-enter, and leave. `TerminalSession` owns focus reporting and recovery, but Bootstrap separately emits bracketed-paste DECSET 2004. The documented tab-reset recovery reasserts OpenTUI modes and focus reporting, not bracketed paste—which the code explicitly says OpenTUI does not enable.  
   Extraction: make `TerminalSession` own a complete enter/reenter/leave mode bundle including bracketed paste.

9. **SCOPING — The full “one viewport for every text pane” generator does not exist; a smaller momentum-axis generator does.**  
   Files: [ScrollableTextViewport.ts](/home/parallels/dev/tui-editor/src/modules/ui/ScrollableTextViewport.ts:1), [Workspace.ts](/home/parallels/dev/tui-editor/src/modules/workspace/Workspace.ts:856), [DiffView.ts](/home/parallels/dev/tui-editor/src/modules/diff/DiffView.ts:415), [MarkdownSplitView.ts](/home/parallels/dev/tui-editor/src/modules/markdown/MarkdownSplitView.ts:234).  
   Shared generator: per-axis impulse, frame step, whole-cell application, boundary halt, programmatic halt, and liveness. Editor, tree, git, Diff, and Markdown legitimately have different offset ownership, so forcing the complete `ScrollableTextViewport` would over-unify them; they instead repeat the smaller lifecycle. Drift already exists: `ScrollableTextViewport` halts at a boundary, while the other clamped surfaces keep requesting frames until velocity decays.  
   Extraction: scope `ScrollableTextViewport` to independently owned text ports and extract a reusable stateful `MomentumAxis` for the common lifecycle.

10. **FATAL — Semantic appearance has escaped the theme seam.**  
    Files: [AgentTranscriptProjection.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentTranscriptProjection.ts:28), [AgentSpinnerFrames.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentSpinnerFrames.ts:11), [AgentPaneContent.ts](/home/parallels/dev/tui-editor/src/modules/agent/AgentPaneContent.ts:282), [TabBar.ts](/home/parallels/dev/tui-editor/src/modules/ui/TabBar.ts:96), [ImagePreview.ts](/home/parallels/dev/tui-editor/src/modules/image/ImagePreview.ts:35), [ThemeIcons.ts](/home/parallels/dev/tui-editor/src/modules/theme/ThemeIcons.ts:84).  
    Shared generator: capability-resolved semantic glyph and palette data. Agent code maintains several private fallback ladders—including a duplicated settings/tool cog—TabBar has another inline ladder, and ImagePreview hardcodes an error hex. These bypass live theme replacement and directly contradict the theme contract’s single home.  
    Extraction: add semantic agent, spinner, separator, ellipsis, and result tokens to ThemeIcons and pass `palette.error` into image preview.

11. **SCOPING — There are no runtime import cycles now, but four production modules violate late-read discipline.**  
    Files: [GitPaneRenderer.ts](/home/parallels/dev/tui-editor/src/modules/ui/GitPaneRenderer.ts:51), [QuickOpenRenderer.ts](/home/parallels/dev/tui-editor/src/modules/ui/QuickOpenRenderer.ts:46), [FindBarRenderer.ts](/home/parallels/dev/tui-editor/src/modules/ui/FindBarRenderer.ts:42), [ImageDecoders.ts](/home/parallels/dev/tui-editor/src/modules/image/ImageDecoders.ts:33).  
    Shared generator: cross-module capabilities must be dereferenced through the live `.Class` slot at call time. These files snapshot imported methods at module initialization; decoder registration also captures `PngDecoder.Class.decode`/`JpegDecoder.Class.decode`, defeating later class swaps and adding eager initialization edges. AST analysis found zero runtime strongly connected components across 156 production files, so this is a real seam/replacement risk rather than a presently crashing cycle.  
    Extraction: replace stored imported methods with delegating closures or provider identifiers that dereference `.Class` on each call.

12. **FATAL — `GitBlame` is a stateful, reactive, unbounded cache disguised as a Static capability.**  
    Files: [GitBlame.ts](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:42), [GitBlame.ts](/home/parallels/dev/tui-editor/src/modules/git/GitBlame.ts:106), [StatusBar.ts](/home/parallels/dev/tui-editor/src/modules/ui/StatusBar.ts:250).  
    Shared generator: blame caching is workspace/session-owned state with explicit capacity and disposal. The module-level map retains a full per-line blame map for every visited path; `clearCache` has no production caller, and a module-level Vue ref provides the repaint signal behind `Static($GitBlame)`. This violates both honest namespace form and active-observation cost.  
    Extraction: make a workspace-owned `Reactive($GitBlameCache)` with an LRU bound, repo-aware keys, and disposal; keep porcelain parsing Static.

13. **FLAG — Bootstrap contains a complete observability projection, not boot wiring.**  
    File: [Bootstrap.ts](/home/parallels/dev/tui-editor/src/modules/app/Bootstrap.ts:397).  
    Shared generator: model state → one `StatusChannel` snapshot. The roughly 200-line `publish` closure independently projects workspace, overlays, Diff, Markdown, panels, images, blame, narration, and agents; every new feature couples its verification projection back into the composition root.  
    Extraction: move it to an `AppStatusProjection` receiving narrow live ports and returning/updating the snapshot. Initial object construction, hook registration, and reverse-order teardown remain genuine Bootstrap wiring.

Mechanical checks: invariant checker passed with 0 problems; `tsc --noEmit` passed; 726 tests across 97 files passed. No smoke or `merge-gate.sh` was run, and no files were edited.

Modules read vs skipped: deeply read `agent`, `app`, `diff`, `editor`, `git`, `image`, `lsp`, `markdown`, `narration`, `system`, `terminal`, `theme`, `ui`, and `workspace`; architecture/import/call-site scanned `commands`, `diagnostics`, `kernel`, `keybindings`, `layout`, `navigation`, `search`, `settings`, `storage`, and `syntax`. Skipped entirely: none at module-directory level; not every one of the 156 production files was line-read.
