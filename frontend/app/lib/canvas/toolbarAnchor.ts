// frontend/app/lib/canvas/toolbarAnchor.ts
// Where the node toolbar sits, in pane pixels. The toolbar itself is never scaled
// (spec §2.3: same size on screen at any zoom); only its anchor follows the node.
export interface Box { x: number; y: number; width: number; height: number }
// Room the bar needs under the node (its height + a margin). Without it, flip above.
const ROOM_BELOW = 64
// Half the widest bar (Edit ▾ + Develop ▾, or Run N · Group · Combine into Frame).
const HALF_BAR = 170

/** The bar sits centred UNDER the node (Julien 09-24: "at the bottom of the
 *  image node"), flipping above when the pane has no room left below, or when
 *  it would land on `avoid` — the bottom prompt stack, which sits over the
 *  canvas and would swallow the bar's clicks. All in pane pixels. */
export function toolbarAnchor(
  box: Box,
  vp: { x: number; y: number; zoom: number },
  paneHeight = Infinity,
  gap = 10,
  avoid?: { left: number; right: number; top: number } | null,
): { left: number; top: number; placement: 'above' | 'below' } {
  const left = vp.x + (box.x + box.width / 2) * vp.zoom
  const below = vp.y + (box.y + box.height) * vp.zoom + gap
  const overlapsAvoid = !!avoid && left + HALF_BAR > avoid.left && left - HALF_BAR < avoid.right && below + ROOM_BELOW > avoid.top
  if (below + ROOM_BELOW <= paneHeight && !overlapsAvoid) return { left, top: below, placement: 'below' }
  return { left, top: vp.y + box.y * vp.zoom - gap, placement: 'above' }
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y))
  const r = Math.max(...boxes.map(b => b.x + b.width)), btm = Math.max(...boxes.map(b => b.y + b.height))
  return { x, y, width: r - x, height: btm - y }
}
