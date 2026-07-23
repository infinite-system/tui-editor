// The agent event vocabulary — the honest minimal shape of "what an agent session emits". An agent is
// NOT a screen (ANSI cells you can only replay); it is a STREAM OF STRUCTURED EVENTS the host can
// project into any surface. This file defines that stream's types (`AgentEvent`) and the append-only
// transcript those events fold into (`TranscriptEntry`). Every backend — the scripted MockAgentBackend,
// the real CliStreamBackend later — speaks exactly this vocabulary, and every surface (pane renderer,
// badges, persistence) is a pure projection of the transcript. No ANSI, ever.
//
// invariant: An agent session is a structured event stream, not a screen (src/modules/agent/agent.invariants.md)
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)

/** A single structured event emitted by an AgentBackend, in the order the session produced it. */
export type AgentEvent =
  /** The session began accepting turns. */
  | { readonly kind: 'session-start' }
  /** A streaming chunk of assistant text. Consecutive deltas concatenate into one assistant turn. */
  | { readonly kind: 'text-delta'; readonly text: string }
  /** The assistant requested a tool call. `id` correlates with the matching `tool-result`. */
  | { readonly kind: 'tool-use'; readonly id: string; readonly name: string; readonly input: unknown }
  /** A tool call finished. `id` matches the originating `tool-use`. */
  | { readonly kind: 'tool-result'; readonly id: string; readonly result: string; readonly isError: boolean }
  /** A session-level error (transport, backend, protocol) — distinct from a tool that returned isError. */
  | { readonly kind: 'error'; readonly message: string }
  /** The session finished; `reason` says how. */
  | { readonly kind: 'session-end'; readonly reason: AgentEndReason };

/** How a session ended. */
export type AgentEndReason = 'completed' | 'interrupted' | 'error';

/** The role of an append-only transcript entry — the projection surface every UI reads. */
export type TranscriptRole = 'user' | 'assistant' | 'tool-use' | 'tool-result' | 'error';

/** One append-only transcript entry. Assistant text-deltas accumulate into a single 'assistant' entry
 *  until a non-text event closes it; everything else appends a discrete entry. */
export type TranscriptEntry =
  | { readonly role: 'user'; readonly text: string }
  | { readonly role: 'assistant'; text: string }
  | { readonly role: 'tool-use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly role: 'tool-result'; readonly id: string; readonly result: string; readonly isError: boolean }
  | { readonly role: 'error'; readonly text: string };

/** The lifecycle state of a session, derived from the event stream. Drives composer availability and
 *  status affordances without any surface tracking its own copy. */
export type AgentStatus = 'idle' | 'streaming' | 'awaiting-tool' | 'ended';
