// Entry point. The kernel boot phase composes modules and seals before App is constructed.
import { boot } from './modules/app/Bootstrap';
import { Logging } from './modules/system/Logging';

async function main(): Promise<void> {
  const rootArg = process.argv[2];
  const booted = await boot({
    root: rootArg,
    onQuit: () => {
      // Give the renderer a tick to restore the terminal, then exit.
      setTimeout(() => process.exit(0), 20);
    },
  });

  // Keep the process alive; the renderer owns the event loop via stdin.
  process.on('SIGINT', () => void booted.shutdown());
  process.on('SIGTERM', () => void booted.shutdown());
}

main().catch((err) => {
  Logging.Class.error(`fatal: ${String(err?.stack ?? err)}`);
  // eslint-disable-next-line no-console
  process.stderr.write(`fatal: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
