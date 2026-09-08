/**
 * WHICH inspector rows a selected stroke gets, and the human words its selects show.
 *
 * Pure, and deliberately NOT inside the modal: every row here is gated on something the
 * PAINTER actually reads, and those gates are the whole difference between a live dial and
 * a control that stores a value nothing consumes. Keeping them in a module means the tests
 * can state each rule outright instead of mounting an 8,500-line component to infer it.
 *
 * Every gate below was read out of `useCompositorLayers.ts` rather than taken on trust:
 *
 *  - `width` is read by `paintStrokeBand` only. `paintStrokeStack` dispatches on STYLE
 *    first and `continue`s inside the shapes arm, BEFORE its `if (!(st.width > 0))` gate —
 *    so a shapes stroke is sized by `shapes.size` and its `width` is dead.
 *  - `join` reaches the canvas at exactly one statement: `s.lineJoin = o.join === 'round'
 *    ? 'round' : 'miter'` in `paintStrokeBand`'s NON-ZERO-distance branch. `strokeAligned`
 *    (the distance-0 path) never touches `lineJoin`, and `paintShapeStroke` has no join at
 *    all. So: band style, non-zero distance.
 *    (A path layer's `build` DOES set `c.lineJoin = 'round'` on the dilation scratch — but
 *    `paintStrokeBand` runs `o.build(s)` and THEN assigns `s.lineJoin` from `o.join`, so the
 *    stroke's own join wins on a path too. Corners is live there, not overridden.)
 *  - `align` is read by `strokeAligned` (distance 0, shapes only) and by `paintStrokeBand`
 *    (any distance). TEXT is the exception: at distance 0 a text stroke is drawn by
 *    `strokeText`, which takes no path and is always centred, so `align` is inert — but a
 *    text stroke AT A DISTANCE goes through `paintTextStrokeBands` → `paintStrokeBand`
 *    WITH `align: st.align`, so alignment is live there. Hiding it on all text would hide a
 *    working control.
 *  - `dash` is read by `strokeAligned` and by `textStrokePasses`, both of which are the
 *    distance-0 paths. `paintStrokeBand`'s band construction never looks at it (a dash
 *    would have to run along an offset curve that does not exist here), and
 *    `paintShapeStroke` has none. So: band style, distance 0.
 *  - `shapes` needs a real outline to flatten; `strokeSupportsShapes` already says which
 *    kinds have one.
 *  - `wobble` is a property of the LINE, not the style — `shapeStrokeGuideFit` and the band's
 *    displaced-path route both take it, so it shows for band AND shapes, on any kind with a
 *    real outline to flatten. Same requirement as `shapes`, so the same gate: `strokeSupportsShapes`.
 *    A Frame text layer stores a CSS family name, not glyph outlines, so it gets neither.
 *  - `wobbleAmount` / `wobbleLength` / `wobblePhase` only mean anything once `wobble` is set,
 *    so they follow it.
 *  - `join` WIDENS for wobble: a wobbled band flattens the outline and strokes a real Path2D
 *    (see `strokeShapes.ts`), which — unlike `strokeAligned`'s dilation-diff band — DOES
 *    honour `lineJoin`. So Corners must show at distance 0 too when a wobble is live, or a
 *    zigzag's points are governed by a hidden control.
 *
 * The repo's rule is to HIDE an inapplicable row, never to grey it.
 */
import {
  strokeSupportsShapes, STROKE_WOBBLES,
  type ShapeStrokeSpec, type StrokeInstance, type StrokeJoin, type StrokeStyle, type StrokeWobble,
} from '~/lib/compositor/strokeStack'

/** One row of the stroke inspector, in the order the panel draws them. */
export const STROKE_ROW_ORDER = [
  'paint', 'width', 'distance', 'wobble', 'wobbleAmount', 'wobbleLength', 'wobblePhase',
  'join', 'align', 'dash', 'style', 'shapes',
] as const
export type StrokeRowId = typeof STROKE_ROW_ORDER[number]

/** The select's value type: the two real shapes plus the sentinel that means "not wobbling",
 *  which is not `StrokeWobble` itself — `undefined` has no HTML `<option value>`. */
export type StrokeWobbleChoice = StrokeWobble | 'off'

/** The distance the PAINTER would use — `strokeDistancePx`'s own coercion, so a stored
 *  `NaN` gates as the on-the-edge stroke it actually renders as. */
export function strokeDistanceOf(stroke: Pick<StrokeInstance, 'distance'>): number {
  const d = stroke.distance
  return typeof d === 'number' && Number.isFinite(d) ? d : 0
}

export function strokeStyleOf(stroke: Pick<StrokeInstance, 'style'>): StrokeStyle {
  return stroke.style === 'shapes' ? 'shapes' : 'band'
}

/** The wobble the PAINTER would use, as the select's own value space: `'off'` when the
 *  stored `wobble` isn't one of `STROKE_WOBBLES` — matching `resolveWobble`'s off rule in
 *  `strokeStack.ts` for the one bit that gates rows: an unrecognised shape reads as off. */
export function strokeWobbleOf(stroke: Pick<StrokeInstance, 'wobble'>): StrokeWobbleChoice {
  return (STROKE_WOBBLES as readonly string[]).includes(stroke.wobble ?? '') ? (stroke.wobble as StrokeWobble) : 'off'
}

