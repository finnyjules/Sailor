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
 *  breaks only — face, weight and content are never touched.
 *
 *  `opts.recolour` gates whether a role paints an EXISTING layer's `color`/
 *  `fill`: omitted or `true` keeps today's behaviour; `false` leaves every
 *  existing layer's colour untouched (a newly inserted shape still gets its
 *  fill — that happens at creation in insert.ts, not here). */
export function applyPlacement(
  layers: LocalLayer[],
  placement: PatternPlacement,
  elements: FrameElements,
  palette: ResolvedPalette,
  opts: { recolour?: boolean } = {},
): LocalLayer[] {
  const recolour = opts.recolour !== false
  // index ops by resolved layer id (last op for an id wins — patterns emit one per element)
  const byId = new Map<string, LayerOp>()
  for (const op of placement.ops) { const id = targetId(op, elements); if (id) byId.set(id, op) }
  return layers.map(layer => {
    const op = byId.get(layer.id)
    if (!op) return layer
    const next: any = { ...layer, x: op.x, y: op.y }
    if (op.rotation != null) next.rotation = op.rotation
    const blend = op.blendMode ?? op.blend
    const textOrImage = layer.kind === 'text' || layer.kind === 'image' || layer.kind === 'wired'
    if (textOrImage) {
      // Opacity, blend (and, for text, line/letter spacing) are re-authored on every apply.
      // The layer's own value is remembered the first time a layout overrides it and put
      // back when a later op leaves the field unset — so switching layouts leaves no residue
      // and never loses what the user had.
      const prev: Record<string, unknown> = { ...((layer as any).layoutPrev ?? {}) }
      const track = (field: string, value: unknown) => {
        if (value !== undefined) {
          if (!(field in prev)) prev[field] = (layer as any)[field] ?? null
          next[field] = value
        } else if (field in prev) {
          const orig = prev[field]
          if (orig == null) delete next[field]; else next[field] = orig
          delete prev[field]
        }
      }
      track('opacity', op.opacity)
      track('blend', blend)
      if (layer.kind === 'text') {
        track('lineHeight', op.lineHeight)
        track('letterSpacing', op.letterSpacing)
      }
      if (Object.keys(prev).length) next.layoutPrev = prev; else delete next.layoutPrev
    } else {
      if (op.opacity != null) next.opacity = op.opacity
      if (blend) next.blend = blend
    }
    if (recolour && op.colorRole) {
      const paint = roleToPaint(op.colorRole, palette)
      if (layer.kind === 'text') next.color = paint
      else if ('fill' in layer) next.fill = paint
    }
    if (layer.kind === 'text') {
      if (op.fontSize != null) next.fontSize = op.fontSize
      if (op.w != null) next.boxW = op.w
      if (op.align) next.align = op.align
      if (op.lineBreak != null) next.text = op.lineBreak
      // Expressive/justify/height are re-authored on every apply: set when the
      // op carries them, otherwise DELETE so switching from an expressive
      // pattern back to a flat one does not leave the title rendering as words.
      if (op.expressive) next.expressive = op.expressive; else delete next.expressive
      if (op.valign) next.valign = op.valign; else delete next.valign
      if (op.boxH != null) next.boxH = op.boxH; else delete next.boxH
      if (op.runs?.length) next.runs = op.runs; else delete next.runs
      if (op.path) next.path = op.path; else delete next.path
    } else if (layer.kind === 'path' && typeof op.w === 'number' && op.w > 0 && (layer as any).bbox?.w > 0) {
      // A path layer has no `w`: it sizes from `bbox × scale` (both in the same
      // normalized-frame-width units as op.w — see useCompositorLayers' layerBoxPx).
      // Writing `w` here would add a dead field and leave the shape at its old size.
      next.scale = op.w / (layer as any).bbox.w
    } else if (layer.kind === 'wired') {
      if (op.w != null) next.w = op.w
      // no h: a wired layer's height comes from its lastAspect, not the op
    } else {
      if (op.w != null) next.w = op.w
      if (op.h != null) next.h = op.h
    }
    if (layer.kind === 'image' || layer.kind === 'wired') {
      if (op.crop) next.crop = op.crop; else delete next.crop
      if (op.mask) next.mask = op.mask; else delete next.mask
    }
    return next as LocalLayer
  })
}
