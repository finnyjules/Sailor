import type { LayerOp } from './types'
import type { ResolvedPalette } from './palette'
import { roleToPaint } from './palette'
import { createShapeLayer } from '~/lib/shapes/pathLayer'
import { createImageLayer } from '~/composables/useCompositorLayers'
import { shapeById } from '~/lib/shapes/catalog'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const SENTINEL = 'shape'
const IMAGE_SENTINEL = 'image'

/** For every sentinel shape op (a pattern wanted a library shape but no shape
 *  layer was placed), build a real path layer with the shape factory, append it,
 *  and retarget the op to the new id. For every image sentinel op, build a stand-in
 *  image layer. Pure: returns new arrays. */
export function insertFromOps(
  layers: LocalLayer[], ops: LayerOp[], palette: ResolvedPalette, idBase: string,
): { layers: LocalLayer[]; inserted: Map<number, string>; ops: LayerOp[] } {
  const next = [...layers]
  const inserted = new Map<number, string>()
  const outOps = ops.map((op, i) => {
    if (op.kind === 'image' && op.target === IMAGE_SENTINEL) {
      const aspect = (op.h ?? op.w ?? 1) / (op.w || 1)   // h/w in width-normalized units
      const layer = createImageLayer('', aspect, { id: `${idBase}-${i}`, x: op.x, y: op.y, w: op.w, h: op.h, standIn: true } as any)
      next.push(layer as LocalLayer)
      inserted.set(i, layer.id)
      return { ...op, target: layer.id }
    }
    if (op.kind !== 'shape' || op.target !== SENTINEL || !op.shapeId) return op
    const shape = shapeById(op.shapeId)
    if (!shape) return op
    const layer = createShapeLayer(shape, {
      id: `${idBase}-${i}`,
      x: op.x, y: op.y,
      targetWidth: op.w,
      fill: roleToPaint(op.colorRole ?? 'accent', palette),
    })
    next.push(layer as LocalLayer)
    inserted.set(i, layer.id)
    return { ...op, target: layer.id }
  })
  return { layers: next, inserted, ops: outOps }
}
