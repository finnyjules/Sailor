// app/composables/pen/penClipboard.ts
// Pen stage 6 (Ruling 8): the pen's own clipboard — module-level, so every
// pen on the page (the pen page, the Frame, Shape Studio) shares one for the
// page session. Not the system clipboard: only Copy as SVG writes that. A
// copy remembers how often it has been pasted, so each ⌘V steps 16 px further.
import { shallowRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'

export const PASTE_STEP_PX = 16
export interface PenClip { doc: SketchDoc; pastes: number }
export const penClipboard = shallowRef<PenClip | null>(null)

export function setPenClipboard(doc: SketchDoc): void { penClipboard.value = { doc: cloneDoc(doc), pastes: 0 } }
/** 1 for the first paste of this copy, 2 for the next … */
export function nextPasteStep(): number {
  const c = penClipboard.value
  if (!c) return 0
  c.pastes += 1
  return c.pastes
}
export function clearPenClipboard(): void { penClipboard.value = null }
