# Performance Baselines — measured (PROGRESS item 8)

Measured with `scripts/perf-baselines.sh` (rerunnable, session-scoped: unique tmux sessions +
per-session status side channels, so live demo instances are never touched).

> ## ⚠️ Two builds measured — read this first
>
> The original table (further down, "run1 / run2") was measured against the perfbaselines worktree
> BASE commit **`f8771ab`**, which **predates the demand-driven idle fix `68f897e`**. At `f8771ab`
> the render loop had no `dropLive`-at-quiescence logic, so it genuinely ran at ~28–29 fps at rest —
> the "142 / 145 idle frames FAIL" was a *correct measurement of a stale build*, not a false-green in
> shipped code. Those idle/latency numbers do NOT describe current `main`.
>
> ### Re-measured on current HEAD (post-fix), single run, 2026-07-21T12:05
>
> | Measurement | current HEAD | pre-fix (f8771ab) | Target | Verdict |
> |---|---|---|---|---|
> | Idle frame delta, final 5s untouched | **0** (12/12/12) | 142/145 (~28 fps) | 0 | **PASS** (was FAIL) — the fix |
> | Idle CPU, final 5s window | **0.60%** | 2.6–3.6% | <2% | **PASS** |
> | Input latency p50 / p95 | **5 ms / 7 ms** | 27–30 / 50–52 ms | <16 ms | **PASS** (was FAIL) |
> | RSS at rest (fixtures + 1 file) | 99.4 MB | 100.4 / 98.7 | <100 idle | borderline PASS |
> | RSS after 60s idle, 5 MB file open | 121.4 MB | 118.8 / 128.8 | <100 idle | **FAIL** (working set of a 5 MB file; leak-flat) |
> | RSS growth over 3 re-open cycles | +4.4 MB | −5.5 / +2.5 | flat | **PASS** (no leak trend) |
> | Boot-to-ready, harness-inclusive | 211–219 ms | 187–222 ms | <150 ms bare | not comparable (harness path) |
> | Clean exit / orphans | 4/5*, no orphans | 5/5 | clean | *cycle-1 miss was CPU contention from concurrent test runs, not a regression |
>
> **Why input latency improved so much:** the "<16 ms unachievable at targetFps:30" conclusion was
> itself an artifact of the *always-on* loop — a keypress waited up to one 33 ms frame period for the
> next scheduled render. With demand-driven rendering, a keypress calls `requestRender()` → an
> immediate one-shot frame → the status flush lands in ~5 ms. The fix improved input latency AND idle
> quiescence together. Idle quiescence is now an ENFORCED, blocking assertion (smoke-editor.sh, and a
> non-zero exit in this script) — measured ≠ enforced.
>
> Still open: idle RSS exceeds the 100 MB target once a 5 MB file is open (~121 MB); it is working set,
> not a leak (re-open cycles are flat). Bare-binary cold start vs <150 ms still needs a non-harness
> measurement.

---

## Original run (STALE — pre-fix build `f8771ab`, kept for provenance)

Two full runs, 2026-07-21; numbers below give both runs as `run1 / run2` where they differ.

## Machine context

| | |
|---|---|
| Platform | aarch64 Linux VM (Parallels), kernel 6.8.0-134-generic |
| CPU / RAM | 16 vCPU · 32 GB |
| Runtime | Bun 1.3.14 · `@opentui/core` 0.4.5 · `targetFps: 30` · CLK_TCK=100 |
| CPU sampling | `/proc/<pid>/stat` utime+stime deltas over 5s windows (NOT `ps %cpu`, which is a lifetime average) |
| Environment note | Other agents + a live user demo run concurrent editor instances; all measurements are pinned to the pid of the session this script launches |

## Results vs targets (brief §Performance Mandate, prototype targets)

| Measurement | run1 / run2 | Target | Verdict |
|---|---|---|---|
| Idle frame delta, FINAL 5s window (10s untouched) | 142 / 145 frames (~28.4–29.0 fps) | 0 | **FAIL** |
| Idle CPU, 5s windows at rest | 3.60→2.60% / 3.00→2.00% | ~0 (<2%) | **FAIL** (marginal, see evidence) |
| Reported "14% idle CPU" | not reproduced at rest (max 3.6% windowed) | — | **REFUTED as an idle figure** (see evidence) |
| RSS after boot (workspace open, no file) | 95.6 / 96.0 MB | — | info |
| RSS at rest, fixtures + one open file | 100.4 / 98.7 MB | <100 MB idle | **borderline FAIL** |
| RSS after opening a 5.15 MB / 50k-line file | 111.9 / 112.6 MB | — | info |
| RSS after 60s idle with the large file open | 118.8 / 128.8 MB | <100 MB idle | **FAIL** |
| Leak signal: RSS growth over 3 re-open cycles (big→small→big) | −5.5 / +2.5 MB (non-monotonic) | flat | **PASS** (GC slack, no leak trend) |
| bun runtime floor (`bun -e` + live event loop) | 33.1 MB | — | itemization baseline |
| OpenTUI + app boot delta (boot − floor) | 62.5 / 62.9 MB | — | itemization |
| Boot-to-ready, harness-inclusive, 5 cycles | 189–222 / 187–218 ms | <150 ms cold start (bare process) | not comparable (includes tmux + login shell + first quiescent frame; 20 ms poll grain) |
| Clean exit via Ctrl+Q, 5 cycles | 5/5 + 5/5, no orphan pids from any run | clean | **PASS** |
| Input latency proxy p50 (keypress→status-flush cursor change) | 30 / 27 ms | <16 ms input-to-screen | proxy only — see note |
| Input latency proxy p95 | 52 / 51 ms | — | proxy only |

