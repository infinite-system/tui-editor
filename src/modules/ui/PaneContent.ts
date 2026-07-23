// The composable-view seam: the honest minimal shape of "a thing that occupies a pane slot". A
// PanelHost hosts a SWITCHABLE SET of these, and each is interchangeable — the terminal is the first
// citizen today; an Output view, a Problems list, or a plugin panel is the same shape tomorrow with
// zero host rewiring. Deliberately NOT retrofitted onto the existing editor/git/tree/markdown panes
// yet (that is an incremental follow-up) — this defines the seam and proves it with one instance.
//
// A pane content renders its region to cells, consumes focused input, and owns a reactive paint
// signal so async producers (a PTY, a log tail) repaint through the single frame effect. It knows
// nothing about the host, the split, or where it is mounted.
import type { StyledText } from '@opentui/core';
import type { KeyEvent } from '@opentui/core';
import type { Ref } from 'vue';
import type { Palette } from '../theme/ThemePalettes';
import type { GlyphLevel } from '../theme/TerminalCapabilities';

/** What a pane content is handed to render itself into the panel slot. */
export interface PaneRenderContext {
  /** Inner cell columns available to the content. */
  width: number;
  /** Inner cell rows available to the content. */
  height: number;
  palette: Palette;
  /** The active glyph fallback tier (nerd → unicode → ascii) — one source for every pane's icons. */
  glyphLevel: GlyphLevel;
  /** True while the panel owns the keyboard (content may paint focus affordances). */
  focused: boolean;
}

/** A switchable occupant of the bottom panel slot. */
export interface PaneContent {
  /** Stable identity used by the switcher (unique within a PanelHost). */
  readonly id: string;
  /** Human-readable name shown on the panel's switcher tab. */
  readonly title: string;
  /** Optional switcher glyph. */
  readonly icon?: string;
  /** A ref bumped whenever the content's projection changes (observed by the frame effect so an
   *  async change repaints without a keypress). */
  readonly renderRevision: Ref<number>;
  /** Project the content into cells for the given region. */
  render(context: PaneRenderContext): StyledText;
  /** Optional native caret cell (viewport-local column/row) so the host can place the terminal-style
   *  block cursor. Contents with no caret (a log view) omit this. */
  caret?(): { column: number; row: number } | null;
  /** Consume a keystroke while the panel is focused; return true if it was handled. */
  handleKey(key: KeyEvent): boolean;
  /** Optional: a wheel gesture over this cell, in signed content rows (negative = toward older/up,
   *  positive = toward newer/down); magnitude is the settings-sourced step. True if it was consumed. */
  onWheel?(rowDelta: number): boolean;
  /** Optional: a pointer-down inside this cell at content-local (column, row) — for click hit-testing
   *  (e.g. toggling a collapsed row). True if it was consumed (a repaint is requested for it). */
  onPointerDown?(column: number, row: number): boolean;
  /** Consume a bulk-text paste (clipboard / dictation) while the panel is focused; return true if it
   *  was handled. Optional — a content that has no text sink (a read-only log) omits it. */
  handlePaste?(text: string): boolean;
  /** The panel's region resized to this many cell columns × rows. */
  onResize(columns: number, rows: number): void;
  /** The panel gained keyboard focus. */
  onFocus(): void;
  /** The panel lost keyboard focus. */
  onBlur(): void;
  /** Release owned resources. */
  dispose(): void;
}
