/**
 * Frame light layers: "a lighting control is being dragged". While it is on, the Frame painters
 * (the editor's renderStack and the Frame card's) repaint through their LIVE, resolution-capped
 * path (LIVE_PREVIEW_MAXPX) instead of a full device-resolution static paint per move; when it
 * goes off they make one full repaint. The lit/lift maps stay cached throughout (moving a light or
 * Darkness never re-stamps), so a drag costs the capped pass only.
 *
 * Callers (Tasks 3 / 4):
 *   - light dot drag: `setLightingDrag(true)` on pointerdown, `setLightingDrag(false)` on
 *     pointerup / pointercancel (in a finally);
 *   - Darkness slider (and any light dial): the same around the slider's drag
 *     (pointerdown → pointerup), or `nudgeLightingDrag()` on every `input` event when there is no
 *     clean start/end;
 *   - wheel / scroll on a dot: `nudgeLightingDrag()` per wheel event — it stays on until the
 *     events stop for `idleMs`, then the full repaint happens once.
 * Module-global on purpose: one pointer drags one control at a time, and the modal and the card
 * (separate editor instances over the same node) must both see it.
 */
import { ref, readonly } from 'vue'

const _dragging = ref(false)
let _idle: ReturnType<typeof setTimeout> | null = null

/** Reactive: watch it to make the one full repaint when it turns off. */
export const lightingDragging = readonly(_dragging)

export function setLightingDrag(on: boolean): void {
  if (_idle) { clearTimeout(_idle); _idle = null }
  _dragging.value = on
}

/** On now, off after `idleMs` with no further nudge (wheel, slider `input` without pointer events). */
export function nudgeLightingDrag(idleMs = 180): void {
  if (_idle) clearTimeout(_idle)
  _dragging.value = true
  _idle = setTimeout(() => { _idle = null; _dragging.value = false }, idleMs)
}
