// app/composables/pen/usePen.ts
// The arc pen's state and actions, hostable by any surface that owns a
// SketchDoc ref and a view matrix (the dev page today; the Frame editor and
// Shape Studio later). PenOverlay draws it and turns pointer/keys into its
// actions; PenToolbar is its tool bar.
//
// ─── HOST CONTRACT ──────────────────────────────────────────────────────────
// 1. One pen per editing session. Create the pen when the session opens and
//    drop it (call dispose()) when it closes.
// 2. Pass a CLONE of the stored drawing, never the stored object:
//      const doc = ref(cloneDoc(stored))        // ~/lib/sketch/clone
//      const pen = usePen({ doc, view, onChange })
//    The pen mutates doc.value in place and replaces it on undo/redo/revert, so
//    handing it the stored object would write half-finished edits into storage.
// 3. To open a DIFFERENT drawing, create a new pen and re-key the overlay and
//    toolbar (`:key`). Both read `props.pen` once, at setup; swapping the prop
//    on a live component does nothing.
// 4. Persist on commit (or in onChange, for settled steps) with
//    cloneDoc(doc.value) — never keep a reference to the pen's doc.
// 5. Any host-side re-normalisation of the drawing (e.g. the Frame's
//    re-centring) happens on commit, never while the pen is open: the pen's
//    history and pending state hold entity ids and positions it expects to
//    still be there.
// 6. Ending the session: call finishSession() first (PenOverlay's Enter-commit
//    and PenToolbar's Done already do, before emitting `commit`) — it finishes
//    or cleans up anything half-drawn so no orphan points are stored. On
//    `cancel`, the host decides: revert() puts the drawing back exactly as it
//    was when the pen was created; the overlay and toolbar never call it.
// 7. Signals: onChange fires after each SETTLED step (a committed history
//    step, undo, redo, reset, revert). onLiveChange fires for UNSETTLED doc
//    mutations mid-gesture (each solve during a drag, a point placed at the
//    start of a path or curve gesture) — use it to re-lay text or copies live.
// 8. Keys: a key the pen acts on is preventDefault-ed and stopPropagation-ed
//    (see onKeydown), so a host checking `defaultPrevented` leaves it alone.
//    PenOverlay listens on window in the bubble phase; a host listener in the
//    capture phase runs FIRST and must yield the pen's keys while it is open.
// ────────────────────────────────────────────────────────────────────────────
//
// Construction must stay side-effect free (vitest runs this in `node`): no
// onMounted/onUnmounted, no window.*, no requestAnimationFrame here. The
// sparkle loop starts lazily inside sparkle(); dispose() cancels it.
import { ref, shallowRef, computed, toRaw, type Ref } from 'vue'
import type { SketchDoc, SketchConstraint, EntityId, ConstraintKind, SegmentSpec, PathEntity } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addConstraint, removeConstraint, deleteEntity, addPath, pointClosure, isPointReferenced, addSmoothHandles } from '~/lib/sketch/edit'
import { snapPoint, snapRule, snapPreviewKind, inferCircleTangents, tangentJointArc, sweepFor, circumcenter, type SnapPreviewKind, type PointSnap } from '~/lib/sketch/infer'
import { solve, type DragTarget } from '~/lib/sketch/solve'
import { bowTangentSnap, pieceOf, tangentRuleFor, curveKey, equivalentRuleKey, type BowTangentSnap } from '~/lib/sketch/tangency'
import { dist, type Vec2 } from '~/lib/sketch/geom'
import { constraintMarks, type ConstraintMark, type ArcDimensionMark } from '~/lib/sketch/annotate'
import { applyView, type ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits, SNAP_PX, BOW_PX, MIN_RADIUS_PX } from '~/lib/sketch/tolerance'
import {
  availableConstraints as availableConstraintsFor,
  orderRefs as orderRefsFor,
  tangentRuleForSelection,
  ruleSpecFor,
  type RuleOption,
} from './penRules'
import { createPenHistory } from './penHistory'
import { handlePenKey, isCleanupKey, type PenKeyContext, NUDGE_PX, NUDGE_PX_SHIFT, screenDeltaToDrawing } from './penKeys'
import { createPenCopies, type PendingOp } from './penCopies'
import { nearestCurve, spanAt, curveGeom, paramOf, pointAt, type Span, type CurveGeom } from '~/lib/sketch/crossings'
import { removeSpan, removeSegment, cutAt, canDissolve, dissolveAt, mergePoints, sameKey } from '~/lib/sketch/trim'
import { cloneDoc } from '~/lib/sketch/clone'
import { runCleanup, STRENGTHS, type CleanupResult, type CleanupScope, type CleanupStrength, type FixKind } from '~/lib/sketch/cleanup'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { extractPieces, insertPieces, piecesCentre, hasClosedPieces } from '~/lib/sketch/clipboard'
import { selectionLabel, topLevelIds, type PieceRef } from '~/lib/sketch/pieces'
import { SIZE_REFUSED, STAY_PX, drawingDirForScreenAngle, arcEndForSweep, radiusPinOf, circleRadiusRuleOf, checkSizeEdit, stayed } from '~/lib/sketch/sizes'
import { penClipboard, setPenClipboard, nextPasteStep, PASTE_STEP_PX } from './penClipboard'
import { OK, no, REASON, type ActionState } from './penReasons'

// NUDGE_PX / NUDGE_PX_SHIFT / screenDeltaToDrawing now live in penKeys.ts
// (they exist only for the arrow-key nudge in the key handler); re-exported
// here so this module's exports are unchanged.
export { NUDGE_PX, NUDGE_PX_SHIFT, screenDeltaToDrawing }

// 'path' is the arc Pen; 'curve' is the Bézier Curve tool. Both add to the
// same pending path (see selectTool / curveDown). 'trim' removes the piece of
// a curve between crossings, 'cut' adds a point on a line or arc, 'dissolve'
// merges the two pieces at a point back into one (see the Trim section).
export type PenTool = 'select' | 'point' | 'line' | 'circle' | 'path' | 'curve' | 'trim' | 'cut' | 'dissolve'
// cleanup: Clean up (pen stage 5) is offered unless a host sets it false
export interface PenOptions { openOnly?: boolean; tools?: PenTool[]; cleanup?: boolean }

export const SPARKLE_LIFETIME_MS = 380

// status when a join would need two fixed points to meet
const BOTH_FIXED = 'Those two points are both fixed in different places'
// a text guide split in two by Trim or Delete: which piece the text follows
const DISSOLVE_REFUSED = 'These two sides don’t line up, so they can’t merge'
export const GUIDE_SPLIT_STATUS = 'The text follows the longer piece'

// Shift-constrain (Illustrator/Figma-style): rotate `pt` about `prev` to the
// nearest 45° increment, preserving the distance between them. Pure — no doc
// reads/writes. Used for path line-segment placement only (see
// pathPlacement and the host's rubber-band preview); arc-bow drags ignore it.
export function snapAngle(prev: Vec2, pt: Vec2): Vec2 {
  const d = dist(prev, pt)
  if (d < 1e-9) return pt
  const ang = Math.atan2(pt.y - prev.y, pt.x - prev.x)
  const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
  return { x: prev.x + d * Math.cos(snapped), y: prev.y + d * Math.sin(snapped) }
}

// Right-angle snap: 4° either side of square, the next path anchor lands
// exactly perpendicular to the last line segment.
export const PERP_SNAP_RAD = (4 * Math.PI) / 180

// Right-angle snap (no Shift): when the rubber band prev→pt is within `tolRad`
// of perpendicular to the segment prevPrev→prev, project `pt` onto the
// perpendicular through `prev`, keeping its signed distance along it. Pure —
// no doc reads/writes. Used by pathPlacement; `snapped` tells the caller to
// capture the matching perpendicular constraint on placement.
export function snapPerpendicular(prevPrev: Vec2, prev: Vec2, pt: Vec2, tolRad: number): { pt: Vec2; snapped: boolean } {
  const dx = prev.x - prevPrev.x, dy = prev.y - prevPrev.y
  const vx = pt.x - prev.x, vy = pt.y - prev.y
  const dl = Math.hypot(dx, dy), vl = Math.hypot(vx, vy)
  if (dl < 1e-9 || vl < 1e-9) return { pt, snapped: false }
  // |cos| of the angle between the two directions = sin of how far off square
  if (Math.abs(dx * vx + dy * vy) / (dl * vl) > Math.sin(tolRad)) return { pt, snapped: false }
  const nx = -dy / dl, ny = dx / dl
  const s = vx * nx + vy * ny
  return { pt: { x: prev.x + nx * s, y: prev.y + ny * s }, snapped: true }
}

// Free (or tangent-joint-locked) arc through/near (J, end, pointer) in world
// (doc) coordinates, via tangentJointArc (~/lib/sketch/infer). sweep/large
// follow the doc-coords SVG convention (matches pathD in sketchPath.ts):
// sweep=1 means the arc travels ccw from J through pointer to reach end.
// tangentDir null → a plain circumcircle-through-three-points free arc (the
// path's first segment, no joint to honor). tangentDir non-null → when the
// free arc's tangent at J is already close to it, the center snaps onto the
// tangent-locked arc instead (see tangentJointArc / snappedTangent). Returns
// null when no arc fits (near-collinear, or the circle would be enormous) —
// callers fall back to a straight line in that case.
// the SVG arc through J → end with this centre, on the pointer's side:
// radius, sweep (1 = ccw in drawing coords, matching pathD), large-arc flag,
// and the drawn arc's middle
export function arcShape(J: Vec2, end: Vec2, pointer: Vec2, center: Vec2): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2 } {
  const TAU = Math.PI * 2
  const r = Math.hypot(J.x - center.x, J.y - center.y)
  const sweep = sweepFor(J, end, pointer, center)
  const a0 = Math.atan2(J.y - center.y, J.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  const ccw = ((a1 - a0) % TAU + TAU) % TAU
  const span = sweep === 1 ? ccw : TAU - ccw
  const large: 0 | 1 = span > Math.PI ? 1 : 0
  const am = sweep === 1 ? a0 + span / 2 : a0 - span / 2
  return { center, r, sweep, large, mid: { x: center.x + r * Math.cos(am), y: center.y + r * Math.sin(am) } }
}

export function bowArc(J: Vec2, end: Vec2, pointer: Vec2, tangentDir: Vec2 | null): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean } | null {
  const arc = tangentJointArc(J, end, pointer, tangentDir)
  if (!arc || arc.radius > 1e4) return null
  return { ...arcShape(J, end, pointer, arc.center), snappedTangent: arc.snappedTangent }
}

// what the Pen shows and commits while bowing: bowArc, then (unless the
// joint's own tangency snapped) the tangent snap onto nearby geometry
export interface BowPreview { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean; touch: BowTangentSnap | null }

// A line leaving an arc's end E (centre C, `sweep` as stored): when the
// rubber band E→pt points forward within `tolRad` of the arc's direction of
// travel at E, `pt` is projected onto that tangent line. Pure.
export function snapArcTangent(C: Vec2, E: Vec2, sweep: 0 | 1, pt: Vec2, tolRad: number): { pt: Vec2; snapped: boolean } {
  const rx = E.x - C.x, ry = E.y - C.y
  const rl = Math.hypot(rx, ry)
  const vx = pt.x - E.x, vy = pt.y - E.y
  const vl = Math.hypot(vx, vy)
  if (rl < 1e-9 || vl < 1e-9) return { pt, snapped: false }
  const s = sweep === 1 ? 1 : -1
  const tx = (-ry / rl) * s, ty = (rx / rl) * s   // travel direction at E
  const along = vx * tx + vy * ty
  if (along <= 0) return { pt, snapped: false }
  if (Math.abs(vx * ty - vy * tx) / vl > Math.sin(tolRad)) return { pt, snapped: false }
  return { pt: { x: E.x + tx * along, y: E.y + ty * along }, snapped: true }
}

// Tangent info at the shared anchor J = pp.anchors[segIndex], derived from
// the PREVIOUS committed segment (pp.segments[segIndex - 1]) so a chain of
// bowed segments can flow smoothly through their shared joints instead of
// kinking. Null when this is the path's first segment (segIndex 0, no prior
// segment to be tangent to) — bowArc then falls back to a free arc.
export type JointInfo =
  | { tangentDir: Vec2; prevKind: 'line'; La: EntityId; Lb: EntityId }
  | { tangentDir: Vec2; prevKind: 'arc'; Cprev: EntityId }

// in-progress multi-click draws
export type Pending =
  // `own`: the start point was created by this draw (not a snap onto an
  // existing point), so finishSession may delete it if the draw is abandoned
  | { kind: 'line'; p1: EntityId; own?: boolean }
  | { kind: 'circle'; center: EntityId; cx: number; cy: number; own?: boolean }
  | null
// `ownAnchors[i]` mirrors `Pending.own` (see above) for anchors[i]: true when
// this draw CREATED that anchor (placePoint made a fresh point), false when it
// snapped onto a point that already existed before the gesture. Fix (a):
// cleanupPendingPath only ever deletes an anchor this draw owns.
export type PendingPath = { anchors: EntityId[]; segments: SegmentSpec[]; ownAnchors: boolean[] } | null
// the path tool's live down→(bow)→up gesture — plain (non-reactive) state, as
// it always was on the page; hosts read it through getPathDrag().
// `perp`: the right-angle rule this press captured on the new line segment
// (see snapPerpendicular) — dropped again if the segment bows into an arc.
export type PathDrag = { anchor: EntityId; prevAnchor: EntityId; startX: number; startY: number; bowed: boolean; perp?: EntityId | null } | null
// the Curve tool's live down→(drag)→up gesture: past the bow threshold the
// point being placed turns smooth and the pointer pulls out its handles.
export type CurveDrag = { anchor: EntityId; startX: number; startY: number; smooth: boolean } | null
const isDrawTool = (t: PenTool) => t === 'path' || t === 'curve'

// Dissolve: how close two pieces must line up to merge (spec: 1 screen px, 0.5°)
export const DISSOLVE_PX = 1
export const DISSOLVE_DEG = 0.5

/** True when two curves lie on the same line, or on the same circle. */
export function sameCarrier(g1: CurveGeom, g2: CurveGeom, eps: number): boolean {
  if (g1.kind === 'line' || g2.kind === 'line') {
    if (g1.kind !== 'line' || g2.kind !== 'line') return false
    const a = g1.a!, b = g1.b!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-12) return false
    const off = (p: Vec2) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len
    return off(g2.a!) <= eps && off(g2.b!) <= eps
  }
  return dist(g1.c!, g2.c!) <= eps && Math.abs(g1.r! - g2.r!) <= eps
}

/** Drawing-space SVG path data for one piece of a curve (a Span from
 *  crossings.ts): what the Trim tool tints on hover and leaves as a ghost.
 *  Arcs follow sketchPath's convention (sweep flag 1 = angle increasing).
 *  A circle piece with fewer than two crossings is the whole circle. */
