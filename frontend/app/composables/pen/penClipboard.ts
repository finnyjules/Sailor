// app/composables/pen/penClipboard.ts
// Pen stage 6 (Ruling 8): the pen's own clipboard — module-level, so every
// pen on the page (the pen page, the Frame, Shape Studio) shares one for the
// page session. Not the system clipboard: only Copy as SVG writes that. A
// copy remembers how often it has been pasted, so each ⌘V steps 16 px further.
// It also remembers which pen it came from and that pen's scale (drawing
// units per screen px) and orientation: each host draws in its own units, so
// a paste into ANOTHER pen resizes the copy to the same on-screen size (and
// turns it the same way up) and lands it in the middle of that pen's view.
import { shallowRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'

export const PASTE_STEP_PX = 16
export interface PenClipSource {
  penId: number
  unitsPerPx: number   // pxToUnits(1, view) of the pen it was copied in
  mirrored: boolean    // that view had y the other way up (isMirrored)
}
export interface PenClip extends Partial<PenClipSource> { doc: SketchDoc; pastes: number }
export const penClipboard = shallowRef<PenClip | null>(null)

export function setPenClipboard(doc: SketchDoc, source?: PenClipSource): void {
  penClipboard.value = { doc: cloneDoc(doc), pastes: 0, ...(source ?? {}) }
}
/** 1 for the first paste of this copy, 2 for the next … */
export function nextPasteStep(): number {
  const c = penClipboard.value
  if (!c) return 0
  c.pastes += 1
  return c.pastes
}
export function clearPenClipboard(): void { penClipboard.value = null }
