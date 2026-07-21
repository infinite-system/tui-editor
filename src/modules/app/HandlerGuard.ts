// A thrown exception in a frame, input, or background event handler must NEVER wedge the
// demand-driven render loop. The loop only advances on events; if a handler throws and the throw
// escapes, the loop can stop requesting frames while the process stays alive — the app looks
// frozen though it is not (the worst possible failure, and a direct north-star violation).
//
// Every handler runs inside run(): a throw is caught, logged to the FILE log (never the TTY — the
// app owns the screen), and the offending cycle degrades to a no-op. A recover callback (request a
// repaint) then keeps the app responsive on the next event, so one bad cycle never freezes the app.
//
// invariant: The immediate layer never blocks (project.invariants.md)
import { Static } from 'ivue/extras';
import { Logging } from '../system/Logging';

class $HandlerGuard {
  /**
   * Run an event handler with exception isolation. A throw is logged and swallowed so it cannot
   * escape into the render loop; `recover` (typically a repaint request) runs afterward to keep
   * the app responsive. `recover` itself is guarded — recovery must never re-throw.
   */
  static run(label: string, handler: () => void, recover?: () => void): void {
    try {
      handler();
    } catch (error) {
      Logging.Class.error(`${label} handler threw (isolated, render loop kept alive): ${String(error)}`);
      if (recover) {
        try {
          recover();
        } catch (recoverError) {
          Logging.Class.error(`${label} recover threw (ignored): ${String(recoverError)}`);
        }
      }
    }
  }
}

export namespace HandlerGuard {
  export const $Class = $HandlerGuard;
  export let Class = Static($HandlerGuard);
}
