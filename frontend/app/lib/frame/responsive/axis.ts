import type { AxisMap, AxisPin } from './types'

/** The scale at which a W0×H0 design fits inside a W×H box. */
export function fitScale(W0: number, H0: number, W: number, H: number): number {
  return Math.min(W / W0, H / H0)
}

/** Room left over after fitting: ≥ 0 on both axes, 0 on at least one. */
export function spareRoom(W0: number, H0: number, W: number, H: number): { x: number; y: number } {
  const s = fitScale(W0, H0, W, H)
  return { x: Math.max(0, W - s * W0), y: Math.max(0, H - s * H0) }
}

/**
 * The guard: pins use spare room only up to the fitted design's own extent on that
 * axis; the rest is split evenly as an outer offset so the arrangement stops
 * spreading and sits centred. Continuous in `spare`.
 */
export function guardedRoom(spare: number, fittedExtent: number): { u: number; o: number } {
  const u = Math.min(spare, fittedExtent)
  return { u, o: (spare - u) / 2 }
}

/** Build the map for one axis. `ref` = reference extent in design px; `refStart` = its start. */
export function axisMap(kind: AxisPin, ref: number, s: number, u: number, o: number, refStart = 0): AxisMap {
  return { kind, s, u, o, ref, refStart }
}

/**
 * Map a design-px coordinate to box px. For 'both', say which edge the point is:
 * the near edge maps like 'left', the far edge like 'right'. Every other kind
 * ignores `edge`.
 */
export function applyMap(m: AxisMap, p: number, edge: 'near' | 'far' = 'near'): number {
  const local = p - m.refStart
  const base = m.o + m.s * p
  switch (m.kind) {
    case 'left': return base
    case 'right': return base + m.u
    case 'center': return base + m.u / 2
    case 'relative': return base + m.u * (m.ref > 0 ? local / m.ref : 0)
    case 'both': return edge === 'far' ? base + m.u : base
  }
}

/** The inverse of applyMap for the same kind/edge (design px from box px). */
export function invertMap(m: AxisMap, q: number, edge: 'near' | 'far' = 'near'): number {
  switch (m.kind) {
    case 'left': return (q - m.o) / m.s
    case 'right': return (q - m.o - m.u) / m.s
    case 'center': return (q - m.o - m.u / 2) / m.s
    case 'relative': {
      // q = o + s·p + u·(p − refStart)/ref  ⇒  p = (q − o + u·refStart/ref) / (s + u/ref)
      const k = m.ref > 0 ? m.u / m.ref : 0
      return (q - m.o + k * m.refStart) / (m.s + k)
    }
    case 'both': return edge === 'far' ? (q - m.o - m.u) / m.s : (q - m.o) / m.s
  }
}
