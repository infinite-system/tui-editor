import { test, expect, describe } from 'bun:test';
import { KeybindingRegistry, type ChordEvent } from '../KeybindingRegistry';
import { canonicalBindings } from '../keybindings.defaults';
import { macOverlayBindings } from '../keybindings.mac';
import { parseKeypress } from '@opentui/core';

function chord(name: string, modifiers: Partial<ChordEvent> = {}): ChordEvent {
  return { name, ctrl: false, shift: false, option: false, ...modifiers };
}

function registryWithDefaults(): KeybindingRegistry.Instance {
  const registry = new KeybindingRegistry.Class();
  registry.registerLayer('canonical', canonicalBindings);
  registry.registerLayer('mac', macOverlayBindings);
  return registry;
}

describe('resolution precedence', () => {
  test('a later layer shadows an earlier one for the same chord', () => {
    const registry = new KeybindingRegistry.Class();
    registry.registerLayer('canonical', [{ chord: { key: 'k' }, action: 'first' }]);
    registry.registerLayer('user', [{ chord: { key: 'k' }, action: 'second' }]);
    expect(registry.resolve(chord('k'), 'editor', 0).action).toBe('second');
  });

  test('input-overlay opening chords resolve from every input-overlay context', () => {
    const registry = registryWithDefaults();
    const inputOverlayContexts = ['find', 'quickopen', 'palette', 'settings', 'menu'];
    for (const inputOverlayContext of inputOverlayContexts) {
      expect(registry.resolve(chord('f', { ctrl: true }), inputOverlayContext, 0).action).toBe('find.open');
      expect(registry.resolve(chord('h', { ctrl: true }), inputOverlayContext, 0).action).toBe('find.replace');
      expect(registry.resolve(chord('p', { ctrl: true }), inputOverlayContext, 0).action).toBe('quickopen.open');
      expect(registry.resolve(chord('f1'), inputOverlayContext, 0).action).toBe('palette.open');
      expect(registry.resolve(chord(',', { ctrl: true }), inputOverlayContext, 0).action).toBe('settings.toggle');
    }
  });

  test('context bindings apply only in their context; global applies everywhere', () => {
    const registry = registryWithDefaults();
    expect(registry.resolve(chord('o'), 'git', 0).action).toBe('git.openFile');
    expect(registry.resolve(chord('o'), 'editor', 0).action).toBeNull(); // typed char, no binding
    expect(registry.resolve(chord('q', { ctrl: true }), 'files', 0).action).toBe('app.quit');
  });

  test('guarded single outranks chord start; failed guard lets the chord start', () => {
    const registry = registryWithDefaults();
    let hasSelection = true;
    registry.registerGuard('editorHasSelection', () => hasSelection);
    // With a selection: Ctrl+X = cut (single wins, no chord pending).
    let resolution = registry.resolve(chord('x', { ctrl: true }), 'editor', 0);
    expect(resolution.action).toBe('editor.cut');
    expect(resolution.chordPending).toBe(false);
    // Without: the quit chord arms.
    hasSelection = false;
    resolution = registry.resolve(chord('x', { ctrl: true }), 'editor', 0);
    expect(resolution.action).toBeNull();
    expect(resolution.chordPending).toBe(true);
    registry.cancelChord();
  });
});

describe('reserved global bindings', () => {
  test('quit resolves without a context and does not disturb chord state', () => {
    const registry = registryWithDefaults();
    registry.registerGuard('editorHasSelection', () => false);
    expect(registry.resolve(chord('x', { ctrl: true }), 'editor', 0).chordPending).toBe(true);

    expect(registry.resolveReservedGlobal(chord('q', { ctrl: true }))).toBe('app.quit');
    expect(registry.resolveReservedGlobal(chord('f10'))).toBe('app.quit');
    expect(registry.resolveReservedGlobal(chord('p', { ctrl: true }))).toBeNull();

    expect(registry.resolve(chord('c', { ctrl: true }), 'editor', 100).action).toBe('app.quit');
  });
});

describe('multi-step chords', () => {
  test('completes on the second step and reports the action', () => {
    const registry = registryWithDefaults();
    registry.registerGuard('editorHasSelection', () => false);
    expect(registry.resolve(chord('x', { ctrl: true }), 'editor', 0).chordPending).toBe(true);
    const done = registry.resolve(chord('c', { ctrl: true }), 'editor', 100);
    expect(done.action).toBe('app.quit');
    expect(done.chordPending).toBe(false);
  });

  test('a wrong key breaks the chord and resolves normally', () => {
    const registry = registryWithDefaults();
    registry.registerGuard('editorHasSelection', () => false);
    registry.resolve(chord('x', { ctrl: true }), 'editor', 0);
    const broken = registry.resolve(chord('s', { ctrl: true }), 'editor', 100);
    expect(broken.chordPending).toBe(false);
    expect(broken.action).toBe('editor.save'); // the breaking key still does its own job
  });

  test('the chord times out', () => {
    const registry = registryWithDefaults();
    registry.registerGuard('editorHasSelection', () => false);
    registry.resolve(chord('x', { ctrl: true }), 'editor', 0);
    const late = registry.resolve(chord('c', { ctrl: true }), 'editor', 5000);
    expect(late.action).toBe('editor.copy'); // expired -> plain Ctrl+C = copy
  });
});

