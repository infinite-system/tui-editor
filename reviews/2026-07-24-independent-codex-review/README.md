# Independent codex review — 2026-07-24 (post-big-run)

Three independent codex-CLI reviewers (correctness / architecture-seams / performance+docs) ran
against main@56fe6df with no builder context. Findings were triaged by severity and dispositioned:

- **Fixed same-night** (branches fix-agent-review, fix-image-theme-review, fix-git-perf-review):
  text-geometry cluster (display-width + grapheme-safe selection), agent lifecycle cluster
  (revision fuse, SDK error-end, draft preservation, unanswered codex permission method, app-server
  exit hygiene, provider registry, O(viewport) projection, visibility-gated spinner), pixel
  placement supersede + sixel pixel-dims key, theme token escape hatches, narration queue bound,
  TerminalSession paste-mode bundle, GitWatcher symlink hole, CommitLog failure-EOF, stale-probe +
  diff-open races, GitBlame reactive LRU cache, editor wrap O(viewport) index, idle git-churn fix,
  hidden-sidebar rebuild gating, perf-baselines harness repair, and the doc reality-sync (2270f3c).
- **DEFERRED REFACTOR BACKLOG** (recorded, awaiting a dedicated pass — architecture report items):
  NdjsonSubprocessTransport unification (#1) · Processes.spawn low-level seam (#2) ·
  ReadOnlyTextBuffer for diff/markdown (#6) · per-surface action-handler tables (#7) ·
  MomentumAxis extraction + viewport scope-narrowing (#9) · AppStatusProjection out of Bootstrap
  (#13).

The reports are verbatim reviewer output; treat as findings-at-a-point-in-time, not doctrine.
