# LSP — Module Invariants

The language-intelligence subsystem: a plain JSON-RPC transport over a Bun subprocess, driven
by a reactive `LanguageClient`. This contract governs `src/modules/lsp/`. It stands on the root
`project.invariants.md` — in particular the reality invariants *Language and git tools are
separate failable processes*, *An async result can outlive the state it described*, *A text
position has several encodings*, and *A referenced resource stays alive*, and the chosen
invariants *The immediate layer never blocks the deferred layer*, *Async results are
revision-stamped and stale results discarded*, and *Cost tracks the actively observed set*.

Invariants are unnumbered — the name is the identifier, matched byte-for-byte by `// invariant:`
annotations. Chosen invariants stand on reality invariants, never the reverse.

## Reality-based invariants

### Byte streams do not preserve message boundaries

**Invariant:** If JSON-RPC messages are carried over a subprocess stdout pipe, then a single
read can split one message across chunks or coalesce several into one, so message boundaries
exist only in the `Content-Length` framing, never in the chunk boundaries.

**Scope:** All decoding of language-server output in `JsonRpc.push`. Not the encode side, which
controls its own framing.

**Renegotiable at:** the OS pipe / Bun stream layer — reality inside this module, fixed by how
byte streams work; no server or config makes a pipe message-preserving.

**Mechanism:** A pipe is a byte stream; the kernel and the reader deliver whatever bytes are
available when a read completes, indifferent to the sender's write boundaries. Only the
`Content-Length: N\r\n\r\n` header lets the decoder recover the original message boundaries.

**Generates:** The incremental `JsonRpc` decoder that accumulates bytes, scans for the header
terminator, reads exactly `Content-Length` body bytes, and loops for further complete messages
in the same buffer.

**Evidence:** `src/modules/lsp/JsonRpc.ts:110` (`push` accumulates then loops); `:128` (waits
until `bytes.byteLength >= bodyLength` before slicing a body); `:155` (`findHeaderEnd` scans the
buffer for `\r\n\r\n`).

**Impossible if true:** A decoder that assumes one read equals one message and either drops the
tail of a coalesced pair or emits a truncated body from a split chunk.

**Verification:** `bun test src/modules/lsp -t "split across two chunks"` and
`bun test src/modules/lsp -t "two messages in one chunk"`.

**Status:** provisional

**Last refined:** 2026-07-21

### LSP positions cross through UTF-16

**Invariant:** If a text position is exchanged with a language server, then it is expressed in
UTF-16 code units on the wire, which do not coincide with the editor's grapheme columns, so a
conversion is required in each direction at the client boundary.

**Scope:** Every position/range sent to or received from the server: definition, references,
hover requests and their result ranges, and diagnostic ranges. Not the editor↔client mapping
above grapheme columns, which the main loop wires later.

**Renegotiable at:** the LSP protocol / server position-encoding negotiation — UTF-16 is the
spec default; a server that negotiates UTF-8 or UTF-32 would move the boundary, but the client
API stays UTF-16-derived.

**Mechanism:** Stands on *A text position has several encodings*. A JS string is UTF-16
internally, but a grapheme cluster (emoji, base+combining, ZWJ sequence) can span several UTF-16
units — and several CODE POINTS, so a code-point walk (`Array.from`) is also wrong. The client
converts grapheme column → UTF-16 character before a request and UTF-16 character → grapheme
column when reading a result, through `EditorCoordinates.graphemeToU16`/`u16ToGrapheme` — the
same segmenter-backed boundaries the editor cursor uses.

**Generates:** `toLspPosition` (grapheme boundary → UTF-16 offset via
`EditorCoordinates.graphemeToU16`) and `fromLspPosition` (UTF-16 offset → grapheme index via
`EditorCoordinates.u16ToGrapheme`); the client API surfacing UTF-16-derived positions rather
than raw grapheme columns.

