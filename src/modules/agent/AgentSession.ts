// The reactive agent service: it composes an AgentBackend with an append-only transcript and wires the
// event direction once, then exposes the session reactively. Backend events (backend.onEvent) fold into
// ONE transcript owned here; each fold bumps `renderRevision` so the single coarse frame effect repaints
// WITHOUT a keypress (an idle session bumps nothing → idle quiescence holds). The transcript is the
// single source of session truth: every surface (pane renderer, badges, persistence) PULLS from it and
// none keeps a parallel history. Assistant text-deltas accumulate into the current assistant turn; any
// other event closes that turn — so streaming text renders as one growing bubble, not fragments.
//
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
// invariant: One session is one Reactive instance (src/modules/agent/agent.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import type { AgentBackend } from './AgentBackend';
import type { AgentEvent, AgentStatus, TranscriptEntry } from './AgentEvents';

class $AgentSession {
  /** The one append-only transcript. Mutated only by fold()/send() here; read-only everywhere else. */
  private readonly entries: TranscriptEntry[] = [];
  /** True while the trailing assistant entry is still accumulating text-deltas. */
  private assistantTurnOpen = false;

  constructor(private readonly backend: AgentBackend) {
    this.backend.onEvent((event) => this.fold(event));
  }

  /** Bumped on every folded event — the reactive paint signal the frame effect observes so async
   *  agent output repaints on its own. */
  get renderRevision() {
    return ref(0);
  }

  /** The lifecycle state derived from the event stream (idle → streaming → awaiting-tool → …). */
  get status() {
    return ref<AgentStatus>('idle');
  }

  /** Read-only view of the transcript — the projection surface every UI reads. */
  get transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  /** True while a turn is in flight (no new turn may start until it settles). */
  get busy(): boolean {
    return this.status.value === 'streaming' || this.status.value === 'awaiting-tool';
  }

  /** Submit a user turn. Ignored while a turn is already in flight (one turn at a time). */
  send(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed || this.busy) return;
    this.assistantTurnOpen = false;
    this.entries.push({ role: 'user', text: trimmed });
    this.status.value = 'streaming';
    this.renderRevision.value++;
    this.backend.send(trimmed);
  }

  /** Request the in-flight turn stop. */
  interrupt(): void {
    if (this.busy) this.backend.interrupt();
  }

  /** Fold one backend event into the transcript + derived status. The whole state machine lives here. */
  private fold(event: AgentEvent): void {
    switch (event.kind) {
      case 'session-start':
        this.status.value = 'streaming';
        break;
      case 'text-delta':
        if (!this.assistantTurnOpen) {
          this.entries.push({ role: 'assistant', text: '' });
          this.assistantTurnOpen = true;
        }
        {
          const last = this.entries[this.entries.length - 1];
          if (last && last.role === 'assistant') last.text += event.text;
        }
        this.status.value = 'streaming';
        break;
      case 'tool-use':
        this.assistantTurnOpen = false;
        this.entries.push({ role: 'tool-use', id: event.id, name: event.name, input: event.input });
        this.status.value = 'awaiting-tool';
        break;
      case 'tool-result':
        this.assistantTurnOpen = false;
        this.entries.push({ role: 'tool-result', id: event.id, result: event.result, isError: event.isError });
        this.status.value = 'streaming';
        break;
      case 'error':
        this.assistantTurnOpen = false;
        this.entries.push({ role: 'error', text: event.message });
        break;
      case 'session-end':
        this.assistantTurnOpen = false;
        this.status.value = event.reason === 'error' ? 'ended' : 'idle';
        break;
    }
    this.renderRevision.value++;
  }

  dispose(): void {
    this.backend.dispose();
  }
}

export namespace AgentSession {
  export const $Class = $AgentSession;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
  export type Model = InstanceType<typeof Class>;
}
