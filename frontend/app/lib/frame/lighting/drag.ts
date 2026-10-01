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
 *
 * It can never stick on: `setLightingDrag(true)` also arms window-level listeners (pointerup and
 * pointercancel in the capture phase, so no stopPropagation can swallow them, and window blur)
 * that turn it off whatever the caller does. A caller that is unmounted mid-drag must still call
 * `setLightingDrag(false)` itself (a release that never comes would otherwise leave the paint
 * capped until the next click anywhere).
 */
import { ref, readonly } from 'vue'

const _dragging = ref(false)
let _idle: ReturnType<typeof setTimeout> | null = null
let _disarm: (() => void) | null = null

/** Reactive: watch it to make the one full repaint when it turns off. */
export const lightingDragging = readonly(_dragging)

function arm(): void {
  if (_disarm || typeof window === 'undefined') return
  const off = () => setLightingDrag(false)
  window.addEventListener('pointerup', off, true)
  window.addEventListener('pointercancel', off, true)
  window.addEventListener('blur', off)
  _disarm = () => {
    window.removeEventListener('pointerup', off, true)
    window.removeEventListener('pointercancel', off, true)
    window.removeEventListener('blur', off)
  }
}
function disarm(): void { const d = _disarm; _disarm = null; d?.() }

export function setLightingDrag(on: boolean): void {
  if (_idle) { clearTimeout(_idle); _idle = null }
  if (on) arm(); else disarm()
  _dragging.value = on
}

/** On now, off after `idleMs` with no further nudge (wheel, slider `input` without pointer events). */
export function nudgeLightingDrag(idleMs = 180): void {
  if (_idle) clearTimeout(_idle)
  _dragging.value = true
  _idle = setTimeout(() => { _idle = null; disarm(); _dragging.value = false }, idleMs)
}
