# Theme module invariants

This contract stands on `project.invariants.md`, especially *Terminal color and glyph support
varies* and *Appearance is data with a capability fallback*, sharpening both into the module-local
mechanisms the `theme` code actually enforces.

## Reality-based invariants

### Terminal capability can only be inferred from the environment

**Invariant:** If the theme resolves a color depth or glyph level, then the value comes from
environment heuristics (`COLORTERM`, `TERM`, `TERM_PROGRAM`, `LANG`, `NERD_FONT`) with a safe
default — never from a reliable in-band query, because terminals do not portably report their
own truecolor or nerd-font support.

**Scope:** `TerminalCapabilities.detectColorDepth` and `detectGlyphLevel`. Excludes explicit user
override through `Theme.setColorDepth` / `setGlyphLevel`, which replaces the inference.

**Renegotiable at:** project scope — *Terminal color and glyph support varies* in
`project.invariants.md` owns the wider claim; this record is its theme-module realization.

**Mechanism:** No standard escape sequence answers "do you render nerd glyphs" and color-depth
reporting is inconsistent, so detection reads env-var proxies and, when they are silent, falls to
a legible default (truecolor when `TERM` is unset, `unicode` on a UTF-8 `LANG`, else `ascii`).

**Generates:** The two capability ladders (a lossy detection MUST have a degrade path below it);
safe defaults over guessed maximums; user-overridable depth/level setters.

**Evidence:** `src/modules/theme/TerminalCapabilities.ts` (`detectColorDepth`, `detectGlyphLevel`
read only `Environment.Class.env(...)` and return a default).

**Impossible if true:** A color-depth or glyph-level value derived from an authoritative in-band
terminal query rather than an environment guess; detection that returns nothing (undefined) when
every env hint is absent. (Graphics-tier detection is DIFFERENT reality — graphics support IS
portably queryable in-band — and is governed by its own record below.)

**Verification:** Inspect `TerminalCapabilities.detectColorDepth` / `detectGlyphLevel` — every
branch reads an env var or returns a literal default; no I/O or terminal round-trip exists.

**Status:** provisional

**Last refined:** 2026-07-24

## Chosen invariants

### Graphics tier prefers the reported capability and degrades to cells

**Invariant:** If the image preview resolves a graphics tier, then the precedence is fixed:
`TUI_GRAPHICS_TIER` override → tmux guard (half-block; passthrough is unreliable) → OpenTUI's
reported terminal capabilities (never second-guessed by env) → conservative env heuristics →
the half-block floor; and while the async capability report has not arrived the tier may only
sit AT or BELOW where the report would put it — detection upgrades, it never flashes a rich
tier that must be taken back.

**Scope:** `TerminalCapabilities.detectGraphicsTier` (the precedence), the `reportedGraphics`
ref + `capabilities` event wiring and the tier ladder ask in `RootView` (the consumption).
Unlike color depth and glyph level, the primary signal here is OpenTUI's in-band query result —
graphics support is the capability terminals DO portably report (DA1 sixel flag, kitty graphics
query), which is why this record is not an instance of *Terminal capability can only be inferred
from the environment*.

**Mechanism:** `detectGraphicsTier(reported)` takes the report as a parameter (pure, testable);
`RootView` holds the report in a `shallowRef` updated by the renderer's `capabilities` event, and
`update()` reads it inside the frame effect, so the answer arriving re-renders and upgrades the
tier. The env heuristics run ONLY on a null report; the floor is `halfblock`, which every
terminal renders.

**Generates:** the kitty → sixel → half-block ladder in `ImageRenderers`; smokes that force any
tier via `TUI_GRAPHICS_TIER` even inside the tmux harness; zero risk of graphics escapes reaching
a terminal that never announced support.

**Evidence:** `src/modules/theme/__tests__/GraphicsTier.test.ts` (the full precedence matrix:
report beats env in both directions, tmux guard, override beats tmux, floor on silence);
`src/modules/theme/TerminalCapabilities.ts` (`detectGraphicsTier`).

**Impossible if true:** a kitty or sixel payload emitted because an env var guessed richer than
the terminal's own report; a rich tier active under tmux without the explicit override; a
detection result that a later capability report DOWNGRADES (report-then-degrade); a second
tier-precedence list outside `detectGraphicsTier`.

**Verification:** `bun test src/modules/theme/__tests__/GraphicsTier.test.ts`

**Status:** provisional

**Last refined:** 2026-07-24

### Appearance comes only from theme data

**Invariant:** If a rendered cell carries a color or glyph, then that value was read from the
active theme (a `Palette` field or an `IconSet` / `ActionIconSet` / `CheckboxIconSet` entry
resolved through `Theme.Class`), never written as a literal hex or glyph at the drawing site —
the `theme` module is the single source of appearance.

**Scope:** All styled output across ui, editor, syntax, diagnostics, and git decorations. The
sole home for color and glyph literals is `src/modules/theme`; consumers pull tokens, they do not
mint them.

