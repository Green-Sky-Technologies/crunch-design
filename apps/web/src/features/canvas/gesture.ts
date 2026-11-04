'use client';

/**
 * Pointer gesture helper: tracks a press on window (so it survives leaving the element),
 * applies a small movement threshold, and cancels on Escape or pointercancel.
 */
export interface GestureHandlers {
  /** Called on every move once the threshold is passed. dx/dy are screen px from the start. */
  onMove?(e: PointerEvent, dx: number, dy: number): void;
  /** Pointer released. `moved` is false for a click. */
  onEnd?(e: PointerEvent, moved: boolean): void;
  /** Escape or pointercancel. */
  onCancel?(): void;
  /** Called once when the threshold is first passed. */
  onStart?(e: PointerEvent): void;
}

export function startGesture(
  down: { clientX: number; clientY: number; pointerId: number },
  h: GestureHandlers,
  threshold = 3,
): () => void {
  const x0 = down.clientX;
  const y0 = down.clientY;
  let moved = false;
  let done = false;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    if (!moved) {
      moved = true;
      h.onStart?.(e);
    }
    h.onMove?.(e, dx, dy);
  };
  const cleanup = () => {
    done = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId || done) return;
    cleanup();
    h.onEnd?.(e, moved);
  };
  const cancel = () => {
    if (done) return;
    cleanup();
    h.onCancel?.();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
  return cancel;
}

/**
 * True when keyboard input belongs to a text field rather than the canvas. Looks at the real
 * target through shadow roots (inline text editing happens inside a frame's shadow DOM).
 */
export function isTypingEvent(e: Event): boolean {
  const el = (e.composedPath?.()[0] ?? e.target) as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
