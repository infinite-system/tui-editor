# Keybindings — Invariants

Load-bearing rules for `src/modules/keybindings/`. Stands on `project.invariants.md`. Written
BEFORE the implementation (the contract is the reduction; the code realizes it).

## Reality-based invariants

### A terminal delivers encoded sequences not keys

**Invariant:** If input arrives from a terminal, then it arrives as encoded byte sequences whose
mapping to physical chords varies by terminal, protocol, and mode — and some chords are consumed
upstream (terminal app menus, tmux prefix, flow control) and NEVER arrive at all.

**Scope:** all keyboard input to the app, on every terminal.

**Mechanism:** the same physical chord encodes differently (legacy CSI vs kitty protocol vs
terminal-specific translations: mac Option+arrow may arrive as ESC-b/f or CSI with modifier;
Cmd+arrow may arrive as Home/End or as a kitty `super` event or not at all). Nothing the app does
changes what arrives — it can only decode what does.

**Generates:** the need for ONE decode layer; the impossibility of "binding Cmd+C" as bytes; the
deliverability-honesty requirement.

**Evidence:** OpenTUI ships two parsers (`parse.keypress` legacy + `parse.keypress-kitty`) and
`KeyEvent.super` exists only under the kitty protocol (`source: 'raw' | 'kitty'`); Terminal.app
consumes Cmd+C before the pty; Ctrl+Q is flow-control on many terminals (why F10 and the
Ctrl+X..Ctrl+C chord exist as quit fallbacks).

**Impossible if true:** a binding expressed as raw bytes that works across terminals; an app-side
guarantee that any specific mac Cmd-chord is receivable.

**Verification:** the parser pair in `@opentui/core`; tmux sequence tests driving distinct
encodings of the same logical chord.

**Status:** established

**Last refined:** 2026-07-21

### Modifier fidelity varies by protocol

**Invariant:** If the terminal speaks the kitty keyboard protocol, then `super`/`repeat`/release
fidelity exists; if not, those distinctions are collapsed or absent — the binding set must remain
OPERABLE at the lowest fidelity.

**Scope:** modifier-dependent bindings (Cmd/super aliases, any future repeat/release use).

**Mechanism:** `useKittyKeyboard` upgrades fidelity when the terminal supports it; on legacy
terminals `super` simply never appears, so super-addressed bindings never match — they degrade to
silence, not misfires, and every action they alias retains a canonical (Ctrl/function-key) binding.

**Generates:** the canonical-floor rule (every action reachable without super/option); safe mac
aliases.

**Evidence:** `KeyEvent.super?: boolean` (optional — absent on legacy); `KittyKeyboardOptions` in
the renderer.

**Impossible if true:** an action whose ONLY binding requires kitty-level fidelity.

**Verification:** registry test — for every action bound with `super`, a non-super binding exists.

**Status:** established

**Last refined:** 2026-07-21

## Chosen invariants

### Bindings are intent addressed

**Invariant:** If a chord does something, then it does it by resolving to an ACTION ID through the
registry — never by inline key-handling code. A binding is data: `chord pattern (or step list) →
action id (+ context guard)`.

**Scope:** every keyboard behavior in the app (palette text entry and typed-character insertion are
the residual DEFAULT actions of their contexts, themselves dispatched by the registry).

**Mechanism:** `KeybindingRegistry.resolve(keyEvent, context)` performs a pure data lookup over the
layered binding set and returns an action id (or a pending-chord state, or null); Bootstrap maps
action ids to handlers. Multi-step chords (Ctrl+X..Ctrl+C) are step-list DATA with a timeout, not
bespoke state code.

**Generates:** rebindability; the palette able to LIST every binding; plugins contributing bindings
as data; the dissolution of Bootstrap's key if/else chains.

**Evidence:** to be realized by this module — `keybindings.defaults.ts` (canonical data),
`KeybindingRegistry` (lookup), Bootstrap reduced to `resolve → dispatch`.

**Impossible if true:** a key behavior implemented outside registry dispatch; an action reachable
only through an unlisted binding; encoding logic anywhere but the decode layer.

**Verification:** grep-level — Bootstrap contains no chord conditionals, only dispatch; registry
tests for every default binding; the checker's annotation on the dispatch site.

**Status:** provisional

**Last refined:** 2026-07-21

### Resolution is layered and later layers shadow earlier

**Invariant:** If two layers bind the same chord in the same context, then the LATER layer wins:
canonical floor ← platform overlay (mac) ← user rebinds. Within a layer, a context-guarded binding
outranks an unguarded one, and a matching single binding outranks starting a chord.

**Scope:** the registry's resolution order.

**Mechanism:** layers are concatenated in priority order and scanned last-to-first; guards
(`when` predicates registered by the host) filter candidates before precedence. Pure function of
(event, context, pending-chord state).

**Generates:** mac defaults that don't fork the canonical set; user rebinds that never require
editing shipped data; deterministic conflicts.

**Evidence:** to be realized; registry precedence tests (shadowing, guard outranking, single-over-
chord).

**Impossible if true:** a chord whose meaning depends on definition ORDER within a layer file; a
user rebind that cannot override a shipped binding.

**Verification:** resolver unit tests enumerating the precedence lattice.

**Status:** provisional

**Last refined:** 2026-07-21

### The canonical layer is the floor

**Invariant:** If an action is bound at all, then it has a binding in the canonical layer that uses
only universally-deliverable chords (Ctrl, plain keys, function keys, arrows) — overlays ALIAS, they
never replace the floor.

**Scope:** `keybindings.defaults.ts` vs every overlay.

**Mechanism:** overlays add patterns for the same action ids; removing every overlay leaves a fully
operable app.

**Generates:** mac/linux/ssh parity; safe degradation when a fancy chord can't arrive.

**Evidence:** to be realized; test — every overlay action id also appears in the canonical layer.

**Impossible if true:** an action reachable on one platform and unreachable on another.

**Verification:** the overlay-floor registry test.

**Status:** provisional

**Last refined:** 2026-07-21

### Advertised bindings are deliverable bindings

**Invariant:** If the UI shows a chord hint (status bar, palette, help), then it shows the
EFFECTIVE binding as resolved for this session's layers — never a chord the current terminal is
known to be unable to deliver.

**Scope:** every user-visible binding hint.

**Mechanism:** hints are pulled from `registry.effectiveBindings()` (the post-shadowing map), not
hand-written strings; platform-conditional chords appear only when their layer is active.

**Generates:** honest help text; hints that update when the user rebinds.

**Evidence:** to be realized (palette hint rendering from the registry).

**Impossible if true:** a hard-coded hint string that contradicts the live binding set.

**Verification:** hint text sourced from the registry in code review; a test that a rebind changes
the hint.

**Status:** provisional

**Last refined:** 2026-07-21
