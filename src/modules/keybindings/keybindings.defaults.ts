// The CANONICAL binding layer — the floor: only universally-deliverable chords (Ctrl, plain keys,
// function keys, arrows). Overlays (mac) ALIAS actions bound here; they never replace the floor.
// Bindings are pure data: chord (or step list) -> action id (+ context / guard).
//
// invariant: The canonical layer is the floor (keybindings.invariants.md)
// invariant: Bindings are intent addressed (keybindings.invariants.md)
import type { Keybinding } from './KeybindingRegistry';

export const canonicalBindings: Keybinding[] = [
  // --- global ---
  // RESERVED escape hatches: quit fires from ANY mode (even a focused search/modal input) so the
  // user is never trapped. `reserved` routes these ahead of modal input consumption (single chords
  // only — the pass-through check is stateless; the Ctrl+X Ctrl+C chord below is editor-context).
  { chord: { key: 'q', ctrl: true }, action: 'app.quit', reserved: true },
  { chord: { key: 'f10' }, action: 'app.quit', reserved: true },
  // Emacs-style quit chord (VS Code's terminal intercepts Ctrl+Q). In the editor WITH a selection,
  // the guarded single below wins and Ctrl+X stays cut.
  { steps: [{ key: 'x', ctrl: true }, { key: 'c', ctrl: true }], action: 'app.quit' },
  { chord: { key: 'p', ctrl: true }, action: 'quickopen.open' }, // VS Code: Ctrl+P = go-to-file
  { chord: { key: 'p', ctrl: true, shift: true }, action: 'palette.open' }, // Ctrl+Shift+P = command palette
  // Find and Replace are global overlay-switch actions: from any current input overlay, one chord
  // replaces the shared modal slot. They still no-op in Bootstrap when no document is open.
  { chord: { key: 'f', ctrl: true }, action: 'find.open' },
  { chord: { key: 'h', ctrl: true }, action: 'find.replace' },
  // F1 ALSO opens the palette (VS Code parity: F1 = Show All Commands). Ctrl+Shift+P is intercepted by
  // VS Code's own terminal AND is unencodable on legacy (non-kitty) terminals that drop the shift bit
  // on a control key — F1 is a single unshifted function key that always reaches the app, so the
  // palette is never unreachable. invariant: Advertised bindings are deliverable bindings.
  { chord: { key: 'f1' }, action: 'palette.open' },
  { chord: { key: 'g', ctrl: true }, action: 'git.togglePanel' },
  { chord: { key: 'tab' }, action: 'focus.toggle' },
  // Editor buffer tabs (item 10a) — global (work in any focus). Ctrl+Tab needs the kitty keyboard
  // protocol; Ctrl+PageUp/PageDown are the widely-supported equivalents.
  { chord: { key: ',', ctrl: true }, action: 'settings.toggle' },
  // Project/workspace tabs are the outer navigation layer. Shift distinguishes them from the
  // buffer-tab layer below; every action is also visible on the workspace strip and in the palette.
  { chord: { key: 'o', ctrl: true, shift: true }, action: 'workspace.openFolder' },
  { chord: { key: 'w', ctrl: true, shift: true }, action: 'workspace.close' },
  { chord: { key: 'pagedown', ctrl: true, shift: true }, action: 'workspace.next' },
  { chord: { key: 'pageup', ctrl: true, shift: true }, action: 'workspace.previous' },
  { chord: { key: 'w', ctrl: true }, action: 'buffer.close' },
  { chord: { key: 'tab', ctrl: true, shift: false }, action: 'buffer.next' },
  { chord: { key: 'tab', ctrl: true, shift: true }, action: 'buffer.previous' },
  { chord: { key: 'pagedown', ctrl: true }, action: 'buffer.next' },
  { chord: { key: 'pageup', ctrl: true }, action: 'buffer.previous' },
  // Diff change navigation uses the conventional debugger/diff keys. The same actions are visible
  // as toolbar buttons and command-palette entries; these bindings are discoverable accelerators.
  { chord: { key: 'f7', shift: true }, action: 'diff.previousChange', context: 'editor' },
  { chord: { key: 'f7', shift: false }, action: 'diff.nextChange', context: 'editor' },
  // Markdown preview actions share the visible tab-bar button / hovered link affordance.
  { chord: { key: 'v', ctrl: true, shift: true }, action: 'markdown.togglePreview', context: 'editor' },
  { chord: { key: 'return', ctrl: true }, action: 'markdown.openHoveredReference', context: 'editor' },
  // Go to Definition (VS Code parity: F12; the pointer path is Ctrl/Cmd+click on the symbol).
  { chord: { key: 'f12' }, action: 'go.definition', context: 'editor' },

  // --- palette (captures input while open) ---
  { chord: { key: 'escape' }, action: 'palette.close', context: 'palette' },
  { chord: { key: 'return' }, action: 'palette.run', context: 'palette' },
  { chord: { key: 'up' }, action: 'palette.previous', context: 'palette' },
  { chord: { key: 'down' }, action: 'palette.next', context: 'palette' },
  { chord: { key: 'backspace' }, action: 'palette.erase', context: 'palette' },
  { chord: { key: 'backspace', alt: true }, action: 'palette.eraseWord', context: 'palette' },
  { chord: { key: 'delete', alt: true }, action: 'palette.eraseWord', context: 'palette' },

  // --- text inputs (query editing stays intent-addressed even though typed characters are residuals) ---
  { chord: { key: 'backspace', alt: true }, action: 'quickopen.eraseWord', context: 'quickopen' },
  { chord: { key: 'delete', alt: true }, action: 'quickopen.eraseWord', context: 'quickopen' },
  { chord: { key: 'backspace', alt: true }, action: 'find.eraseWord', context: 'find' },
  { chord: { key: 'delete', alt: true }, action: 'find.eraseWord', context: 'find' },

  // --- context menu (modal while open: Bootstrap resolves ONLY in this context and consumes
  //     everything unbound by closing the menu — see the modal block in Bootstrap.onKey) ---
  { chord: { key: 'up' }, action: 'menu.previous', context: 'menu' },
  { chord: { key: 'down' }, action: 'menu.next', context: 'menu' },
  { chord: { key: 'return' }, action: 'menu.run', context: 'menu' },
  { chord: { key: 'escape' }, action: 'menu.close', context: 'menu' },

  // --- settings panel (Ctrl+,) ---
  { chord: { key: 'up' }, action: 'settings.up', context: 'settings' },
  { chord: { key: 'down' }, action: 'settings.down', context: 'settings' },
  { chord: { key: 'left' }, action: 'settings.decrease', context: 'settings' },
  { chord: { key: 'right' }, action: 'settings.increase', context: 'settings' },
  { chord: { key: 'escape' }, action: 'settings.close', context: 'settings' },

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
  { chord: { key: 'right' }, action: 'git.expandRight', context: 'git' },
  { chord: { key: 'left' }, action: 'git.collapseLeft', context: 'git' },
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
  // Ctrl+E → line end. Ctrl+E was unbound, so this is a free win that ALSO makes iTerm2 "Natural Text
  // Editing" Cmd+Right (which sends a raw ^E / 0x05) jump to the line end. (Cmd+Left = raw ^A is
  // disambiguated from Ctrl+A = Select All in the onKey handler, since both resolve the same here.)
  { chord: { key: 'e', ctrl: true }, action: 'editor.lineEnd', context: 'editor' },
  // --- editor: find / replace input is owned by the 'find' context — typing, Enter/Shift+Enter
  //     cycle, Ctrl+Enter replace, Tab switches field, and Esc closes. The opening chords are global. ---
  // --- editor: editing ---
  { chord: { key: 'return' }, action: 'editor.newline', context: 'editor' },
  { chord: { key: 'backspace' }, action: 'editor.backspace', context: 'editor' },
  { chord: { key: 'delete' }, action: 'editor.delete', context: 'editor' },
  // OpenTUI decodes macOS Option+Backspace ESC DEL as backspace+meta and modified Delete as
  // delete+option; Bootstrap normalizes either modifier to this `alt` slot. Both delete a word.
  { chord: { key: 'backspace', alt: true }, action: 'edit.deletePreviousWord', context: 'editor' },
  { chord: { key: 'delete', alt: true }, action: 'edit.deletePreviousWord', context: 'editor' },
  { chord: { key: 'escape' }, action: 'editor.escape', context: 'editor' },
  // --- editor: chords ---
  { chord: { key: 's', ctrl: true }, action: 'editor.save', context: 'editor' },
  { chord: { key: 'a', ctrl: true }, action: 'editor.selectAll', context: 'editor' },
  { chord: { key: 'c', ctrl: true }, action: 'editor.copy', context: 'editor' },
  // Guarded: with a selection Ctrl+X cuts (outranks starting the quit chord); without, the
  // global quit chord starts.
  { chord: { key: 'x', ctrl: true }, action: 'editor.cut', context: 'editor', when: 'editorHasSelection' },
  { chord: { key: 'v', ctrl: true }, action: 'editor.paste', context: 'editor' },
  // Alt+Z toggles word wrap (VS Code parity; `alt` matches the event's option/meta slot).
  { chord: { key: 'z', alt: true }, action: 'editor.toggleWordWrap', context: 'editor' },
  { chord: { key: 'z', ctrl: true, shift: false }, action: 'editor.undo', context: 'editor' },
  { chord: { key: 'z', ctrl: true, shift: true }, action: 'editor.redo', context: 'editor' },
  { chord: { key: 'y', ctrl: true }, action: 'editor.redo', context: 'editor' },
];
