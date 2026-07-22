// Entry point. PROD PROFILE BY DEFAULT: NODE_ENV selects Vue's build (dev adds per-ref/effect
// bookkeeping — real CPU+RSS), so it is set BEFORE any vue-importing module loads (dynamic import
// below keeps the ordering; export NODE_ENV=development to develop against the dev build).
process.env.NODE_ENV ??= 'production';

async function loadApp() {
  const [{ Bootstrap }, { Logging }] = await Promise.all([
    import('./modules/app/Bootstrap'),
    import('./modules/system/Logging'),
  ]);
  return { Bootstrap, Logging };
}

async function main(): Promise<void> {
  const appModules = await loadApp();
  const rootArgument = process.argv[2];
  const booted = await appModules.Bootstrap.Class.boot({
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

main().catch(async (error) => {
  const { Logging } = await loadApp();
  Logging.Class.error(`fatal: ${String(error?.stack ?? error)}`);
  // eslint-disable-next-line no-console
  process.stderr.write(`fatal: ${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
