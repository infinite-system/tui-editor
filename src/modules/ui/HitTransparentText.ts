// A TextRenderable that paints normally but never stamps the hit grid — so it can never receive or
// consume a pointer event. Used by the tooltip (display-only overlay) and as the base for the
// axis-balanced horizontal scrollbar paint. Masking addToHitGrid for the duration of one render is
// the robust way to be visually present yet hit-transparent (OpenTUI has no opt-out flag).
//
// invariant: A tooltip never intercepts input (src/modules/ui/ui.invariants.md)
import { TextRenderable, type OptimizedBuffer } from '@opentui/core';

class $HitTransparentText extends TextRenderable {
  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    const context = this._ctx;
    const originalAddToHitGrid = context.addToHitGrid;
    context.addToHitGrid = () => {};
    try {
      super.render(buffer, deltaTime);
    } finally {
      context.addToHitGrid = originalAddToHitGrid;
    }
  }
}

export namespace HitTransparentText {
  export const $Class = $HitTransparentText;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
