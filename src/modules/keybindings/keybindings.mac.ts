// The macOS overlay — ALIASES for mac-native chords, layered over the canonical floor (every
// action here is also reachable canonically; removing this layer leaves a fully operable app).
// Registered unconditionally: these patterns only match when the terminal actually delivers the
// corresponding events, so on non-mac terminals they are inert — degradation is silence, never a
// misfire.
//
// invariant: Modifier fidelity varies by protocol (keybindings.invariants.md)
// invariant: The canonical layer is the floor (keybindings.invariants.md)
import type { Keybinding } from './KeybindingRegistry';

export const macOverlayBindings: Keybinding[] = [
  // Deliberately no Alt/Option+Delete -> buffer.close alias. Word deletion lives in the canonical
  // text-input bindings; closing a buffer remains Ctrl+W (and any independently deliverable Cmd alias).
  // Option word-jumps. Terminals encode Option+arrow either as alt+arrow, or as the readline
  // forms ESC-b / ESC-f (Terminal.app default profile) — both patterns, one intent.
  { chord: { key: 'left', alt: true }, action: 'editor.wordLeft', context: 'editor' },
  { chord: { key: 'right', alt: true }, action: 'editor.wordRight', context: 'editor' },
  { chord: { key: 'b', alt: true }, action: 'editor.wordLeft', context: 'editor' },
  { chord: { key: 'f', alt: true }, action: 'editor.wordRight', context: 'editor' },
  // Option+Up/Down: paragraph-ish jumps map to the warp jumps.
  { chord: { key: 'up', alt: true }, action: 'editor.jumpUp', context: 'editor' },
  { chord: { key: 'down', alt: true }, action: 'editor.jumpDown', context: 'editor' },

  // Cmd navigation — arrives EITHER as terminal translations (iTerm2 sends Home/End for
  // Cmd+Left/Right, already canonical) OR as true `super` events under the kitty keyboard
  // protocol. The super forms:
  { chord: { key: 'left', super: true }, action: 'editor.lineStart', context: 'editor' },
  { chord: { key: 'right', super: true }, action: 'editor.lineEnd', context: 'editor' },
  { chord: { key: 'up', super: true }, action: 'editor.documentStart', context: 'editor' },
  { chord: { key: 'down', super: true }, action: 'editor.documentEnd', context: 'editor' },

  // Cmd editing chords (kitty protocol only — legacy terminals never deliver super, and the
  // Ctrl forms remain the floor).
  { chord: { key: 'c', super: true }, action: 'editor.copy', context: 'editor' },
  { chord: { key: 'v', super: true }, action: 'editor.paste', context: 'editor' },
  { chord: { key: 'x', super: true }, action: 'editor.cut', context: 'editor', when: 'editorHasSelection' },
  { chord: { key: 'a', super: true }, action: 'editor.selectAll', context: 'editor' },
  { chord: { key: 's', super: true }, action: 'editor.save', context: 'editor' },
  { chord: { key: 'z', super: true, shift: false }, action: 'editor.undo', context: 'editor' },
  { chord: { key: 'z', super: true, shift: true }, action: 'editor.redo', context: 'editor' },
  { chord: { key: 'p', super: true }, action: 'palette.open' },
  { chord: { key: 'q', super: true }, action: 'app.quit' },
];
