// OS clipboard capability with a platform fallback ladder: copy/paste via wl-copy·wl-paste (Wayland)
// / xclip / xsel / pbcopy·pbpaste (macOS); OSC 52 terminal escape as the copy fallback (works over
// SSH, write-only). Stateless behavior → a Static capability. Detection is cached at module scope.
import { Static } from './Static';

export interface ClipboardTool {
  copy: string[];
  paste: string[];
}

let detected: ClipboardTool | null | undefined = undefined;

async function which(cmd: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['which', cmd], { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 0;
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
  for (const c of candidates) {
    if (await which(c.probe)) {
      detected = c.tool;
      return c.tool;
    }
  }
  detected = null;
  return null;
}

class $Clipboard {
  /** Copy text to the system clipboard; OSC 52 fallback when no tool is available. */
  static async copy(text: string): Promise<boolean> {
    const tool = await detectTool();
    if (tool) {
      try {
        const p = Bun.spawn(tool.copy, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
        p.stdin.write(text);
        await p.stdin.end();
        if ((await p.exited) === 0) return true;
      } catch {
        /* fall through to OSC 52 */
      }
    }
    try {
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      process.stdout.write(`\x1b]52;c;${b64}\x07`);
      return true;
    } catch {
      return false;
    }
  }

  /** Read the system clipboard; '' when no read tool is available (OSC 52 read is unreliable). */
  static async paste(): Promise<string> {
    const tool = await detectTool();
    if (!tool) return '';
    try {
      const p = Bun.spawn(tool.paste, { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return out;
    } catch {
      return '';
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