**Evidence:** `src/modules/lsp/LanguageClient.ts:643` (`toLspPosition` →
`EditorCoordinates.graphemeToU16`); `:650` (`fromLspPosition` → `EditorCoordinates.u16ToGrapheme`).
Driven against a real `typescript-language-server` 5.3.0: a use site after a ZWJ family emoji
(grapheme 39 / code point 43 / UTF-16 46) resolved to the correct identifier — the server's
`originSelectionRange` echoed exactly the `greetWidget` token.

**Impossible if true:** A definition/hover/diagnostic that lands on the correct column for ASCII
text but drifts by the surrogate/cluster width once an emoji or combining mark precedes it.

**Verification:** `bun test src/modules/lsp -t "cross to the server as UTF-16"` and
`bun test src/modules/lsp -t "ZWJ emoji"`.

**Status:** provisional

**Last refined:** 2026-07-21

## Chosen invariants

### The LSP attaches only to documents within the size budget

**Invariant:** If a document's text exceeds the configured size budget (`lspFileSizeLimitKb`, in KB;
`0` disables the limit), then it is never attached to the language server — no `didOpen` or
`didChange` carries its text to the subprocess — so the server can never balloon on a huge file and
crash the app; and when the ACTIVE file is suppressed this way a status notice states it, so the
suppression is never a silent no-op.

**Scope:** `LanguageClient` document attachment (`openDocument`, `syncDocument`, and the shared
`sendLatestDocument` send site) plus the active-file notice surfaced through `Workspace` and the
status bar. Not semantic requests on already-attached small files, which are unaffected. A budget of
`0` means every supported document attaches as before. The threshold is a product choice set by the
`lspFileSizeLimitKb` setting (default 2048 = 2 MB — a 3 MB file was reproduced killing tsgo); `0`
removes the guard entirely.

**Mechanism:** Stands on *Language and git tools are separate failable processes* — the language
server is a separate process whose memory scales with the file it ingests, so a large-enough file
drives it to out-of-memory and takes the shared app down with it. The client reads the budget late
through a `fileSizeLimitKb` getter (mirroring how `preferredTypeScriptServer` is threaded). Every
attachment path recomputes suppression against the current text length before remembering or syncing
the document; the one place text actually reaches the server returns early for an oversized document,
so no attach path can leak it. Suppressed URIs are tracked in a set with a reactive revision signal
the active-file notice reads.

**Generates:** The `documentExceedsSizeLimit` / `refreshSizeSuppression` guard; the early returns in
`openDocument` and `syncDocument`; the load-bearing skip in `sendLatestDocument`; the
`sizeSuppressedUris` set with `isSizeSuppressed` / `sizeSuppressionNotice`; the `Workspace`
`languageSizeNotice` the status bar shows and the observability channel publishes.

**Rejected alternatives:** Attaching every file and hoping the server survives — the exact path that
crashed the user's editor on a 30 MB file. Folding size into `supportsDocument` (path-based language
support) — conflates two independent axes (language vs size) and would silently change the
activation-follows-demand invariant's meaning.

**Evidence:** `src/modules/lsp/LanguageClient.ts` — `documentExceedsSizeLimit`,
`refreshSizeSuppression`, the `openDocument`/`syncDocument` early returns, and the annotated skip in
`sendLatestDocument`; `src/modules/workspace/Workspace.ts` (`languageSizeNotice`, the
`fileSizeLimitKb` threading in `createLanguageClient`); `src/modules/ui/StatusBar.ts` (the notice
part); `src/modules/app/Bootstrap.ts` (`lspSizeSuppressed` published). Driven by
`scripts/smoke-settings-applied.sh`: with `lspFileSizeLimitKb` 1 a >1 KB `.ts` file stays suppressed
(no diagnostics, `lspSizeSuppressed` true) and the app survives; with the default budget the same
file attaches and diagnostics arrive. Drive-verified against a real 3 MB / 100k-line file: with the
guard on tsgo is never sent the file and its RSS stays stable; with the guard off tsgo balloons.

**Impossible if true:** A `textDocument/didOpen` or `didChange` sent for a document whose text
exceeds the budget; a size-suppressed active file with no visible notice; the app crashing because a
file larger than the budget was handed to the server.

**Verification:** `bash scripts/smoke-settings-applied.sh` (the `lspFileSizeLimitKb` drive) and
`bun test src/modules/lsp`.

