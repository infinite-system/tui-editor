// Scroll/viewport state. The editor renders only the lines this window exposes — memory
// and render cost track the visible set, not the file size.
//
// invariant: The terminal shows a bounded viewport (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';

class $Viewport {
  get scrollTop() {
    return ref(0);
  }
  get scrollLeft() {
    return ref(0);
  }
  get height() {
    return ref(20);
  }
  get width() {
    return ref(80);
  }

  setSize(width: number, height: number): void {
    this.width.value = Math.max(1, width);
    this.height.value = Math.max(1, height);
  }

  /** Ensure line `n` is visible within [scrollTop, scrollTop+height). */
  scrollToLine(n: number, totalLines: number): void {
    const h = this.height.value;
    if (n < this.scrollTop.value) {
      this.scrollTop.value = n;
    } else if (n >= this.scrollTop.value + h) {
      this.scrollTop.value = n - h + 1;
    }
    const maxTop = Math.max(0, totalLines - h);
    if (this.scrollTop.value > maxTop) this.scrollTop.value = maxTop;
    if (this.scrollTop.value < 0) this.scrollTop.value = 0;
  }

  scrollBy(delta: number, totalLines: number): void {
    const maxTop = Math.max(0, totalLines - this.height.value);
    this.scrollTop.value = Math.max(0, Math.min(this.scrollTop.value + delta, maxTop));
  }

  get firstVisible(): number {
    return this.scrollTop.value;
  }
  get visibleCount(): number {
    return this.height.value;
  }
}

export namespace Viewport {
  export const $Class = $Viewport;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
