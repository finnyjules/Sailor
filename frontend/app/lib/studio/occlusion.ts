/**
 * Canvas-occlusion contract — ONE signal for "a fullscreen studio modal now
 * covers the canvas, so canvas-preview render loops should pause".
 *
 * Background: canvas cards (Frame, Space Type, 3D, …) each run their own rAF
 * preview loop. When a fullscreen studio modal opens over the canvas, those loops
 * keep rendering scenes nobody can see, competing with the modal's own preview for
 * the main thread (measured ~13fps in the Space Type case). The fix is to pause the
 * card loops while a modal occludes them.
 *
 * This used to be wired per-modal: every gate component listened for
 * `sailor:openCompositor`/`closeCompositor`, then someone added
 * `sailor:openSpaceType`/`closeSpaceType`, and the other ~20 fullscreen studios were
 * never covered (third occurrence of the same class of bug). This module replaces
 * that with a single canonical signal:
 *
 *   - VueNodeCanvas.vue owns the list of which modals are open and emits
 *     `emitCanvasOcclusion(open)` whenever *any* canvas-covering modal opens/closes.
 *   - Gate components (ArtifactFrameNode, SpaceTypeNode, …) call `onCanvasOcclusion`
 *     to pause/resume — they don't need to know which modal it was.
 *
 * "Occluding" means the modal covers the WHOLE canvas (fixed/absolute inset-0 or the
 * StudioModalShell). Side/bottom drawers (the Ascii glyph drawer, the Collection
 * drawer) and popovers (Inspector, Actions, Ascii-options) are deliberately NOT
 * occluding — the canvas stays partially visible beside them, so freezing a card the
 * user can still see would be wrong. The authoritative open/close list lives in
 * VueNodeCanvas.vue's `anyCanvasOccludingModalOpen` computed.
 */

export const CANVAS_OCCLUSION_EVENT = 'sailor:canvasOccludedChange'

// Latest emitted state, so a gate component that mounts *while* a modal is already
// open (e.g. a node dropped onto the canvas mid-modal) can sync to it immediately
// rather than waiting for the next open/close edge.
let _occluded = false

export function isCanvasOccluded(): boolean {
  return _occluded
}

/**
 * Announce that the canvas is now covered (or uncovered) by a fullscreen studio
 * modal. Idempotent: emitting the same value twice does nothing. Called from the
 * single choke point in VueNodeCanvas.vue.
 */
export function emitCanvasOcclusion(open: boolean): void {
  if (typeof window === 'undefined') return
  if (open === _occluded) return
  _occluded = open
  window.dispatchEvent(new CustomEvent(CANVAS_OCCLUSION_EVENT, { detail: { open } }))
}

/**
 * Subscribe to occlusion changes. Fires `cb(current)` immediately with the current
 * state (so late-mounting gates sync up), then on every subsequent change. Returns
 * an unsubscribe function — call it from `onBeforeUnmount`.
 */
export function onCanvasOcclusion(cb: (open: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => cb(!!(e as CustomEvent).detail?.open)
  window.addEventListener(CANVAS_OCCLUSION_EVENT, handler)
  cb(_occluded)
  return () => window.removeEventListener(CANVAS_OCCLUSION_EVENT, handler)
}

/**
 * `applyGate` above only pauses the rAF loop — fine for cards whose paints are
 * driven by that loop, but the Frame card's poster repaints are watch-driven
 * (a `JSON.stringify(localLayers)` watch fires on every layer edit, loop or no
 * loop). Dragging a layer inside a fullscreen modal still fires that watch for
 * the occluded card behind it, repainting pixels nobody can see (~110ms/move
 * on a torn-edge card). This gate is the watch-driven equivalent of `applyGate`:
 * "Repaint now, or remember that one is owed?" for a card whose paints are
 * watch-driven (not a loop). While occluded, every request is swallowed and marked
 * owed; the first un-occlude returns true exactly once so the caller paints the
 * deferred state.
 */
export function createOcclusionRepaintGate() {
  let occluded = false, owed = false
  return {
    /** Call before painting. true ⇒ paint now. false ⇒ occluded; a repaint is now owed. */
    shouldPaint(): boolean { if (occluded) { owed = true; return false } return true },
    /** Feed the occlusion signal. Returns true when the card just became visible AND a repaint is owed. */
    setOccluded(open: boolean): boolean { occluded = open; if (open) return false; const due = owed; owed = false; return due },
    get occluded() { return occluded }, get owed() { return owed },
  }
}
