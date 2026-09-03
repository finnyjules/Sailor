/**
 * Shape library → Compositor path layer. Pure: recentre the manifest's
 * absolute path data on its ink box and scale it into the PathLayer local
 * frame (units = canvas width, centred on 0,0). No paper.js — the manifest
 * only carries M L C Z, so a number-pair transform is exact.
 */
import type { PathLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LibraryShape } from '~/lib/shapes/catalog'

export const SHAPE_LAYER_DEFAULT_WIDTH = 0.3
const DEFAULT_FILL = '#3b82f6'   // createPathLayer's default — the manifest colour is a hint only

export interface ShapeGeometry { d: string; bbox: { w: number; h: number } }

const r5 = (v: number) => { const x = Math.round(v * 1e5) / 1e5; return Object.is(x, -0) ? 0 : x }

/** Ink box → `targetWidth` wide, centred on (0,0). Throws on a non-MLCZ command or a degenerate box. */
export function shapeGeometry(shape: LibraryShape, targetWidth: number): ShapeGeometry {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(targetWidth > 0)) throw new Error(`shapeGeometry: degenerate box for shape "${shape.id}"`)
  const k = targetWidth / bw
  const cx = bx + bw / 2, cy = by + bh / 2
  let out = ''
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m: RegExpExecArray | null
  let pending: number | null = null
  while ((m = re.exec(shape.d))) {
    if (m[1]) {
      if (!'MLCZ'.includes(m[1])) throw new Error(`shapeGeometry: unsupported path command "${m[1]}" in shape "${shape.id}"`)
      if (pending !== null) throw new Error(`shapeGeometry: odd coordinate count in shape "${shape.id}"`)
      out += m[1]
      pending = null
    } else {
      const v = Number(m[2])
      if (pending === null) { pending = v; continue }
      if (!out) throw new Error(`shapeGeometry: path data must start with a command in shape "${shape.id}"`)
      const x = (pending - cx) * k, y = (v - cy) * k
      out += (out.endsWith('M') || out.endsWith('L') || out.endsWith('C') ? '' : ',') + `${r5(x)},${r5(y)}`
      pending = null
    }
  }
  if (pending !== null) throw new Error(`shapeGeometry: odd coordinate count in shape "${shape.id}"`)
  return { d: out, bbox: { w: bw * k, h: bh * k } }
}

let seq = 0
const newId = () => `shape-${Date.now().toString(36)}-${++seq}`

export interface CreateShapeLayerOpts { x?: number; y?: number; targetWidth?: number; fill?: Paint; id?: string }

export function createShapeLayer(shape: LibraryShape, o: CreateShapeLayerOpts = {}): PathLayer {
  const g = shapeGeometry(shape, o.targetWidth ?? SHAPE_LAYER_DEFAULT_WIDTH)
  return {
    id: o.id ?? newId(), kind: 'path',
    x: o.x ?? 0.5, y: o.y ?? 0.5, rotation: 0, opacity: 1,
    d: g.d, bbox: g.bbox, scale: 1,
    fill: o.fill ?? DEFAULT_FILL, fillRule: shape.fillRule, stroke: '', strokeWidth: 0,
    shapeId: shape.id,
  }
}

/** Same layer, new shape: layout and paint kept, geometry regenerated at the current ink width. */
export function swapShapeLayer(layer: PathLayer, shape: LibraryShape): PathLayer {
  // A persisted layer with a zero/NaN bbox (e.g. hand-edited JSON) falls back to the
  // default width instead of feeding shapeGeometry a non-positive targetWidth, which
  // would otherwise throw or produce degenerate geometry.
  const g = shapeGeometry(shape, layer.bbox.w > 0 ? layer.bbox.w : SHAPE_LAYER_DEFAULT_WIDTH)
  return { ...layer, d: g.d, bbox: g.bbox, fillRule: shape.fillRule, shapeId: shape.id }
}
