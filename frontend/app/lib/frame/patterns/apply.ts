import type { PatternPlacement, LayerOp, FrameElements, Role } from './types'
import type { ResolvedPalette } from './palette'
import { roleToPaint } from './palette'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { isImageKind } from './userImages'

const ROLES: Role[] = ['title', 'details', 'caption', 'date']

/** Value equality for layout-set fields (numbers, strings, small plain objects/arrays). */
function same(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))
}

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
  for (const op of placement.ops) {
    // An owned piece's op only carries its stacking (`z`, read by order.ts); the piece itself
    // arrives fully built through mergeOwned, so apply leaves it alone.
    if (op.insert) continue
    const id = targetId(op, elements); if (id) byId.set(id, op)
  }
  return layers.map(layer => {
    const textOrImage = layer.kind === 'text' || isImageKind(layer)
    // A shape a layout placed remembers its own place and size (Knockout's band), so a layout
    // that does not place the shape at all gives it back: it is applied as an op that sets
    // nothing, and every field the earlier layout set comes back (unless the user changed it
    // since). Text and image layers no op targets are left exactly as they are.
    const op = byId.get(layer.id)
      ?? (!textOrImage && (layer as any).layoutPrev ? { target: layer.id, kind: 'shape' } as LayerOp : undefined)
    if (!op) return layer
    const next: any = { ...layer }
    const blend = op.blendMode ?? op.blend
    // Layout-set fields (opacity, blend, spacing, crop, mask, path, runs; a shape's place and size) are re-authored on
    // every apply, but apply only ever clears what a layout set: the layer's own value is
    // remembered the first time a layout overrides it (with what the layout wrote), and put
    // back when a later op leaves the field unset — unless the user has changed it since.
    const prev: Record<string, { was: unknown; set: unknown }> = { ...((layer as any).layoutPrev ?? {}) }
    const track = (field: string, value: unknown) => {
      const cur = (layer as any)[field]
      const entry = prev[field]
      const untouched = entry !== undefined && same(cur, entry.set)
      if (value !== undefined) {
        prev[field] = { was: untouched ? entry!.was : (cur ?? null), set: value }
        next[field] = value
      } else if (entry !== undefined) {
        if (untouched) { if (entry.was == null) delete next[field]; else next[field] = entry.was }
        delete prev[field]
      }
    }
    if (textOrImage) {
      if (op.x != null) next.x = op.x
      if (op.y != null) next.y = op.y
    } else {
      track('x', op.x)
      track('y', op.y)
    }
    // A hidden op carries no geometry or other fields — it only toggles visibility (tracked
    // like every other layout-set field: restored when a later op leaves `hidden` unset, unless
    // the user changed visibility since). Stop here: nothing else about the layer changes.
    track('visible', op.hidden ? false : undefined)
    if (op.hidden && op.hiddenBy && prev.visible) prev.visible = { ...prev.visible, by: op.hiddenBy } as typeof prev.visible
    // A shown op only gives the visibility back (the `track` above restored it): same early stop.
    if (op.hidden || op.shown) {
      if (Object.keys(prev).length) next.layoutPrev = prev; else delete next.layoutPrev
      return next as LocalLayer
    }
    // Text ops always carry their rotation. An image or shape takes the layout's angle (the kit
    // writes 0 when the layout gives none), with the user's own angle remembered like the other
    // layout-set fields and put back when an op leaves it unset.
    if (layer.kind === 'text') { if (op.rotation != null) next.rotation = op.rotation } else track('rotation', op.rotation)
    if (textOrImage) {
      track('opacity', op.opacity)
      track('blend', blend)
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
      track('lineHeight', op.lineHeight)
      track('letterSpacing', op.letterSpacing)
      track('runs', op.runs?.length ? op.runs : undefined)
      track('path', op.path ?? undefined)
      track('textTransform', op.textTransform)
      track('underline', op.underline)
      // Flow text is sized by the layout at the size the checker approved, measured with plain
      // wrapping: a shrink / fill / break box fit would redraw it at another size or break. While
      // the layout holds, the fit is 'wrap' (the renderer's default); the user's own fit comes
      // back when a later op sets the layer as placed lines or on a path (where fit is unused).
      const flow = !op.runs?.length && !op.path
      const fit = (layer as any).boxFit
      track('boxFit', flow && ((fit && fit !== 'wrap') || prev.boxFit) ? 'wrap' : undefined)
    } else if (layer.kind === 'path' && (layer as any).bbox?.w > 0) {
      // A path layer has no `w`: it sizes from `bbox × scale` (both in the same
      // normalized-frame-width units as op.w — see useCompositorLayers' layerBoxPx).
      // Writing `w` here would add a dead field and leave the shape at its old size.
      track('scale', typeof op.w === 'number' && op.w > 0 ? op.w / (layer as any).bbox.w : undefined)
    } else if (!textOrImage) {
      // Any other shape takes the layout's box, remembered like the other layout-set fields.
      track('w', op.w)
      track('h', op.h)
    } else if (layer.kind === 'wired') {
      if (op.w != null) next.w = op.w
      // A wired layer's height comes from its lastAspect — unless it is cropped to a box,
      // when the renderer honours `h` (cover crop). The layout's box height travels with its crop.
      track('h', op.crop && op.h != null ? op.h : undefined)
    } else {
      if (op.w != null) next.w = op.w
      if (op.h != null) next.h = op.h
    }
    if (isImageKind(layer)) {
      track('crop', op.crop ?? undefined)
      track('mask', op.mask ?? undefined)
    }
    if (Object.keys(prev).length) next.layoutPrev = prev; else delete next.layoutPrev
    return next as LocalLayer
  })
}
