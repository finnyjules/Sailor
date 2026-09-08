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
import type { WobbleSpec } from '~/lib/compositor/strokeShapes'

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

/** Wobble is a property of the LINE, not the style — a band strokes the wavy line, and
 *  marching shapes walk a guide built from it, so both inherit the same four dials. */
export const STROKE_WOBBLES = ['wave', 'zigzag'] as const
export type StrokeWobble = typeof STROKE_WOBBLES[number]

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
  /** Absent ⇒ the line runs straight, exactly as it does today. */
  wobble?: StrokeWobble
  /** Peak deviation either side of the line, same units as `width`. */
  wobbleAmount?: number
  /** One full cycle, same units as `width`. Non-positive or non-finite ⇒ treated as off. */
  wobbleLength?: number
  /** Degrees — where the cycle starts around the outline. */
  wobblePhase?: number
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

/**
 * The id on the ONE entry `strokeStackOf` SYNTHESISES from a layer that still stores the
 * legacy single-stroke fields.
 *
 * It is a READING artefact — "there is no stored list, so I made this entry up" — and it is
 * the only id in the system that is not unique to one stroke. It must never reach storage,
 * because a stored entry is a real stroke that consumers address by id, and two of them
 * would collide. `writeStrokeStackToLayer` stamps a real id over it at the single boundary
 * where a read-through stack becomes a stored one.
 *
 * Nothing may ask "does this layer store a list?" by comparing an entry's id to this — that
 * is a question about the LAYER, and `layerStoresStrokeStack` is the answer.
 */
export const LEGACY_STROKE_ID = 'legacy'

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

/**
 * The wobble fields resolved to a clean shape, or `null` when off — shared by
 * `strokeStackOf`'s read-through normalisation and `wobbleSpecOf` so "is it on" and "what
 * are its clean values" can never disagree about the same raw fields.
 *
 * Off: an unrecognised `shape`, a non-positive or non-finite `length`, or a non-finite
 * `amount`. A non-finite `phase` is not a reason to turn off — it just reads as 0, matching
 * `strokeDistancePx` / `strokeReachPx`'s convention for a bad number.
 */
function resolveWobble(
  shape: unknown, lengthRaw: unknown, amountRaw: unknown, phaseRaw: unknown,
): { shape: StrokeWobble; amount: number; length: number; phase: number } | null {
  if (shape !== 'wave' && shape !== 'zigzag') return null
  const length = num(lengthRaw)
  if (!(length > 0)) return null
  if (typeof amountRaw !== 'number' || !Number.isFinite(amountRaw)) return null
  return { shape, amount: amountRaw, length, phase: num(phaseRaw) }
}

/** Whether the layer's own legacy single-stroke fields say anything. A live legacy field is
 *  what makes the whole array fall through to the fold below — see the call sites. */
function legacyStrokeIsLive(layer: StrokeHost): boolean {
  return hasInk(layer.kind === 'text' ? layer.strokeColor : layer.stroke) && num(layer.strokeWidth) > 0
}

/**
 * THE decision: the stored entries this layer's strokes come from, or `null` when they come
 * from the legacy fields instead.
 *
 * Split out of `strokeStackOf` so that "does this layer store a list?" has ONE answer, asked
 * of the layer. It used to be inferred from the first returned entry's id (`!== 'legacy'`),
 * which is a different question with a different answer: fold a legacy entry into a new list
 * and the stored list is led by an entry still carrying the sentinel, so the inference said
 * "no list" about a layer that had one — and the caller then wrote the legacy pair back over
 * it, which sends the WHOLE array down the fold and deletes every other outline.
 */
function storedStrokeEntries(layer: StrokeHost | null | undefined): Record<string, unknown>[] | null {
  if (!layer) return null
  // A BRUSH layer's `strokes` is a `PaintStroke[]` — freehand paint-stroke PATH data, a
  // completely different meaning of the same field name (see `BrushLayer` in
  // useCompositorLayers.ts). Today a PaintStroke happens to carry neither an `id` nor a
  // `paint`, so the filter below would drop it — but that is a coincidence of the brush
  // format, not a guarantee, and the painter now calls this for every layer it draws.
  // Refuse the array outright for a brush so a brush stroke can never be mistaken for an
  // outline; the legacy `stroke`/`strokeWidth` fields a brush also declares still read
  // through normally below.
  const raw = layer.kind === 'brush' || !Array.isArray(layer.strokes) ? [] : layer.strokes
  //
  // WHAT MAKES THE ARRAY TRUSTWORTHY IS ITS SHAPE, NOT ITS INK. An entry carrying a
  // well-formed id is one WE wrote, whatever its paint says; an inkless entry
  // (`paint: 'none'`, or none stored) is a perfectly well-formed stroke that simply paints
  // nothing, and every painter loop re-checks `hasPaint(st.paint)` itself before drawing
  // (useCompositorLayers.ts:1346, :1728, :2607, :3024, :3120), as does the SVG writer.
  //
  // These two questions used to be one filter, and the cost was silent DATA LOSS: the
  // inspector's Colour row is `<FillControl allow-none>`, so one click on Remove made one
  // entry inkless, which dropped it from `known`, which made `allIded` false, which sent
  // the WHOLE array down the legacy branch. Every stroke row then vanished from the tree,
  // the disclosure chevron with them, the inspector closed, the painter drew no outline at
  // all — and the next "Add outline" wrote `strokes: [new]` over the survivors.
  const known = raw.filter(
    (s): s is Record<string, unknown> =>
      !!s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
      && (s as { id: string }).id !== '',
  )
  const allIded = known.length > 0 && known.length === raw.length
  // A new-shape layer that ALSO carries a live legacy stroke can only come from an older
  // build editing a newer document; the legacy field is the one with a trustworthy meaning,
  // so it falls through. Same decision effectStackOf makes for tornEdge/feather.
  return allIded && !legacyStrokeIsLive(layer) ? known : null
}