**Status:** provisional

**Last refined:** 2026-07-23

### LSP activation follows semantic demand

**Invariant:** If no supported document is open and no semantic feature has been requested, then
no language-server subprocess is spawned; the server starts only on the first supported
`openDocument` or the first semantic request (definition, references, hover).

**Scope:** `LanguageClient` startup. A single lazily-created process/transport per client;
unsupported files never trigger a start.

**Mechanism:** Stands on *Language and git tools are separate failable processes* and *Cost
tracks the actively observed set*. Every entry point routes through `ensureStarted`, which spawns
the process on first demand and otherwise returns the in-flight/settled start; `openDocument`
returns early for unsupported paths before any activation.

**Generates:** The `ensureStarted`/`activate` gate; the process/transport factories invoked on
demand; the guarantee that a cold workspace holds no LSP subprocess.

**Rejected alternatives:** Spawning one server per project file at launch — costs a subprocess
for files the user never touches and violates *Cost tracks the actively observed set*.

**Evidence:** `src/modules/lsp/LanguageClient.ts:169` (`openDocument` returns early for
unsupported paths, else schedules `ensureStarted`); `:352` (`ensureStarted` is the sole start
gate); `:498` (semantic requests reach `ensureStarted` via `transportFor`).

**Impossible if true:** A spawned language server while every open document is unsupported and no
semantic command has run.

**Verification:** `bun test src/modules/lsp -t "not started until a supported document"` and
`bun test src/modules/lsp -t "semantic command with no prior openDocument"`.

**Status:** provisional

**Last refined:** 2026-07-21

### Client disposal releases the server

**Invariant:** If a `LanguageClient` is disposed, then its subprocess is killed and its transport
is closed, leaving no orphan process, no live reader, and a terminal `disposed` status — even if
the protocol shutdown handshake is slow or fails.

**Scope:** `LanguageClient.dispose`, `LspTransport.dispose`, `LspProcess.dispose`, and the
supersede paths in `activate` when a newer generation or disposal races an in-flight start.

**Mechanism:** Stands on *A referenced resource stays alive* (a subprocess retains its cost until
explicitly killed). Dispose attempts a bounded `shutdown`/`exit` handshake, then unconditionally
disposes the transport (cancel reader, reject pending) and the process (end stdin, kill child).
The client owns no `$watch` effects, so no `$stopEffects()` is called — that would clear the
cached getter cells and discard the terminal `disposed` status.

**Generates:** The unconditional kill-after-handshake ordering; idempotent `dispose`; the
generation guard that disposes a superseded process/transport created by a racing `activate`.

**Rejected alternatives:** Relying on the protocol `shutdown` handshake alone — a slow or crashed
server would then leak the child process.

**Evidence:** `src/modules/lsp/LanguageClient.ts:322` (`process?.dispose()` runs unconditionally
after the guarded handshake); `src/modules/lsp/LspProcess.ts:122` (`child?.kill()`);
`src/modules/lsp/LspTransport.ts:97` (`reader.cancel()` on dispose).

**Impossible if true:** A live subprocess or an un-cancelled stdout reader after `dispose()`
resolves; a disposed client whose status reads anything other than `disposed`.

**Verification:** `bun test src/modules/lsp -t "dispose kills the subprocess"`.

**Status:** provisional

**Last refined:** 2026-07-21

### Server failures remain contained

**Invariant:** If the language server is absent, slow, or crashes, then the failure surfaces only
as observable optional-service state (`unavailable`/`error`, empty results); it never throws
across the client boundary into editor input or document mutation.

**Scope:** Provider resolution, process spawn, transport start, every semantic request, and the
transport-close/crash path. The whole public surface of `LanguageClient`.

**Mechanism:** Stands on *Language and git tools are separate failable processes* and generates
*The immediate layer never blocks the deferred layer*. A failed spawn returns `false` plus
`error` rather than throwing; each semantic method wraps its request in try/catch and returns a
neutral value (`null`/`[]`) via `containFailure`; a mid-session crash routes through the
transport `onClose` handler that resets state without rethrowing.

