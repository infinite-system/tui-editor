// Entry shim — ONLY what a class cannot own. (1) NODE_ENV selects Vue's build (dev adds per-ref/effect
// bookkeeping — real CPU+RSS) at MODULE LOAD TIME, so it must be set before any vue-importing module
// loads; the dynamic import below enforces that ordering (export NODE_ENV=development to develop against
// the dev build). (2) The catch handles exactly one case — AppLoader itself failed to LOAD — where
// by definition no class is reachable, so it is bare stderr + exit, depending on nothing. Everything
// else (argv, boot, signals, fatal) lives in AppLoader: overridable and unit-tested.
process.env.NODE_ENV ??= 'production';

import('./modules/app/AppLoader')
  .then(({ AppLoader }) => AppLoader.Class.main())
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${String((error as { stack?: unknown })?.stack ?? error)}\n`);
    process.exit(1);
  });
