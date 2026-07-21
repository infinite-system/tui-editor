// OS clipboard capability with a platform fallback ladder: copy/paste via wl-copy·wl-paste (Wayland)
// / xclip / xsel / pbcopy·pbpaste (macOS); OSC 52 terminal escape as the copy fallback (works over
// SSH, write-only). Stateless behavior → a Static capability. Detection is cached at module scope.
import { Static } from 'ivue/extras';
import { openSync, writeSync, closeSync } from 'node:fs';

export interface ClipboardTool {
  copy: string[];
  paste: string[];
}

let detected: ClipboardTool | null | undefined = undefined;

async function which(command: string): Promise<boolean> {
  try {
    const subprocess = Bun.spawn(['which', command], { stdout: 'ignore', stderr: 'ignore' });
    return (await subprocess.exited) === 0;
  } catch {
    return false;
  }
}

async function detectTool(): Promise<ClipboardTool | null> {
  if (detected !== undefined) return detected;
  const candidates: Array<{ probe: string; tool: ClipboardTool }> = [
    { probe: 'wl-copy', tool: { copy: ['wl-copy'], paste: ['wl-paste', '--no-newline'] } },
    {
      probe: 'xclip',
      tool: {
        copy: ['xclip', '-selection', 'clipboard'],
        paste: ['xclip', '-selection', 'clipboard', '-o'],
      },
    },
    {
      probe: 'xsel',
      tool: { copy: ['xsel', '--clipboard', '--input'], paste: ['xsel', '--clipboard', '--output'] },
    },
    { probe: 'pbcopy', tool: { copy: ['pbcopy'], paste: ['pbpaste'] } },
  ];
  for (const candidate of candidates) {
    if (await which(candidate.probe)) {
      detected = candidate.tool;
      return candidate.tool;
    }
  }
  detected = null;
  return null;
}

class $Clipboard {
  /** Which delivery worked on the last copy: the tool name, 'osc52', or null before any copy. */
  static lastBackend: string | null = null;

  // In-app clipboard buffer: paste ALWAYS works in-app after an in-app copy, even on machines with
  // no clipboard tool and a write-only OSC 52 (this VM: no xclip/xsel/wl-copy, no DISPLAY).
  private static internalBuffer = '';

  /** Copy text: system tool if present, else OSC 52 (tmux-passthrough aware); always buffers in-app. */
  static async copy(text: string): Promise<boolean> {
    this.internalBuffer = text;
    const tool = await detectTool();
    if (tool) {
      try {
        const subprocess = Bun.spawn(tool.copy, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
        subprocess.stdin.write(text);
        await subprocess.stdin.end();
        if ((await subprocess.exited) === 0) {
          this.lastBackend = tool.copy[0] ?? 'tool';
          return true;
        }
      } catch {
        /* fall through to OSC 52 */
      }
    }
    try {
      const base64 = Buffer.from(text, 'utf-8').toString('base64');
      // PLAIN OSC 52, even inside tmux: with set-clipboard on/external tmux itself intercepts it,
      // stores a tmux paste buffer, AND forwards to the outer terminal. (A Ptmux passthrough
      // wrapper would BYPASS tmux's handling and is dropped by default on tmux >= 3.3.)
      // Written to /dev/tty, NOT process.stdout — the TUI renderer owns/filters stdout and the
      // escape never reached the pty through it (verified: bare-shell OSC 52 lands in the tmux
      // buffer; the same escape via stdout under the renderer does not).
      const sequence = `\x1b]52;c;${base64}\x07`;
      try {
        const tty = openSync('/dev/tty', 'w');
        writeSync(tty, sequence);
        closeSync(tty);
      } catch {
        process.stdout.write(sequence); // no controlling tty (tests) — best effort
      }
      this.lastBackend = 'osc52';
      return true;
    } catch {
      this.lastBackend = null;
      return false;
    }
  }

  /** Read the clipboard: system tool if present, else the in-app buffer (OSC 52 is write-only). */
  static async paste(): Promise<string> {
    const tool = await detectTool();
    if (!tool) return this.internalBuffer;
    try {
      const subprocess = Bun.spawn(tool.paste, { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(subprocess.stdout).text();
      await subprocess.exited;
      return output;
    } catch {
      return this.internalBuffer;
    }
  }

  /** Test seam: force the detected tool (null → force the OSC 52 / empty-read fallback). */
  static setToolForTest(tool: ClipboardTool | null): void {
    detected = tool;
  }
}

export namespace Clipboard {
  export const $Class = $Clipboard;
  export let Class = Static($Class);
}
