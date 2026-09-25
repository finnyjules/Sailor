// How far to pan so a node comes into view (spec §3.1: "pans just enough").
// Screen-space rects; `view` is the visible pane above the prompt stack.
export interface Rect { left: number; top: number; right: number; bottom: number }

function axis(lo: number, hi: number, vlo: number, vhi: number, m: number): number {
  const a = vlo + m
  const b = vhi - m
  if (hi - lo > b - a) return a - lo // bigger than the room: align its start
  if (lo < a) return a - lo
  if (hi > b) return b - hi
  return 0
}

export function revealDelta(node: Rect, view: Rect, margin = 32): { dx: number; dy: number } {
  return {
    dx: axis(node.left, node.right, view.left, view.right, margin),
    dy: axis(node.top, node.bottom, view.top, view.bottom, margin),
  }
}