export function spanPathD(doc: SketchDoc, span: Span): string {
  const g = curveGeom(doc, span.ref)
  if (!g) return ''
  const a = span.start.point, b = span.end.point
  if (g.kind === 'line') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
  const r = g.r!
  if (g.kind === 'circle') {
    const whole = !span.start.cutter || !span.end.cutter || span.end.t - span.start.t >= Math.PI * 2 - 1e-9
    if (whole) {
      const c = g.c!
      return `M ${c.x + r} ${c.y} A ${r} ${r} 0 1 1 ${c.x - r} ${c.y} A ${r} ${r} 0 1 1 ${c.x + r} ${c.y}`
    }
    const large = span.end.t - span.start.t > Math.PI ? 1 : 0
    return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`
  }
  const sweepAngle = g.sweepAngle! * (span.end.t - span.start.t)
  const large = Math.abs(sweepAngle) > Math.PI ? 1 : 0
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} ${sweepAngle >= 0 ? 1 : 0} ${b.x} ${b.y}`
}

export function usePen(opts: {
  doc: Ref<SketchDoc>          // a CLONE of the host's drawing (see HOST CONTRACT); the pen mutates doc.value in place and replaces it on undo/redo/reset/revert
  view: Ref<ViewMatrix>        // drawing → screen: screen-pixel tolerances, arrow-nudge steps and the screen marquee
  options?: PenOptions
  onChange?: () => void        // after every SETTLED step: committed history step, undo, redo, reset, revert
  onLiveChange?: () => void    // after every UNSETTLED doc mutation mid-gesture (drag solves, a gesture's first point)
  // the host's own live pointer gesture (the dev page's pan): Escape offers
  // it the chance to abort — return true if one was aborted (the key stops
  // there). PenOverlay's marquee is offered first, through onKeydown's
  // second argument.
  cancelGesture?: () => boolean
}) {
  const doc = opts.doc
  type Tool = PenTool

  // --- PenOptions: resolved once at construction (opts.options is read-only
  // config, not a live ref — the HOST CONTRACT already says a new pen is
  // created to change anything fixed at setup). `tools` defaults to every
  // tool; Select is always included (there is no drawing without a way back
  // to it); openOnly drops Circle even if the host listed it — an open-path
  // guide has no use for a closed shape. See PenToolbar for how `tools` gates
  // the toolbar's own buttons.
  const ALL_PEN_TOOLS: PenTool[] = ['select', 'point', 'line', 'circle', 'path', 'curve', 'trim', 'cut', 'dissolve']
  const openOnly = !!opts.options?.openOnly
  const cleanupAllowed = opts.options?.cleanup !== false
  const resolvedTools: PenTool[] = (() => {
    let list = opts.options?.tools ? opts.options.tools.filter(t => ALL_PEN_TOOLS.includes(t)) : [...ALL_PEN_TOOLS]
    if (!list.includes('select')) list = ['select', ...list]
    if (openOnly) list = list.filter(t => t !== 'circle')
    return list
  })()
  // frozen: fixed for the pen's lifetime, same as resolvedTools/openOnly above
  const options = Object.freeze({ openOnly, tools: Object.freeze(resolvedTools), cleanup: cleanupAllowed })
  function isToolAllowed(t: Tool): boolean { return resolvedTools.includes(t) }

  const tool = ref<Tool>('select')
  const status = ref('ready')
  // Guide mode: while ON, the Point/Line/Circle/Path tools place their geometry
  // as construction (dashed, full snap/constraint target, excluded from
  // Copy-SVG) — the "draw as a guide" counterpart to the existing "Make
  // construction" verb, which only toggles already-placed geometry.
  const guideMode = ref(false)
  function toggleGuideMode() { guideMode.value = !guideMode.value }
  function setGuideMode(on: boolean) { guideMode.value = on }

  // Labels toggle: while ON (default), every persistent annotation layer
  // renders — constraint badges (visibleMarks) and arc radius chips (arcDims).
  // While OFF, none of them do — a clean view of the raw drawing for a large
  // composition (e.g. a many-petal mandala) where the badges pile up and bury
  // the geometry. VIEW state only, like guideMode's viewport siblings — never
  // touches `doc` or history (see commitHistory's own contract).
  const showLabels = ref(true)
  function toggleShowLabels() { showLabels.value = !showLabels.value }
  function setShowLabels(on: boolean) { showLabels.value = on }

  // in-progress multi-click draws (Pending: see the module-level type)
  const pending = ref<Pending>(null)

  // live path pointer position, world coords — drives the in-progress draw
  // preview (previewD below); null when not hovering with the path tool.
  // `shift` carries the pointer event's shiftKey through to the preview so the
  // rubber-band segment can show the 45°-snapped position live (see previewD).
  const cursor = ref<{ x: number; y: number; shift: boolean } | null>(null)

  const selection = ref<EntityId[]>([])
  // additive=false (plain click): selection becomes exactly [id]. additive=true
  // (shift-click / shift-marquee): toggle `id` within the current selection,
  // same as the old always-toggle behavior. Entity selection and segment
  // selection (below) are mutually exclusive, with ONE exception: one point,
  // line or circle plus one Option-clicked segment stay selected together
  // (the "On curve" / "Midpoint" / Tangent pairing, penRules
  // availableConstraints) when the second pick is a Shift- or Option-click
  // (additive here; pickSegment is always an Option-click). A plain click
  // replaces everything; any other mix clears the segment selection.
  function pick(id: EntityId, additive = false) {
    if (!additive) { clearSegSel(); selection.value = [id]; return }
    const i = selection.value.indexOf(id)
    if (i >= 0) selection.value.splice(i, 1)
    else selection.value.push(id)
    const sel = selection.value
    const pairs = selectedSegments.value.length === 1 && (sel.length === 0 || (sel.length === 1 && (isPointId(sel[0]!) || isLineOrCircleId(sel[0]!))))
    if (!pairs) clearSegSel()
  }
  function clearSel() { selection.value = [] }

  // --- segment selection: individual { pathId, segIndex } picks, distinct from
  // (and mutually exclusive with) whole-entity `selection` above. additive=false
  // replaces; additive=true toggles the segment within the current set, mirroring
  // pick()'s own contract. Selecting a segment clears any live entity
  // selection, except a single point, line or circle while this leaves at most
  // one segment (the point/line/circle + segment pairing — see pick()).
  const selectedSegments = ref<{ pathId: EntityId; segIndex: number }[]>([])
  function pickSegment(pathId: EntityId, segIndex: number, additive = false) {
    if (!additive) selectedSegments.value = [{ pathId, segIndex }]
    else {
      const i = selectedSegments.value.findIndex(s => s.pathId === pathId && s.segIndex === segIndex)
      if (i >= 0) selectedSegments.value.splice(i, 1)
      else selectedSegments.value.push({ pathId, segIndex })
    }
    const sel = selection.value
    const pairs = selectedSegments.value.length <= 1 && sel.length === 1 && (isPointId(sel[0]!) || isLineOrCircleId(sel[0]!))
    if (!pairs) clearSel()
  }
  function clearSegSel() { selectedSegments.value = [] }

  // --- guided structural ops (Repeat / Mirror) ---
  // Repeat needs a CENTER point and Mirror needs an AXIS line — geometry the
  // user usually hasn't multi-selected alongside the unit. Rather than silently
  // no-op'ing when the selection isn't exactly right (the old failure the user
  // hit: "I have no idea how you're doing the repeat thing"), invoking the verb
  // arms a one-shot "now click the center / axis" mode. `pendingOp` holds the
  // units + params; the next point-click (repeat) or line-click (mirror) — or an
  // empty-canvas click, which drops a fresh fixed center — supplies the missing
  // piece and applies. Escape / tool-switch cancels it. opHint drives the banner.
  const pendingOp = ref<PendingOp>(null)
  function cancelPendingOp() { pendingOp.value = null }

  // --- inline value request: replaces the browser-native prompt dialog so
  // the pen can live inside a host (the Frame editor) that has none.
  // requestValue arms `valueRequest` (read by PenValueRow) and returns a
  // Promise the caller awaits; submitValue/cancelValue (PenValueRow's ✓/Enter
  // and Escape/Cancel, plus the four call sites below) resolve it. A second
  // requestValue while one is still pending cancels the first (resolves null)
  // — only one request is ever live.
  const valueRequest = ref<{ label: string; initial: number; min?: number } | null>(null)
  let resolveValueRequest: ((v: number | null) => void) | null = null
  function requestValue(label: string, initial: number, min?: number): Promise<number | null> {
    if (resolveValueRequest) { const prev = resolveValueRequest; resolveValueRequest = null; prev(null) }
    return new Promise<number | null>((resolve) => {
      resolveValueRequest = resolve
      valueRequest.value = { label, initial, min }
    })
  }
  function submitValue(v: number): void {
    if (!resolveValueRequest) return
    const resolve = resolveValueRequest
    resolveValueRequest = null
    valueRequest.value = null
    resolve(v)
  }
  function cancelValue(): void {
    valueRequest.value = null
    if (!resolveValueRequest) return
    const resolve = resolveValueRequest
    resolveValueRequest = null
    resolve(null)
  }
  const opHint = computed(() => {
    const op = pendingOp.value
    if (!op) return null
    if (op.kind === 'repeat') return `Click the centre of the ring — an existing point, or empty space to drop one (×${op.count})`
    return 'Click the mirror axis — a line to reflect across'
  })
  function isPointId(id: EntityId) {
    return (doc.value.entities.find(e => e.id === id) as any)?.kind === 'point'
  }
  function isLineOrCircleId(id: EntityId) {
    const k = (doc.value.entities.find(e => e.id === id) as any)?.kind
    return k === 'line' || k === 'circle'
  }

  // --- undo/redo history: see penHistory.ts. Its undo()/redo()/revert() do
  // only the doc/pointer part; the wrappers below add the pen's own
  // transient-state resets, in the same order the inline version had, before
  // firing onChange.
  const penHistory = createPenHistory({ doc, onChange: opts.onChange, onLiveChange: opts.onLiveChange })
  const { commitHistory, initHistory, canUndo, canRedo } = penHistory
  function undo() {
    // with a Clean up preview open, undo only closes it (as ⌘Z does) — it
    // never also steps back over the drawing under the preview
    if (cleanup.value) { cancelCleanup(); return }
    if (trimPress) trimUp()   // a live Trim press settles before stepping back over it
    if (arcDrag) arcDragEnd()   // so does a live arc drag
    if (!penHistory.undo()) return
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    resetEditTools()
    status.value = 'undo'
    opts.onChange?.()
  }
  function redo() {
    if (cleanup.value) { cancelCleanup(); return }   // likewise: only closes the preview
    if (trimPress) trimUp()
    if (arcDrag) arcDragEnd()
    if (!penHistory.redo()) return
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    resetEditTools()
    status.value = 'redo'
    opts.onChange?.()
  }

  // Returns true when the key did something. PenOverlay reads that for
  // Escape / Enter: with nothing to cancel or finish, the key belongs to the
  // host ('cancel' / 'commit'). The "typing in a field" guard is the
  // caller's (PenOverlay's window listener runs isTypingInField once).
  // `local.cancelGesture` is the caller's own live gesture (the overlay's
  // marquee); it is offered Escape before the host's opts.cancelGesture.
  // A key the pen acts on is the pen's: preventDefault (so a host checking
  // `defaultPrevented` — e.g. a modal that closes on Escape or deletes its
  // selection on Delete — leaves it alone) and stopPropagation. A key it does
  // not act on is left untouched.
  // Builds the context the moved-out key handler (penKeys.ts) needs, fresh on
  // every call — cheap, and avoids keeping a second copy of these refs/funcs
  // alive that could drift from the pen's own.
  function onKeydown(ev: KeyboardEvent, local?: { cancelGesture?: () => boolean }): boolean {
    // any real key mid arc drag settles it first (its own step), so no verb
    // (nudge, delete, a rule, a tool) ever snapshots the transient point
    // a Clean up preview owns the keys (cleanupKey)
    if (cleanup.value) {
      const handled = cleanupKey(ev)
      if (handled) { ev.preventDefault(); ev.stopPropagation() }
      return handled
    }
    if (arcDrag && !MODIFIER_KEYS.has(ev.key)) arcDragEnd()
    const ctx: PenKeyContext = {
      tool, pendingPath, dimBuffer, pendingOp, status, selection, selectedSegments, view: opts.view,
      cancelGesture: opts.cancelGesture,
      cancelPendingOp, undo, redo, cancelPath, commitDimension, finishPath, removeLastAnchor, del, nudge,
      selectTool, isToolAllowed, clearTrimGhosts, cleanupAllowed, toggleCleanup,
    }
    const handled = handlePenKey(ev, ctx, local)
    if (handled) { ev.preventDefault(); ev.stopPropagation() }
    return handled
  }

  // the pen holds no key-held state of its own today (Space-pan is the
  // host's viewport); kept so a host can wire all three listeners uniformly.
  function onKeyup(_ev: KeyboardEvent) {}

  function onBlur() {}

  function apply(kind: ConstraintKind, value?: number) {
    const spec = ruleSpecFor(doc.value, selection.value, selectedSegments.value, { kind, label: '' }, value)
    // two points: Coincident makes them ONE point — the second picked merges
    // into the first, which stays where it is (a `coincident` rule is only
    // ever read back from older drawings)
    if (spec && 'merge' in spec) {
      const [keep, gone] = spec.merge
      const refusal = joinRefusal(gone, keep)
      if (refusal) { status.value = refusal; return }
      clearSel()
      const pairs = segmentPairs()
      if (!mergePoints(doc.value, gone, keep)) { status.value = BOTH_FIXED; return }
      pruneSelections()
      segmentsAfterMerge(pairs, gone, keep)
      runSolve()
      const k = doc.value.entities.find(e => e.id === keep)
      if (k?.kind === 'point') sparkle(k.x, k.y)
      commitHistory()
      return
    }
    // every other rule: written from ruleSpecFor (penRules.ts) — one point +
    // one segment (On curve / Midpoint), segments, or entities
    if (spec) { const id = addConstraint(doc.value, spec.kind, spec.refs, spec.value); sparkleAtConstraint(id) }
    clearSel()
    clearSegSel()
    runSolve()
    commitHistory()
  }

  // Tangent (penRules tangentRuleForSelection): the rule for the two selected
  // pieces — the joint form where they meet, tangentLineArc / tangentArcs
  // where they don't. A rule already there that says the same (whatever order
  // its refs were written in — equivalentRuleKey) is not added twice.
  function applyTangent() {
    const rule = tangentRuleForSelection(doc.value, selection.value, selectedSegments.value)
    clearSel()
    clearSegSel()
    if (!rule) return
    const key = equivalentRuleKey(doc.value, rule)
    if (doc.value.constraints.some(c => equivalentRuleKey(doc.value, c) === key)) return   // already there — no step
    const id = addConstraint(doc.value, rule.kind, rule.refs, rule.value)
    runSolve()
    sparkleAtConstraint(id)
    commitHistory()
  }

  async function applyWithValue(v: { kind: ConstraintKind; label: string; value?: boolean; tangent?: boolean }) {
    if (v.tangent) { applyTangent(); return }
    if (!v.value) { apply(v.kind); return }
    const n = await requestValue(v.label, 3)
    if (n == null) return                    // cancelled → no constraint (Bug 3)
    if (!Number.isFinite(n)) return           // invalid → no constraint (Bug 3)
    apply(v.kind, n)
  }

  // Deletes the selected entities, and any Option-selected segments through
  // Trim's "remove a whole segment" (removeSegment). A segment is found again
  // by its two anchors (in order) before each removal: removing one re-numbers
  // the rest (an open path splits, a closed one opens and re-starts), so the
  // stored indexes go stale — highest index first per path keeps an open
  // path's earlier indexes valid, the anchor lookup covers the rest.
  function del() {
    const segs = selectedSegments.value.map(s => {
      const p = doc.value.entities.find(e => e.id === s.pathId) as any
      if (!p || p.kind !== 'path') return null
      return { pathId: s.pathId, segIndex: s.segIndex, from: p.anchors[s.segIndex] as EntityId, to: p.anchors[(s.segIndex + 1) % p.anchors.length] as EntityId }
    }).filter((s): s is NonNullable<typeof s> => !!s)
      .sort((a, b) => a.pathId === b.pathId ? b.segIndex - a.segIndex : a.pathId < b.pathId ? -1 : 1)
    const pathsBefore = doc.value.entities.filter(e => e.kind === 'path').length
    for (const s of segs) {
      const at = findSegment(s.from, s.to)
      if (at) removeSegment(doc.value, at.pathId, at.segIndex)
    }
    clearSegSel()
    for (const id of [...selection.value]) deleteEntity(doc.value, id)
    clearSel()
    runSolve()
    // a text guide split in two: say which piece the text follows
    const pathsAfter = doc.value.entities.filter(e => e.kind === 'path').length
    if (openOnly && segs.length && pathsAfter > Math.max(1, pathsBefore)) status.value = GUIDE_SPLIT_STATUS
    commitHistory()
  }
  function findSegment(from: EntityId, to: EntityId): { pathId: EntityId; segIndex: number } | null {
    for (const e of doc.value.entities) {
      if (e.kind !== 'path') continue
      const n = e.anchors.length
      const count = e.closed ? n : n - 1
      for (let i = 0; i < count; i++) {
        if (e.anchors[i] === from && e.anchors[(i + 1) % n] === to) return { pathId: e.id, segIndex: i }
      }
    }
    return null
  }

  // --- editable dimension chips: arc radius chips (arcDims, over every arc
  // segment's true midpoint) and constraint value chips (marks with a numeric
  // value — distance/radius) are both click-to-edit. Both funnel through
  // setArcRadius/setConstraintValue, which the __sketchDraw test hooks call
  // directly — so a click and a test call run the identical code path.

  // resolve an arcDims mark's "pathId:segIndex" id to the arc segment's center
  // point and start-anchor point (arcDimensionMarks keys the start anchor as
  // anchors[segIndex] — same convention followed here). Path ids never contain
  // ':' (see ids.ts), so splitting on the last colon is unambiguous even though
  // pathId itself is arbitrary text.
  function resolveArcSegment(pathId: EntityId, segIndex: number): { centerId: EntityId; startAnchorId: EntityId } | null {
    const path = doc.value.entities.find(e => e.id === pathId) as any
    if (!path || path.kind !== 'path') return null
    const seg = path.segments[segIndex]
    if (!seg || seg.kind !== 'arc') return null
    const startAnchorId = path.anchors[segIndex]
    if (!startAnchorId) return null
    return { centerId: seg.center, startAnchorId }
  }

  // an existing distance constraint pinning exactly this [center, startAnchor]
  // pair (either ref order) — found first so a second edit updates it in place
  // instead of stacking a duplicate constraint (radius = |center − startAnchor|,
  // so this pair IS the radius pin).
  function findRadiusPin(centerId: EntityId, startAnchorId: EntityId): SketchConstraint | undefined {
    return doc.value.constraints.find(c => c.kind === 'distance' &&
      ((c.refs[0] === centerId && c.refs[1] === startAnchorId) || (c.refs[0] === startAnchorId && c.refs[1] === centerId)))
  }

  // pin an arc segment's radius to an exact value: add (or update) a distance
  // constraint between its center and start anchor. Shared by the chip click
  // handler and the __sketchDraw.setArcRadius test hook.
  function setArcRadius(pathId: EntityId, segIndex: number, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return
    const resolved = resolveArcSegment(pathId, segIndex)
    if (!resolved) return
    const { centerId, startAnchorId } = resolved
    const existing = findRadiusPin(centerId, startAnchorId)
    if (existing) existing.value = value
    else addConstraint(doc.value, 'distance', [centerId, startAnchorId], value)
    runSolve()
    commitHistory()
  }

  // update a distance/radius constraint's value in place. Shared by the
  // constraint-chip click handler and the __sketchDraw.setConstraintValue test
  // hook.
  function setConstraintValue(constraintId: EntityId, value: number): void {
    if (!Number.isFinite(value) || value <= 0) return
    const c = doc.value.constraints.find(x => x.id === constraintId)
    if (!c || c.value == null) return
    c.value = value
    runSolve()
    commitHistory()
  }

  async function onArcDimClick(m: ArcDimensionMark): Promise<void> {
    const sep = m.id.lastIndexOf(':')
    if (sep < 0) return
    const pathId = m.id.slice(0, sep)
    const segIndex = Number(m.id.slice(sep + 1))
    const resolved = resolveArcSegment(pathId, segIndex)
    if (!resolved) return
    const center = doc.value.entities.find(e => e.id === resolved.centerId) as any
    const start = doc.value.entities.find(e => e.id === resolved.startAnchorId) as any
    if (!center || !start) return
    const current = dist({ x: center.x, y: center.y }, { x: start.x, y: start.y })
    const n = await requestValue('Radius', Number(current.toFixed(2)))
    if (n == null) return                     // cancelled → no change (Bug 3 pattern)
    if (!Number.isFinite(n) || n <= 0) return  // invalid → no change
    setArcRadius(pathId, segIndex, n)
  }

  // remove a constraint by id: same code path the badge click and the
  // __sketchDraw.removeConstraintById test hook both use. Allowed for ANY
  // constraint kind — including auto-derived ones like equalDist/rotatedFrom
  // (e.g. removing an arc's equalDist lets it degenerate) — undo is the
  // safety net, not a kind-based guard here.
  function removeConstraintById(id: EntityId): void {
    if (!doc.value.constraints.some(c => c.id === id)) return
    removeConstraint(doc.value, id)
    runSolve()
    commitHistory()
  }

  // Constraint-badge click (the Opacity model): a glyph-only badge (no
  // editable value — tangent/perpendicular/parallel/collinear/coincident/
  // concentric/horizontal/vertical/midpoint/equalDist/equalRadius/
  // rotatedFrom/mirroredFrom/pointOn…) removes the constraint on a plain
  // click. A value-bearing chip (distance/radius, m.text set) keeps M4's
  // plain-click-to-edit; shift+click removes it instead.
  async function onConstraintMarkClick(m: ConstraintMark, ev: MouseEvent): Promise<void> {
    if (m.text == null) { removeConstraintById(m.id); return }
    if (ev.shiftKey) { removeConstraintById(m.id); return }
    const c = doc.value.constraints.find(x => x.id === m.id)
    if (!c || c.value == null) return
    const n = await requestValue(c.kind === 'radius' ? 'Radius' : 'Distance', Number(c.value.toFixed(2)))
    if (n == null) return
    if (!Number.isFinite(n) || n <= 0) return
    setConstraintValue(m.id, n)
  }

  // arrow-key / test-hook nudge: move every selected point AND the point-closure
  // of any selected line/circle/path (pointClosure — same expansion flip()
  // already uses) by a world-space (dx, dy), then re-solve so any live
  // constraints fight back immediately, same as a select-tool drag. No-op with
  // nothing selected — worth guarding here too since __sketchDraw.nudge() is a
  // direct test entry point, not just the keydown path.
  function nudge(dx: number, dy: number) {
    if (!selection.value.length) return
    const ids = pointClosure(doc.value, selection.value)
    for (const id of ids) {
      const p = doc.value.entities.find(e => e.id === id) as any
      if (p && p.kind === 'point') { p.x += dx; p.y += dy }
    }
    runSolve()
    commitHistory()
  }

  // Solve on a plain (non-reactive) snapshot — every inner-loop read/write in the
  // solver would otherwise pay Vue proxy overhead. structuredClone can't handle
  // what toRaw hands back once any entity has gone through a delete (a stale Vue
  // proxy reference can end up embedded), so build the plain snapshot explicitly
  // instead. Only positions/radii are copied back afterward — solve never changes
  // entity/constraint structure.
  // `hold`: points treated as fixed for this solve only (the snapshot's copy
  // is marked; `fixed` is never copied back to the drawing).
  function runSolve(drag?: DragTarget, hold?: EntityId[]) {
    const held = hold && hold.length ? new Set(hold) : null
    const plain: SketchDoc = {
      entities: doc.value.entities.map(e => ({
        ...toRaw(e),
        ...(held && e.kind === 'point' && held.has(e.id) ? { fixed: true } : {}),
        ...(e.kind === 'path' ? { anchors: [...e.anchors], segments: e.segments.map(s => ({ ...toRaw(s) })) } : {}),
      })),
      constraints: doc.value.constraints.map(c => ({ ...toRaw(c), refs: [...c.refs] })),
    }
    const res = solve(plain, { maxIter: 120, drag })
    const solved = new Map(plain.entities.map(e => [e.id, e]))
    for (const e of doc.value.entities) {
      const s = solved.get(e.id)
      if (!s) continue
      if (e.kind === 'point' && s.kind === 'point') { e.x = s.x; e.y = s.y }
      else if (e.kind === 'circle' && s.kind === 'circle') { e.r = s.r }
    }
    status.value = res.converged ? `solved · ${doc.value.entities.length} ent · ${doc.value.constraints.length} con` : `NOT converged (${res.residualNorm.toFixed(2)})`
    // a drag solve is a live, unsettled change — the settle (commitHistory on
    // release) reports through onChange
    if (drag) opts.onLiveChange?.()
    return res
  }

  // --- sparkle-on-snap delight: a short-lived celebratory flourish spawned at
  // the world point where a constraint is CAPTURED while drawing (tangent-joint
  // commit, snap-on-placement, Shift H/V capture, apply-verb — see call sites
  // below). Purely visual: no doc mutation, no solve, no history entry. The
  // rAF loop starts lazily in sparkle() (never at construction) and dispose()
  // cancels it — performance.now/requestAnimationFrame never belong in lib/sketch.
  let sparkleSeq = 0
  const sparkles = ref<{ id: number; x: number; y: number; born: number }[]>([])
  // advanced by the rAF loop below — read by sparkleRender so every frame's
  // render reflects the sparkles' current age, not just the frames where one is
  // added or pruned.
  const sparkleClock = ref(0)
  let sparkleRaf = 0
  function sparkleTick() {
    sparkleClock.value = performance.now()
    sparkles.value = sparkles.value.filter(s => sparkleClock.value - s.born < SPARKLE_LIFETIME_MS)
    // keep ticking only while something is live — no idle rAF once the last one prunes
    sparkleRaf = sparkles.value.length ? requestAnimationFrame(sparkleTick) : 0
  }
  function sparkle(x: number, y: number): void {
    sparkles.value.push({ id: sparkleSeq++, x, y, born: performance.now() })
    // lazily, and only where there is a frame loop (never in a node test run)
    if (!sparkleRaf && typeof requestAnimationFrame !== 'undefined') sparkleRaf = requestAnimationFrame(sparkleTick)
  }
  function sparkleCount(): number { return sparkles.value.length }

  // sparkle at the just-added constraint's own badge anchor — reuses
  // constraintMarks' anchor resolution (annotate.ts) so the apply-verb sparkle
  // lands exactly where that constraint's badge will render, not a hand-rolled
  // duplicate of that logic.
  function sparkleAtConstraint(constraintId: EntityId): void {
    const mark = constraintMarks(doc.value).find(m => m.id === constraintId)
    if (mark) sparkle(mark.x, mark.y)
  }

  // place a point, honoring a snap: reuse the snapped point (coincident) or create
  // a new point and the rule the snap implies (snapRule: on a line, circle,
  // path segment or arc, or at a middle).
  // `construction` (guide mode) only affects a freshly-created point — a
  // coincident snap always reuses whatever the existing target point already is.
  // Every snap kind that actually captures a constraint (coincident reuse, or a
  // fresh point with its rule) sparkles at the snapped location — see
  // sparkle() above.
  // placePoint, plus whether it created a fresh point (vs. snapping onto one
  // that already existed) — the same before/after entity-count check
  // Line/Circle starts use for `Pending.own`, reused here for a path/curve
  // anchor's `ownAnchors` entry (fix a).
  function placePointOwn(x: number, y: number, exclude: EntityId[] = [], construction = false): { id: EntityId; own: boolean } {
    const before = doc.value.entities.length
    const id = placePoint(x, y, exclude, construction)
    return { id, own: doc.value.entities.length !== before }
  }

  function placePoint(x: number, y: number, exclude: EntityId[] = [], construction = false): EntityId {
    // Bézier handles are construction points that belong to their anchor —
    // never a snap target (08-29 build note)
    const handles = handleIds()
    const ex = handles.size ? [...exclude, ...handles] : exclude
    const snapped = snapPoint(doc.value, x, y, { exclude: ex, tol: pxToUnits(SNAP_PX, opts.view.value) })
    if (snapped.snap?.kind === 'coincident') { sparkle(snapped.x, snapped.y); return snapped.snap.targetId }
    const id = addPoint(doc.value, snapped.x, snapped.y, { construction })
    // on a line/circle/segment/arc or at a middle: the rule that keeps it there
    const rule = snapped.snap ? snapRule(snapped.snap, id) : null
    if (rule) { addConstraint(doc.value, rule.kind, rule.refs); sparkle(snapped.x, snapped.y) }
    return id
  }

  // the current tool's action at world (x,y) — while guideMode is on, Point/
  // Line/Circle/Path all place their geometry as construction (dashed, snap/
  // constraint-target, excluded from Copy-SVG) rather than real geometry.
  function place(x: number, y: number) {
    if (tool.value === 'point') {
      placePoint(x, y, [], guideMode.value)
      runSolve()
      commitHistory()
    } else if (tool.value === 'line') {
      if (!pending.value || pending.value.kind !== 'line') {
        const before = doc.value.entities.length
        const p1 = placePoint(x, y, [], guideMode.value)
        pending.value = { kind: 'line', p1, own: doc.value.entities.length !== before }
        commitHistory()
      } else {
        const p2 = placePoint(x, y, [pending.value.p1], guideMode.value)
        if (p2 !== pending.value.p1) addLine(doc.value, pending.value.p1, p2, { construction: guideMode.value })
        pending.value = null
        runSolve()
        commitHistory()
      }
    } else if (tool.value === 'circle') {
      if (!pending.value || pending.value.kind !== 'circle') {
        const before = doc.value.entities.length
        const center = placePoint(x, y, [], guideMode.value)
        const c = doc.value.entities.find(e => e.id === center) as any
        pending.value = { kind: 'circle', center, cx: c.x, cy: c.y, own: doc.value.entities.length !== before }
        commitHistory()
      } else {
        const r = Math.max(pxToUnits(MIN_RADIUS_PX, opts.view.value), dist({ x, y }, { x: pending.value.cx, y: pending.value.cy }))
        const cid = addCircle(doc.value, pending.value.center, r, { construction: guideMode.value })
        // auto-capture tangency to existing geometry
        for (const t of inferCircleTangents(doc.value, pending.value.cx, pending.value.cy, r, { exclude: [cid], tol: pxToUnits(SNAP_PX, opts.view.value) })) {
          addConstraint(doc.value, t.kind, t.kind === 'tangentLineCircle' ? [t.targetId, cid] : [cid, t.targetId])
        }
        pending.value = null
        runSolve()
        commitHistory()
      }
    } else if (tool.value === 'path') {
      pathClick(x, y)
    }
    // 'select' does nothing on empty-space click
  }

  // --- path tool: multi-click anchor chain, line or arc segments ---
  const pendingPath = ref<PendingPath>(null)
  // retained for API/E2E compat (setNextSegment / pathClick below) — the UI
  // toggle is gone; the real gesture is now click-and-drag-to-bow (pathDown/Move/Up)
  const nextSegment = ref<'line' | 'arc'>('line')

  // type-a-dimension (Fusion-style): while a path draw gesture is live —
  // pendingPath.value set, either mid rubber-band (next line anchor) or mid
  // arc bow (pathDrag.bowed) — digit/decimal keys routed in onKeydown
  // accumulate here instead of driving the pointer. commitDimension() (below,
  // also a __sketchDraw test hook) applies it: RADIUS for a bowing arc, LENGTH
  // for a pending line anchor. See applyArcDimension/applyLineDimension.
  const dimBuffer = ref<string>('')

  // Shift-constrain: see the module-level snapAngle.

  // World placement for a path-tool click/pointerdown: with Shift held and a
  // previous anchor to measure against, angle-snap the raw pointer position
  // (see snapAngle) before it reaches placePoint's own near-geometry snap —
  // angle-snap wins, but placePoint can still coincide with the snapped spot if
  // it happens to land on existing geometry. The path's first anchor (no prior
  // anchor yet) is never snapped — there's nothing to measure the angle from.
  // Shift placement (pathPlacement/snapAngle, above) snaps the anchor's
  // POSITION to 45° increments but on its own leaves no trace — the segment
  // un-squares the moment either anchor is dragged. When the snapped segment
  // lands exactly horizontal or vertical, capture that as a real
  // horizontal/vertical constraint on the two anchor points (the point-pair
  // form residuals.ts accepts alongside its legacy line-ref form) so the
  // solver keeps it axis-aligned across later drags. 45° diagonals get no
  // constraint — there's no residual for that angle, so they stay snap-only.
  function captureAxisConstraint(prevId: EntityId, newId: EntityId): void {
    const a = doc.value.entities.find(e => e.id === prevId) as any
    const b = doc.value.entities.find(e => e.id === newId) as any
    if (!a || a.kind !== 'point' || !b || b.kind !== 'point') return
    const dx = b.x - a.x, dy = b.y - a.y
    const kind: 'horizontal' | 'vertical' | null =
      Math.abs(dy) < 1e-6 ? 'horizontal' : Math.abs(dx) < 1e-6 ? 'vertical' : null
    if (!kind) return
    const already = doc.value.constraints.some(c => c.kind === kind &&
      ((c.refs[0] === prevId && c.refs[1] === newId) || (c.refs[0] === newId && c.refs[1] === prevId)))
    if (!already) { addConstraint(doc.value, kind, [prevId, newId]); sparkle(b.x, b.y) }
  }

  // Without Shift, the right-angle snap (snapPerpendicular) takes its place:
  // when the last pending segment is a line and the rubber band runs within
  // PERP_SNAP_RAD of square to it, the placement lands exactly perpendicular.
  // `perpendicular` reports that it fired, so pathDown/pathClick can capture
  // the rule (capturePerpendicular) and the overlay can show its ⊥ chip.
  function pathPlacement(x: number, y: number, shift: boolean): { x: number; y: number; perpendicular: boolean; tangent: boolean } {
    const pp = pendingPath.value
    if (!pp || pp.anchors.length === 0) return { x, y, perpendicular: false, tangent: false }
    const prev = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
    if (!prev || prev.kind !== 'point') return { x, y, perpendicular: false, tangent: false }
    if (shift) return { ...snapAngle({ x: prev.x, y: prev.y }, { x, y }), perpendicular: false, tangent: false }
    const lastSeg = pp.segments[pp.segments.length - 1]
    // leaving an arc's end: snap onto its tangent (snapArcTangent) — only when
    // the next segment is a line (pathDown always starts one; pathClick follows
    // nextSegment), since only a line gets the rule (captureArcTangent)
    if (lastSeg && lastSeg.kind === 'arc') {
      if (nextSegment.value === 'arc') return { x, y, perpendicular: false, tangent: false }
      const C = doc.value.entities.find(e => e.id === lastSeg.center) as any
      if (!C || C.kind !== 'point') return { x, y, perpendicular: false, tangent: false }
      const r = snapArcTangent({ x: C.x, y: C.y }, { x: prev.x, y: prev.y }, lastSeg.sweep, { x, y }, PERP_SNAP_RAD)
      return { x: r.pt.x, y: r.pt.y, perpendicular: false, tangent: r.snapped }
    }
    if (pp.anchors.length < 2 || !lastSeg || lastSeg.kind !== 'line') return { x, y, perpendicular: false, tangent: false }
    const pprev = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 2]) as any
    if (!pprev || pprev.kind !== 'point') return { x, y, perpendicular: false, tangent: false }
    const r = snapPerpendicular({ x: pprev.x, y: pprev.y }, { x: prev.x, y: prev.y }, { x, y }, PERP_SNAP_RAD)
    return { x: r.pt.x, y: r.pt.y, perpendicular: r.snapped, tangent: false }
  }

  // live read of where the next path anchor would land under the cursor
  // (Shift 45° / right-angle snap applied) — the overlay's rubber band,
  // dimension line and ⊥ chip all read this, so they agree with pathDown.
  // Null unless the path tool is hovering with a pending path.
  const placementPreview = computed(() => {
    const c = cursor.value
    const pp = pendingPath.value
    if (tool.value !== 'path' || !c || !pp || pp.anchors.length === 0) return null
    return pathPlacement(c.x, c.y, c.shift)
  })

  // The right-angle snap's counterpart to captureAxisConstraint: when the
  // placement snapped square (`perpendicular`) and the anchor really landed
  // there — a fresh point at exactly the snapped spot, not reused or pulled
  // onto existing geometry (coincident wins) — capture perpendicular
  // [prevPrev, prev, prev, new] so later drags keep the corner square.
  // Returns the constraint id it added, or null.
  function capturePerpendicular(p: { x: number; y: number; perpendicular: boolean }, id: EntityId, own: boolean): EntityId | null {
    const pp = pendingPath.value
    if (!p.perpendicular || !own || !pp || pp.anchors.length < 3) return null
    const n = pp.anchors.length
    const a = pp.anchors[n - 3]!, b = pp.anchors[n - 2]!
    if (pp.anchors[n - 1] !== id) return null
    const placed = doc.value.entities.find(e => e.id === id) as any
    const corner = doc.value.entities.find(e => e.id === b) as any
    if (!placed || placed.kind !== 'point' || !corner || corner.kind !== 'point') return null
    if (Math.abs(placed.x - p.x) > 1e-9 || Math.abs(placed.y - p.y) > 1e-9) return null
    const already = doc.value.constraints.some(c => c.kind === 'perpendicular' &&
      c.refs[0] === a && c.refs[1] === b && c.refs[2] === b && c.refs[3] === id)
    if (already) return null
    const cid = addConstraint(doc.value, 'perpendicular', [a, b, b, id])
    sparkle(corner.x, corner.y)
    return cid
  }

  // The arc counterpart of capturePerpendicular: the new anchor landed exactly
  // on the previous arc's tangent (placement `tangent`) — capture the joint
  // rule perpendicular [C, E, E, new] (radius ⊥ the new line).
  function captureArcTangent(p: { x: number; y: number; tangent: boolean }, id: EntityId, own: boolean): EntityId | null {
    const pp = pendingPath.value
    if (!p.tangent || !own || !pp || pp.anchors.length < 3) return null
    const n = pp.anchors.length
    if (pp.anchors[n - 1] !== id) return null
    const arc = pp.segments[n - 3]
    if (!arc || arc.kind !== 'arc') return null
    const joint = pp.anchors[n - 2]!
    const placed = doc.value.entities.find(e => e.id === id) as any
    const corner = doc.value.entities.find(e => e.id === joint) as any
    if (!placed || placed.kind !== 'point' || !corner || corner.kind !== 'point') return null
    if (Math.abs(placed.x - p.x) > 1e-9 || Math.abs(placed.y - p.y) > 1e-9) return null
    const refs = [arc.center, joint, joint, id]
    if (doc.value.constraints.some(c => c.kind === 'perpendicular' && c.refs.join() === refs.join())) return null
    const cid = addConstraint(doc.value, 'perpendicular', refs)
    sparkle(corner.x, corner.y)
    return cid
  }

  function pathClick(x: number, y: number, shift = false) {
    const p = pathPlacement(x, y, shift)
    const { id, own } = placePointOwn(p.x, p.y, [], guideMode.value)
    if (!pendingPath.value) { pendingPath.value = { anchors: [id], segments: [], ownAnchors: [own] }; commitHistory(); return }
    const pp = pendingPath.value
    const prev = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
    if (id === pp.anchors[0] && pp.anchors.length >= 2) {
      if (openOnly) return   // open-only: clicking the first anchor is a click on an existing anchor, not a close
      finishPath(true); return   // clicked first anchor → close (finishPath commits)
    }
    if (id === pp.anchors[pp.anchors.length - 1]) return                               // ignore double-click same point
    dropLastHOut()
    if (nextSegment.value === 'arc') {
      const cur = doc.value.entities.find(e => e.id === id) as any
      // center: midpoint pushed perpendicular by half the chord
      const mx = (prev.x + cur.x) / 2, my = (prev.y + cur.y) / 2
      const dx = cur.x - prev.x, dy = cur.y - prev.y
      const c = addPoint(doc.value, mx - dy / 2, my + dx / 2)
      pp.segments.push({ kind: 'arc', center: c, sweep: 1 })
    } else {
      pp.segments.push({ kind: 'line' })
    }
    pp.anchors.push(id)
    pp.ownAnchors.push(own)
    if (nextSegment.value === 'line' && !capturePerpendicular(p, id, own)) captureArcTangent(p, id, own)
    commitHistory()
  }

  // bowArc: see the module-level function.

  // Tangent info at the shared anchor J = pp.anchors[segIndex], derived from
  // the PREVIOUS committed segment (pp.segments[segIndex - 1]) so a chain of
  // bowed segments can flow smoothly through their shared joints instead of
  // kinking. Null when this is the path's first segment (segIndex 0, no prior
  // segment to be tangent to) — bowArc then falls back to a free arc, same as
  // before this joint-tangent wiring existed.
  function jointInfoForSegment(pp: { anchors: EntityId[]; segments: SegmentSpec[] }, segIndex: number): JointInfo | null {
    if (segIndex < 1) return null
    const prevSeg = pp.segments[segIndex - 1]
    const jId = pp.anchors[segIndex]
    const J = jId ? (doc.value.entities.find(e => e.id === jId) as any) : null
    if (!prevSeg || !J || J.kind !== 'point') return null
    if (prevSeg.kind === 'line') {
      const laId = pp.anchors[segIndex - 1]
      const La = laId ? (doc.value.entities.find(e => e.id === laId) as any) : null
      if (!laId || !La || La.kind !== 'point') return null
      return { tangentDir: { x: J.x - La.x, y: J.y - La.y }, prevKind: 'line', La: laId, Lb: jId! }
    }
    if (prevSeg.kind === 'arc') {
      const Cp = doc.value.entities.find(e => e.id === prevSeg.center) as any
      if (!Cp || Cp.kind !== 'point') return null
      return { tangentDir: { x: -(J.y - Cp.y), y: J.x - Cp.x }, prevKind: 'arc', Cprev: prevSeg.center }
    }
    return null   // prev segment is a cubic — the path tool never produces one, no joint defined
  }

  // --- path tool: the real gesture — pointerdown places an anchor (+ a line
  // segment from the previous one, as today); if the pointer moves past the
  // threshold before pointerup, that segment bows into a circular arc through
  // the live pointer (see bowArc).
  let pathDrag: PathDrag = null
  // pathDrag is a plain variable (hot path), so overlay computeds that read it
  // through getPathDrag() would never re-run on press/bow/release; every
  // write goes through setPathDrag (or bumps pathDragTick) and getPathDrag
  // reads the tick, making the drag state reactive to its readers.
  const pathDragTick = ref(0)
  // the curve the bow is snapped tangent to (curveKey), so the sparkle fires
  // once when the snap engages, not on every move
  let bowTouchKey: string | null = null
  function setPathDrag(v: PathDrag) { pathDrag = v; bowTouchKey = null; pathDragTick.value++ }

  // The arc the bowing segment would become under `pointer`: bowArc (with the
  // joint's own tangency), then — unless that snapped, or `snap: false` (a
  // typed radius) — the tangent snap onto nearby committed geometry
  // (bowTangentSnap). Reads pathDragTick so overlay computeds follow the drag.
  // bowTangentSnap scans every curve; pathMove and the overlay's two readers
  // ask for the same cursor each move, so one result is kept per drag tick and
  // inputs (the drawing does not change while a segment bows)
  let bowSnapMemo: { key: string; doc: SketchDoc; val: BowTangentSnap | null } | null = null
  function bowSnapOnce(J: Vec2, E: Vec2, free: Vec2, tol: number, skip: EntityId[]): BowTangentSnap | null {
    const d = doc.value
    const key = `${pathDragTick.value}|${d.entities.length}|${d.constraints.length}|${J.x},${J.y}|${E.x},${E.y}|${free.x},${free.y}|${tol}|${skip.join(',')}`
    if (bowSnapMemo && bowSnapMemo.key === key && bowSnapMemo.doc === d) return bowSnapMemo.val
    const val = bowTangentSnap(d, J, E, free, tol, skip)
    bowSnapMemo = { key, doc: d, val }
    return val
  }
  function bowPreview(pointer: Vec2 | null, o: { snap?: boolean } = {}): BowPreview | null {
    void pathDragTick.value
    if (!pointer || !pathDrag || !pathDrag.bowed) return null
    const pp = pendingPath.value
    if (!pp) return null
    const p0 = doc.value.entities.find(e => e.id === pathDrag!.prevAnchor) as any
    const p1 = doc.value.entities.find(e => e.id === pathDrag!.anchor) as any
    if (!p0 || p0.kind !== 'point' || !p1 || p1.kind !== 'point') return null
    const J = { x: p0.x, y: p0.y }, E = { x: p1.x, y: p1.y }
    const joint = jointInfoForSegment(pp, pp.segments.length - 1)
    const arc = bowArc(J, E, pointer, joint?.tangentDir ?? null)
    if (!arc) return null
    if (arc.snappedTangent || o.snap === false) return { ...arc, touch: null }
    const touch = bowSnapOnce(J, E, arc.center, pxToUnits(SNAP_PX, opts.view.value), [pathDrag.prevAnchor, pathDrag.anchor])
    if (!touch) return { ...arc, touch: null }
    return { ...arcShape(J, E, pointer, touch.center), snappedTangent: false, touch }
  }

  function pathDown(x: number, y: number, shift = false) {
    const p = pathPlacement(x, y, shift)
    const { id, own } = placePointOwn(p.x, p.y, [], guideMode.value)
    if (!pendingPath.value) {
      pendingPath.value = { anchors: [id], segments: [], ownAnchors: [own] }
      setPathDrag(null)
      commitHistory()   // first anchor of a fresh path — a complete, standalone placement
      return
    }
    const pp = pendingPath.value
    if (id === pp.anchors[0] && pp.anchors.length >= 2) {
      if (openOnly) { setPathDrag(null); return }   // open-only: clicking the first anchor is a click on an existing anchor, not a close
      finishPath(true); setPathDrag(null); return   // clicked first anchor → close (finishPath commits)
    }
    if (id === pp.anchors[pp.anchors.length - 1]) { setPathDrag(null); return }                            // ignore double-click same point
    const prevAnchor = pp.anchors[pp.anchors.length - 1]!
    dropLastHOut()   // a line/arc segment has no use for a Curve point's out-handle
    pp.segments.push({ kind: 'line' })
    pp.anchors.push(id)
    pp.ownAnchors.push(own)
    if (shift) captureAxisConstraint(prevAnchor, id)
    const perp = capturePerpendicular(p, id, own) ?? captureArcTangent(p, id, own)
    // don't commit here — this anchor+segment (and any shift-captured axis or
    // right-angle constraint) settle as ONE history entry together with
    // whatever pathUp does next (a plain click, or bowing the segment into an arc)
    setPathDrag({ anchor: id, prevAnchor, startX: x, startY: y, bowed: false, perp })
    opts.onLiveChange?.()
  }

  function pathMove(x: number, y: number, shift = false) {
    // reactive — drives previewD/pathBowChip live, whether this came from a
    // real pointermove or a direct __sketchDraw.pathMove() call (tests)
    cursor.value = { x, y, shift }
    if (!pathDrag) return
    if (dist({ x, y }, { x: pathDrag.startX, y: pathDrag.startY }) > pxToUnits(BOW_PX, opts.view.value) && !pathDrag.bowed) { pathDrag.bowed = true; pathDragTick.value++ }
    if (pathDrag.bowed) {
      const pv = bowPreview({ x, y }, { snap: !dimBuffer.value })   // a typed radius wins over the snap (and its sparkle)
      const key = pv?.touch ? curveKey(pv.touch.target) : null
      if (key && key !== bowTouchKey) sparkle(pv!.touch!.touch.x, pv!.touch!.touch.y)
      bowTouchKey = key
    }
  }

  // Commits the currently-bowing segment (pathDrag.bowed) into an arc through
  // `pointer` — the "place the arc as usual" step shared by a normal pathUp
  // release and a typed-radius commit (applyArcDimension below), so the two
  // can't drift apart. Returns the new center point id, or null if bowArc
  // couldn't fit (near-collinear / enormous radius) or nothing is bowing —
  // callers treat null as "segment stayed a plain line, nothing to pin".
  function commitBowedSegment(pointer: Vec2, snap = true): EntityId | null {
    if (!pathDrag || !pathDrag.bowed) return null
    const { anchor, prevAnchor } = pathDrag
    const pp = pendingPath.value
    if (!pp) return null
    const segIndex = pp.segments.length - 1
    const seg = pp.segments[segIndex]
    const p0 = doc.value.entities.find(e => e.id === prevAnchor) as any
    const p1 = doc.value.entities.find(e => e.id === anchor) as any
    if (!seg || seg.kind !== 'line' || !p0 || !p1) return null
    const joint = jointInfoForSegment(pp, segIndex)
    const pv = bowPreview(pointer, { snap })
    if (!pv) return null
    const c = addPoint(doc.value, pv.center.x, pv.center.y)
    pp.segments[segIndex] = { kind: 'arc', center: c, sweep: pv.sweep }
    // the right-angle (or arc-tangent) rule this press captured was for a
    // straight segment — gone now it is an arc
    if (pathDrag.perp) removeConstraint(doc.value, pathDrag.perp)
    // tangent-continuous with the previous segment: wire the joint constraint
    // so the solver keeps the flow smooth after later drags (see brief §joint)
    if (pv.snappedTangent && joint) {
      if (joint.prevKind === 'arc') addConstraint(doc.value, 'collinear', [joint.Cprev, prevAnchor, c])
      else addConstraint(doc.value, 'perpendicular', [joint.La, joint.Lb, prevAnchor, c])
      sparkle(p0.x, p0.y)   // joint anchor J
    } else if (pv.touch) {
      // snapped tangent onto nearby geometry: the rule that keeps it touching
      const target = pieceOf(doc.value, pv.touch.target)
      const rule = target ? tangentRuleFor(doc.value, { kind: 'arc', c, s: prevAnchor, e: anchor }, target) : null
      if (rule) { addConstraint(doc.value, rule.kind, rule.refs, rule.value); sparkle(pv.touch.touch.x, pv.touch.touch.y) }
    }
    return c
  }

  function pathUp(x: number, y: number) {
    if (!pathDrag) return
    commitBowedSegment({ x, y }, !dimBuffer.value)   // a radius being typed: no unannounced tangent rule
    setPathDrag(null)
    // the pointer is here now: re-seat the cursor so anything reading the
    // (non-reactive) drag state — the overlay's cursor glow — settles too
    if (cursor.value) cursor.value = { ...cursor.value, x, y }
    runSolve()
    commitHistory()   // one entry for the whole down→(bow)→up gesture
  }

  // --- type-a-dimension apply: RADIUS for a bowing arc, LENGTH for a pending
  // line anchor. Both reuse findRadiusPin (above, despite the arc-flavored
  // name — it just looks up an existing distance constraint between two point
  // ids) to update an existing pin in place rather than stacking a duplicate,
  // same as the M4 editable-chip path.

  // arc branch: place the arc exactly as pathUp would (commitBowedSegment,
  // through the live cursor position), then pin distance[center, startAnchor]
  // (prevAnchor — the arc segment's start, same pair resolveArcSegment/
  // setArcRadius use) to the typed radius and solve.
  function applyArcDimension(value: number): void {
    if (!pathDrag || !pathDrag.bowed || !cursor.value) return
    const prevAnchor = pathDrag.prevAnchor
    const c = commitBowedSegment(cursor.value, false)   // a typed radius wins over the tangent snap
    setPathDrag(null)
    if (!c) return   // bowArc couldn't fit — segment stayed a line, nothing to pin
    const existing = findRadiusPin(c, prevAnchor)
    if (existing) existing.value = value
    else addConstraint(doc.value, 'distance', [c, prevAnchor], value)
    runSolve()
    commitHistory()
  }

  // line branch: place a new anchor `value` world-units from the previous
  // anchor along the current cursor direction, add the line segment, then pin
  // distance[prevAnchor, newAnchor] to the typed length and solve.
  function applyLineDimension(value: number): void {
    const pp = pendingPath.value
    if (!pp || !cursor.value) return
    const prevId = pp.anchors[pp.anchors.length - 1]!
    const prev = doc.value.entities.find(e => e.id === prevId) as any
    if (!prev || prev.kind !== 'point') return
    // aim along where the point would land (Shift 45° / right-angle snap), so
    // the typed length follows the same direction the dimension line shows
    const aim = pathPlacement(cursor.value.x, cursor.value.y, cursor.value.shift)
    const dx = aim.x - prev.x, dy = aim.y - prev.y
    const d = Math.hypot(dx, dy)
    const dir = d > 1e-9 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }   // cursor sitting on the anchor: fall back to +x
    const target = { x: prev.x + dir.x * value, y: prev.y + dir.y * value }
    const { id, own } = placePointOwn(target.x, target.y, [prevId], guideMode.value)
    pp.segments.push({ kind: 'line' })
    pp.anchors.push(id)
    pp.ownAnchors.push(own)
    // aimed along the previous arc's tangent: keep it there (the rule the
    // overlay's T chip promised). The right-angle snap has no such capture here.
    captureArcTangent({ ...target, tangent: d > 1e-9 && aim.tangent }, id, own)
    const existing = findRadiusPin(prevId, id)
    if (existing) existing.value = value
    else addConstraint(doc.value, 'distance', [prevId, id], value)
    runSolve()
    commitHistory()
  }

  // Enter (onKeydown) and the __sketchDraw.commitDimension test hook both land
  // here: dispatch to the arc or line branch by which gesture is actually
  // live, then clear the buffer either way.
  function commitDimension(): void {
    const raw = dimBuffer.value
    dimBuffer.value = ''
    const value = Number(raw)
    if (!raw || !Number.isFinite(value) || value <= 0) return
    if (pathDrag && pathDrag.bowed) applyArcDimension(value)
    else if (pendingPath.value) applyLineDimension(value)
  }

  // closing segment between last and first anchors — the Pen closes with a
  // line; the Curve tool closes with a cubic that carries the last point's
  // out-handle and the first point's in-handle (so a smooth first point stays
  // smooth instead of landing as a cusp).
  function closingSegment(): SegmentSpec {
    if (tool.value === 'curve') {
      const seg: SegmentSpec = { kind: 'cubic', h1: lastHOut, h2: firstHIn }
      lastHOut = null; firstHIn = null   // consumed by the path now
      return seg
    }
    return { kind: 'line' }
  }

  function finishPath(close = false) {
    if (openOnly) close = false   // open-only: a "close" request finishes the path open instead
    const pp = pendingPath.value
    pendingPath.value = null
    dimBuffer.value = ''
    curveDrag.value = null
    if (!pp || pp.anchors.length < 2) {
      // a lone point finished: its handles mean nothing — drop them as their
      // own history step, or undo/redo would bring them back as plain points
      const before = doc.value.entities.length
      dropUnusedHandles()
      if (doc.value.entities.length !== before) commitHistory()
      return
    }
    if (close) {
      // closing segment of the current kind between last and first anchors
      if (tool.value !== 'curve' && nextSegment.value === 'arc') {
        const a = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
        const b = doc.value.entities.find(e => e.id === pp.anchors[0]) as any
        const c = addPoint(doc.value, (a.x + b.x) / 2 - (b.y - a.y) / 2, (a.y + b.y) / 2 + (b.x - a.x) / 2)
        pp.segments.push({ kind: 'arc', center: c, sweep: 1 })
      } else pp.segments.push(closingSegment())
    }
    addPath(doc.value, pp.anchors, pp.segments, close, { construction: guideMode.value })
    dropUnusedHandles()   // an open end's out-handle / a first in-handle the path never used
    runSolve()
    commitHistory()
  }

  // --- curve tool (Bézier): click places a sharp point; click-and-drag places
  // a smooth point and pulls out its handles (the opposite one mirrors, held
  // by a collinear rule — addSmoothHandles). Each new segment's kind is the
  // tool active when its END point is placed, so Pen and Curve build one path.
  // a shallowRef (replaced, never mutated) so the overlay's live preview and
  // drag handles re-render the moment a drag turns smooth
  const curveDrag = shallowRef<CurveDrag>(null)
  // the previous smooth point's out-handle — the next cubic's h1. Cleared on
  // every sharp point, or the next segment inherits a stale handle.
  let lastHOut: EntityId | null = null
  // the first point's in-handle, if it was drawn smooth — the closing cubic's h2
  let firstHIn: EntityId | null = null

  function resetCurveState() { curveDrag.value = null; lastHOut = null; firstHIn = null }

  // a handle point nothing uses any more: delete it (its collinear rule goes
  // with it). Never touches a point a line/circle/path still references.
  function dropHandle(id: EntityId | null) {
    if (!id) return
    const p = doc.value.entities.find(e => e.id === id) as any
    if (p && p.kind === 'point' && !isPointReferenced(doc.value, id)) deleteEntity(doc.value, id)
  }
  function dropLastHOut() { dropHandle(lastHOut); lastHOut = null }
  function dropUnusedHandles() { dropHandle(lastHOut); dropHandle(firstHIn); lastHOut = null; firstHIn = null }

  // every Bézier handle id in play: committed paths' cubic handles, the
  // pending path's, and the two held between clicks
  function handleIds(): Set<EntityId> {
    const out = new Set<EntityId>()
    const add = (segs: SegmentSpec[]) => {
      for (const s of segs) if (s.kind === 'cubic') { if (s.h1) out.add(s.h1); if (s.h2) out.add(s.h2) }
    }
    for (const e of doc.value.entities) if (e.kind === 'path') add(e.segments)
    if (pendingPath.value) add(pendingPath.value.segments)
    if (lastHOut) out.add(lastHOut)
    if (firstHIn) out.add(firstHIn)
    return out
  }

  function curveDown(x: number, y: number) {
    const { id, own } = placePointOwn(x, y, [], guideMode.value)
    if (!pendingPath.value) {
      pendingPath.value = { anchors: [id], segments: [], ownAnchors: [own] }
      lastHOut = null
      firstHIn = null
      // no commit yet: the first point (and its handles, if dragged) settle as
      // one history entry in curveUp
      curveDrag.value = { anchor: id, startX: x, startY: y, smooth: false }
      opts.onLiveChange?.()
      return
    }
    const pp = pendingPath.value
    if (id === pp.anchors[0] && pp.anchors.length >= 2) {
      if (openOnly) { curveDrag.value = null; return }   // open-only: clicking the first point is a click on an existing point, not a close
      finishPath(true); curveDrag.value = null; return   // clicked first point → close (finishPath commits)
    }
    if (id === pp.anchors[pp.anchors.length - 1]) { curveDrag.value = null; return }                            // ignore double-click same point
    pp.segments.push({ kind: 'cubic', h1: lastHOut, h2: null })
    pp.anchors.push(id)
    pp.ownAnchors.push(own)
    curveDrag.value = { anchor: id, startX: x, startY: y, smooth: false }
    opts.onLiveChange?.()
  }

  function curveMove(x: number, y: number) {
    // reactive — drives the overlay's live preview and drag handles
    cursor.value = { x, y, shift: false }
    if (!curveDrag.value) return
    if (!curveDrag.value.smooth && dist({ x, y }, { x: curveDrag.value.startX, y: curveDrag.value.startY }) > pxToUnits(BOW_PX, opts.view.value)) curveDrag.value = { ...curveDrag.value, smooth: true }
  }

  function curveUp(x: number, y: number) {
    if (!curveDrag.value) return
    const { anchor, smooth } = curveDrag.value
    curveDrag.value = null
    const pp = pendingPath.value
    if (smooth) {
      const { hOut, hIn } = addSmoothHandles(doc.value, anchor, x, y)
      if (pp && pp.segments.length > 0) {
        const segIn = pp.segments[pp.segments.length - 1]
        if (segIn && segIn.kind === 'cubic') segIn.h2 = hIn
      }
      if (pp && pp.anchors[0] === anchor) firstHIn = hIn   // this point IS the path's first point
      lastHOut = hOut
    } else {
      // sharp point — no out-handle; must NOT carry the previous smooth point's
      lastHOut = null
    }
    runSolve()
    commitHistory()   // one entry for the whole down→(drag)→up gesture
  }
  function getCurveDrag(): CurveDrag { return curveDrag.value }
  // the handles held between clicks (not yet in any segment) — for the overlay's arms
  function getHeldHandles(): { lastHOut: EntityId | null; firstHIn: EntityId | null } { return { lastHOut, firstHIn } }

  // Where a drawing tool's next point would snap onto existing geometry under
  // the hovering cursor — the same snapPoint call placePoint makes (handles
  // excluded; a Line's second click also excludes its start), on the path
  // tool's placement point. Read-only: never touches the doc. Null when
  // nothing is in reach, mid-gesture, or for a Circle's radius click (which
  // places no point).
  // `kind` is what the overlay's preview chip shows (point / midpoint / curve).
  const hoverSnap = computed<{ x: number; y: number; kind: SnapPreviewKind } | null>(() => {
    const c = cursor.value
    const t = tool.value
    // Select: the join a point drag would make on release (dropSnap below)
    if (t === 'select') { const d = dropSnap.value; return d ? { x: d.x, y: d.y, kind: snapPreviewKind(d) } : null }
    // otherwise only the tools that place points (never Trim, Cut or Dissolve)
    if (!c || t === 'trim' || t === 'cut' || t === 'dissolve') return null
    if (t === 'circle' && pending.value?.kind === 'circle') return null
    const base = t === 'path' ? (placementPreview.value ?? c) : c
    const ex = [...handleIds()]
    if (t === 'line' && pending.value?.kind === 'line') ex.push(pending.value.p1)
    const snapped = snapPoint(doc.value, base.x, base.y, { exclude: ex, tol: pxToUnits(SNAP_PX, opts.view.value) })
    return snapped.snap ? { x: snapped.x, y: snapped.y, kind: snapPreviewKind(snapped.snap) } : null
  })

  // --- Select: drag a point onto something to join it ---
  // While ONE point is dragged (the overlay's point drag), dragPoint moves it
  // and looks for what it would join under the pointer: another point (they
  // merge on release) or a line, circle, path segment or middle (it is pinned
  // there with that curve's rule). The join shows as hoverSnap's chip and the
  // point sits on the snapped spot while it is in reach. dropPoint settles
  // the whole drag — the join included — as ONE history entry. `noJoin`
  // (⌘ / Ctrl held) moves without snapping or joining.
  // Never a target: the dragged point, any Bézier handle (and a handle is
  // never dragged onto anything), a point it can't join without collapsing a
  // piece (collapseNeighbours), and the pieces built on it (skipCurvesUsing).
  const dropSnap = shallowRef<PointSnap | null>(null)
  let dragPointer: Vec2 | null = null   // the raw pointer, while dropSnap pulls the point off it
  // points `id` can't be joined with without collapsing a piece: the other end
  // of a line or path segment it is on, an arc's centre and its ends. One
  // exception: the two ends of an open path of ONE near-full arc (sweep over
  // 180°) may meet — the arc closes into a circle (mergePoints). A smaller
  // arc's ends would collapse it like any piece. In a text guide (openOnly) the other
  // end of its own open path is off too: a guide never closes.
  function collapseNeighbours(id: EntityId): Set<EntityId> {
    const out = new Set<EntityId>()
    for (const e of doc.value.entities) {
      if (e.kind === 'line') {
        if (e.p1 === id) out.add(e.p2)
        if (e.p2 === id) out.add(e.p1)
      } else if (e.kind === 'path') {
        const n = e.anchors.length
        const oneArc = !e.closed && n === 2 && e.segments.length === 1 && e.segments[0]!.kind === 'arc'
          && Math.abs(curveGeom(doc.value, { kind: 'seg', pathId: e.id, segIndex: 0 })?.sweepAngle ?? 0) > Math.PI
        e.segments.forEach((seg, i) => {
          const a = e.anchors[i], b = e.anchors[(i + 1) % n]
          if (!a || !b) return
          if (!oneArc || openOnly) {
            if (a === id) out.add(b)
            if (b === id) out.add(a)
          }
          if (seg.kind === 'arc') {
            if (a === id || b === id) out.add(seg.center)
            if (seg.center === id) { out.add(a); out.add(b) }
          }
        })
        if (openOnly && !e.closed && n >= 2) {
          const first = e.anchors[0]!, last = e.anchors[n - 1]!
          if (first === id) out.add(last)
          if (last === id) out.add(first)
        }
      }
    }
    if (openOnly) for (const q of closingEnds(id)) out.add(q)
    return out
  }
  // In a text guide: the ends of OTHER open paths that `id` would close the
  // guide with. `id` is an end of open path P whose other end O is also an end
  // of open path Q; joining `id` to Q's far end would weld P and Q into a loop
  // (mergePoints joins two open paths meeting end to end).
  function closingEnds(id: EntityId): EntityId[] {
    const out: EntityId[] = []
    const open = doc.value.entities.filter((e): e is PathEntity => e.kind === 'path' && !e.closed && e.anchors.length >= 2)
    const farEnd = (e: PathEntity, x: EntityId) => {
      const n = e.anchors.length
      return e.anchors[0] === x ? e.anchors[n - 1]! : e.anchors[n - 1] === x ? e.anchors[0]! : null
    }
    for (const p of open) {
      const o = farEnd(p, id)
      if (!o || o === id) continue
      for (const q of open) {
        if (q === p) continue
        const f = farEnd(q, o)
        if (f && f !== o) out.push(f)
      }
    }
    return out
  }
  // why `gone` can't be merged into `keep` (null when it can) — shared by the
  // drag's targets and the Coincident verb
  function joinRefusal(gone: EntityId, keep: EntityId): string | null {
    const handles = handleIds()
    if (handles.has(gone) || handles.has(keep)) return 'A curve handle can’t be joined to a point'
    if (openOnly && collapseNeighbours(gone).has(keep) && isGuideEnds(gone, keep)) return 'A text guide stays open'
    if (collapseNeighbours(gone).has(keep)) return 'That would collapse the piece'
    return null
  }
  function isGuideEnds(a: EntityId, b: EntityId): boolean {
    return doc.value.entities.some(e => e.kind === 'path' && !e.closed && e.anchors.length >= 2
      && ((e.anchors[0] === a && e.anchors[e.anchors.length - 1] === b) || (e.anchors[0] === b && e.anchors[e.anchors.length - 1] === a)))
      || closingEnds(a).includes(b)
  }
  // drop selection entries a merge left pointing at nothing (a path that
  // became a circle, a segment index past a shortened path's end)
  // Selected segments by their two anchors, captured before a merge. A merge
  // can join two paths (mergePoints → joinOpenEnds), which may reverse the
  // path that keeps its id, so a {pathId, segIndex} no longer names the same
  // piece; segmentsAfterMerge finds each piece again by its anchors (`from`
  // now reads as `into`), either way round, dropping any that are gone.
  function segmentPairs(): [EntityId, EntityId][] {
    const ents = new Map(doc.value.entities.map(e => [e.id, e]))
    const out: [EntityId, EntityId][] = []
    for (const sg of selectedSegments.value) {
      const p = ents.get(sg.pathId)
      if (!p || p.kind !== 'path') continue
      const n = p.anchors.length
      if (sg.segIndex >= (p.closed ? n : n - 1)) continue
      out.push([p.anchors[sg.segIndex]!, p.anchors[(sg.segIndex + 1) % n]!])
    }
    return out
  }
  function segmentsAfterMerge(pairs: [EntityId, EntityId][], from: EntityId, into: EntityId): void {
    const sw = (id: EntityId) => (id === from ? into : id)
    const out: { pathId: EntityId; segIndex: number }[] = []
    for (const [a0, b0] of pairs) {
      const a = sw(a0), b = sw(b0)
      if (a === b) continue
      const hit = findSegment(a, b) ?? findSegment(b, a)
      if (hit && !out.some(o => o.pathId === hit.pathId && o.segIndex === hit.segIndex)) out.push(hit)
    }
    selectedSegments.value = out
  }
  function pruneSelections(): void {
    const ents = new Map(doc.value.entities.map(e => [e.id, e]))
    selection.value = selection.value.filter(id => ents.has(id))
    selectedSegments.value = selectedSegments.value.filter(sg => {
      const p = ents.get(sg.pathId)
      if (!p || p.kind !== 'path') return false
      return sg.segIndex < (p.closed ? p.anchors.length : p.anchors.length - 1)
    })
  }
  function dragPoint(id: EntityId, x: number, y: number, noJoin = false): void {
    dragPointer = { x, y }
    const handles = handleIds()
    const snap = noJoin || handles.has(id) ? null : snapPoint(doc.value, x, y, {
      exclude: [id, ...handles, ...collapseNeighbours(id)], skipCurvesUsing: [id], tol: pxToUnits(SNAP_PX, opts.view.value),
    }).snap
    dropSnap.value = snap
    runSolve({ point: id, x: snap ? snap.x : x, y: snap ? snap.y : y })
  }
  function dropPoint(id: EntityId, noJoin = false): void {
    const pulled = dropSnap.value
    const snap = noJoin ? null : pulled
    const pointer = dragPointer
    dropSnap.value = null
    dragPointer = null
    let joined = false
    if (snap?.kind === 'coincident') {
      const pairs = segmentPairs()
      if (mergePoints(doc.value, id, snap.targetId)) {
        joined = true
        pruneSelections()
        segmentsAfterMerge(pairs, id, snap.targetId)
        runSolve()
        const t = doc.value.entities.find(e => e.id === snap.targetId)
        if (t?.kind === 'point') sparkle(t.x, t.y)
      }
    } else if (snap) {
      const p = doc.value.entities.find(e => e.id === id)
      const rule = snapRule(snap, id)
      if (p?.kind === 'point' && rule) {
        joined = true
        p.x = snap.x; p.y = snap.y
        // already pinned there by the very same rule: don't add a second copy
        const key = sameKey({ id: '', kind: rule.kind, refs: rule.refs })
        if (!doc.value.constraints.some(c => sameKey(c) === key)) addConstraint(doc.value, rule.kind, rule.refs)
        runSolve()
        sparkle(p.x, p.y)
      }
    }
    // no join: the point goes back under the pointer, off the snapped spot
    if (!joined && pulled && pointer && doc.value.entities.some(e => e.id === id)) runSolve({ point: id, x: pointer.x, y: pointer.y })
    if (!joined && snap?.kind === 'coincident') status.value = BOTH_FIXED
    commitHistory()
  }
  function cancelPointDrop(): void { dropSnap.value = null }

  // --- Select: drag an arc's bow (or, with ⌘, its centre) ---
  const MODIFIER_KEYS = new Set(['Shift', 'Meta', 'Control', 'Alt'])
  // A press on an arc segment that moves (PenOverlay) starts arcDragStart. Bow
  // mode adds a transient guide point on the arc at the grab spot, pinned on
  // it (equalDist [C, T, C, S]); each move solves with that point held at the
  // pointer and the arc's ends held too — or, if that can't converge (a rule
  // needs an end to move), with the ends free. Centre mode (⌘) moves the
  // centre point by the pointer's movement. arcDragEnd removes the transient
  // point and settles ONE history step (none when nothing moved). Plain
  // state, like pathDrag: every write goes through setArcDrag or bumps
  // pathDragTick, so arcDragTransient() stays reactive for the overlay.
  type ArcDrag = {
    pathId: EntityId; segIndex: number; centre: EntityId; ends: [EntityId, EntityId]
    transient: EntityId | null; from: Vec2; centreFrom: Vec2; moved: boolean
  } | null
  let arcDrag: ArcDrag = null
  function setArcDrag(v: ArcDrag) { arcDrag = v; pathDragTick.value++ }
  function arcDragTransient(): EntityId | null { void pathDragTick.value; return arcDrag?.transient ?? null }
  /** The drawing as a host should show it mid-gesture: without an arc drag's
   *  transient guide point and its pin (they exist only while the bow is held). */
  function liveDoc(): SketchDoc {
    const t = arcDrag?.transient
    if (!t) return doc.value
    return { ...doc.value, entities: doc.value.entities.filter(e => e.id !== t), constraints: doc.value.constraints.filter(c => !c.refs.includes(t)) }
  }

  function arcDragStart(pathId: EntityId, segIndex: number, x: number, y: number, centre = false): boolean {
    if (arcDrag) arcDragEnd()
    const path = doc.value.entities.find(e => e.id === pathId)
    if (!path || path.kind !== 'path') return false
    const seg = path.segments[segIndex]
    if (!seg || seg.kind !== 'arc') return false
    const g = curveGeom(doc.value, { kind: 'seg', pathId, segIndex })
    const c = doc.value.entities.find(e => e.id === seg.center)
    if (!g || g.kind !== 'arc' || !c || c.kind !== 'point') return false
    const a = path.anchors[segIndex]!, b = path.anchors[(segIndex + 1) % path.anchors.length]!
    let transient: EntityId | null = null
    if (!centre) {
      const on = pointAt(g, paramOf(g, { x, y }))
      transient = addPoint(doc.value, on.x, on.y, { construction: true })
      addConstraint(doc.value, 'equalDist', [seg.center, transient, seg.center, a])
    }
    setArcDrag({ pathId, segIndex, centre: seg.center, ends: [a, b], transient, from: { x, y }, centreFrom: { x: c.x, y: c.y }, moved: false })
    return true
  }

  // the transient point left the drawn arc (the pointer crossed the chord):
  // flip the segment so the drawn arc runs under it again. Only called after
  // a converged solve (a failed one leaves T wherever it was). True if flipped.
  function keepTransientOnArc(d: NonNullable<ArcDrag>): boolean {
    const t = doc.value.entities.find(e => e.id === d.transient)
    const g = curveGeom(doc.value, { kind: 'seg', pathId: d.pathId, segIndex: d.segIndex })
    if (!t || t.kind !== 'point' || !g || g.kind !== 'arc') return false
    const on = pointAt(g, paramOf(g, t))
    if (dist(on, t) <= 1e-6 * Math.max(1, g.r!)) return false
    const path = doc.value.entities.find(e => e.id === d.pathId) as PathEntity
    const seg = path.segments[d.segIndex]!
    if (seg.kind !== 'arc') return false
    path.segments[d.segIndex] = { ...seg, sweep: seg.sweep === 1 ? 0 : 1 }
    return true
  }

  function arcDragMove(x: number, y: number): void {
    const d = arcDrag
    if (!d) return
    if (!d.transient) {
      d.moved = true
      runSolve({ point: d.centre, x: d.centreFrom.x + (x - d.from.x), y: d.centreFrom.y + (y - d.from.y) })
    } else {
      // warm start: the centre of the circle through both ends and the
      // pointer — exactly the answer when nothing else ties the arc, and the
      // only way across the chord (Gauss-Newton can't walk through the
      // infinite radius in between)
      const pa = doc.value.entities.find(e => e.id === d.ends[0])
      const pb = doc.value.entities.find(e => e.id === d.ends[1])
      const pc = doc.value.entities.find(e => e.id === d.centre)
      if (!pa || pa.kind !== 'point' || !pb || pb.kind !== 'point' || !pc || pc.kind !== 'point') return
      const cc = circumcenter({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }, { x, y })
      if (!cc || Math.hypot(cc.x - pa.x, cc.y - pa.y) > 1e4) return   // pointer on the chord line: no circle through it yet
      d.moved = true
      // a fixed centre is never warm-started (the solver may not move it)
      const was = { x: pc.x, y: pc.y }
      if (!pc.fixed) { pc.x = cc.x; pc.y = cc.y }
      let res = runSolve({ point: d.transient, x, y }, d.ends)
      if (!res.converged) res = runSolve({ point: d.transient, x, y })
      if (!res.converged) { pc.x = was.x; pc.y = was.y }   // no answer: the arc stays as it was
      else if (keepTransientOnArc(d)) opts.onLiveChange?.()   // the live layer sees the flipped sweep
    }
    pathDragTick.value++
  }

  function arcDragEnd(): void {
    const d = arcDrag
    if (!d) return
    setArcDrag(null)
    if (d.transient && doc.value.entities.some(e => e.id === d.transient)) deleteEntity(doc.value, d.transient)
    if (d.moved) { runSolve(); commitHistory() }
  }

  // --- Trim / Cut / Dissolve (lib/sketch/crossings.ts + trim.ts) ---
  // Trim: hovering tints the piece of a curve between crossings under the
  // pointer (trimHover); a press removes it, and while the button is held
  // every move removes the piece under the pointer too. The whole
  // press→release settles as ONE history entry (commit on release). Removed
  // pieces stay drawn as faint ghosts (trimGhosts, drawing-space path data —
  // overlay only, never stored) until the tool changes, Escape, or the
  // session ends. Cut and Dissolve are click tools; their hover refs only
  // show the target. All of these are refs, so the overlay's computeds follow.
  const trimHover = ref<Span | null>(null)
  const trimGhosts = ref<string[]>([])
  // the point on a line or arc where a Cut click would add a point
  const cutHover = ref<{ x: number; y: number } | null>(null)
  // the path point a Dissolve click would remove; ok = the two pieces line up
  const dissolveHover = ref<{ pathId: EntityId; anchorIndex: number; x: number; y: number; ok: boolean } | null>(null)
  // a live Trim press: plain state (only the pen reads it). `removed` and
  // `dropped` count the pieces and the rules removed so far (an empty press
  // settles nothing, and the status line reports the rules); `ends` are the
  // ends of the pieces removed so far and `carrier` the curve the last one lay
  // on (see sweepSkips); `last` is the last pointer position the press saw
  // (see trimMove); `paths` the path count when the press began (a text guide
  // split in two says which piece the text follows).
  let trimPress: { removed: number; dropped: number; ends: Vec2[]; carrier: CurveGeom | null; last: Vec2; paths: number } | null = null
  const pathCount = () => doc.value.entities.filter(e => e.kind === 'path').length

  // the distinct points where a crossing cuts the hovered piece — one ring
  // each (a circle crossed once starts and ends at the same crossing)
  const trimHoverEnds = computed<Vec2[]>(() => {
    const s = tool.value === 'trim' ? trimHover.value : null
    if (!s) return []
    const out: Vec2[] = []
    for (const e of [s.start, s.end]) {
      if (!e.cutter) continue
      if (!out.some(q => Math.hypot(q.x - e.point.x, q.y - e.point.y) < 1e-9)) out.push(e.point)
    }
    return out
  })

  const snapTol = () => pxToUnits(SNAP_PX, opts.view.value)

  function trimSpanAt(x: number, y: number): Span | null {
    const hit = nearestCurve(doc.value, { x, y }, snapTol())
    return hit ? spanAt(doc.value, hit.ref, hit.t) : null
  }
  // remove one piece, leaving its ghost; false when trim refused it
  function trimRemove(span: Span): boolean {
    const d = spanPathD(doc.value, span)
    const carrier = curveGeom(doc.value, span.ref)
    const res = removeSpan(doc.value, span)
    if (!res.ok) return false
    if (d) trimGhosts.value = [...trimGhosts.value, d]
    if (trimPress) {
      trimPress.removed++
      trimPress.dropped += res.droppedRules
      trimPress.ends.push(span.start.point, span.end.point)
      trimPress.carrier = carrier
    }
    opts.onLiveChange?.()
    return true
  }
  function trimDown(x: number, y: number) {
    if (tool.value !== 'trim') return
    trimPress = { removed: 0, dropped: 0, ends: [], carrier: null, last: { x, y }, paths: pathCount() }
    const span = trimSpanAt(x, y)
    if (span) trimRemove(span)
    trimHover.value = trimSpanAt(x, y)
  }
  // Sweeping along a curve passes right over the crossings it was cut at, and
  // there the cutting curve is just as close to the pointer. So while the
  // pointer is still within reach of the end of a piece this press removed,
  // only a piece on the same curve as the last one removed is taken; any other
  // curve's piece waits until the pointer has moved clear of that crossing.
  function sweepSkips(span: Span, x: number, y: number): boolean {
    const press = trimPress
    if (!press || !press.carrier) return false
    const tol = snapTol()
    if (!press.ends.some(e => Math.hypot(e.x - x, e.y - y) <= tol)) return false
    const g = curveGeom(doc.value, span.ref)
    return !g || !sameCarrier(press.carrier, g, pxToUnits(0.5, opts.view.value))
  }
  // The browser coalesces pointer moves (about one per frame), so a fast sweep
  // arrives as big jumps. While pressed, walk from the last position the press
  // saw to this one in steps of half the snap reach, taking the piece under
  // each step, so no piece the pointer passed over is skipped.
  function trimMove(x: number, y: number) {
    if (tool.value !== 'trim') return
    const press = trimPress
    if (press) {
      const from = press.last
      const len = Math.hypot(x - from.x, y - from.y)
      const n = Math.max(1, Math.ceil(len / (snapTol() / 2)))
      for (let i = 1; i <= n; i++) {
        const px = from.x + (x - from.x) * (i / n), py = from.y + (y - from.y) * (i / n)
        const span = trimSpanAt(px, py)
        if (span && !sweepSkips(span, px, py)) trimRemove(span)
      }
      press.last = { x, y }
    }
    trimHover.value = trimSpanAt(x, y)
  }
  function trimUp(x?: number, y?: number) {
    const press = trimPress
    if (!press) return
    trimPress = null
    if (press.removed > 0) {
      runSolve()
      const notes: string[] = []
      if (press.dropped > 0) notes.push(`Removed ${press.dropped} ${press.dropped === 1 ? 'rule' : 'rules'} with that piece`)
      if (openOnly && pathCount() > Math.max(1, press.paths)) notes.push(GUIDE_SPLIT_STATUS)
      if (notes.length) status.value = notes.join(' · ')
      commitHistory()   // one entry for the whole press→release
    }
    trimHover.value = x != null && y != null && tool.value === 'trim' ? trimSpanAt(x, y) : null
  }

  function cutTarget(x: number, y: number) {
    const hit = nearestCurve(doc.value, { x, y }, snapTol())
    if (!hit || hit.ref.kind === 'circle' || !(hit.t > 1e-9 && hit.t < 1 - 1e-9)) return { hit, ok: false }
    return { hit, ok: true }
  }
  function cutMove(x: number, y: number) {
    if (tool.value !== 'cut') return
    const { hit, ok } = cutTarget(x, y)
    const g = ok && hit ? curveGeom(doc.value, hit.ref) : null
    if (!g || !hit) { cutHover.value = null; return }
    const a = g.a!, b = g.b!
    if (g.kind === 'line') cutHover.value = { x: a.x + (b.x - a.x) * hit.t, y: a.y + (b.y - a.y) * hit.t }
    else {
      const ang = g.a0! + g.sweepAngle! * hit.t
      cutHover.value = { x: g.c!.x + g.r! * Math.cos(ang), y: g.c!.y + g.r! * Math.sin(ang) }
    }
  }
  function cutClick(x: number, y: number) {
    if (tool.value !== 'cut') return
    const { hit, ok } = cutTarget(x, y)
    if (!hit || !ok) {
      // a circle, or no line or arc in reach (Bézier curves aren't cut in v1)
      if (!hit || hit.ref.kind === 'circle') status.value = 'Cut works on lines and arcs'
      return
    }
    const id = cutAt(doc.value, hit.ref, hit.t)
    if (!id) return
    runSolve()
    commitHistory()
    const p = doc.value.entities.find(e => e.id === id) as any
    if (p && p.kind === 'point') sparkle(p.x, p.y)
    cutMove(x, y)
  }

  // the nearest interior path point within snap reach (an open path's two
  // ends have only one piece each, so there is nothing to merge there)
  function dissolveTarget(x: number, y: number) {
    const tol = snapTol()
    let best: { pathId: EntityId; anchorIndex: number; x: number; y: number; d: number } | null = null
    for (const e of doc.value.entities) {
      if (e.kind !== 'path') continue
      const n = e.anchors.length
      for (let k = 0; k < n; k++) {
        if (!e.closed && (k === 0 || k === n - 1)) continue
        if (e.closed && n < 3) continue
        const p = doc.value.entities.find(q => q.id === e.anchors[k]) as any
        if (!p || p.kind !== 'point') continue
        const d = Math.hypot(p.x - x, p.y - y)
        if (d <= tol && (!best || d < best.d)) best = { pathId: e.id, anchorIndex: k, x: p.x, y: p.y, d }
      }
    }
    if (!best) return null
    const ok = canDissolve(doc.value, best.pathId, best.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG)
    return { pathId: best.pathId, anchorIndex: best.anchorIndex, x: best.x, y: best.y, ok }
  }
  function dissolveMove(x: number, y: number) {
    if (tool.value !== 'dissolve') return
    dissolveHover.value = dissolveTarget(x, y)
  }
  function dissolveClick(x: number, y: number) {
    if (tool.value !== 'dissolve') return
    const t = dissolveTarget(x, y)
    if (!t) return
    if (!t.ok) { status.value = DISSOLVE_REFUSED; return }
    const res = dissolveAt(doc.value, t.pathId, t.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG)
    if (!res.ok) { status.value = DISSOLVE_REFUSED; return }
    runSolve()
    commitHistory()
    sparkle(t.x, t.y)
    dissolveMove(x, y)
  }

  // the pointer left the drawing: nothing is under it any more
  function clearToolHover() {
    trimHover.value = null
    cutHover.value = null
    dissolveHover.value = null
  }
  // Escape in Trim: true when there were ghosts to clear
  function clearTrimGhosts(): boolean {
    if (!trimGhosts.value.length) return false
    trimGhosts.value = []
    return true
  }
  // every Trim/Cut/Dissolve transient back to rest (tool change, undo/redo,
  // reset, session end). A live Trim press is settled first so its removals
  // land as their own history step.
  function resetEditTools() {
    if (trimPress) trimUp()
    cancelPointDrop()
    clearToolHover()
    trimGhosts.value = []
  }

  // --- Repeat / Mirror / Flip: see penCopies.ts. doRepeat and repeatPrompt
  // (the inline-value-request entry points — requestValue, above) stay here
  // and call into it.
  const penCopies = createPenCopies({ doc, selection, pendingOp, status, clearSel, runSolve, commitHistory })
  const { applyRepeat, applyMirror, armRepeat, doMirror, flip } = penCopies
  // kept for the test hook / fast path: exact-selection repeat (1 point + units)
  function doRepeat(count: number) {
    const ptSel = selection.value.filter(id => isPointId(id))
    const entSel = selection.value.filter(id => !ptSel.includes(id))
    if (ptSel.length !== 1 || entSel.length === 0) return
    applyRepeat(entSel, ptSel[0]!, count)
  }
  async function repeatPrompt() {
    const ptSel = selection.value.filter(id => isPointId(id))
    const entSel = selection.value.filter(id => !ptSel.includes(id))
    if (entSel.length === 0) { status.value = 'Select a shape first, then Repeat…'; return }
    const count = await requestValue('Copies around the ring', 6, 2)
    if (count == null) return
    if (!Number.isFinite(count) || count < 2) { status.value = 'Repeat needs a count of 2 or more'; return }
    // fast path: a center point is already part of the selection
    if (ptSel.length === 1) { applyRepeat(entSel, ptSel[0]!, count); return }
    // guided: arm the center pick
    armRepeat(entSel, count)
  }
  function makeConstruction() {
    for (const id of selection.value) {
      const e = doc.value.entities.find(x => x.id === id) as any
      if (e && e.kind !== 'point') e.construction = !e.construction
    }
    clearSel(); runSolve(); commitHistory()
  }
  function fixSelected() {
    for (const id of selection.value) {
      const e = doc.value.entities.find(x => x.id === id) as any
      if (e && e.kind === 'point') e.fixed = true
    }
    clearSel(); runSolve(); commitHistory()
  }

  // --- Copy / Paste / Select all / Dissolve a point (pen stage 6) ---
  // The pen's own clipboard (penClipboard.ts) holds a copy of the pieces and
  // the rules among them, shared by every pen on the page; pasting gives the
  // pieces fresh ids (lib/sketch/clipboard.ts). Copy as SVG writes the
  // selection's outline — the pen page's Copy SVG format — to the system
  // clipboard. Copy and Select all write no history; Paste and Dissolve are
  // one step each.
  const hasPick = () => selection.value.length > 0 || selectedSegments.value.length > 0
  function copySelection(): boolean {
    if (!hasPick()) return false
    const clip = extractPieces(doc.value, selection.value, selectedSegments.value)
    if (!clip.entities.length) return false
    setPenClipboard(clip)
    status.value = `Copied ${selectionLabel(doc.value, selection.value, selectedSegments.value)}`
    return true
  }
  function pasteState(): ActionState {
    const c = penClipboard.value
    if (!c) return no(REASON.emptyClip)
    if (openOnly && hasClosedPieces(c.doc)) return no(REASON.openOnly)
    return OK
  }
  // `at` (the menu's Paste): the copy's centre lands there; else (⌘V) 16 px
  // down-right on screen of where it was copied, 16 px more per paste
  function paste(at?: Vec2 | null): boolean {
    if (!pasteState().ok) return false
    const c = penClipboard.value!
    if (tool.value !== 'select') selectTool('select')
    let offset: Vec2 = { x: 0, y: 0 }
    if (at) {
      const ctr = piecesCentre(c.doc)
      offset = { x: at.x - ctr.x, y: at.y - ctr.y }
    } else {
      const step = screenDeltaToDrawing(opts.view.value, PASTE_STEP_PX, PASTE_STEP_PX)
      const k = nextPasteStep()
      if (step) offset = { x: step.x * k, y: step.y * k }
    }
    const { top } = insertPieces(doc.value, c.doc, offset)
    clearSegSel()
    selection.value = top
    runSolve()
    commitHistory()
    status.value = `Pasted ${selectionLabel(doc.value, top, [])}`
    return true
  }
  function copySvg(): string {
    if (!hasPick()) return ''
    const d = sketchPathData(extractPieces(doc.value, selection.value, selectedSegments.value))
    if (!d) return ''
    try { if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(d)?.catch?.(() => {}) } catch {}
    status.value = 'Copied as SVG'
    return d
  }
  function selectAll(): boolean {
    const ids = topLevelIds(doc.value)
    if (!ids.length) return false
    if (tool.value !== 'select') selectTool('select')
    clearSegSel()
    selection.value = ids
    return true
  }
  // Dissolve on one selected point: it must sit between two pieces of a path
  // (an open path's ends don't) — the Dissolve tool's rule
  function dissolveSpot(id: EntityId): { pathId: EntityId; anchorIndex: number } | null {
    for (const e of doc.value.entities) {
      if (e.kind !== 'path') continue
      const n = e.anchors.length
      for (let k = 0; k < n; k++) {
        if (e.anchors[k] !== id) continue
        if (e.closed ? n >= 3 : k > 0 && k < n - 1) return { pathId: e.id, anchorIndex: k }
      }
    }
    return null
  }
  function dissolveState(id: EntityId): ActionState {
    const s = dissolveSpot(id)
    if (!s) return no(REASON.notBetween)
    return canDissolve(doc.value, s.pathId, s.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG) ? OK : no(REASON.noMerge)
  }
  function dissolvePoint(id: EntityId): boolean {
    const s = dissolveSpot(id)
    const p = doc.value.entities.find(e => e.id === id)
    if (!s || p?.kind !== 'point') return false
    const { x, y } = p
    const res = dissolveAt(doc.value, s.pathId, s.anchorIndex, pxToUnits(DISSOLVE_PX, opts.view.value), DISSOLVE_DEG)
    if (!res.ok) { status.value = DISSOLVE_REFUSED; return false }
    clearSel()
    clearSegSel()
    runSolve()
    commitHistory()
    sparkle(x, y)
    return true
  }

  // --- Properties: typed sizes and the hover highlight (pen stage 6) ---
  // A typed size is checked first on a copy — only the window round it
  // (checkSizeEdit, the stage-5 window solve; never a big drawing whole). A
  // certain "no" refuses it and changes nothing. Else the same edit runs on
  // the drawing through the pen's normal solve (runSolve); if that solve
  // fails the drawing is put back and it is refused (an uncertain check is
  // never a refusal on a guess). Any temporary rule goes again; one step.
  // `seeds` are what the edit touches when it neither drags nor adds a rule
  // (a rule's value changed). `stay` are the points a drag must leave where
  // they are for the typed size to be kept (a line's other end, an arc's
  // centre and start) — a solve that meets the rules by moving them has lost
  // the typed size, and that is a refusal too.
  type SizeEdit = { drag?: DragTarget; temp?: { kind: ConstraintKind; refs: EntityId[]; value: number }; seeds?: EntityId[]; stay?: EntityId[] }
  function tryEdit(edit: (d: SketchDoc) => SizeEdit | null, own?: [EntityId, EntityId]): boolean {
    const plan = edit(cloneDoc(doc.value))
    if (!plan) return false
    const seeds = plan.drag ? [plan.drag.point] : plan.temp ? plan.temp.refs : plan.seeds ?? []
    const unitsPerPx = pxToUnits(1, opts.view.value)
    const verdict = checkSizeEdit(doc.value, {
      fresh: () => {
        const t = cloneDoc(doc.value)
        const p = edit(t)!
        if (p.drag) { const q = ptOf(t, p.drag.point); if (q) { q.x = p.drag.x; q.y = p.drag.y } }
        if (p.temp) t.constraints.push({ id: '__size', kind: p.temp.kind, refs: [...p.temp.refs], value: p.temp.value })
        return t
      },
      seeds, held: new Set(plan.drag ? [plan.drag.point] : []), unitsPerPx, own, stay: plan.stay,
    })
    if (verdict === 'refuse') { status.value = SIZE_REFUSED; return false }
    const before = cloneDoc(doc.value)
    const real = edit(doc.value)!
    const tempId = real.temp ? addConstraint(doc.value, real.temp.kind, real.temp.refs, real.temp.value) : null
    const res = runSolve(real.drag)
    if (!res.converged || !stayed(before, doc.value, real.stay ?? [], STAY_PX * unitsPerPx)) {
      doc.value = before
      status.value = SIZE_REFUSED
      return false
    }
    if (tempId) removeConstraint(doc.value, tempId)
    commitHistory()
    return true
  }
  const ptOf = (d: SketchDoc, id: EntityId) => { const p = d.entities.find(e => e.id === id); return p?.kind === 'point' ? p : null }
  function setPointXY(id: EntityId, x: number, y: number): boolean {
    const p = ptOf(doc.value, id)
    if (!p || !Number.isFinite(x) || !Number.isFinite(y)) return false
    if (p.fixed) { status.value = 'Fixed points stay where they are'; return false }
    return tryEdit(() => ({ drag: { point: id, x, y } }))
  }
  // move the free end of a–b so it runs `len` along `dir` from the other end
  function moveLineEnd(a: EntityId, b: EntityId, dirOf: (A: Vec2, B: Vec2) => Vec2 | null, lenOf: (A: Vec2, B: Vec2) => number): boolean {
    return tryEdit(d => {
      const A = ptOf(d, a), B = ptOf(d, b)
      if (!A || !B || (A.fixed && B.fixed)) return null
      const dir = dirOf(A, B), len = lenOf(A, B)
      if (!dir || !(len > 0)) return null
      if (!B.fixed) return { drag: { point: b, x: A.x + dir.x * len, y: A.y + dir.y * len }, stay: [a] }
      return { drag: { point: a, x: B.x - dir.x * len, y: B.y - dir.y * len }, stay: [b] }
    }, [a, b])
  }
  const unitDir = (A: Vec2, B: Vec2): Vec2 | null => { const n = Math.hypot(B.x - A.x, B.y - A.y); return n > 1e-12 ? { x: (B.x - A.x) / n, y: (B.y - A.y) / n } : null }
  function setLineLength(a: EntityId, b: EntityId, len: number): boolean {
    if (!(len > 0)) return false
    return moveLineEnd(a, b, unitDir, () => len)
  }
  function setLineAngle(a: EntityId, b: EntityId, deg: number): boolean {
    if (!Number.isFinite(deg)) return false
    return moveLineEnd(a, b, () => drawingDirForScreenAngle(opts.view.value, deg), (A, B) => Math.hypot(B.x - A.x, B.y - A.y))
  }
  function arcParts(d: SketchDoc, pathId: EntityId, segIndex: number) {
    const p = d.entities.find(e => e.id === pathId)
    if (p?.kind !== 'path') return null
    const seg = p.segments[segIndex]
    if (seg?.kind !== 'arc') return null
    const s = p.anchors[segIndex], e = p.anchors[(segIndex + 1) % p.anchors.length]
    return s && e ? { c: seg.center, s, e, sweep: seg.sweep } : null
  }
  function setArcRadiusValue(pathId: EntityId, segIndex: number, r: number): boolean {
    if (!(r > 0)) return false
    return tryEdit(d => {
      const a = arcParts(d, pathId, segIndex)
      if (!a) return null
      const pin = radiusPinOf(d, a.c, a.s)
      if (pin) { pin.value = r; return { seeds: [a.c, a.s] } }
      return { temp: { kind: 'distance', refs: [a.c, a.s], value: r } }
    })
  }
  function setArcSweep(pathId: EntityId, segIndex: number, deg: number): boolean {
    if (!Number.isFinite(deg)) return false
    const sweepDeg = Math.min(359.5, Math.max(0.5, deg))
    return tryEdit(d => {
      const a = arcParts(d, pathId, segIndex)
      const C = a && ptOf(d, a.c), S = a && ptOf(d, a.s), E = a && ptOf(d, a.e)
      if (!a || !C || !S || !E || E.fixed) return null
      const to = arcEndForSweep(C, S, a.sweep === 1 ? 1 : -1, sweepDeg)
      return { drag: { point: a.e, x: to.x, y: to.y }, stay: [a.c, a.s] }
    })
  }
  function setArcLength(pathId: EntityId, segIndex: number, len: number): boolean {
    const a = arcParts(doc.value, pathId, segIndex)
    const C = a && ptOf(doc.value, a.c), S = a && ptOf(doc.value, a.s)
    if (!C || !S || !(len > 0)) return false
    const r = Math.hypot(S.x - C.x, S.y - C.y)
    return r > 1e-12 ? setArcSweep(pathId, segIndex, (len / r) * 180 / Math.PI) : false
  }
  function toggleArcRadiusLock(pathId: EntityId, segIndex: number): void {
    const a = arcParts(doc.value, pathId, segIndex)
    const C = a && ptOf(doc.value, a.c), S = a && ptOf(doc.value, a.s)
    if (!a || !C || !S) return
    const pin = radiusPinOf(doc.value, a.c, a.s)
    if (pin) removeConstraintById(pin.id)
    else setArcRadius(pathId, segIndex, Math.hypot(S.x - C.x, S.y - C.y))
  }
  function setCircleRadius(id: EntityId, r: number): boolean {
    if (!(r > 0)) return false
    return tryEdit(d => {
      const c = d.entities.find(e => e.id === id)
      if (c?.kind !== 'circle') return null
      const rule = circleRadiusRuleOf(d, id)
      if (rule) { rule.value = r; return { seeds: [id] } }
      c.r = r
      return { temp: { kind: 'radius', refs: [id], value: r } }
    })
  }
  function toggleCircleRadiusLock(id: EntityId): void {
    const c = doc.value.entities.find(e => e.id === id)
    if (c?.kind !== 'circle') return
    const rule = circleRadiusRuleOf(doc.value, id)
    if (rule) { removeConstraintById(rule.id); return }
    addConstraint(doc.value, 'radius', [id], c.r)
    runSolve()
    commitHistory()
  }
  // what the Properties panel lights while a rule row is hovered — view state
  // (no history); replaced, never mutated, so the overlay's computeds follow
  const highlight = shallowRef<PieceRef[]>([])
  function setHighlight(p: PieceRef[]): void { highlight.value = p }

  // --- Clean up (pen stage 5, lib/sketch/cleanup) ---
  // A preview: the drawing stays exactly as it is while `cleanup` holds the
  // cleaned copy, re-solved from the drawing as it was when Clean up opened
  // on every switch or strength change (so the same switches always give the
  // same answer). Apply writes it as ONE history step; Cancel, Escape, ⌥⇧C
  // again, or anything that ends the session (a tool change, undo / redo,
  // reset, revert, finishSession, parking, dispose) drops it untouched.
  // Tolerances use the zoom Clean up opened at, so zooming mid-preview does
  // not reshuffle the fixes. The object is replaced on every change, never
  // mutated, so the overlay's and toolbar's computeds follow it.
  // `memo` keeps every answer of this session keyed by strength + the sorted
  // switched-off ids, so switching a badge back and forth is instant; it is
  // carried from object to object and dies with the session. A run that ran
  // out of time (`result.stopped`, see runCleanup's budget) depends on the
  // machine's speed; the memo still keeps one answer per setting per session.
  interface CleanupSession {
    strength: CleanupStrength
    off: ReadonlySet<string>
    scope: CleanupScope | null
    unitsPerPx: number
    original: SketchDoc
    result: CleanupResult
    memo: Map<string, CleanupResult>
  }
  const cleanup = shallowRef<CleanupSession | null>(null)
  function solveCleanup(s: Omit<CleanupSession, 'result'>): CleanupSession {
    const k = `${s.strength}|${[...s.off].sort().join(',')}`
    let result = s.memo.get(k)
    if (!result) {
      result = runCleanup(s.original, { unitsPerPx: s.unitsPerPx, strength: s.strength, scope: s.scope, off: s.off, openOnly })
      s.memo.set(k, result)
    }
    return { ...s, result }
  }
  function startCleanup(): void {
    if (!cleanupAllowed || cleanup.value) return
    finishSession()   // every live gesture settles first (its own step, if it changed anything); the selection is kept
    const picked = selection.value.length > 0 || selectedSegments.value.length > 0
    const scope: CleanupScope | null = picked
      ? { entities: [...selection.value], segments: selectedSegments.value.map(s => ({ ...s })) }
      : null
    cleanup.value = solveCleanup({
      strength: 'normal', off: new Set(), scope, unitsPerPx: pxToUnits(1, opts.view.value),
      original: cloneDoc(doc.value), memo: new Map(),
    })
  }
  function closeCleanup(): void { cleanup.value = null }
  function cancelCleanup(): void {
    if (!cleanup.value) return
    cleanup.value = null
    status.value = 'Clean up cancelled'
  }
  function toggleCleanup(): void {
    if (cleanup.value) cancelCleanup()
    else startCleanup()
  }
  function setCleanupStrength(strength: CleanupStrength): void {
    const s = cleanup.value
    if (!s || s.strength === strength) return
    cleanup.value = solveCleanup({ ...s, strength })
  }
  function toggleCleanupFix(id: string): void {
    const s = cleanup.value
    if (!s) return
    const off = new Set(s.off)
    if (off.has(id)) off.delete(id)
    else off.add(id)
    cleanup.value = solveCleanup({ ...s, off })
  }
  // a collapsed badge: every fix of that kind off when all are on, else all on
  function toggleCleanupKind(kind: FixKind): void {
    const s = cleanup.value
    if (!s) return
    const mine = s.result.fixes.filter(f => f.kind === kind)
    if (!mine.length) return
    const allOn = mine.every(f => f.on)
    const off = new Set(s.off)
    for (const f of mine) { if (allOn) off.add(f.id); else off.delete(f.id) }
    cleanup.value = solveCleanup({ ...s, off })
  }
  function applyCleanup(): void {
    const s = cleanup.value
    if (!s) return
    cleanup.value = null
    const on = s.result.fixes.filter(f => f.on)
    if (!on.length) return
    doc.value = cloneDoc(s.result.doc)
    clearSel()
    clearSegSel()
    commitHistory()
    for (const f of on.slice(0, 12)) sparkle(f.at.x, f.at.y)
    status.value = `Cleaned up · ${on.length} ${on.length === 1 ? 'change' : 'changes'}`
  }
  // a button / field / control has focus (the key's target, else the
  // document's active element) — Space then belongs to it
  function isControlFocused(ev: KeyboardEvent): boolean {
    const t = (ev.target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as Element | null
    if (!t || typeof (t as Element).closest !== 'function') return false
    return !!t.closest('button, input, select, textarea, [role="button"], [role="radio"], [role="slider"], [role="tab"], [contenteditable="true"]')
  }
  // the toolbar's own Cancel control (PenToolbar's data-act="cleanup-cancel")
  // has focus — native button behaviour says Enter there presses IT, not
  // Apply (the target, else the document's active element, same fallback as
  // isControlFocused)
  function isCancelFocused(ev: KeyboardEvent): boolean {
    const t = (ev.target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as Element | null
    return !!(t && typeof t.closest === 'function' && t.closest('[data-act="cleanup-cancel"]'))
  }
  // the focused strength control (PenToolbar's [data-strength] radios), if any
  function focusedStrength(ev: KeyboardEvent): Element | null {
    const t = (ev.target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as Element | null
    return t && typeof t.closest === 'function' ? t.closest('[data-strength]') : null
  }
  const STRENGTH_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
  // keys while a preview is open: Enter applies — except on a focused Cancel
  // button, where it cancels, matching what a native button does with Enter,
  // and with every fix off, where it does nothing —
  // ←/→/↑/↓ on a focused strength control move the strength —
  // Escape / ⌥⇧C always cancel, ⌘Z / ⌘Y only close it; every other plain key
  // is swallowed so nothing edits the drawing under the preview — except
  // Tab / ⇧Tab, and Space on a focused control, left to the browser so the
  // keyboard reaches strength / Apply / Cancel; other ⌘ combos and bare
  // modifiers are not the pen's
  function cleanupKey(ev: KeyboardEvent): boolean {
    if (ev.metaKey || ev.ctrlKey) {
      const k = ev.key.toLowerCase()
      if (k === 'z' || k === 'y') { cancelCleanup(); return true }
      return false
    }
    if (ev.key === 'Enter') {
      if (isCancelFocused(ev)) cancelCleanup()
      // with every fix off Enter does nothing, as the disabled Apply button
      else if (cleanup.value?.result.fixes.some(f => f.on)) applyCleanup()
      return true
    }
    if (ev.key === 'Escape' || isCleanupKey(ev)) { cancelCleanup(); return true }
    // the strength control is a radio group: the arrows move it (round the
    // ends) and take the focus along, since Space may be the host's pan key
    const step = STRENGTH_STEP[ev.key]
    const radio = step && !ev.altKey && !ev.shiftKey ? focusedStrength(ev) : null
    if (radio && cleanup.value) {
      const i = STRENGTHS.indexOf((radio.getAttribute('data-strength') ?? cleanup.value.strength) as CleanupStrength)
      const next = STRENGTHS[(Math.max(0, i) + step! + STRENGTHS.length) % STRENGTHS.length]!
      setCleanupStrength(next)
      const to = radio.closest('[role="radiogroup"]')?.querySelector(`[data-strength="${next}"]`) as HTMLElement | null | undefined
      to?.focus?.()
      return true
    }
    // keyboard access to the strength / Apply / Cancel row: Tab / ⇧Tab move
    // focus, and Space presses a focused button or control
    if (ev.key === 'Tab') return false
    if (ev.key === ' ' && isControlFocused(ev)) return false
    return !MODIFIER_KEYS.has(ev.key)
  }

  // select every entity with ANY point-closure point (pointClosure — same
  // expansion nudge()/flip() use) inside the world rect [x0,y0]–[x1,y1] — a
  // forgiving "any point touches" test rather than requiring the whole entity
  // inside. additive=true adds to the current selection (shift-marquee);
  // additive=false replaces it. Exposed directly as __sketchDraw.marqueeSelect
  // so E2E can drive the exact same path a real drag resolves to.
  // box-select: an entity is hit when any point of its closure is inside.
  // marqueeSelect takes a DRAWING-axis box (the test hook);
  // marqueeSelectScreen takes a SCREEN-pixel box — what a real marquee drag
  // is — and tests each point through the view, so it is right under any
  // rotation or mirror.
  function marqueeSelect(x0: number, y0: number, x1: number, y1: number, additive = false) {
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1)
    const loY = Math.min(y0, y1), hiY = Math.max(y0, y1)
    selectPointsWhere(p => p.x >= loX && p.x <= hiX && p.y >= loY && p.y <= hiY, additive)
  }
  function marqueeSelectScreen(x0: number, y0: number, x1: number, y1: number, additive = false) {
    const loX = Math.min(x0, x1), hiX = Math.max(x0, x1)
    const loY = Math.min(y0, y1), hiY = Math.max(y0, y1)
    const view = opts.view.value
    selectPointsWhere(p => {
      const s = applyView(view, p)
      return s.x >= loX && s.x <= hiX && s.y >= loY && s.y <= hiY
    }, additive)
  }
  function selectPointsWhere(inside: (p: { x: number; y: number }) => boolean, additive: boolean) {
    clearSegSel()
    const hits: EntityId[] = []
    for (const e of doc.value.entities) {
      const closure = pointClosure(doc.value, [e.id])
      const inRect = closure.some(pid => {
        const p = doc.value.entities.find(x => x.id === pid) as any
        return p && p.kind === 'point' && inside(p)
      })
      if (inRect) hits.push(e.id)
    }
    if (!additive) { selection.value = hits; return }
    const set = new Set(selection.value)
    for (const id of hits) set.add(id)
    selection.value = Array.from(set)
  }

  // an abandoned path draw (tool switched away, or reset, before it was
  // committed) leaves its anchors and handles sitting in the doc forever. Delete
  // whichever of them nothing committed ends up referencing — an anchor reused
  // via snap-coincidence with existing geometry stays (deleteEntity would
  // otherwise cascade into whatever committed line/circle/path shares it).
  // Fix (a): an anchor this draw did NOT create (ownAnchors[i] === false, it
  // snapped onto a pre-existing point) is never a deletion candidate at all —
  // same rule Pending.own already applies to a Line/Circle start point.
  function cleanupPendingPath() {
    const pp = pendingPath.value
    if (!pp) return
    const candidates = new Set<EntityId>(pp.anchors.filter((_, i) => pp.ownAnchors[i]))
    for (const s of pp.segments) {
      if (s.kind === 'cubic') { if (s.h1) candidates.add(s.h1); if (s.h2) candidates.add(s.h2) }
      else if (s.kind === 'arc') candidates.add(s.center)
    }
    if (lastHOut) candidates.add(lastHOut)
    if (firstHIn) candidates.add(firstHIn)
    for (const id of candidates) {
      const p = doc.value.entities.find(e => e.id === id) as any
      if (!p || p.kind !== 'point' || p.fixed) continue
      if (!isPointReferenced(doc.value, id)) deleteEntity(doc.value, id)
    }
  }

  // Shared by every call site that tears down a pending path outside of
  // removeLastAnchor's own step-back bookkeeping (which commits itself).
  // cleanupPendingPath only nulls state + deletes orphaned anchors — it never
  // commits — so every caller here MUST wrap it in a before/after entity-count
  // check and commit iff something was actually deleted. Skipping that commit
  // is exactly the ghost-anchor bug: the deleted anchor keeps living in the
  // PRIOR history entry, and a later undo lands right past this state, un­doing
  // past the deletion and resurrecting the anchor even though the canvas
  // showed it gone. selectTool (toolbar buttons) used to call
  // cleanupPendingPath bare — no commit — which was this exact gap.
  function cleanupPendingAndCommit() {
    const before = doc.value.entities.length
    cleanupPendingPath()
    if (doc.value.entities.length !== before) commitHistory()
  }

  // Escape / test hook: abandon the in-progress path draw without committing a
  // "half path". Reuses cleanupPendingAndCommit (above) for the actual anchor
  // cleanup — same logic selectTool already relies on when switching tools
  // mid-draw. Commits only if that cleanup actually deleted something: a plain
  // Escape with nothing pending is a true no-op (no spurious history entry),
  // and — the known edge case this guards against — an Escape that DID delete
  // a pending-only anchor must land its own history entry, or else the anchor
  // stays alive in the PRIOR entry and a later undo/redo cycle can resurrect it
  // as a ghost (undo lands on the old entry that still has it, redo brings it
  // forward again) even though the canvas shows it gone right now.
  function cancelPath() {
    if (!pendingPath.value) return
    cleanupPendingAndCommit()
    pendingPath.value = null
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
  }

  // Backspace/Delete while a path is pending: step back ONE anchor (undo the
  // last pathClick/pathDown placement) rather than the coarser full cancel.
  // Also drops the trailing segment leaving that anchor, and — if it was an
  // arc — the center point that segment alone owned (mirrors the segment
  // bookkeeping addPath/deleteEntity do for a committed path). Stepping back
  // from 2 anchors to 1 leaves a perfectly valid pending state — the same
  // single-anchor state a fresh path starts in — so that anchor is kept, not
  // deleted. Only when the LAST anchor itself gets popped (0 remain, nothing
  // left to keep drawing from) does this fall through to the same full-cancel
  // cleanup cancelPath uses. Either way, folded into ONE history commit (only
  // if something was actually deleted) so this can't leave the same
  // ghost-anchor gap cancelPath's own comment describes.
  function removeLastAnchor() {
    const pp = pendingPath.value
    if (!pp || pp.anchors.length === 0) return
    const before = doc.value.entities.length
    const lastAnchor = pp.anchors.pop()!
    const lastOwn = pp.ownAnchors.pop()
    const lastSeg = pp.segments.length ? pp.segments.pop() : undefined
    const candidates: EntityId[] = lastOwn ? [lastAnchor] : []
    if (lastSeg && lastSeg.kind === 'arc') candidates.push(lastSeg.center)
    // a Curve point: its in-handle (the popped segment's h2) and its out-handle
    // go with it; the previous point's out-handle (h1) is held again
    if (lastSeg && lastSeg.kind === 'cubic' && lastSeg.h2) candidates.push(lastSeg.h2)
    if (lastHOut) candidates.push(lastHOut)
    lastHOut = lastSeg && lastSeg.kind === 'cubic' ? lastSeg.h1 : null
    curveDrag.value = null
    for (const id of candidates) {
      const p = doc.value.entities.find(e => e.id === id) as any
      if (p && p.kind === 'point' && !p.fixed && !isPointReferenced(doc.value, id)) deleteEntity(doc.value, id)
    }
    if (pp.anchors.length === 0) {
      cleanupPendingPath()
      pendingPath.value = null
      setPathDrag(null)
      resetCurveState()
      cursor.value = null
    }
    if (doc.value.entities.length !== before) commitHistory()
  }

  // A pending Line/Circle's start point is deleted iff this draw created it
  // fresh (Pending.own — placePoint's own before/after entity-count check) and
  // nothing else references it; a snap onto a pre-existing point is always
  // left alone. Shared by finishSession (session ends before the shape is
  // completed) and selectTool's fix (c) (the tool changes instead) — same
  // rule, two different moments a Line/Circle draw can be abandoned. Returns
  // whether it actually deleted something, for a caller that folds this into
  // its own before/after commit check.
  function deletePendingOwnPoint(): boolean {
    const pd = pending.value
    if (!pd || !pd.own) return false
    const id = pd.kind === 'line' ? pd.p1 : pd.center
    const p = doc.value.entities.find(e => e.id === id) as any
    if (!p || p.kind !== 'point' || p.fixed || isPointReferenced(doc.value, id)) return false
    deleteEntity(doc.value, id)
    return true
  }

  function selectTool(t: Tool) {
    if (!isToolAllowed(t)) return   // PenOptions.tools / openOnly: not a tool this host offers — no-op
    closeCleanup()   // a tool change drops a Clean up preview
    if (arcDrag) arcDragEnd()   // a live arc drag settles as its own step
    // Pen ↔ Curve mid-path keeps drawing the same path: the next segment's kind
    // follows whichever of the two is active when its end point is placed
    if (pendingPath.value && isDrawTool(tool.value) && isDrawTool(t)) {
      tool.value = t
      setPathDrag(null)
      curveDrag.value = null
      dimBuffer.value = ''
      return
    }
    // Switching away mid-path keeps the work: a pending path with two or more
    // points is finished as an open path (as finishSession does; finishPath
    // commits it). A lone first point is still dropped just below.
    if (pendingPath.value && pendingPath.value.anchors.length >= 2) finishPath(false)
    // Fix (c): switching tools mid Line/Circle must delete its owned start
    // point too (deletePendingOwnPoint, above). Folded into ONE before/after
    // check + commit with the pending PATH cleanup right below, so a switch
    // that touches both never lands two history entries (or, worse, an
    // uncommitted one — see cleanupPendingPath's own ghost-anchor warning).
    const before = doc.value.entities.length
    cleanupPendingPath()
    deletePendingOwnPoint()
    if (doc.value.entities.length !== before) commitHistory()
    cancelPendingOp()   // a half-armed Repeat/Mirror never survives a tool switch
    cancelValue()       // a pending value request (Distance/Radius/Copies) never survives a tool switch
    resetEditTools()    // Trim's ghosts and every hover target go with the tool
    // switching to a draw tool must not carry a stale entity/segment
    // selection along with it — the verb bar, arrow-nudge, and Backspace-
    // delete all act on `selection`/`selectedSegments`, and a leftover pick
    // from the select tool would silently apply to whatever gets drawn next.
    // Switching TO 'select' is left alone: entering select mode is exactly
    // when a live selection is expected.
    if (t !== 'select') {
      clearSel()
      clearSegSel()
    }
    tool.value = t
    pending.value = null
    pendingPath.value = null
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
  }

  function reset() {
    closeCleanup()
    setArcDrag(null)   // dropped, never settled — the drawing is thrown away
    resetEditTools()
    cleanupPendingPath()
    doc.value = { entities: [], constraints: [] }
    cancelValue()   // a pending value request never survives a reset
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    status.value = 'ready'
    initHistory()
    opts.onChange?.()
  }

  // every transient (non-doc) draw/selection state back to rest — shared by
  // finishSession and revert
  function clearTransient() {
    resetEditTools()
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    pendingOp.value = null
    cancelValue()   // a pending value request never survives finishSession/revert
    setPathDrag(null)
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
  }

  // Settle the session before the host stores the drawing (Enter-commit and
  // Done both call this, then emit `commit`): a pending path with ≥2 anchors
  // is finished as an open path; a lone pending anchor, or a Line/Circle's
  // placed start point, is removed (only if this draw created it — a snap
  // onto an existing point is left alone), so no orphan points are stored.
  // A half-armed Repeat/Mirror is dropped. Commits one history step iff the
  // doc changed.
  function finishSession(): void {
    closeCleanup()   // a Clean up preview is dropped, never applied
    if (arcDrag) arcDragEnd()   // a live arc drag settles as its own step
    pendingOp.value = null
    if (pendingPath.value && pendingPath.value.anchors.length >= 2) {
      finishPath(false)
    } else if (pendingPath.value) {
      cleanupPendingPath()
    }
    deletePendingOwnPoint()
    const sel = selection.value.slice(), segs = selectedSegments.value.slice()
    clearTransient()
    // keep the user's selection — settling is not deselecting (but drop ids
    // the cleanup just deleted)
    selection.value = sel.filter(id => doc.value.entities.some(e => e.id === id))
    selectedSegments.value = segs
    commitHistory()   // no-op when nothing changed (its own guard)
  }

  // Put the drawing back exactly as it was when this pen was created (not
  // the capped undo history's oldest entry) and start history afresh. Never
  // called by the overlay or toolbar — a host calls it on `cancel` if its
  // cancel means "discard".
  function revert(): void {
    closeCleanup()
    trimPress = null   // discarded with everything else — never settled onto the reverted drawing
    setArcDrag(null)   // likewise a live arc drag
    penHistory.revert()   // doc.value = cloneDoc(opening); initHistory()
    clearTransient()
    status.value = 'ready'
    opts.onChange?.()
  }

  // which verbs apply to the current selection (order = display order) — the
  // pure rules in penRules.ts, fed this pen's doc + selections
  function availableConstraints(): RuleOption[] {
    return availableConstraintsFor(doc.value, selection.value, selectedSegments.value)
  }
  function orderRefs(kind: ConstraintKind, ids: EntityId[]): EntityId[] {
    return orderRefsFor(doc.value, kind, ids)
  }
  function getPathDrag(): PathDrag { void pathDragTick.value; return pathDrag }

  // Fix (b): end the pen's own live down→drag→up gesture without touching the
  // pending path itself — the host calls this when it parks the pen (e.g.
  // PenOverlay's `active` turning false) so a drag that never got a pointerup
  // doesn't resume mid-air once the overlay reactivates. Mirrors what the
  // overlay's own watcher already does for its point-drag/marquee state.
  function endGesture(): void {
    closeCleanup()   // parking the pen drops a Clean up preview
    cancelPointDrop()
    setPathDrag(null)
    curveDrag.value = null
    if (trimPress) trimUp()   // the pieces already removed settle as their step
    if (arcDrag) arcDragEnd()   // so does a live arc drag
    clearToolHover()
  }

  // stop the sparkle loop — the host calls this when it unmounts
  function dispose() {
    closeCleanup()
    cancelValue()   // a pending value request never outlives the pen
    highlight.value = []
    if (sparkleRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(sparkleRaf)
    sparkleRaf = 0
  }

  initHistory()

  return {
    // the host's doc ref, handed back so a renderer (PenOverlay) needs only the pen
    doc,
    // resolved PenOptions (tools defaults to all tools; openOnly excludes circle)
    options,
    // the host's view (Properties reads angles as on screen)
    view: opts.view,
    // state
    tool, guideMode, showLabels, status, selection, selectedSegments, pending, pendingPath,
    pendingOp, opHint, cursor, dimBuffer, nextSegment, sparkles, sparkleClock, placementPreview, hoverSnap,
    valueRequest, submitValue, cancelValue,
    // tools + view toggles
    selectTool, setGuideMode, toggleGuideMode, setShowLabels, toggleShowLabels,
    // selection
    pick, clearSel, pickSegment, clearSegSel, marqueeSelect, marqueeSelectScreen, isPointId,
    // select-tool point drag, joining onto what it is dropped on
    dragPoint, dropPoint, cancelPointDrop, arcDragStart, arcDragMove, arcDragEnd, arcDragTransient, liveDoc,
    // drawing
    place, pathDown, pathMove, pathUp, finishPath, cancelPath, removeLastAnchor, getPathDrag, jointInfoForSegment, bowPreview,
    curveDown, curveMove, curveUp, getCurveDrag, getHeldHandles, handleIds, endGesture,
    // trim / cut / dissolve
    trimHover, trimHoverEnds, trimGhosts, cutHover, dissolveHover,
    trimDown, trimMove, trimUp, cutMove, cutClick, dissolveMove, dissolveClick, clearToolHover, clearTrimGhosts,
    // verbs
    runSolve, apply, applyWithValue, applyTangent, availableConstraints, orderRefs, del, nudge, fixSelected, makeConstruction, flip,
    repeatPrompt, armRepeat, doRepeat, applyRepeat, doMirror, applyMirror, cancelPendingOp,
    setArcRadius, setConstraintValue, removeConstraintById, onArcDimClick, onConstraintMarkClick,
    commitDimension,
    // copy / paste / select all / dissolve a point (pen stage 6)
    copySelection, pasteState, paste, copySvg, selectAll, dissolveState, dissolvePoint,
    // Properties: typed sizes, the radius lock, the hover highlight (pen stage 6)
    highlight, setHighlight, setPointXY, setLineLength, setLineAngle, setArcRadiusValue, setArcSweep, setArcLength,
    toggleArcRadiusLock, setCircleRadius, toggleCircleRadiusLock,
    // Clean up (pen stage 5)
    cleanup, toggleCleanup, startCleanup, applyCleanup, cancelCleanup, toggleCleanupFix, toggleCleanupKind, setCleanupStrength,
    // history
    undo, redo, canUndo, canRedo, reset, revert, commitHistory, initHistory,
    // session
    finishSession,
    // keys
    onKeydown, onKeyup, onBlur,
    // delight
    sparkle, sparkleCount, dispose,
  }
}

export type Pen = ReturnType<typeof usePen>

/** True while focus is in a text field — keys then belong to the field, not
 *  the pen or the host's viewport. Reads `document` only when called. */
export function isTypingInField(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)
}

/** True while focus is inside Clean up's strength / Cancel / Apply bar
 *  (`[data-cleanup-bar]`) — Space then presses the focused control, so a
 *  host's hold-Space-to-pan must leave Space alone. Nowhere else: a pen tool
 *  button a mouse click left focused keeps Space-to-pan (`:focus-visible`
 *  can't tell, it turns true on the first keydown). Reads `document` only
 *  when called. */
export function isCleanupBarFocused(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  return !!el?.closest?.('[data-cleanup-bar]')
}
