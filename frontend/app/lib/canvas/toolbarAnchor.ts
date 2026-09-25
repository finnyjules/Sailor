// frontend/app/lib/canvas/toolbarAnchor.ts
// Where the node toolbar sits, in pane pixels. The toolbar itself is never scaled
// (spec §2.3: same size on screen at any zoom); only its anchor follows the node.
export interface Box { x: number; y: number; width: number; height: number }
const MIN_TOP = 56 // room for the toolbar above; below this, flip under the node

export function toolbarAnchor(box: Box, vp: { x: number; y: number; zoom: number }, gap = 10): { left: number; top: number; placement: 'above' | 'below' } {
  const left = vp.x + (box.x + box.width / 2) * vp.zoom
  const above = vp.y + box.y * vp.zoom - gap
  if (above >= MIN_TOP) return { left, top: above, placement: 'above' }
  return { left, top: vp.y + (box.y + box.height) * vp.zoom + gap, placement: 'below' }
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y))
  const r = Math.max(...boxes.map(b => b.x + b.width)), btm = Math.max(...boxes.map(b => b.y + b.height))
  return { x, y, width: r - x, height: btm - y }
}
