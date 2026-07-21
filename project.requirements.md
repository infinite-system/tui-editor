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

## PRODUCT NORTH STAR — learnable in ~15 minutes, zero prior knowledge (governs ALL UI)

**A user who knows NOTHING can learn this editor in ~15 minutes and use it at almost full power — "kid
to grandpa."** Every UI decision serves this. It is the acceptance lens on EVERY UI feature (activity
bar, Ctrl+P, Search view, shortcuts page, workspace tabs, find/replace, git panel, status bar): each must
be usable by a first-timer by LOOKING + CLICKING, with tooltips, findable in the palette. This is the
product expression of the [No action requires a memorized motion] invariant.

Load-bearing sub-invariants (apply to everything):
1. **Every action has a VISIBLE, CLICKABLE affordance** — never keyboard-only. Discoverable by looking,
   not by knowing.
2. **Every affordance SELF-EXPLAINS** — hover → tooltip with what-it-does + its shortcut (the UI teaches
   its own shortcuts).
3. **Any action is FINDABLE** — command palette (search all actions) + the shortcuts page (full map). No
   hidden actions.
4. **Current STATE is always visible** — status bar: file, mode, cursor position, context.
5. **Forgiving + immediate FEEDBACK** — hover/active/press states, destructive-action confirmations, clear results.

**WIRE-AND-DISCOVER RULE (like wire-and-drive):** when you add an ACTION, add its click affordance +
tooltip + palette/shortcuts-page entry in the SAME change. A keyboard-only action is not done.

