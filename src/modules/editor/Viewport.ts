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

  /** Ensure line `line` is visible within [scrollTop, scrollTop+height). */
  scrollToLine(line: number, totalLines: number): void {
    const viewportHeight = this.height.value;
    if (line < this.scrollTop.value) {
      this.scrollTop.value = line;
    } else if (line >= this.scrollTop.value + viewportHeight) {
      this.scrollTop.value = line - viewportHeight + 1;
    }
    const maxScrollTop = Math.max(0, totalLines - viewportHeight);
    if (this.scrollTop.value > maxScrollTop) this.scrollTop.value = maxScrollTop;
    if (this.scrollTop.value < 0) this.scrollTop.value = 0;
  }

  scrollBy(delta: number, totalLines: number): void {
    const maxScrollTop = Math.max(0, totalLines - this.height.value);
    this.scrollTop.value = Math.max(0, Math.min(this.scrollTop.value + delta, maxScrollTop));
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