/** THE gate. Every row the modal draws asks this list whether it belongs. */
export function strokeInspectorRows(kind: string, stroke: StrokeInstance): StrokeRowId[] {
  const band = strokeStyleOf(stroke) === 'band'
  const d = strokeDistanceOf(stroke)
  const shapeable = strokeSupportsShapes(kind)
  // Wobble needs a real outline to flatten, same requirement `shapes` has — and it applies
  // regardless of style, since it displaces the LINE both a band and marching shapes walk.
  const wobbling = shapeable && strokeWobbleOf(stroke) !== 'off'
  const rows: StrokeRowId[] = ['paint']
  if (band) rows.push('width')
  rows.push('distance')
  if (shapeable) {
    rows.push('wobble')
    if (wobbling) rows.push('wobbleAmount', 'wobbleLength', 'wobblePhase')
  }
  // Widened for wobble: a wobbled band strokes a real path and DOES honour `lineJoin`, unlike
  // `strokeAligned`'s distance-0 dilation-diff band — see the header comment.
  if (band && (d !== 0 || wobbling)) rows.push('join')
  // Text at distance 0 is `strokeText`, which is always centred.
  if (band && (kind !== 'text' || d !== 0)) rows.push('align')
  if (band && d === 0) rows.push('dash')
  if (shapeable) rows.push('style')
  if (shapeable && !band) rows.push('shapes')
  return rows
}

/** Sentence-case words for the two enums the inspector exposes. House rule: an internal
 *  identifier must never reach the DOM. */
export const STROKE_JOIN_OPTIONS: { value: StrokeJoin; label: string }[] = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'round', label: 'Rounded' },
]
export const STROKE_STYLE_OPTIONS: { value: StrokeStyle; label: string }[] = [
  { value: 'band', label: 'Band' },
  { value: 'shapes', label: 'Shapes' },
]
export const STROKE_WOBBLE_OPTIONS: { value: StrokeWobbleChoice; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'wave', label: 'Wave' },
  { value: 'zigzag', label: 'Zigzag' },
]

/** The seed a stroke's Amount/Every get the first time Wobble is switched on from Off — the
 *  same reasoning as `seedShapeSpec`: a first render that shows nothing sends the user
 *  hunting for a dial to raise from zero. 12px of deviation once every 60px on a 1200-wide
 *  frame — clearly visible, not a full redesign of the line. */
export function seedWobbleFields(): { wobbleAmount: number; wobbleLength: number } {
  return { wobbleAmount: 0.01, wobbleLength: 0.05 }
}

/**
 * The patch that changes a stroke's wobble — ONE object, never two writes.
 *
 * Turning it ON from Off seeds `wobbleAmount` and `wobbleLength` in the SAME patch, so the
 * first render shows something rather than a wobble at whatever stale (or absent) amount the
 * stroke still carried — the exact half-applied-edit shape `strokeStylePatch` already guards
 * against for Style. Switching between Wave and Zigzag, or back to Off, leaves Amount/Every/
 * Phase exactly as they were: a user who dials in a look and flips the shape should not lose
 * it, and switching back to a shape they already tuned should not reseed over their edit.
 */
export function strokeWobblePatch(stroke: StrokeInstance, next: StrokeWobbleChoice): Partial<StrokeInstance> {
  if (next === 'off') return { wobble: undefined }
  const wasOff = strokeWobbleOf(stroke) === 'off'
  return { wobble: next, ...(wasOff ? seedWobbleFields() : {}) }
}

/** The seed a stroke gets the first time it is switched to Shapes: marks at 2× the band's
 *  width, spaced 4×, turning with the edge — so the very first render shows something
 *  rather than an empty stroke the user has to guess their way out of. A zero-width stroke
 *  would seed a zero-size mark (`paintShapeStroke` no-ops on `size > 0`), so fall back to
 *  the same 0.005 `createStroke` starts a band at. */
export function seedShapeSpec(width: number): ShapeStrokeSpec {
  const w = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0.005
  return { shapeId: 'sparkle', size: w * 2, spacing: w * 4, follow: true }
}

/**
 * The patch that changes a stroke's style — ONE object, never two writes.
 *
 * A `style: 'shapes'` entry must always carry a usable `shapes`. Writing `style` first and
 * `shapes` second leaves an instant where the layer says "shapes" with no payload, which is
 * exactly the state that used to flash a full band at whatever stale `width` the row still
 * carried (Finding 1 of the Task 6 review). `strokeStackOf` now normalises that away, but
 * the inspector still has no business producing it.
 */
export function strokeStylePatch(stroke: StrokeInstance, style: StrokeStyle): Partial<StrokeInstance> {
  if (style !== 'shapes') return { style: 'band' }
  return { style: 'shapes', shapes: stroke.shapes ?? seedShapeSpec(stroke.width) }
}

/** Why a distant stroke on TEXT cannot be reordered above an on-edge one. Stated in the
 *  inspector rather than left for the user to discover: `paintTextStrokeBands` lays every
 *  distant band down as a group beneath the per-line stroke/fill loop, because a
 *  whole-block band cannot be interleaved into a per-line draw. */
export const TEXT_DISTANT_STROKE_NOTE =
  'On text, a stroke set at a distance is drawn as one band around the whole block, always beneath the strokes that sit on the edge.'

export function showsTextDistantNote(kind: string, stroke: StrokeInstance): boolean {
  return kind === 'text' && strokeDistanceOf(stroke) !== 0
}