**PROXY GATES (turn "learnable" from hope into enforcement — add to the merge-gate as each becomes real;
you can't gate "grandpa learns it" but you CAN gate these):**
- **CLICK-COMPLETENESS** — every action in the command registry has a click affordance somewhere
  (button/menu/palette). Enumerate actions; assert each is reachable by click. No keyboard-only actions.
- **TOOLTIP-COMPLETENESS** — every interactive/clickable element exposes a tooltip (name + shortcut).
- **PALETTE + SHORTCUTS-PAGE COMPLETENESS** — every bound action appears in BOTH the command palette AND
  the shortcuts page (KeybindingRegistry.effectiveBindings). (This also finally wires effectiveBindings.)

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

## Definition of Done + wiring discipline (build-but-don't-wire is THE tracked disease)

Three independent audits (2026-07-21) converged on one systemic failure: capabilities and settings get
built cleanly, pass ISOLATED tests, and their contracts read as live — but nothing consumes them (zero
callers). Confirmed dead at the time: DiffView (700 lines), 8 of 13 settings, palette entries. Isolated
tests HIDE it. The craft is fine; wiring is the blind spot. These rules make it structurally impossible:

- **DEFINITION OF DONE (load-first; a feature/capability is NOT done until all three hold):**
  (a) WIRED into the running app with a live caller path (a real user can reach it);
  (b) an e2e test DRIVES the real user path (FrameProbe/tmux/status.json) — an isolated unit test is
      explicitly NOT sufficient;
  (c) verified in the demo/framebuffer.
  "Isolated test green + contract written" is NOT done. This is inherited by every worker via the packet.
- **MERGE RULE:** a worker-delivered capability does NOT merge until it is WIRED + its DRIVING test is
  added in the SAME integration. No "merge the capability now, wire it later" — that backlog is the disease.
- **CONTRACT-LIVENESS:** a user-facing capability's `*.invariants.md` MUST name its wiring/mount point
  (the caller). If it can't name one, it is not live and not done.
- **MECHANICAL GATE (#1, enforced):** `scripts/check-unwired-capabilities.sh` (run inside
  conventions-gate) fails if any namespace+Static/Reactive module is referenced ONLY by its own file +
  test. Forward-milestones (LSP/Markdown) are allowlisted WITH a justification; the list only SHRINKS.
- **SETTINGS APPLIED-EFFECT META-GATE (#2, being built as P3):** every Settings field MUST have an e2e
  test that DRIVES its observable effect; a schema-enumeration meta-assertion fails the gate if any field
  lacks one. This is why 8 dead settings went unnoticed — the existing tests only assert the ref changed.

## Invariant-contract system (executable felt-invariants + the ratchet)

A prose invariant that doesn't gate is just a description (the audit found DiffView had a full
`*.invariants.md` while being DEAD). Load-bearing FELT invariants get a DRIVEN assertion that runs at the
merge gate — `scripts/behavioral-contracts.sh`. Rules:

- **ASSERT ESSENCE, NOT EXPRESSION.** Gate the refactor-proof behavior ("a wheel notch glides past its
  immediate step, then decays to rest"), never an implementation detail ("the handler calls addImpulse").
  An impl-coupled assertion gates the expression, not the invariant, and breaks on honest refactors.
- **LOAD-BEARING ONLY.** Gate what must be true for the subsystem to be itself. Decorative behavior
  (exact decel curve, exact pixel) stays ungated — a false invariant increases rigidity without truth.
- **RATCHET (the core rule).** Every user-reported behavioral regression, ONCE FIXED, becomes a PERMANENT
  contract entry BEFORE the fix commits. The protected set only ever grows; the same break cannot recur
  silently. (First entries: momentum-glide per non-wrap pane. Wrap-mode-momentum joins when bug 2 lands.)
- **SUBSYSTEM-TOUCH GATE.** Changing a subsystem means re-running its contracts, not just tsc. Wiring a
  setting into the scroll path = the scroll contracts must still pass. "It typechecks" is not "it still
  feels right." The behavioral suite is the mechanical form of that check.
- Mirror of idle-quiescence: quiescence asserts motion STOPS at rest; momentum-glide asserts motion
  CONTINUES then stops. Both are load-bearing feel-invariants, both driven, both gated.
- **A scroll test MUST replicate the REAL USER PATH from a fresh open (user requirement).** Open a
  MODERATE-length file (a few screenfuls — enough to traverse start↔end deterministically, not stress
  volume). From the POST-OPEN state, scroll via the REAL input (wheel AND keyboard) — do NOT inject a
  focus click and do NOT drive scrollTop directly (either MASKS the bug: a click focuses/moves the cursor;
  a direct scrollTop write bypasses the input path). Assert BOTH directions: scrolling DOWN reaches +
  renders the TRUE last line at the bottom; scrolling UP returns + renders the TRUE first line at the top.
  This single contract catches THREE classes at once: focus-on-open (wheel does nothing after open), a
  cursor-reveal that re-pins the viewport to the cursor line (a $watchEffect reading scrollTop re-runs on
  every scroll → snaps back to the cursor at line 0 — the actual bug), and wrong max-scroll extent (can't
  reach an end). The false-green that shipped it: the test had focus already set / drove scrollTop, so it
  never exercised the real open-then-wheel path. Gated in scripts/behavioral-contracts.sh (merge-gate).

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
- SETTINGS APPLIED-EFFECT is an ENFORCED INVARIANT (user): a persist-only test is insufficient — every
  settings field needs a REPEATABLE e2e test that drives the observable effect (status.json/FrameProbe/
  behavior) after setting it the real way, then re-changes + re-asserts. A schema-enumeration
  META-ASSERTION requires every field to have such a test (a new setting without one FAILS the gate).
  Rationale: sidebarWidth was a live panel control that did nothing (RootView didn't read it) — a dead
  setting only an applied-effect test catches. Deterministic via the fake-fs/settings seam; always-run.

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
- Cmd+Up / Cmd+Down (document start/end) — UNBINDABLE on the user's terminal (cat -v capture, RESOLVED
  2026-07-21, do NOT add a binding): Cmd+Up arrives as `\e[<65;61;16M` = an SGR MOUSE WHEEL event
  (button 65 = wheel-down) — the terminal translates Cmd+Up into a scroll gesture, INDISTINGUISHABLE from
  a real wheel, so binding it would fire on every scroll and break scrolling. Cmd+Down produces NOTHING
  (swallowed). Document start/end stays on the canonical **Ctrl+Home / Ctrl+End** (which reach the app
  reliably). Making Cmd+Up/Down send distinct sequences would require a user-side iTerm2 remap. Thread closed.

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
