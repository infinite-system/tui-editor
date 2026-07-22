// Shared wheel-gesture math: whether the configured scroll modifier is held, and how many rows one
// wheel notch moves (linesPerNotch × the fast-scroll factor when its modifier is held). Both the
// sidebar and the editor scroll handlers use these, so they live in one Static capability rather than
// duplicated in each pane controller. Pure: reads only the event modifiers and the settings values.
import { Static } from 'ivue/extras';
import type { ScrollModifier, Settings } from '../settings/Settings';

export interface WheelModifiers {
  modifiers: { alt: boolean; shift: boolean; ctrl: boolean };
}

// Is the configured scroll modifier held on this wheel event? 'none' is never held (the control is
// off, not misleading). Single source: the modifier comes from Settings, never hardcoded.
function $modifierHeld(event: WheelModifiers, modifier: ScrollModifier): boolean {
  switch (modifier) {
    case 'alt':
      return event.modifiers.alt;
    case 'shift':
      return event.modifiers.shift;
    case 'ctrl':
      return event.modifiers.ctrl;
    default:
      return false; // 'none'
  }
}

// Rows per wheel notch = settings.linesPerNotch (was a hardcoded 3), multiplied by the fast-scroll
// factor when the fast-scroll modifier is held (settings.fastScrollMultiplier; modifier defaults to
// 'none' = off). One expression feeds BOTH the wrap-mode direct step and the momentum impulse.
function $wheelStep(event: WheelModifiers, settings: Settings.Instance): number {
  const notch = Math.max(1, Math.round(settings.linesPerNotch.value));
  const fast = $modifierHeld(event, settings.fastScrollModifier.value)
    ? Math.max(1, Math.round(settings.fastScrollMultiplier.value))
    : 1;
  return notch * fast;
}

class $ScrollGesture {
  static modifierHeld = $modifierHeld;
  static wheelStep = $wheelStep;
}

export namespace ScrollGesture {
  export const $Class = $ScrollGesture;
  export const Class = Static($ScrollGesture);
}
