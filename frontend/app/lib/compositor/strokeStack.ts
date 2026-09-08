/**
 * A layer's strokes, as an ordered list.
 *
 * The sibling of `effectStack.ts`, and deliberately built the same way: stored layers are
 * read with a raw cast in several places and there is no sanitize step, so a migration on
 * load would rewrite every saved frame the moment it opened. `strokeStackOf` READS THROUGH
 * the legacy single-stroke fields instead, and the new shape is written only on an edit.
 *
 * Pure: no canvas, no DOM, no Path2D. The painter decides how a stroke is drawn; this
 * decides only what strokes a layer has and in what order.
 */
import type { Paint } from '~/lib/compositor/paint'

/** Where a band sits relative to its reference edge. Mirrors the composable's type; declared
 *  here rather than imported because the composable imports THIS module (cycle). */
export type StrokeAlign = 'center' | 'inside' | 'outside'
export interface StrokeDash { dash: number; gap: number }

/** How the OFFSET treats corners. 'sharp' (canvas miter) keeps a star's spikes as spikes;
 *  'round' is the literal reading of "distance from the edge" — every point exactly d away. */
export const STROKE_JOINS = ['sharp', 'round'] as const
export type StrokeJoin = typeof STROKE_JOINS[number]

/** A continuous band, or library shapes marching along the edge. */
export const STROKE_STYLES = ['band', 'shapes'] as const
export type StrokeStyle = typeof STROKE_STYLES[number]

export interface ShapeStrokeSpec {
  /** An id from lib/shapes/catalog. */
  shapeId: string
  /** Same units as `width`: normalized to canvas width, or a path layer's local units. */
  size: number
  /** Centre-to-centre along the edge, same units as `size`. */
  spacing: number
  /** true (default): each mark rotates to the tangent. false: all upright. */
  follow?: boolean
}

export interface StrokeInstance {
  id: string
  /** Absent ⇒ visible, the same convention as EffectInstance. */
  visible?: boolean
  paint: Paint
  /** Normalized to canvas width; a path layer stores local units at scale 1, as today. */
  width: number
  /** How far the band's REFERENCE EDGE sits from the shape's own edge, same units as
   *  `width`. 0 = the shape's edge, i.e. exactly today. Positive out, negative in. */
  distance?: number
  align?: StrokeAlign
  dash?: StrokeDash
  join?: StrokeJoin
  style?: StrokeStyle
  shapes?: ShapeStrokeSpec
}

/** The kinds whose stroke can become a list. A line has no interior to offset from, so it
 *  keeps its single stroke and is deliberately NOT a member.
 *
 *  Being honest about the consequence: the painter's line arm is a genuine special case —
 *  it reads `layer.strokeWidth` / `layer.stroke` directly and never calls `strokeStackOf`.
 *  That is not an oversight to tidy up later. Its `Math.max(1, width * W)` hairline floor
 *  and its `'#ffffff'` default-when-unpainted have no expression in a stack (which drops a
 *  zero-width or unpainted stroke outright), so routing it through here would change what
 *  a saved line renders. The tree offers a line no plus-menu for the same reason. */
const STACKABLE = new Set(['rect', 'ellipse', 'polygon', 'star', 'path', 'text'])
export function strokeSupportsStack(kind: string): boolean { return STACKABLE.has(kind) }

/** Marching shapes need an exact path to flatten. The Frame's text layer stores only a CSS
 *  family name — it has no glyph outlines — so text is band-only. See the spec's "text limit". */
const SHAPEABLE = new Set(['rect', 'ellipse', 'polygon', 'star', 'path'])
export function strokeSupportsShapes(kind: string): boolean { return SHAPEABLE.has(kind) }

let _seq = 0
export function newStrokeId(): string { return `st${Date.now().toString(36)}${(_seq++).toString(36)}` }

/** A fresh stroke: on the edge, centred, 6 px on a 1200-wide frame. */
export function createStroke(): StrokeInstance {
  return { id: newStrokeId(), paint: '#ffffff', width: 0.005, distance: 0, align: 'center', join: 'sharp', style: 'band' }
}

interface StrokeHost {
  kind?: unknown
  strokes?: unknown
  stroke?: unknown
  strokeColor?: unknown
  strokeWidth?: unknown
  strokeAlign?: unknown
  strokeDash?: unknown
}

const hasInk = (p: unknown): boolean => {
  if (typeof p === 'string') return p !== '' && p !== 'none'
  return !!p && typeof p === 'object'
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** A style:'shapes' entry's `shapes`, coerced into something the painter (and every other
 *  consumer) can never mistake for "no payload". Defaults absent/malformed fields to the
 *  zero value `paintShapeStroke` already treats as "draw nothing" (`shapeById('')` finds
 *  nothing; `size`/`spacing` of 0 fail its own `> 0` gates) — so an entry normalised this
 *  way is inert, never wrong. See the call site's comment for why this lives HERE. */
const normalizeShapeSpec = (v: unknown): ShapeStrokeSpec => {
  const o = v && typeof v === 'object' ? v as Record<string, unknown> : {}
  const spec: ShapeStrokeSpec = {
    shapeId: typeof o.shapeId === 'string' ? o.shapeId : '',
    size: num(o.size),
    spacing: num(o.spacing),
  }
  if (typeof o.follow === 'boolean') spec.follow = o.follow
  return spec
}

/** THE reader. Every consumer goes through this — the painter, the pad helper, the SVG
 *  writer, the agent and the inspector — so they cannot disagree about what a layer's
 *  strokes are. */
