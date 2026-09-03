import { polygonVertices, starVertices, roundedPolygonPath, type Pt } from '~/lib/compositor/polygonGeometry'
import { SHAPES, shapeById } from '~/lib/shapes/catalog'
import { fitShapePath } from '~/lib/shapes/geometry'

export type BaseShapeKind =
  | 'circle' | 'square' | 'triangle' | 'diamond' | 'pentagon' | 'hexagon'
  | 'octagon' | 'star' | 'semicircle' | 'cross' | 'leaf' | 'irregular' | 'library'

/** Canonical order for menus/validation — append, don't reorder. */
export const BASE_SHAPES: BaseShapeKind[] = [
  'circle', 'square', 'triangle', 'diamond', 'pentagon', 'hexagon',
  'octagon', 'star', 'semicircle', 'cross', 'leaf', 'irregular', 'library',
]

/** The library shape a fresh Library base shape shows, and the fallback for an id the catalog no longer has. */
export const DEFAULT_LIBRARY_SHAPE = 'sparkle'

export interface BaseShapeOpts {
  sides: number; starInner: number; irregularSeed: number
  size: number; roundCorners: number; roundRadius: number
  /** `library` only: a shape-library id. */
  libraryShape?: string
}

/** A library shape fitted so its larger ink side spans `size`, centred like every other base shape. */
function libraryPath(id: string | undefined, size: number): string {
  // Floor the lookup instead of asserting: an id the catalog no longer has falls
  // back to DEFAULT_LIBRARY_SHAPE, and — if that id were ever renamed out of the
  // manifest too — to the catalog's first shape. A missing base shape must not be
  // able to throw inside a render pass.
  const shape = (id ? shapeById(id) : undefined) ?? shapeById(DEFAULT_LIBRARY_SHAPE) ?? SHAPES[0]
  if (!shape) return ''
  return fitShapePath(shape, size).d
}

// Small seeded RNG (mulberry32 over an xmur3 hash) — self-contained.
function rng(seed: number): () => number {
  const s = `geo|${seed}`
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19) }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909)
  let a = (h ^= h >>> 16) >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function irregularVertices(sides: number, size: number, seed: number): Pt[] {
  const base = polygonVertices(sides, size, size)
  const r = rng(seed)
  // jitter each vertex radially by ±30% of size/2
  return base.map((p) => { const k = 0.7 + r() * 0.6; return { x: p.x * k, y: p.y * k } })
}

const f = (v: number) => +v.toFixed(3)

/** Axis-aligned square (corners at 45° from the diamond orientation). */
function squareVertices(size: number): Pt[] {
  const h = size / 2
  return [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }]
}

/** A plus / cross: 12 vertices, arm half-width `w`, reach `a`. Rounding-friendly. */
function crossVertices(size: number): Pt[] {
  const a = size / 2, w = size * 0.18
  return [
    { x: -w, y: -a }, { x: w, y: -a }, { x: w, y: -w }, { x: a, y: -w },
    { x: a, y: w }, { x: w, y: w }, { x: w, y: a }, { x: -w, y: a },
    { x: -w, y: w }, { x: -a, y: w }, { x: -a, y: -w }, { x: -w, y: -w },
  ]
}

/** A full circle as two SVG arcs (paper.js parses arcs; the composite converts
 *  them to bezier commands). */
function circlePath(size: number): string {
  const r = size / 2
  return `M ${f(r)} 0 A ${f(r)} ${f(r)} 0 1 1 ${f(-r)} 0 A ${f(r)} ${f(r)} 0 1 1 ${f(r)} 0 Z`
}

/** A half-disk, bbox-centred on the origin (flat edge below, dome above). */
function semicirclePath(size: number): string {
  const r = size / 2
  const y = r / 2 // shift so the bbox (dome apex .. flat edge) straddles 0
  return `M ${f(-r)} ${f(y)} A ${f(r)} ${f(r)} 0 0 1 ${f(r)} ${f(y)} Z`
}

/** A pointed leaf / vesica: two quadratic arcs meeting at the top and bottom tips. */
function leafPath(size: number): string {
  const r = size / 2, w = size * 0.36
  return `M 0 ${f(-r)} Q ${f(w)} 0 0 ${f(r)} Q ${f(-w)} 0 0 ${f(-r)} Z`
}

/** One SVG `d` (centred on the origin) for the chosen base shape. `roundCorners`
 *  gates corner rounding (0 = off) for the polygonal shapes; `roundRadius`/100 is
 *  the corner-radius fraction. Curved shapes (circle/semicircle/leaf) ignore it. */
export function baseShapePath(kind: BaseShapeKind, o: BaseShapeOpts): string {
  const cr = o.roundCorners > 0 ? Math.max(0, Math.min(1, o.roundRadius / 100)) : 0
  const ngon = (n: number) => roundedPolygonPath(polygonVertices(n, o.size, o.size), cr)
  switch (kind) {
    case 'circle':     return circlePath(o.size)
    case 'square':     return roundedPolygonPath(squareVertices(o.size), cr)
    case 'triangle':   return ngon(3)
    case 'diamond':    return ngon(4)
    case 'pentagon':   return ngon(5)
    case 'hexagon':    return ngon(6)
    case 'octagon':    return ngon(8)
    case 'star':       return roundedPolygonPath(starVertices(o.sides, o.starInner, o.size, o.size), cr)
    case 'semicircle': return semicirclePath(o.size)
    case 'cross':      return roundedPolygonPath(crossVertices(o.size), cr)
    case 'leaf':       return leafPath(o.size)
    case 'irregular':  return roundedPolygonPath(irregularVertices(o.sides, o.size, o.irregularSeed), cr)
    case 'library':    return libraryPath(o.libraryShape, o.size)
  }
}