describe('shift semantics', () => {
  test('unspecified shift is DON\'T-CARE (movement extends via the event, one binding)', () => {
    const registry = registryWithDefaults();
    expect(registry.resolve(chord('up'), 'editor', 0).action).toBe('editor.moveUp');
    expect(registry.resolve(chord('up', { shift: true }), 'editor', 0).action).toBe('editor.moveUp');
  });

  test('explicit shift distinguishes undo from redo', () => {
    const registry = registryWithDefaults();
    expect(registry.resolve(chord('z', { ctrl: true }), 'editor', 0).action).toBe('editor.undo');
    expect(registry.resolve(chord('z', { ctrl: true, shift: true }), 'editor', 0).action).toBe('editor.redo');
  });
});

describe('the canonical floor', () => {
  test('every super-bound action is also reachable without super', () => {
    const registry = registryWithDefaults();
    expect(registry.actionsMissingCanonicalFloor()).toEqual([]);
  });

  test('mac alt word-jumps alias actions the floor also binds', () => {
    const registry = registryWithDefaults();
    expect(registry.resolve(chord('left', { option: true }), 'editor', 0).action).toBe('editor.wordLeft');
    expect(registry.resolve(chord('b', { option: true }), 'editor', 0).action).toBe('editor.wordLeft');
    expect(registry.resolve(chord('left', { ctrl: true }), 'editor', 0).action).toBe('editor.wordLeft');
  });

  test('super chords resolve under kitty fidelity', () => {
    const registry = registryWithDefaults();
    expect(registry.resolve(chord('c', { super: true }), 'editor', 0).action).toBe('editor.copy');
    expect(registry.resolve(chord('left', { super: true }), 'editor', 0).action).toBe('editor.lineStart');
  });

  test('actual Option Backspace and modified Delete sequences resolve to word deletion never close', () => {
    const registry = registryWithDefaults();
    const sequences = [
      parseKeypress('\x1b\x7f'),
      parseKeypress('\x1b[3;3~'),
      parseKeypress('\x1b[127;3u', { useKittyKeyboard: true }),
      parseKeypress('\x1b[57349;3u', { useKittyKeyboard: true }),
    ];

    for (const key of sequences) {
      expect(key).not.toBeNull();
      const resolution = registry.resolve(
        {
          name: key!.name,
          ctrl: key!.ctrl,
          shift: key!.shift,
          option: key!.option || key!.meta,
          super: key!.super,
        },
        'editor',
        0,
      );
      expect(resolution.action).toBe('edit.deletePreviousWord');
      expect(resolution.action).not.toBe('buffer.close');
    }
  });

  test('Alt Backspace and Alt Delete resolve in every present text-input context', () => {
    const registry = registryWithDefaults();
    const expectedActions = new Map([
      ['editor', 'edit.deletePreviousWord'],
      ['palette', 'palette.eraseWord'],
      ['quickopen', 'quickopen.eraseWord'],
      ['find', 'find.eraseWord'],
    ]);
    for (const [context, expectedAction] of expectedActions) {
      expect(registry.resolve(chord('backspace', { option: true }), context, 0).action).toBe(expectedAction);
      expect(registry.resolve(chord('delete', { option: true }), context, 0).action).toBe(expectedAction);
    }
  });
});

describe('effective bindings (deliverability honesty)', () => {
  test('a user rebind changes the effective binding for the hint layer', () => {
    const registry = registryWithDefaults();
    const before = registry.effectiveBindings('editor').get('editor.save');
    expect(before?.chord?.key).toBe('s');
    registry.registerLayer('user', [{ chord: { key: 'w', ctrl: true }, action: 'editor.save', context: 'editor' }]);
    const after = registry.effectiveBindings('editor').get('editor.save');
    expect(after?.chord?.key).toBe('w');
  });

  test('the hint formats the post-shadowing chord rather than a hard-coded default', () => {
    const registry = new KeybindingRegistry.Class();
    registry.registerLayer('canonical', [
      { chord: { key: 'v', ctrl: true, shift: true }, action: 'markdown.togglePreview' },
    ]);
    expect(registry.bindingHint('markdown.togglePreview', 'editor')).toBe('Ctrl+Shift+V');

    registry.registerLayer('user', [
      { chord: { key: 'm', alt: true }, action: 'markdown.togglePreview', context: 'editor' },
    ]);
    expect(registry.bindingHint('markdown.togglePreview', 'editor')).toBe('Alt+M');
  });
});
