// File logger — the TUI owns the terminal, so logs must never touch stdout/stderr.
// Writes to artifacts/tui.log. Static capability.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOG_PATH = 'artifacts/tui.log';
let prepared = false;

class $Logging {
  static get path(): string {
    return LOG_PATH;
  }

  static write(level: string, msg: string): void {
    if (!prepared) {
      try {
        mkdirSync(dirname(LOG_PATH), { recursive: true });
      } catch {
        /* ignore */
      }
      prepared = true;
    }
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    try {
      appendFileSync(LOG_PATH, line);
    } catch {
      /* logging must never crash the app */
    }
  }

  static info(msg: string): void {
    this.write('info', msg);
  }

  static error(msg: string): void {
    this.write('error', msg);
  }
}

export namespace Logging {
  export const $Class = $Logging;
  export let Class = $Logging;
}