**Mechanism:** `Theme` exposes `palette`, `icons`, `actionIcons`, `checkboxIcons`, and `icon()`
as plain getters that re-derive from `PALETTES` and the icon `SETS` on read; because the data is
reactive selection, a palette or capability change reaches every consumer without any component
caching or copying its own colors.

**Generates:** *The palette ladder quantizes color without leaving the palette*; *The glyph ladder
degrades icons single-cell and legible*; theme/icon-set plugin extension points; a single grep
boundary for auditing hard-coded appearance.

**Evidence:** `src/modules/theme/Theme.ts` (`palette`, `icons`, `actionIcons`, `checkboxIcons`,
`icon` getters); the color literals live only in `ThemePalettes.ts` (`DARK`, `LIGHT`) and the
glyph literals only in `ThemeIcons.ts` (`NERD`, `UNICODE`, `ASCII`, `ACTION_ICONS`,
`CHECKBOX_ICONS`).

**Impossible if true:** A rendering component outside `src/modules/theme` naming a `#rrggbb`
color or a nerd/unicode glyph literal to draw with instead of reading it from `Theme.Class`.

**Verification:** `grep -rnE "#[0-9a-fA-F]{6}" src --include=*.ts | grep -v modules/theme` returns
no drawing-site literal; `bun test src/modules/theme`.

**Status:** provisional

**Last refined:** 2026-07-21

### The palette ladder quantizes color without leaving the palette

**Invariant:** If a palette is resolved for a terminal of a given depth, then it passes through
`quantizePalette(base, depth)`: `truecolor` is identity, `256` maps every hex to the xterm 6×6×6
cube, `16` maps every hex to the nearest ANSI-16 color — and the result is always a complete
`Palette` with the same semantic-token keys, only the hex values changing.

**Scope:** `ThemePalettes.quantizePalette` and the `Theme.palette` getter that calls it. Every
color a consumer reads has already been quantized to the active `colorDepth`.

**Mechanism:** `quantizePalette` clones the base and rewrites only string fields starting with
`#`; the token set is preserved because it copies the object and mutates values in place, so no
key is dropped and no non-`#` field is touched. `256` and `16` map into fixed lookup tables
(`cube`, `ANSI16`), so the emitted color is always one the terminal can render.

**Generates:** Depth-safe rendering (a 16-color terminal never receives a truecolor hex); a
single quantization chokepoint instead of per-consumer downsampling.

**Evidence:** `src/modules/theme/ThemePalettes.ts` (`$quantizePalette`, `to256Hex`, `to16Hex`,
`ANSI16`, `cube`); `truecolor quantization is identity`, `16-color quantization maps every color
into the ANSI-16 set`, and `256 quantization keeps hex shape` in
`src/modules/theme/__tests__/theme.test.ts`.

**Impossible if true:** A quantized palette missing a semantic key present in the source palette;
a color emitted at `16` depth that is outside the ANSI-16 set; a truecolor hex surviving into a
`256`- or `16`-depth render.

**Verification:** `bun test src/modules/theme -t "quantization"`

**Status:** provisional

**Last refined:** 2026-07-21

### The glyph ladder degrades icons single-cell and legible

**Invariant:** If an icon, action button, or checkbox glyph is resolved, then it is selected from
the set for the active glyph level (`nerd` → `unicode` → `ascii`); the `ascii` rung is always a
printable single-cell marker, and every action/checkbox glyph at every level is exactly one cell
so the git-panel hit-columns stay aligned; an unknown file extension resolves to `set.file`,
never empty or undefined.

**Scope:** `ThemeIcons.iconSetFor`, `actionIconsFor`, `checkboxIconsFor`, and `iconFor`, plus the
`Theme` getters that call them. Covers file-tree icons, git changes-row action buttons, and
staging checkboxes.

**Mechanism:** The `SETS`, `ACTION_ICONS`, and `CHECKBOX_ICONS` tables are keyed by `GlyphLevel`,
so selection is a total lookup with no missing rung; the `ascii` entries are letters and
`+`/`-`/space/`x`; action and checkbox glyphs are authored as one code point each; `iconFor`
falls back through `set.ext[extension] ?? set.file` so it always returns a printable string.

**Generates:** Legible output on a no-nerd-font terminal; stable click hit-zones because button
and checkbox columns never shift width between capability levels.

**Evidence:** `src/modules/theme/ThemeIcons.ts` (`SETS`, `ACTION_ICONS`, `CHECKBOX_ICONS`,
`$iconSetFor`, `$actionIconsFor`, `$checkboxIconsFor`, `$iconFor`); `icon fallback ladder`,
`unicode icon set resolves known extension and falls back for unknown`, `checkbox icons ladder`,
and `git action icons ladder` in `src/modules/theme/__tests__/theme.test.ts`.

**Impossible if true:** An `ascii`-level render emitting a nerd or multi-cell glyph; an
action/checkbox glyph wider than one cell at any level; `iconFor` returning empty or undefined for
an unknown extension.

**Verification:** `bun test src/modules/theme -t "ladder"`

**Status:** provisional

**Last refined:** 2026-07-21
