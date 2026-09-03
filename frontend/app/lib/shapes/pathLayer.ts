/**
 * Shape library → Compositor path layer. Pure: recentre the manifest's
 * absolute path data on its ink box and scale it into the PathLayer local
 * frame (units = canvas width, centred on 0,0). No paper.js — the manifest
 * only carries M L C Z, so a number-pair transform is exact.
 */
import type { PathLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LibraryShape } from '~/lib/shapes/catalog'
import { transformShapePath } from '~/lib/shapes/geometry'

export const SHAPE_LAYER_DEFAULT_WIDTH = 0.3
const DEFAULT_FILL = '#3b82f6'   // createPathLayer's default — the manifest colour is a hint only

export interface ShapeGeometry { d: string; bbox: { w: number; h: number } }

/** Ink box → `targetWidth` wide, centred on (0,0). Throws on a non-MLCZ command or a degenerate box. */
export function shapeGeometry(shape: LibraryShape, targetWidth: number): ShapeGeometry {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(targetWidth > 0)) throw new Error(`shapeGeometry: degenerate box for shape "${shape.id}"`)
  const k = targetWidth / bw
  return { d: transformShapePath(shape, k, bx + bw / 2, by + bh / 2), bbox: { w: bw * k, h: bh * k } }
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
