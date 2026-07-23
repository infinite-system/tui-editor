# Audio Narration — Invariants

Load-bearing rules for `src/modules/narration/` (the audio projection of an agent session — the THIRD
projection: text→pane, visual→decorations, audio→speech). Stands on `project.invariants.md` (one-way
data flow, cost tracks the observed set) and `agent.invariants.md` (the transcript is the single source
of session truth). It deliberately mirrors the backend-seam pattern of `terminal.invariants.md` /
`agent.invariants.md`: a `TtsBackend` interface with a Mock (hermetic gate) and a System implementation
(real engine, auto-detected). Tier-S scope: speak completed assistant turns aloud, opt-in, interruptible.

## Reality-based invariants

### Narration is a pure projection of the transcript

**Invariant:** The narration keeps NO history of its own — it derives everything it speaks from the
session's append-only transcript, the same source the pane renderer and any decorations read. It only
ever speaks the text of `assistant` transcript entries; it never synthesizes, paraphrases, or invents
speech, so what is heard is always a subset of what is on screen. Because the three projections share
one source, they cannot drift out of sync.

**Scope:** `NarrationProjection` (subscriber), `AgentSession.transcript` (the read-only source),
`AgentEvents.TranscriptEntry`. NOT the backend, which only produces events.

**Mechanism:** `NarrationProjection` watches `session.renderRevision` and, on each bump, walks the
`session.transcript` array, speaking the text of newly finalized `assistant` entries and skipping every
other role (`user`, `tool-use`, `tool-result`, `error`). It holds only an index (`consideredThrough`)
into that shared array plus derived counters — never a parallel copy of any message text.

**Generates:** perfect text↔audio sync for free (audio is a function of the same transcript the screen
shows); a narrator that stays truthful to the visible session with zero reconciliation.

