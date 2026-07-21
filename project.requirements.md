# project.requirements.md — THE persistent cross-cutting requirements brief (READ FIRST)

Single source of truth for accumulated, still-live requirements and hard-won decisions. It exists so
NOTHING decided is lost across compaction or a cold restart, and so EVERY spawned worker inherits it.

- **Loaded first** on every resume/cold-start (with `project.conventions.md` + `project.invariants.md`).
- **Embedded by reference** in the fractal delegate packet (`scripts/delegate-packet.sh`) — every
  codex/Fable worker reads it before working.
- **Append + commit** whenever a new standing rule/decision arrives. It accumulates; it never lives
  only in chat history (which compaction can drop). "Encode this persistently" is the default for any
  standing decision.
- The live per-item checklist is `project.progress.md` (USER PIPELINE); this file holds the durable
  cross-cutting rules, that file holds the work items.

## Conventions (also in project.conventions.md — the canonical WHAT)
- FULL descriptive identifier names, NO abbreviations, ever, in all code.
- ivue namespace pattern: `class $X {}` + `export namespace X { export const $Class=$X; export const
  Class=Static($X) | export let Class=Reactive($X); export type Instance = typeof Class.Instance }`.
- Static-manifest shape + `$`-raw-form: a manifest member's backing is `$name` (the `...Implementation`
  suffix is BANNED; the gate fails on it).
- FILE-NAME-FOLLOWS-CLASSIFICATION: a namespace+Static/Reactive class file is `<Namespace>.ts`
  (PascalCase); loose role-collections stay `<module>.<role>.ts`. ATOMIC convert+rename in ONE change.
- Governance docs are `project.<type>.md` (progress/conventions/invariants/requirements/handoff/…).
- `Static` is imported from `ivue/extras` (ivue ≥ 2.1.0); `Reactive` from `ivue`. No vendored copy.
- `tsc --noEmit` GREEN before EVERY commit — `scripts/conventions-gate.sh` HARD-BLOCKS on tsc failure
  (it runs tsc as check 0). Never pipe tsc (`bunx tsc --noEmit; echo TSC=$?`).

## Verification (the discipline that makes parallelism safe)
- Verify by DRIVING — FrameProbe framebuffer / tmux / per-session `status-<session>.json` — NEVER by
  reading code. "The handler looks right" is not verification.
- The idle/quiescence smoke (frame-delta == 0 at rest) runs + passes on every gate.
- MEASURED ≠ ENFORCED: a check that does not run on every commit is not a gate; an invariant must
  BLOCK (non-zero exit) on violation, on the AUTHORITATIVE signal.
- End-to-end smokes must exercise the REAL path. (The GitWatcher bug hid behind isolated-passing unit
  tests; the missing enforcement was an external-fs-change → panel-update smoke.)
- Audit for BUILT-BUT-UNWIRED capabilities: a capability referenced only by its own test is suspect.
  (Known forward-milestone, not-yet-wired-by-design: MarkdownRenderable [M6], LanguageClient [M5].)

## Input / terminal facts (terminal-dependent, hard-won — do NOT re-litigate)
- Horizontal scroll = Option/Meta + wheel = SGR **74/75** (confirmed on the user's terminal). Routed
  via `event.modifiers.alt` + native direction left/right.
- Shift+wheel (SGR 68/69) is SWALLOWED by the terminal — dead, not our bug. Do not rely on it.
- Native horizontal tilt (66/67) is not forwarded by the user's terminal.
- Fast-scroll modifier [F]: AWAITING the user's `cat -v` capture. The setting is present; default it
  UNSET until the confirmed key + SGR code is relayed.
- Cmd+Left/Right (iTerm2 "Natural Text Editing"): the terminal sends RAW control bytes — Cmd+Left = ^A
  (0x01), Cmd+Right = ^E (0x05). It does NOT translate to Home/End. (Commit 2da0384's "works via
  Home/End translation" was a FALSE GREEN — verified by tmux INJECTION of Home/End, not against the
  real terminal.) FIX (3f… commit): under the Kitty protocol a PHYSICAL Ctrl+A arrives as the kitty
  form (`key.sequence === 'a'`, escape-encoded), while the terminal's Cmd remap arrives as a raw 0x01
  byte (`key.sequence === ''`). They are DISTINGUISHABLE (driven + confirmed: raw seq=[01]/[05]
  super=undefined vs kitty seq=[61]/[65] super=false). So onKey diverts raw ^A → editor.lineStart
  (only when `renderer.useKittyKeyboard`, so legacy raw ^A stays Ctrl+A=Select All), and a plain
  Ctrl+E binding covers Cmd+Right (raw ^E) + Ctrl+E → line-end (Ctrl+E was unbound = no conflict).
  RESULT, driven-verified against the real bytes: Cmd+Left→col 0, Cmd+Right→line-end, Ctrl+A→Select All,
  all live. Home/End keys are the always-working canonical line-start/end fallback.

## Behavioural requirements
- RESPECT `.gitignore` in BOTH the git panel display AND the GitWatcher recursion — never
  watch/list `node_modules` or other ignored dirs.
- Tab overflow arrows PAN the strip viewport only; they NEVER change the active tab.
- Rendering is demand-driven; the render loop STOPS at rest (idle frame-delta == 0).

## Orchestration
- Worktree-per-writer + DISJOINT file sets. PARALLELIZE capabilities, SERIALIZE RootView integration
  (the coordinator owns RootView; workers build isolated new/owned files, wired in one merge at a time).
- Use Fable/Claude subagents for HARD reasoning-heavy work; codex for mechanical/isolated builds
  (separate budget). Both inherit the full fractal packet.
- GOTCHA: the Claude Agent tool's worktree-isolation targets the WRONG repo — so for tui-editor work,
  explicitly `git worktree add` a tui-editor worktree and point the worker at it.
- NEVER use a shell `&` under a backgrounded Bash (double-background orphans/kills the process).
- Delegates never commit; the coordinator reviews (naming/contracts/verification/no unexpected
  deletions) and merges. codex is never trusted with deletions.
