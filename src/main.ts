// Entry point. The kernel boot phase composes modules and seals before App is constructed.
import { boot } from './modules/app/Bootstrap';
import { Logging } from './modules/system/Logging';

async function main(): Promise<void> {
  const rootArgument = process.argv[2];
  const booted = await boot({
    root: rootArgument,
    onQuit: () => {
      // Give the renderer a tick to restore the terminal, then exit.
      setTimeout(() => process.exit(0), 20);
    },
  });

  // Keep the process alive; the renderer owns the event loop via stdin.
  process.on('SIGINT', () => void booted.shutdown());
  process.on('SIGTERM', () => void booted.shutdown());
}

main().catch((error) => {
  Logging.Class.error(`fatal: ${String(error?.stack ?? error)}`);
  // eslint-disable-next-line no-console
  process.stderr.write(`fatal: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
