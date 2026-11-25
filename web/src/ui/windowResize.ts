import { capturePointer, releasePointer } from "./pointerCapture.ts";

export const WINDOW_RESIZE_EDGES = ["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const;
export type ResizeEdge = typeof WINDOW_RESIZE_EDGES[number];
export interface WindowRect { x: number; y: number; w: number; h: number }

/** Keep the opposite edge anchored, including when the dragged edge reaches a size limit. */
export function resizedWindow(
  edge: ResizeEdge, start: WindowRect, dx: number, dy: number,
  minimum: { w: number; h: number }, desktop: { w: number; h: number },
): WindowRect {
  let { x, y, w, h } = start;
  const clamp = (n: number, min: number, max: number) => Math.round(Math.max(min, Math.min(n, max)));
  if (edge.includes("w")) {
    w = clamp(w - dx, minimum.w, x + w);
    x += start.w - w;
  } else if (edge.includes("e")) w = clamp(w + dx, minimum.w, desktop.w - x);
  if (edge.includes("n")) {
    h = clamp(h - dy, minimum.h, y + h);
    y += start.h - h;
  } else if (edge.includes("s")) h = clamp(h + dy, minimum.h, desktop.h - y);
  return { x, y, w, h };
}

/** A resize belongs to the pointer that began it, even outside the handle. */
export function dragWindowEdge(event: PointerEvent, move: (dx: number, dy: number) => void, finish?: () => void): void {
  const handle = event.currentTarget as HTMLElement;
  const { pointerId, clientX, clientY } = event;
  const controller = new AbortController();
  const { signal } = controller;
  event.preventDefault();
  event.stopPropagation();
  capturePointer(handle, pointerId);
  const stop = (e: PointerEvent | FocusEvent) => {
    if (signal.aborted || ("pointerId" in e && e.pointerId !== pointerId)) return;
    controller.abort();
    releasePointer(handle, pointerId);
    finish?.();
  };
  window.addEventListener("pointermove", e => {
    if (e.pointerId === pointerId) move(e.clientX - clientX, e.clientY - clientY);
  }, { signal });
  window.addEventListener("pointerup", stop, { signal });
  window.addEventListener("pointercancel", stop, { signal });
  window.addEventListener("blur", stop, { signal });
  handle.addEventListener("lostpointercapture", stop, { signal });
}
