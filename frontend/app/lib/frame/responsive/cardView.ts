/**
 * The Frame CARD's viewing shape (the canvas node, not the Frame editor). A responsive Frame's
 * card can be reshaped freely with its corner grip; the shape it is dragged to is a viewing size
 * in Frame px, saved on the node as `sailor_frame.cardView`, and the card reflows to it through
 * `resolveLayout` exactly as the editor does for its viewing sizes. A fixed Frame never has one.
 */
import { clampViewSize, type Size } from './viewport'

/** Screen px per Frame px on the card: the design's long side is the display edge. Constant while
 *  the view is dragged, so the card grows under the cursor. */
export function cardScale(design: Size, displayEdge: number): number {
  return displayEdge / Math.max(1, design.w, design.h)
}

/** The card's box (logical px) for a viewing size. At the design size it is exactly the fixed
 *  Frame's box (long side = the display edge, short side from the aspect), so a responsive card
 *  that has not been reshaped looks as it always did. */
export function cardBox(design: Size, view: Size, displayEdge: number): Size {
  const E = displayEdge
  if (view.w === design.w && view.h === design.h && design.w > 0 && design.h > 0) {
    const a = design.w / design.h
    return a >= 1 ? { w: E, h: Math.round(E / a) } : { w: Math.round(E * a), h: E }
  }
  const k = cardScale(design, E)
  return { w: Math.round(view.w * k), h: Math.round(view.h * k) }
}

/** The stored card viewing size (`sailor_frame.cardView`), clamped; the design size when absent. */
export function cardViewOf(sailorFrame: unknown, design: Size): Size {
  const v = (sailorFrame as { cardView?: { w?: unknown; h?: unknown } } | undefined)?.cardView
  const w = Number(v?.w), h = Number(v?.h)
  if (!(typeof v?.w === 'number' && typeof v?.h === 'number' && w > 0 && h > 0)) return { w: design.w, h: design.h }
  return clampViewSize({ w, h }, design)
}

/** The design size and Responsive switch the saved card view was made against. */
export interface CardViewBasis { w: number; h: number; responsive: boolean }

/** A saved card view is stale once the design size or Responsive changes (the Frame editor resets
 *  its viewing size on the same rule). A Frame that had no size yet is not a change — that is its
 *  widgets arriving, not the user resizing it. */
export function cardViewStale(prev: CardViewBasis, next: CardViewBasis): boolean {
  if (!(prev.w > 0 && prev.h > 0)) return false
  return prev.w !== next.w || prev.h !== next.h || prev.responsive !== next.responsive
}
