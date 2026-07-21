// Observability side channel (plan §5.2) — the deterministic artifact the tmux harness
// asserts against instead of scraping the pane. The app pushes model/process state here;
// this writes artifacts/status.json atomically after each settled frame.
//
// State verdicts come from this file + `git` + process snapshots; pane capture is reserved
// for genuinely visual assertions (layout, squiggles, theme).
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';

const STATUS_PATH = 'artifacts/status.json';
const TMP_PATH = 'artifacts/.status.json.tmp';
let prepared = false;

export interface StatusSnapshot {
  ready: boolean;
  frame: number;
  renderQuiescent: boolean;
  width: number;
  height: number;
  activeWorkspace: string | null;
  workspaces: string[];
  activeBuffer: string | null;
  bufferRevision: number;
  dirty: boolean;
  cursor: { line: number; col: number } | null;
  openBuffers: string[];
  diagnosticsCount: number;
  subprocessPids: number[];
  lifecycleTier: string;
  overlay: string | null;
  [key: string]: unknown;
}

const state: StatusSnapshot = {
  ready: false,
  frame: 0,
  renderQuiescent: false,
  width: 0,
  height: 0,
  activeWorkspace: null,
  workspaces: [],
  activeBuffer: null,
  bufferRevision: 0,
  dirty: false,
  cursor: null,
  openBuffers: [],
  diagnosticsCount: 0,
  subprocessPids: [],
  lifecycleTier: 'boot',
  overlay: null,
};

class $StatusChannel {
  static get path(): string {
    return STATUS_PATH;
  }

  static get snapshot(): StatusSnapshot {
    return state;
  }

  /** Merge a partial update into the live snapshot (does not write). */
  static update(patch: Partial<StatusSnapshot>): void {
    Object.assign(state, patch);
  }

  /** Atomically flush the current snapshot to disk (write-temp + rename). */
  static flush(): void {
    if (!prepared) {
      try {
        mkdirSync('artifacts', { recursive: true });
      } catch {
        /* ignore */
      }
      prepared = true;
    }
    try {
      writeFileSync(TMP_PATH, JSON.stringify(state, null, 2));
      renameSync(TMP_PATH, STATUS_PATH);
    } catch {
      /* never crash the app over observability */
    }
  }

  /** Mark the frame settled and flush — called after a render quiesces. */
  static settle(frame: number): void {
    state.frame = frame;
    state.renderQuiescent = true;
    this.flush();
  }
}

export namespace StatusChannel {
  export const $Class = $StatusChannel;
  export let Class = $StatusChannel;
}