/**
 * True when this layer STORES its strokes as a list — the question `setStroke` and every
 * other write has to answer before it decides which shape to write back.
 *
 * Asked of the layer, never of an entry's id: an id says which stroke it is, not where the
 * layer keeps its strokes. Same source of truth as `strokeStackOf`, so the two cannot drift.
 */
export function layerStoresStrokeStack(layer: StrokeHost | null | undefined): boolean {
  return storedStrokeEntries(layer) !== null
}

/** THE reader. Every consumer goes through this — the painter, the pad helper, the SVG
 *  writer, the agent and the inspector — so they cannot disagree about what a layer's
 *  strokes are. */
export function strokeStackOf(layer: StrokeHost | null | undefined): StrokeInstance[] {
  const known = storedStrokeEntries(layer)
  if (known) {
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
      // Wobble is a property of the LINE, not the style, so it is normalised for every
      // entry here — the same guarantee `normalizeShapeSpec` gives a style:'shapes' payload,
      // now given to the four wobble fields regardless of style.
      const w = resolveWobble(
        (s as { wobble?: unknown }).wobble,
        (s as { wobbleLength?: unknown }).wobbleLength,
        (s as { wobbleAmount?: unknown }).wobbleAmount,
        (s as { wobblePhase?: unknown }).wobblePhase,
      )
      const wobbleFields = w
        ? { wobble: w.shape, wobbleAmount: w.amount, wobbleLength: w.length, wobblePhase: w.phase }
        : { wobble: undefined, wobbleAmount: undefined, wobbleLength: undefined, wobblePhase: undefined }
      if ((s as { style?: unknown }).style === 'shapes') {
        return {
          ...s, visible, shapes: normalizeShapeSpec((s as { shapes?: unknown }).shapes), ...wobbleFields,
        }
      }
      return { ...s, visible, ...wobbleFields }
    }) as unknown as StrokeInstance[]
  }
  if (!layer || !legacyStrokeIsLive(layer)) return []
  const one: StrokeInstance = {
    // SYNTHESISED, not stored — see `LEGACY_STROKE_ID`.
    id: LEGACY_STROKE_ID,
    visible: true,
    paint: (layer.kind === 'text' ? layer.strokeColor : layer.stroke) as Paint,
    width: num(layer.strokeWidth),
    distance: 0,
    style: 'band',
  }
  if (layer.strokeAlign === 'inside' || layer.strokeAlign === 'outside') one.align = layer.strokeAlign
  const d = layer.strokeDash as StrokeDash | undefined
  if (d && typeof d === 'object' && num(d.dash) > 0) one.dash = { dash: num(d.dash), gap: num(d.gap) }
  return [one]
}

/**
 * A stroke's wobble as a `WobbleSpec`, or `null` when it is off — the ONE question every
 * consumer (a band's painter, marching shapes) asks instead of re-deriving "is it on" from
 * the four raw fields.
 *
 * `unit` scales `amount` and `length` into the caller's own units (canvas pixels for a
 * rect/ellipse, local units for a path) the same way callers already scale `width` and
 * `distance` — `phase` is degrees and is never scaled.
 *
 * Self-contained rather than trusting a caller to have gone through `strokeStackOf` first:
 * `resolveWobble` re-derives the same off rule `strokeStackOf` normalises with, so a raw,
 * freshly-created, or hand-built `StrokeInstance` reads exactly the same way a stored one
 * does after a read-through.
 */
export function wobbleSpecOf(stroke: StrokeInstance, unit: number): WobbleSpec | null {
  const w = resolveWobble(stroke.wobble, stroke.wobbleLength, stroke.wobbleAmount, stroke.wobblePhase)
  if (!w) return null
  return { shape: w.shape, amount: w.amount * unit, length: w.length * unit, phase: w.phase }
}

/** An entry on its way INTO storage, with an id that addresses exactly it. Returns the same
 *  object when its id is already real, so a write that changes nothing changes nothing. */
const stampStoredStrokeId = (s: StrokeInstance): StrokeInstance => {
  const id = (s as { id?: unknown }).id
  return typeof id === 'string' && id !== '' && id !== LEGACY_STROKE_ID ? s : { ...s, id: newStrokeId() }
}

/**
 * The patch that stores a stack. Every legacy field is cleared in the SAME patch, so a layer
 * can never carry both shapes and fall into the legacy branch on the next read.
 *
 * It is also where a READ-THROUGH stack becomes a STORED one, which makes it the one place
 * that can guarantee the reading-time sentinel (and an entry with no id at all — `allIded`
 * drops the whole array over one of those) never lands on disk. Every write path in the app
 * goes through here — the inspector's `setLayerStrokes`, the shape-stroke row, and all four
 * of the agent's stroke ops — so the guarantee is structural rather than a rule each caller
 * has to remember.
 */
export function writeStrokeStackToLayer(stack: StrokeInstance[]): {
  strokes: StrokeInstance[]
  stroke: undefined; strokeColor: undefined; strokeWidth: undefined
  strokeAlign: undefined; strokeDash: undefined
} {
  return {
    strokes: stack.map(stampStoredStrokeId),
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