**Generates:** `setUnavailable` for missing servers; `containFailure` for in-flight faults;
`handleTransportClose` for crashes; neutral return values from `definition`/`references`/`hover`.

**Evidence:** `src/modules/lsp/LspProcess.ts:93` (`start` catches and returns `false`);
`src/modules/lsp/LanguageClient.ts:375` (`setUnavailable` on no server); `:441` (`activate`
catch → `containFailure`); `:244`/`:268`/`:287` (semantic requests catch → return neutral).

**Impossible if true:** An editor keystroke or buffer mutation that throws or blocks because an
LSP is missing, slow, or has died.

**Verification:** `bun test src/modules/lsp -t "missing server executable degrades to unavailable"`.

**Status:** provisional

**Last refined:** 2026-07-21

### A definition gesture jumps to the declaration

**Invariant:** If the user Ctrl/Cmd+clicks a symbol in a supported document (or presses F12 at
the cursor), then the editor resolves the symbol through the language client's
`textDocument/definition`, opens the declaring file as a tab, and lands the cursor on the
declaration — and when no definition is available (no document, unsupported file, absent server,
empty result) the gesture degrades to a silent no-op, never a crash.

**Scope:** The `Workspace.goToDefinition` jump path, the Ctrl/Cmd+click branch of
`codeBody.onMouseDown` in `RootView`, and the `go.definition` command/F12 binding. Not hover or
references, which reuse the same client but are wired separately.

**Mechanism:** Stands on *LSP positions cross through UTF-16* and *Server failures remain
contained*. `documentPositionAtCell` already yields grapheme columns — exactly what
`LanguageClient.definition` takes — so the pointer gesture and the cursor position feed one
`Workspace.goToDefinition` method. The result flows through the existing
`openFileInTab` → `placeCursor` → `revealCursor` path (no parallel navigation). The real server
returns the IMPORT SPECIFIER while the declaring file is not open in the server; one re-request
from the import specifier (`rehopThroughImportSpecifier`) reaches the original declaration,
matching VS Code. Per-workspace lifecycle: every live buffer registers through the
`OpenBufferSet` create/dispose seams (`openDocument`/`closeDocument`), and a targeted
document-revision watch in Bootstrap pushes edits as revision-idempotent `didChange`.

**Generates:** `Workspace.goToDefinition`/`rehopThroughImportSpecifier`/`jumpToLocation`; the
lazy one-client-per-workspace ownership (`ensureLanguageClient`, disposed with the workspace);
the consumed (never selection-starting) modifier-click branch; the `go.definition` command and
its F12 floor binding.

**Rejected alternatives:** A separate navigation path for LSP jumps (parallel to
`openFileInTab`) — two openers would drift on tab/diff/focus semantics. Treating the import
specifier result as final — lands the user on the import line instead of the declaration.

**Evidence:** `src/modules/workspace/Workspace.ts` (`goToDefinition`,
`rehopThroughImportSpecifier`, `jumpToLocation`, the buffer-seam `openDocument`/`closeDocument`
registration); `src/modules/ui/RootView.ts` (`codeBody.onMouseDown` modifier branch);
`src/modules/app/Bootstrap.ts` (`'go.definition'` action + the document-revision sync watch);
`src/modules/keybindings/keybindings.defaults.ts` (F12 → `go.definition`). Driven against a real
`typescript-language-server`: `scripts/smoke-goto-definition.sh` Ctrl+clicks a use site in
`bar.ts` and asserts the editor shows `foo.ts` with the cursor on the declaration, then repeats
the jump via F12.

**Impossible if true:** A Ctrl/Cmd+click on a resolvable symbol that starts a text selection
instead of jumping; a jump that opens the declaring file but leaves the cursor away from the
declaration; a crash or thrown error from the gesture when the server is missing.

**Verification:** `bash scripts/smoke-goto-definition.sh` (skips cleanly when no server is
installed) and `bun test src/modules/workspace/Workspace.goToDefinition.test.ts`.

**Status:** provisional

**Last refined:** 2026-07-22

