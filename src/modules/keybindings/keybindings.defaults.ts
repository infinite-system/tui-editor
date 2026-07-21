// The CANONICAL binding layer — the floor: only universally-deliverable chords (Ctrl, plain keys,
// function keys, arrows). Overlays (mac) ALIAS actions bound here; they never replace the floor.
// Bindings are pure data: chord (or step list) -> action id (+ context / guard).
//
// invariant: The canonical layer is the floor (keybindings.invariants.md)
// invariant: Bindings are intent addressed (keybindings.invariants.md)
import type { Keybinding } from './KeybindingRegistry';

export const canonicalBindings: Keybinding[] = [
  // --- global ---
  { chord: { key: 'q', ctrl: true }, action: 'app.quit' },
  { chord: { key: 'f10' }, action: 'app.quit' },
  // Emacs-style quit chord (VS Code's terminal intercepts Ctrl+Q). In the editor WITH a selection,
  // the guarded single below wins and Ctrl+X stays cut.
  { steps: [{ key: 'x', ctrl: true }, { key: 'c', ctrl: true }], action: 'app.quit' },
  { chord: { key: 'p', ctrl: true }, action: 'palette.open' },
  { chord: { key: 'g', ctrl: true }, action: 'git.togglePanel' },
  { chord: { key: 'tab' }, action: 'focus.toggle' },

  // --- palette (captures input while open) ---
  { chord: { key: 'escape' }, action: 'palette.close', context: 'palette' },
  { chord: { key: 'return' }, action: 'palette.run', context: 'palette' },
  { chord: { key: 'up' }, action: 'palette.previous', context: 'palette' },
  { chord: { key: 'down' }, action: 'palette.next', context: 'palette' },
  { chord: { key: 'backspace' }, action: 'palette.erase', context: 'palette' },

  // --- files (tree) ---
  { chord: { key: 'up' }, action: 'tree.up', context: 'files' },
  { chord: { key: 'down' }, action: 'tree.down', context: 'files' },
  { chord: { key: 'return' }, action: 'tree.activate', context: 'files' },
  { chord: { key: 'space' }, action: 'tree.activate', context: 'files' },
  { chord: { key: 'right' }, action: 'tree.rightExpandOrOpen', context: 'files' },
  { chord: { key: 'left' }, action: 'tree.leftCollapse', context: 'files' },

  // --- git panel ---
  { chord: { key: 'up' }, action: 'git.up', context: 'git' },
  { chord: { key: 'down' }, action: 'git.down', context: 'git' },
  { chord: { key: 'pageup' }, action: 'git.pageUp', context: 'git' },
  { chord: { key: 'pagedown' }, action: 'git.pageDown', context: 'git' },
  { chord: { key: 'return' }, action: 'git.stageToggle', context: 'git' },
  { chord: { key: 'space' }, action: 'git.stageToggle', context: 'git' },
  { chord: { key: 'o' }, action: 'git.openFile', context: 'git' },
  { chord: { key: 'd' }, action: 'git.discard', context: 'git' },
  { chord: { key: 'escape' }, action: 'git.leave', context: 'git' },

  // --- editor: movement (shift left unspecified = extend composes as a parameter) ---
  { chord: { key: 'up' }, action: 'editor.moveUp', context: 'editor' },
  { chord: { key: 'down' }, action: 'editor.moveDown', context: 'editor' },
  { chord: { key: 'left' }, action: 'editor.moveLeft', context: 'editor' },
  { chord: { key: 'right' }, action: 'editor.moveRight', context: 'editor' },
  { chord: { key: 'pageup' }, action: 'editor.pageUp', context: 'editor' },
  { chord: { key: 'pagedown' }, action: 'editor.pageDown', context: 'editor' },
  { chord: { key: 'home' }, action: 'editor.lineStart', context: 'editor' },
  { chord: { key: 'end' }, action: 'editor.lineEnd', context: 'editor' },
  // --- editor: warp movement ---
  { chord: { key: 'up', ctrl: true }, action: 'editor.jumpUp', context: 'editor' },
  { chord: { key: 'down', ctrl: true }, action: 'editor.jumpDown', context: 'editor' },
  { chord: { key: 'left', ctrl: true }, action: 'editor.wordLeft', context: 'editor' },
  { chord: { key: 'right', ctrl: true }, action: 'editor.wordRight', context: 'editor' },
  { chord: { key: 'home', ctrl: true }, action: 'editor.documentStart', context: 'editor' },
  { chord: { key: 'end', ctrl: true }, action: 'editor.documentEnd', context: 'editor' },
  // --- editor: editing ---
  { chord: { key: 'return' }, action: 'editor.newline', context: 'editor' },
  { chord: { key: 'backspace' }, action: 'editor.backspace', context: 'editor' },
  { chord: { key: 'delete' }, action: 'editor.delete', context: 'editor' },
  { chord: { key: 'escape' }, action: 'editor.escape', context: 'editor' },
  // --- editor: chords ---
  { chord: { key: 's', ctrl: true }, action: 'editor.save', context: 'editor' },
  { chord: { key: 'a', ctrl: true }, action: 'editor.selectAll', context: 'editor' },
  { chord: { key: 'c', ctrl: true }, action: 'editor.copy', context: 'editor' },
  // Guarded: with a selection Ctrl+X cuts (outranks starting the quit chord); without, the
  // global quit chord starts.
  { chord: { key: 'x', ctrl: true }, action: 'editor.cut', context: 'editor', when: 'editorHasSelection' },
  { chord: { key: 'v', ctrl: true }, action: 'editor.paste', context: 'editor' },
  { chord: { key: 'z', ctrl: true, shift: false }, action: 'editor.undo', context: 'editor' },
  { chord: { key: 'z', ctrl: true, shift: true }, action: 'editor.redo', context: 'editor' },
  { chord: { key: 'y', ctrl: true }, action: 'editor.redo', context: 'editor' },
];
