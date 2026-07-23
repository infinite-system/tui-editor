// The agent session as a PaneContent — the adapter that makes an AgentSession a first-class occupant of
// the composable PanelHost. It owns only the COMPOSER buffer (the line being typed); all session state
// lives below in the AgentSession (the single source of truth). render() delegates to AgentPaneRenderer,
// handleKey() edits the composer (printable → append, Backspace → delete, Enter → send + clear), and
// renderRevision fuses the session's paint pulse with composer edits so both repaint through the one
// frame effect. The host sees only a generic PaneContent.
//
// invariant: The agent pane is a PaneContent citizen, not a special case (src/modules/agent/agent.invariants.md)
// invariant: The transcript is the single source of agent session truth (src/modules/agent/agent.invariants.md)
import type { StyledText, KeyEvent } from '@opentui/core';
import { computed, ref, type Ref } from 'vue';
import type { PaneContent, PaneRenderContext } from '../ui/PaneContent';
import { AgentPaneRenderer } from './AgentPaneRenderer';
import type { AgentSession } from './AgentSession';

/** A printable single character (no modifier, code ≥ 32, not DEL) — same test the editor input uses. */
function isTypedCharacter(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option) return false;
  const sequence = key.sequence;
  if (!sequence || sequence.length !== 1) return false;
  const code = sequence.charCodeAt(0);
  return code >= 32 && code !== 127;
}

class $AgentPaneContent implements PaneContent {
  readonly id = 'agent';
  readonly icon = '✦';

  private readonly composer = ref('');
  /** Fuses the session's paint pulse with composer edits — the frame effect tracks both. */
  private readonly revision: Ref<number>;
  /** The pane height at last render, so caret() can pin the composer caret to the bottom row. */
  private lastHeight = 1;

  constructor(private readonly session: AgentSession.Instance) {
    this.revision = computed(() => this.session.renderRevision.value + this.composer.value.length);
  }

  get title(): string {
    return this.session.busy ? 'Claude (working…)' : 'Claude';
  }

  get renderRevision(): Ref<number> {
    return this.revision;
  }

  render(context: PaneRenderContext): StyledText {
    this.lastHeight = context.height;
    return AgentPaneRenderer.Class.render({
      session: this.session,
      palette: context.palette,
      width: context.width,
      height: context.height,
      composer: this.composer.value,
      focused: context.focused,
    });
  }

  handleKey(key: KeyEvent): boolean {
    if (key.name === 'return') {
      this.session.send(this.composer.value);
      this.composer.value = '';
      return true;
    }
    if (key.name === 'backspace') {
      this.composer.value = this.composer.value.slice(0, -1);
      return true;
    }
    if (isTypedCharacter(key)) {
      this.composer.value += key.sequence;
      return true;
    }
    return false;
  }

  caret(): { column: number; row: number } | null {
    // The composer sits on the last row, after the '❯ ' prompt (2 cells).
    return { column: 2 + [...this.composer.value].length, row: Math.max(0, this.lastHeight - 1) };
  }

  onResize(_columns: number, _rows: number): void {
    /* the transcript reflows purely from width at render time; nothing to push down a seam */
  }

  onFocus(): void {
    /* no focus-specific state; the composer caret follows context.focused */
  }

  onBlur(): void {
    /* no-op */
  }

  dispose(): void {
    this.session.dispose();
  }
}

export namespace AgentPaneContent {
  export const $Class = $AgentPaneContent;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
