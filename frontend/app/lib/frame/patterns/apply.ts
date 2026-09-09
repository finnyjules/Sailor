import type { PatternPlacement, LayerOp, FrameElements, Role } from './types'
import type { ResolvedPalette } from './palette'
import { roleToPaint } from './palette'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const ROLES: Role[] = ['title', 'details', 'caption', 'date']

/** Resolve an op's target to a concrete layer id: a role → the inferred element's
 *  id; anything else is treated as a literal layer id (image/shape ops). */
function targetId(op: LayerOp, elements: FrameElements): string | undefined {
  if ((ROLES as string[]).includes(op.target)) {
    const el = elements[op.target as Role]
    return el?.id
  }
  return op.target
}

/** Apply a placement's ops onto a copy of `layers`. Pure: returns a new array of
 *  new layer objects; never mutates the input. Geometry/colour-role/blend/line-
 *  breaks only — face, weight and content are never touched. */
export function applyPlacement(
  layers: LocalLayer[],
  placement: PatternPlacement,
  elements: FrameElements,
  palette: ResolvedPalette,
): LocalLayer[] {
  // index ops by resolved layer id (last op for an id wins — patterns emit one per element)
  const byId = new Map<string, LayerOp>()
  for (const op of placement.ops) { const id = targetId(op, elements); if (id) byId.set(id, op) }
  return layers.map(layer => {
    const op = byId.get(layer.id)
    if (!op) return layer
    const next: any = { ...layer, x: op.x, y: op.y }
    if (op.rotation != null) next.rotation = op.rotation
    if (op.blend) next.blend = op.blend
    if (op.colorRole) {
      const paint = roleToPaint(op.colorRole, palette)
      if (layer.kind === 'text') next.color = paint
      else if ('fill' in layer) next.fill = paint
    }
    if (layer.kind === 'text') {
      if (op.fontSize != null) next.fontSize = op.fontSize
      if (op.w != null) next.boxW = op.w
      if (op.align) next.align = op.align
      if (op.lineBreak != null) next.text = op.lineBreak
    } else {
      if (op.w != null) next.w = op.w
      if (op.h != null) next.h = op.h
    }
    return next as LocalLayer
  })
}