### Diagnostic updates match current revisions

**Invariant:** If a diagnostic batch is applied to a document — arriving by PUSH
(`publishDiagnostics`) or by PULL (`textDocument/diagnostic` response) — then the revision it is
stored under equals both the document's current revision and the version last synced to the
server. A batch naming any other version is discarded; a PUSH batch naming NO version (real
`typescript-language-server` 5.x omits `version` even when `versionSupport` is advertised) is
attributed to the last synced revision, and a PULL report is stamped with the revision synced when
the request was issued — either way accepted only while that revision is still the current one.

**Scope:** `storeDiagnostics` (the shared sink), reached from `applyDiagnostics` (push) and
`ingestDiagnosticReport` (pull). Diagnostics for a document whose text has advanced past the
batch's version, or that was never opened/synced.

**Mechanism:** Stands on *An async result can outlive the state it described* and generates
*Async results are revision-stamped and stale results discarded*. The client stamps every
`didOpen`/`didChange` with the document revision; a returning batch is accepted only when its
version — reported, or `lastSentVersion` when a push server omits it, or the `lastSentVersion`
captured when a pull request was issued — matches both the live revision and the last-sent
version, so a batch computed against stale text is dropped either way. The pull path captures the
request version BEFORE awaiting the response: if the document advances mid-flight, `lastSentVersion`
moves and the same guard drops the stale report.

**Generates:** The exact-version guard in `storeDiagnostics`; the versionless push fallback to
`lastSentVersion`; the pull's `requestVersion` capture before the await; revision stamping on
document sync; per-URI diagnostic batches keyed by version.

**Rejected alternatives:** Applying whatever diagnostics arrive last — an older batch would then
overwrite diagnostics for newer text, the exact failure *Async results are revision-stamped*
forbids. Requiring a reported `version` unconditionally — drops every batch from real
`typescript-language-server` 5.x, which never sends one (found by driving the real server).

**Evidence:** `src/modules/lsp/LanguageClient.ts` — `applyDiagnostics` versionless push fallback to
`state.lastSentVersion`; `pullDiagnostics` captures `requestVersion = state.lastSentVersion` before
the `textDocument/diagnostic` await; `storeDiagnostics` holds the shared discard guard
(`state.document.revision.value !== version || state.lastSentVersion !== version`).

**Impossible if true:** A stored diagnostic whose `version` is older than the document revision it
is shown against — whether it arrived by push or by pull.

**Verification:** `bun test src/modules/lsp -t "stored only for the current document revision"`,
`bun test src/modules/lsp -t "versionless batch"`, and
`bun test src/modules/lsp -t "full report replaces the prior batch"`.

**Status:** provisional

**Last refined:** 2026-07-21

### Diagnostic storage stays compact and bounded

**Invariant:** If diagnostics are held for a document, then they are stored as plain
non-reactive records in a per-URI map and capped at `maxDiagnosticsPerDocument`, so storage
scales with the configured bound, not with whatever count the server emits.

**Scope:** The `diagnosticBatches` store and every read/ingest path (`storeDiagnostics`,
`diagnosticSlice`). Not the reactive revision signal, which is a single sparse counter.

**Mechanism:** Stands on *Cost tracks the actively observed set*. Ground truth is a
`Map<uri, {version, items}>` of compact records; a single `diagnosticsRevision` ref signals
change. Ingest slices the incoming array to the cap, and reads clamp their window to it, so a
pathological server cannot inflate memory or reactive fan-out. Both the push and pull paths ingest
through the one `storeDiagnostics` sink, so the cap is applied regardless of source.

**Generates:** The compact `LanguageDiagnostic` record; the single coarse `diagnosticsRevision`
signal instead of a ref per diagnostic; the ingest and read caps.

**Rejected alternatives:** One reactive object per diagnostic — reintroduces the per-item
reactivity cost *Cost tracks the actively observed set* rejects.

**Evidence:** `src/modules/lsp/LanguageClient.ts` — `diagnosticBatches` is a plain `Map`;
`storeDiagnostics` ingests `rawDiagnostics.slice(0, maxDiagnosticsPerDocument)`; `diagnosticSlice`
clamps its read window to the cap.