export function strokeStackOf(layer: StrokeHost | null | undefined): StrokeInstance[] {
  if (!layer) return []
  // A BRUSH layer's `strokes` is a `PaintStroke[]` — freehand paint-stroke PATH data, a
  // completely different meaning of the same field name (see `BrushLayer` in
  // useCompositorLayers.ts). Today a PaintStroke happens to carry neither an `id` nor a
  // `paint`, so the filter below would drop it — but that is a coincidence of the brush
  // format, not a guarantee, and the painter now calls this for every layer it draws.
  // Refuse the array outright for a brush so a brush stroke can never be mistaken for an
  // outline; the legacy `stroke`/`strokeWidth` fields a brush also declares still read
  // through normally below.
  const raw = layer.kind === 'brush' || !Array.isArray(layer.strokes) ? [] : layer.strokes
  const known = raw.filter(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
      && (s as { id: string }).id !== '' && hasInk((s as { paint?: unknown }).paint),
  )
  const allIded = known.length > 0 && known.length === raw.length
  // A new-shape layer that ALSO carries a live legacy stroke can only come from an older
  // build editing a newer document; the legacy field is the one with a trustworthy meaning,
  // so it falls through. Same decision effectStackOf makes for tornEdge/feather.
  const legacyPaint = layer.kind === 'text' ? layer.strokeColor : layer.stroke
  const legacyLive = hasInk(legacyPaint) && num(layer.strokeWidth) > 0
  if (allIded && !legacyLive) {
    return known.map(s => {
      const visible = s.visible !== false
      // FINDING 1 (Task 6 review): `style: 'shapes'` with a missing or malformed `shapes`
      // used to fall straight through the painter's `if (shapes)` check and paint a full
      // BAND with whatever stale `width` the row still carried — the shape an inspector
      // writing `style` and `shapes` in two patches (or any older writer) can produce.
      // Guaranteed HERE, not in the painter: `strokeStackOf` is the one place the painter,
      // the SVG writer and the agent all read a layer's strokes through, so a style:'shapes'
      // entry ALWAYS carrying a real (if inert) `shapes` object here means none of those
      // consumers can independently get the "missing payload" case wrong.
      if ((s as { style?: unknown }).style === 'shapes') {
        return { ...s, visible, shapes: normalizeShapeSpec((s as { shapes?: unknown }).shapes) }
      }
      return { ...s, visible }
    }) as unknown as StrokeInstance[]
  }
  if (!legacyLive) return []
  const one: StrokeInstance = {
    id: 'legacy',
    visible: true,
    paint: legacyPaint as Paint,
    width: num(layer.strokeWidth),
    distance: 0,
    style: 'band',
  }
  if (layer.strokeAlign === 'inside' || layer.strokeAlign === 'outside') one.align = layer.strokeAlign
  const d = layer.strokeDash as StrokeDash | undefined
  if (d && typeof d === 'object' && num(d.dash) > 0) one.dash = { dash: num(d.dash), gap: num(d.gap) }
  return [one]
}

/** The patch that stores a stack. Every legacy field is cleared in the SAME patch, so a
 *  layer can never carry both shapes and fall into the legacy branch on the next read. */
export function writeStrokeStackToLayer(stack: StrokeInstance[]): {
  strokes: StrokeInstance[]
  stroke: undefined; strokeColor: undefined; strokeWidth: undefined
  strokeAlign: undefined; strokeDash: undefined
} {
  return {
    strokes: stack,
    stroke: undefined, strokeColor: undefined, strokeWidth: undefined,
    strokeAlign: undefined, strokeDash: undefined,
  }
}

/** Appended, so a new stroke paints UNDER the existing ones — adding one never changes
 *  what you already see. */
export function addStroke(stack: StrokeInstance[]): StrokeInstance[] {
  return [...stack, createStroke()]
}

export function removeStroke(stack: StrokeInstance[], id: string): StrokeInstance[] {
  const next = stack.filter(s => s.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original with a fresh id. Deep-cloned: a shallow copy would
 *  share the original's nested `dash` / `shapes` objects with its duplicate. */
export function duplicateStroke(stack: StrokeInstance[], id: string): StrokeInstance[] {
  const i = stack.findIndex(s => s.id === id)
  if (i === -1) return stack
  const copy = { ...(JSON.parse(JSON.stringify(stack[i]!)) as StrokeInstance), id: newStrokeId() }
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

export function canReorderStroke(stack: StrokeInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  return stack.some(s => s.id === fromId) && stack.some(s => s.id === toId)
}

export function reorderStroke(stack: StrokeInstance[], fromId: string, toId: string): StrokeInstance[] {
  if (!canReorderStroke(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex(s => s.id === fromId)
  // `to` MUST be read before the splice below. Reading it after — against the already
  // shortened array — yields a stale index that silently undoes a forward drag. This is
  // the exact bug the effect stack's own tests caught in its plan's reference code.
  const to = next.findIndex(s => s.id === toId)
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}

/** The tree row's label. Sentence case, no internal identifiers (house rule). */
export function strokeRowLabel(stroke: StrokeInstance, W: number): string {
  if ((stroke.style ?? 'band') === 'shapes' && stroke.shapes) {
    const id = stroke.shapes.shapeId
    return id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ') : 'Shapes'
  }
  const px = Math.round(stroke.width * W)
  const d = Math.round(num(stroke.distance) * W)
  if (d > 0) return `${px} px, ${d} px out`
  if (d < 0) return `${px} px, ${-d} px in`
  return `${px} px`
}
