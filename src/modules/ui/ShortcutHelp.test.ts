// The cheat-sheet's rows must DERIVE from KeybindingRegistry.effectiveBindings — never a constant
// list — so a rebind (a later layer shadowing an earlier one) re-labels the sheet automatically.
// invariant: The shortcut sheet lists the effective bindings (src/modules/ui/ui.invariants.md)
import { describe, expect, test } from 'bun:test';
import { ShortcutHelp, type ShortcutHelpRow } from './ShortcutHelp';
import { KeybindingRegistry } from '../keybindings/KeybindingRegistry';
import { CommandRegistry } from '../commands/CommandRegistry';
import { canonicalBindings } from '../keybindings/keybindings.defaults';

function buildSheet(): {
  keybindings: KeybindingRegistry.Instance;
  sheet: InstanceType<typeof ShortcutHelp.Class>;
} {
  const keybindings = new KeybindingRegistry.Class();
  keybindings.registerLayer('canonical', canonicalBindings);
  const commands = new CommandRegistry.Class();
  commands.register({
    id: 'help.shortcuts',
    title: 'Help: Keyboard Shortcuts',
    category: 'Help',
    run: () => {},
  });
  commands.register({
    id: 'app.quit',
    title: 'Application: Quit',
    category: 'Application',
    run: () => {},
  });
  const sheet = new ShortcutHelp.Class(keybindings, commands);
  return { keybindings, sheet };
}

function bindingRowFor(rows: ShortcutHelpRow[], actionIdentifier: string): ShortcutHelpRow | undefined {
  return rows.find((row) => row.kind === 'binding' && row.actionIdentifier === actionIdentifier);
}

describe('ShortcutHelp', () => {
  test('rows derive from the effective bindings (real chords, real actions)', () => {
    const { sheet } = buildSheet();
    const rows = sheet.rows();
    expect(bindingRowFor(rows, 'quickopen.open')?.chordLabel).toBe('Ctrl+P');
    expect(bindingRowFor(rows, 'quickopen.open')?.label).toBe('Go to File');
    const quitRow = bindingRowFor(rows, 'app.quit');
    expect(quitRow?.label).toBe('Application: Quit');
    expect(quitRow?.chordLabel.length).toBeGreaterThan(0);
  });

  test('the sheet lists itself — its own open chord is a row', () => {
    const { sheet } = buildSheet();
    const selfRow = bindingRowFor(sheet.rows(), 'help.shortcuts');
    expect(selfRow?.chordLabel).toBe('Shift+F1');
    expect(selfRow?.label).toBe('Help: Keyboard Shortcuts');
  });

  test('rows are grouped under category header rows', () => {
    const { sheet } = buildSheet();
    const rows = sheet.rows();
    const categoryLabels = rows.filter((row) => row.kind === 'category').map((row) => row.label);
    expect(categoryLabels).toContain('Editor');
    expect(categoryLabels).toContain('Help');
    expect(categoryLabels).toEqual([...categoryLabels].sort());
    // Every binding row sits beneath some category header.
    expect(rows[0]?.kind).toBe('category');
  });

  test('a rebind in a later layer re-labels the sheet (rebinding-proof, not a constant)', () => {
    const { keybindings, sheet } = buildSheet();
    expect(bindingRowFor(sheet.rows(), 'quickopen.open')?.chordLabel).toBe('Ctrl+P');
    keybindings.registerLayer('user', [
      { chord: { key: 'o', ctrl: true }, action: 'quickopen.open' },
    ]);
    const reboundRows = sheet.rows();
    expect(bindingRowFor(reboundRows, 'quickopen.open')?.chordLabel).toBe('Ctrl+O');
    const chordLabels = reboundRows
      .filter((row) => row.actionIdentifier === 'quickopen.open')
      .map((row) => row.chordLabel);
    expect(chordLabels).not.toContain('Ctrl+P');
  });

  test('scrollBy clamps to the row window at both ends', () => {
    const { sheet } = buildSheet();
    const rowCount = sheet.rows().length;
    sheet.scrollBy(10_000, 10);
    expect(sheet.scrollTop.value).toBe(Math.max(0, rowCount - 10));
    sheet.scrollBy(-10_000, 10);
    expect(sheet.scrollTop.value).toBe(0);
  });

  test('show resets scroll and open/close toggle the modal flag', () => {
    const { sheet } = buildSheet();
    sheet.scrollBy(5, 3);
    sheet.show();
    expect(sheet.open.value).toBe(true);
    expect(sheet.scrollTop.value).toBe(0);
    sheet.close();
    expect(sheet.open.value).toBe(false);
  });
});