**Impossible if true:** A document holding more than `maxDiagnosticsPerDocument` stored
diagnostics, or a reactive object allocated per diagnostic.

**Verification:** `bun test src/modules/lsp -t "capped at maxDiagnosticsPerDocument"`.

**Status:** provisional

**Last refined:** 2026-07-21

### Diagnostics reach the store by push or pull

**Invariant:** If a language server reports diagnostics, then they reach the diagnostics store the
same way regardless of transport model: a PUSH server (`typescript-language-server`) sends
`textDocument/publishDiagnostics` notifications, while a PULL server (tsgo / native-preview, which
never publishes) is polled with `textDocument/diagnostic` — and both funnel through the single
`storeDiagnostics` sink under one revision guard and one cap. Pulling is gated on the server's
advertised `diagnosticProvider` capability, so a push-only server is never polled and a pull-only
server is never left silent.

**Scope:** `storeDiagnostics` (shared sink), `applyDiagnostics` (push adapter),
`pullDiagnostics`/`ingestDiagnosticReport`/`parseDiagnosticReport` (pull adapter),
`scheduleDiagnosticPull` (debounce), and the `serverPullsDiagnostics` capability guard. The
render (`Workspace.diagnosticsByLine` → `EditorPaneRenderer`) reads the store and is indifferent
to which adapter wrote it.

**Mechanism:** Stands on *Cost tracks the actively observed set* and generates nothing below it.
The client advertises pull support on `initialize` (`textDocument.diagnostic`,
`workspace.diagnostics.refreshSupport`). On `initialize`'s result it records
`serverCapabilities.diagnosticProvider`. `sendLatestDocument` schedules a debounced pull after
each `didOpen` (~50ms) and `didChange` (~350ms) — a no-op when the server is push-model.
`pullDiagnostics` sends `textDocument/diagnostic` (echoing the last `resultId` as
`previousResultId`); a `full` report REPLACES the stored batch through `storeDiagnostics` (so an
error that disappears is cleared, even by an empty `items`), while an `unchanged` report keeps the
batch and only refreshes the `resultId`. A `workspace/diagnostic/refresh` server request re-pulls
every open document.

**Generates:** The `storeDiagnostics` sink both adapters share; the `serverPullsDiagnostics` guard;
the debounced `scheduleDiagnosticPull` with its per-URI timers; the `resultId` bookkeeping and
`full`/`unchanged` handling; the `workspace/diagnostic/refresh` re-pull.

**Rejected alternatives:** A separate pull-only diagnostics store parallel to the push store — the
render would need two readers and would drift on clearing/versioning. Pulling unconditionally
(ignoring `diagnosticProvider`) — floods a push-only server with `textDocument/diagnostic` it need
not answer. Pulling without a debounce — one request per keystroke during typing.

**Evidence:** `src/modules/lsp/LanguageClient.ts` — `storeDiagnostics` (shared sink),
`pullDiagnostics`/`ingestDiagnosticReport`/`parseDiagnosticReport`, `serverPullsDiagnostics`,
`scheduleDiagnosticPull`, the `initialize` capability advertisement, and the
`workspace/diagnostic/refresh` handler. Driven against BOTH real servers by
`scripts/smoke-diagnostics.sh`: tsgo (pull) and typescript-language-server (push) each paint the
red gutter mark + red underline on the error line.

**Impossible if true:** A reported diagnostic visible under one server model but not the other for
the same error; a `textDocument/diagnostic` request sent to a server that never advertised
`diagnosticProvider`; a pull report stored under a revision the document has moved past.

**Verification:** `bash scripts/smoke-diagnostics.sh` (skips a case cleanly when that server is
absent), `bun test src/modules/lsp -t "diagnostics are pulled via textDocument/diagnostic"`,
`bun test src/modules/lsp -t "unchanged report keeps the prior batch"`, and
`bun test src/modules/lsp -t "never sends textDocument/diagnostic"`.

**Status:** provisional

**Last refined:** 2026-07-23