**Evidence:** `src/modules/narration/NarrationProjection.test.ts` (only assistant text is spoken —
user/tool entries never are; the spoken lines are exactly the assistant entries' text);
`scripts/smoke-audio-narration.sh` drives a real agent turn and asserts the spoken line equals the
assistant transcript text.

**Impossible if true:** narration speaking a user prompt or a tool result; spoken text that never
appears in the transcript; a narration history that diverges from the pane.

**Verification:** `bun test src/modules/narration/NarrationProjection.test.ts && bash scripts/smoke-audio-narration.sh`

**Status:** provisional

**Last refined:** 2026-07-23

## Chosen invariants

### Narration audio crosses exactly one TTS backend seam

**Invariant:** Every utterance leaves through the `TtsBackend` interface (`speak` / `stop` / `dispose`);
`NarrationProjection` never spawns a process, opens an audio device, or knows which engine (if any) is
present. So `MockTtsBackend` (records what would be spoken, no sound) and `SystemTtsBackend` (a real
engine + player) are interchangeable with zero change above the seam — the swap seam, parallel to the
terminal's `TerminalBackend` and the agent's `AgentBackend`.

**Scope:** `TtsBackend`, `MockTtsBackend`, `SystemTtsBackend`, `TtsFactory`, and the
`NarrationProjection` that depends only on the interface.

**Mechanism:** `NarrationProjection` is constructed with a `TtsBackend` and calls only `speak`/`stop`/
`dispose`. `TtsFactory.createBackend` picks the implementation: `INVAR_TTS_BACKEND=mock` forces the
silent double (so the gate emits no audio), otherwise a `SystemTtsBackend` that auto-detects the engine.
The projection has no `Bun.spawn`, no device, no engine name in its code path.

**Generates:** a hermetic, non-flaky narration gate (scripted transcript → asserted spoken lines through
the mock); a real audio path that drops in behind the same three methods.

**Evidence:** `src/modules/narration/NarrationProjection.test.ts` (the projection drives a
`MockTtsBackend` and the exact spoken lines are asserted); `TtsFactory` returns the mock under
`INVAR_TTS_BACKEND=mock`.

**Impossible if true:** `NarrationProjection` spawning a synth process directly; a second audio path
that bypasses the seam; the projection branching on the engine name.

**Verification:** `bun test src/modules/narration/NarrationProjection.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23

### Narration speaks only completed assistant turns

**Invariant:** The projection speaks an assistant turn ONLY at its completion milestone — when a later
event has closed it, or the session has settled (idle/ended) — never token-by-token while it streams.
An assistant entry that is still the trailing, open, streaming turn is not spoken until it finalizes.
This is the difference between a narrator (speaks whole thoughts) and a backseat driver (mutters every
fragment).

**Scope:** `NarrationProjection.onTranscriptChanged` / `isFinalized`, keyed off `AgentSession.status`
and the transcript's trailing-entry position.

**Mechanism:** An entry is finalized iff it has a successor (a later event closed it) OR it is the last
entry and `session.status` is `idle`/`ended`. `onTranscriptChanged` walks from `consideredThrough`,
STOPS at the first non-finalized entry (the open turn), and only advances/speaks past finalized ones —
so each assistant turn is uttered exactly once, in full, at its boundary.

**Generates:** speech that arrives at turn boundaries as coherent utterances; no stutter, no partial
sentences, no re-speaking as more tokens arrive.

**Evidence:** `src/modules/narration/NarrationProjection.test.ts` (streaming deltas speak nothing until
`session-end`; a turn closed by a following `tool-use` speaks at that boundary; each turn is spoken
once).

**Impossible if true:** speech emitted per token; the same turn spoken twice as it grows; a half-formed
sentence uttered before the turn closes.

**Verification:** `bun test src/modules/narration/NarrationProjection.test.ts`

**Status:** provisional

**Last refined:** 2026-07-23

### A keystroke barges in on narration

**Invariant:** Any keystroke immediately stops the current utterance and clears the queue — the
interruptibility invariant applied to audio. The user is never trapped listening; typing always wins.
Barge-in interrupts the CURRENT speech only; it does not disable narration, so subsequent turns still
narrate.

**Scope:** `NarrationProjection.bargeIn` (→ `TtsBackend.stop`) and the single call site at the top of
`Bootstrap.keyTick`.

**Mechanism:** `Bootstrap.keyTick` calls `narration?.bargeIn()` before any routing, on EVERY key.
`bargeIn` calls `tts.stop()`, which drops the queue and kills the current synth/player process (a no-op
when nothing is speaking, so it is always safe to call).

**Generates:** speech that yields the instant the user acts; no audio that outlives the user's
attention; parity with the terminal/agent interrupt affordances.

**Evidence:** `src/modules/narration/NarrationProjection.test.ts` (`bargeIn()` increments the mock's
`stopCount`); `scripts/smoke-audio-narration.sh` drives a keystroke mid-narration and asserts a stop
was issued.

**Impossible if true:** a keystroke that does not stop speech; audio that continues after the user
types; a barge-in that also permanently mutes future turns.

**Verification:** `bun test src/modules/narration/NarrationProjection.test.ts && bash scripts/smoke-audio-narration.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### A missing speech engine degrades to silence, never an error

**Invariant:** With no TTS engine installed, `SystemTtsBackend` is a clean no-op: `available` is false,
`speak`/`stop` do nothing, and no process is spawned — narration is simply silent until an engine is
installed. A failed spawn drops that one utterance rather than crashing. The feature's presence never
depends on an engine being present.

**Scope:** `SystemTtsBackend` (engine/player auto-detection, the guarded spawns), `TtsFactory`.

**Mechanism:** `detectEngine()` resolves the first of espeak-ng/piper/say on PATH (or null);
`detectPlayer()` resolves pw-play/aplay for the WAV pipe. `available` is false when no engine (or, on
Linux, no player) is found, and `speak` early-returns in that case. Each `Bun.spawn` is wrapped so a
launch failure skips the utterance and continues the queue. On this box no engine is installed, so the
backend reports `available=false` and utters nothing (`sudo apt-get install -y espeak-ng` enables it).

**Generates:** a feature that ships and passes its gate with no engine present; a real audio path that
lights up the moment an engine is installed, with no code change.

**Evidence:** the box has no engine (espeak-ng/piper/say absent); `TtsFactory` under
`INVAR_TTS_BACKEND=mock` keeps the gate hermetic; the app boots and runs with narration toggled on and
no engine, emitting no audio and no error (driven by `scripts/smoke-audio-narration.sh`, which runs the
whole flow through the mock).

**Impossible if true:** an unhandled error when narration is enabled with no engine; a crash from a
failed synth spawn; narration that refuses to exist unless an engine is present.

**Verification:** `bash scripts/smoke-audio-narration.sh`

**Status:** provisional

**Last refined:** 2026-07-23

### The narration voice is chosen from the discovered set

**Invariant:** The narration voice is picked from the piper voices actually INSTALLED on the machine —
discovered by scanning the voices directory (`$XDG_DATA_HOME/piper-voices`, else `~/.local/share/…`) AND
its `library/` subdir for `*.onnx` — never a hardcoded list. The selected voice (`agentNarrationVoice`,
'' = auto) resolves to that voice's model; an empty or unknown selection falls back to the first
discovered voice; no voices → null (silent). So every downloaded voice is selectable and the setting can
never point at a voice that is not present.

**Scope:** `VoiceDiscovery` (`discover`/`names`/`options`/`resolvePath`), `SystemTtsBackend.resolvePiperModel`
+ its `voice` option, `TtsFactory` (threads `voice`), and the settings picker (`agentNarrationVoice`, a
`dynamic-enum` whose options come from `VoiceDiscovery.options()`).

**Mechanism:** `VoiceDiscovery.discover` lists `*.onnx` in the dir + `library/`, dedupes by name (top
level wins), sorts. `options()` prepends '' (auto). `resolvePath(selected)` returns the matching model,
else the first, else null. `SystemTtsBackend.resolvePiperModel` delegates to it (an explicit
`INVAR_PIPER_MODEL` still overrides, for tests). The settings panel probes `options()` at panel-open so
the picker lists what is installed right now.

**Generates:** a real voice selector that replaces hand-moving `.onnx` files; the dynamic-enum primitive
(options-from-a-runtime-probe) reused later for providers/LSP servers.

**Evidence:** `src/modules/narration/VoiceDiscovery.test.ts` (discovery across dir + library/, ignoring
non-onnx; selected-over-first resolution incl. a library/ voice; INVAR_PIPER_MODEL override);
`src/modules/settings/SettingsPanel.test.ts` (the voice row is a dynamic-enum whose options are probed at
open and cycle the setting); `scripts/smoke-voice-picker.sh` (a seeded fake voices dir lists in the
picker, cycling changes the setting).

**Impossible if true:** a voice option that is not installed; a downloaded voice in `library/` that the
picker cannot select; a hardcoded voice list.

**Verification:** `bun test src/modules/narration/VoiceDiscovery.test.ts src/modules/settings/SettingsPanel.test.ts && bash scripts/smoke-voice-picker.sh`

**Status:** provisional

**Last refined:** 2026-07-23
