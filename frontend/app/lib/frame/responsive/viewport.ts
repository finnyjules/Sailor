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
