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
- **RECORDED KNOWN LIMITATIONS / FOLLOW-UP INVESTIGATIONS** (finisher + baseline carry-forwards):
  - *Astral-plane input dropped app-wide*: characters beyond the BMP (emoji, some CJK extensions)
    are discarded by OpenTUI's input parser before the app ever sees them — typing/pasting them
    is a no-op everywhere (editor, find, composer). BMP-wide input (CJK, accents) works. Upstream
    parser limitation; needs an OpenTUI-side fix or a raw-sequence bypass.
  - *Input-latency proxy regression*: the 2026-07-21 post-demand-driven-rendering run measured
    p50 ≈ 5 ms; the 2026-07-24 repaired-harness run measures p50 ≈ 28 ms (one frame period) with
    idle quiescence still intact — something in the feature growth since re-quantized the
    keypress→flush path to the frame cadence. Needs a targeted bisect
    (see project.performance-baselines.md, "Input-latency proxy regression note").

The reports are verbatim reviewer output; treat as findings-at-a-point-in-time, not doctrine.
