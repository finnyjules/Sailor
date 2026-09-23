export interface Size { w: number; h: number }
export interface ShapePreset { id: string; label: string; w: number; h: number }

const MIN_FACTOR = 0.25, MAX_FACTOR = 5

/** Shapes at roughly the design's own area. */
export function shapePresets(design: Size): ShapePreset[] {
  const area = Math.max(1, design.w * design.h)
  const at = (ratio: number): { w: number; h: number } => {
    // w*h = area, w/h = ratio  ⇒  h = sqrt(area/ratio), w = ratio*h
    const h = Math.sqrt(area / ratio)
    return { w: Math.round(ratio * h), h: Math.round(h) }
  }
  return [
    { id: 'design', label: 'Your design', w: design.w, h: design.h },
    { id: 'wide', label: 'Wide', ...at(16 / 9) },
    { id: 'tall', label: 'Tall', ...at(9 / 16) },
    { id: 'square', label: 'Square', ...at(1) },
    { id: 'banner', label: 'Banner', ...at(4) },
  ]
}

export function clampViewSize(v: Size, design: Size): Size {
  const clamp = (val: number, base: number) => Math.round(Math.min(MAX_FACTOR * base, Math.max(MIN_FACTOR * base, val)))
  return { w: clamp(v.w, design.w), h: clamp(v.h, design.h) }
}

export function resizeViewFromEdge(design: Size, view: Size, edge: 'e' | 's' | 'se', dxPx: number, dyPx: number, displayScale: number): Size {
  const scale = displayScale > 1e-6 ? displayScale : 1
  const dW = (edge === 'e' || edge === 'se') ? dxPx / scale : 0
  const dH = (edge === 's' || edge === 'se') ? dyPx / scale : 0
  return clampViewSize({ w: view.w + dW, h: view.h + dH }, design)
}

export function atDesignSize(view: Size, design: Size): boolean {
  return Math.abs(view.w - design.w) < 1 && Math.abs(view.h - design.h) < 1
}

export function readoutLabel(view: Size, design: Size): 'Design size' | 'Viewing size' {
  return atDesignSize(view, design) ? 'Design size' : 'Viewing size'
}

/**
 * The artboard the editor works in: DESIGN-shaped at the artboard's width. At a viewing size
 * the artboard takes the view's shape, and it only re-fits a tick after a snap back to the design
 * size, so this goes by the artboard's actual shape rather than by "at the design size": an
 * artboard already at the design shape is returned as it is, anything else gets the design shape.
 * The artboard's sides are each rounded when it is fitted, which is the tolerance. A fixed Frame
 * always gets the artboard as it is.
 */
export function designShapedArtboard(canvas: Size, design: Size, responsive: boolean): Size {
  if (!responsive || !(design.w > 0) || !(design.h > 0)) return { w: canvas.w, h: canvas.h }
  const ratio = design.h / design.w
  const h = canvas.w * ratio
  if (Math.abs(canvas.h - h) <= 0.5 + 0.5 * ratio + 1e-9) return { w: canvas.w, h: canvas.h }
  return { w: canvas.w, h }
}