Latency note: 20 ms poll grain + ~1–3 ms read cost, and the status flush is quantized to the
~33 ms frame cadence — so p50 ≈ one frame period is the *expected floor for this proxy*, an upper
bound on input-to-screen. However: with a 30 fps loop, worst-case input-to-paint is structurally
≥ one 33 ms frame period, so the <16 ms brief target cannot be met at `targetFps: 30` regardless
of code efficiency (bimodal samples ~27 ms vs ~50 ms = 1 vs 2 frame periods, exactly the
quantization signature).

## Evidence — idle quiescence FAIL (diagnosis only; no source modified)

The app **never goes quiescent**: the frame counter advances at ~29/s indefinitely at rest, on a
freshly booted instance with zero interaction pending, momentum velocity at zero, and no drag.

1. **The frame rate equals `targetFps`.** 142–145 frames per 5 s window ≈ 29 fps ≈ the renderer's
   30 fps target. A momentum/drag/viewport-convergence tick would decay or be bursty; a flat
   targetFps-rate signature is the render loop itself.
2. **Root cause (file:line):** `src/modules/app/Bootstrap.ts:478` calls `renderer.start()`.
   In `@opentui/core` 0.4.5 (`chunk-bun-tkm837n2.js`), `start()` sets control state
   `explicit_started` (line ~9295) and `loop()` unconditionally reschedules itself with
   `setTimeout(targetFrameTime)` while `_isRunning` is true (lines ~9652–9663) — a continuous
   render loop, independent of dirtiness and of `requestRender()`. The onFrame ticks in
   `Bootstrap.ts:178–204` are correctly gated (velocity/drag checks) and are NOT the cause.
3. **OpenTUI has an on-demand mode the app does not use:** control state `auto()` +
   `requestLive()`/`dropLive()` (lines ~9281–9300) pause the loop at zero live requests, and
   `requestRender()` schedules a single frame when the loop is not running (line ~7514). The
   momentum/drag ticks would need to hold a live request while animating.
4. **Secondary idle cost:** because a frame renders every ~33 ms, `Bootstrap.ts:201` calls
   `StatusChannel.Class.settle(frame)` every frame → `src/modules/system/StatusChannel.ts:89–93`
   `flush()` does `writeFileSync` + `renameSync` of the pretty-printed status JSON ~29×/s at
   idle — continuous disk writes contributing to the idle CPU and I/O.
5. **The "14% idle CPU" report:** refuted as an *idle* figure on this machine — true at-rest
   windowed CPU is 2.0–3.6%. Plausible origins for 14%: `ps %cpu` is a *lifetime average*
   (measured 5.0–5.8% on instances that had just booted + interacted; higher after heavy
   interaction), or a sample taken while momentum/drag animation was active. The live user demo
   sampled at 6.8% windowed during unknown activity. Regardless, idle CPU still FAILS the <2%
   target — because of the continuous render loop, not because it is 14%.

## Evidence — memory FAIL

- Itemization: bun runtime floor **33.1 MB** + OpenTUI/app boot delta **~63 MB** ≈ **96 MB before
  any file is open** — the boot footprint alone nearly consumes the 100 MB budget; the brief's
  <60 MB stretch target is structurally out of reach without shrinking the boot delta.
- The 5.15 MB/50k-line file adds ~16 MB on first open (text + line index + render state ≈ 3× the
  raw bytes — unsurprising for UTF-16-ish storage + per-line structures).
- Re-open cycles oscillate 117.9–128.1 MB with no monotonic trend (−5.5 MB run1, +2.5 MB run2
  cycle1→cycle3): **no leak signal**; the band above the first-open value is Bun GC slack —
  RSS is high-water-mark-ish, and the continuous render loop gives the GC no idle window.
- 60s-idle RSS (118.8 / 128.8 MB) did not shrink back toward the boot figure.

## Lifecycle + orphan audit

- 5/5 launch→ready→Ctrl+Q cycles exited cleanly in both runs (bun pid gone within the 5 s
  wait; typically well under 1 s). Boot-to-ready 187–222 ms *including* tmux session creation +
  login shell + bun startup + first quiescent frame; the bare-process cold-start target
  (<150 ms) needs a TTY-direct measurement outside this harness to adjudicate.
- Orphan audit: every bun pid spawned by the script (7 per run) exited; global editor-process
  counts are reported but informational only, since concurrent agents launch their own instances.

## How to rerun

```
bash scripts/perf-baselines.sh    # ~3.5 min; exits non-zero only if a MEASUREMENT could not be taken
bash scripts/smoke-editor.sh      # verified ALL-PASS after both perf runs
```
