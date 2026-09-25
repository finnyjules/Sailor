// app/composables/pen/usePen.ts
// The arc pen's state and actions, hostable by any surface that owns a
// SketchDoc ref and a view matrix (the dev page today; the Frame editor and
// Shape Studio later). Moved verbatim out of pages/dev/sketch-draw.vue — the
// host keeps its viewport, rendering and pointer handlers, and registers the
// window key listeners itself (delegating to onKeydown/onKeyup/onBlur).
//
// Construction must stay side-effect free (vitest runs this in `node`): no
// onMounted/onUnmounted, no window.*, no requestAnimationFrame here. The
// sparkle loop starts lazily inside sparkle(); dispose() cancels it.
import { ref, shallowRef, computed, toRaw, type Ref } from 'vue'
import type { SketchDoc, SketchConstraint, EntityId, ConstraintKind, SegmentSpec } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addConstraint, removeConstraint, deleteEntity, addPath, repeatEntities, mirrorEntities, pointClosure, isPointReferenced, addSmoothHandles } from '~/lib/sketch/edit'
import { snapPoint, inferCircleTangents, tangentJointArc } from '~/lib/sketch/infer'
import { solve, type DragTarget } from '~/lib/sketch/solve'
import { dist, type Vec2 } from '~/lib/sketch/geom'
import { constraintMarks, type ConstraintMark, type ArcDimensionMark } from '~/lib/sketch/annotate'
import { cloneDoc } from '~/lib/sketch/clone'
import { applyView, type ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits, SNAP_PX, BOW_PX, MIN_RADIUS_PX } from '~/lib/sketch/tolerance'
import {
  availableConstraints as availableConstraintsFor,
  orderRefs as orderRefsFor,
  segmentConstraintRefs,
  type RuleOption,
} from './penRules'

// 'path' is the arc Pen; 'curve' is the Bézier Curve tool. Both add to the
// same pending path (see selectTool / curveDown).
export type PenTool = 'select' | 'point' | 'line' | 'circle' | 'path' | 'curve'
export interface PenOptions { openOnly?: boolean; tools?: PenTool[] }

export const SPARKLE_LIFETIME_MS = 380

// Shift-constrain (Illustrator/Figma-style): rotate `pt` about `prev` to the
// nearest 45° increment, preserving the distance between them. Pure — no doc
// reads/writes. Used for path line-segment placement only (see
// pathPlacementXY and the host's rubber-band preview); arc-bow drags ignore it.
export function snapAngle(prev: Vec2, pt: Vec2): Vec2 {
  const d = dist(prev, pt)
  if (d < 1e-9) return pt
  const ang = Math.atan2(pt.y - prev.y, pt.x - prev.x)
  const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
  return { x: prev.x + d * Math.cos(snapped), y: prev.y + d * Math.sin(snapped) }
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
export function bowArc(J: Vec2, end: Vec2, pointer: Vec2, tangentDir: Vec2 | null): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean } | null {
  const arc = tangentJointArc(J, end, pointer, tangentDir)
  if (!arc || arc.radius > 1e4) return null
  const TAU = Math.PI * 2
  const a0 = Math.atan2(J.y - arc.center.y, J.x - arc.center.x)
  const a1 = Math.atan2(end.y - arc.center.y, end.x - arc.center.x)
  const ccw = ((a1 - a0) % TAU + TAU) % TAU
  const span = arc.sweep === 1 ? ccw : TAU - ccw
  const large: 0 | 1 = span > Math.PI ? 1 : 0
  const am = arc.sweep === 1 ? a0 + span / 2 : a0 - span / 2
  const mid = { x: arc.center.x + arc.radius * Math.cos(am), y: arc.center.y + arc.radius * Math.sin(am) }
  return { center: arc.center, r: arc.radius, sweep: arc.sweep, large, mid, snappedTangent: arc.snappedTangent }
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
  | { kind: 'line'; p1: EntityId }
  | { kind: 'circle'; center: EntityId; cx: number; cy: number }
  | null
export type PendingPath = { anchors: EntityId[]; segments: SegmentSpec[] } | null
// the path tool's live down→(bow)→up gesture — plain (non-reactive) state, as
// it always was on the page; hosts read it through getPathDrag().
export type PathDrag = { anchor: EntityId; prevAnchor: EntityId; startX: number; startY: number; bowed: boolean } | null
// the Curve tool's live down→(drag)→up gesture: past the bow threshold the
// point being placed turns smooth and the pointer pulls out its handles.
export type CurveDrag = { anchor: EntityId; startX: number; startY: number; smooth: boolean } | null
const isDrawTool = (t: PenTool) => t === 'path' || t === 'curve'

// Arrow-key nudge, in screen pixels: 0.25 / 2.5 drawing units at the dev
// page's default 34 px/unit, so the default view moves exactly as before.
export const NUDGE_PX = 8.5
export const NUDGE_PX_SHIFT = 85

/** A screen-pixel delta as a drawing delta: solves M·d = s with the view's
 *  linear part (Cramer's rule, no reciprocal, so the y-up 34 px/unit view
 *  gives exactly 0.25 for 8.5 px). Null for a singular view. */
export function screenDeltaToDrawing(m: ViewMatrix, sx: number, sy: number): { x: number; y: number } | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return { x: (m.d * sx - m.c * sy) / det, y: (m.a * sy - m.b * sx) / det }
}

export function usePen(opts: {
  doc: Ref<SketchDoc>          // the host owns the ref; the pen mutates doc.value in place and replaces it on undo/redo/reset
  view: Ref<ViewMatrix>        // for tolerances only (Task 3); rendering uses it in Task 4
  options?: PenOptions
  onChange?: () => void        // after every committed history step, undo, redo and reset
  // the host's own live pointer gesture (the dev page's pan): Escape offers
  // it the chance to abort — return true if one was aborted (the key stops
  // there). PenOverlay's marquee is offered first, through onKeydown's
  // second argument.
  cancelGesture?: () => boolean
}) {
  const doc = opts.doc
  type Tool = PenTool

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
  // selection (below) are mutually exclusive — picking an entity always clears
  // any live segment selection first.
  function pick(id: EntityId, additive = false) {
    clearSegSel()
    if (!additive) { selection.value = [id]; return }
    const i = selection.value.indexOf(id)
    if (i >= 0) selection.value.splice(i, 1)
    else selection.value.push(id)
  }
  function clearSel() { selection.value = [] }

  // --- segment selection: individual { pathId, segIndex } picks, distinct from
  // (and mutually exclusive with) whole-entity `selection` above. additive=false
  // replaces; additive=true toggles the segment within the current set, mirroring
  // pick()'s own contract. Selecting a segment always clears any live entity
  // selection first — see pick()'s own clearSegSel() call for the reverse.
  const selectedSegments = ref<{ pathId: EntityId; segIndex: number }[]>([])
  function pickSegment(pathId: EntityId, segIndex: number, additive = false) {
    clearSel()
    if (!additive) { selectedSegments.value = [{ pathId, segIndex }]; return }
    const i = selectedSegments.value.findIndex(s => s.pathId === pathId && s.segIndex === segIndex)
    if (i >= 0) selectedSegments.value.splice(i, 1)
    else selectedSegments.value.push({ pathId, segIndex })
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
  const pendingOp = ref<
    | null
    | { kind: 'repeat'; units: EntityId[]; count: number }
    | { kind: 'mirror'; units: EntityId[] }
  >(null)
  function cancelPendingOp() { pendingOp.value = null }
  const opHint = computed(() => {
    const op = pendingOp.value
    if (!op) return null
    if (op.kind === 'repeat') return `Click the center of the ring — an existing point, or empty space to drop one (×${op.count})`
    return 'Click the mirror axis — a line to reflect across'
  })
  function isPointId(id: EntityId) {
    return (doc.value.entities.find(e => e.id === id) as any)?.kind === 'point'
  }

  // --- undo/redo history: plain snapshots of `doc`, taken after every
  // mutating action settles. `histPtr` points at the entry matching the
  // current `doc.value`; undo/redo just move it and restore that snapshot.
  const history = ref<SketchDoc[]>([])
  const histPtr = ref(-1)
  function initHistory() { history.value = [cloneDoc(doc.value)]; histPtr.value = 0 }
  function commitHistory() {
    // no-op guard: a settle that left `doc` structurally identical to the
    // current top-of-history entry (dragging a fixed point, Delete with an
    // empty selection, re-pinning a chip to its existing value, …) must not
    // push a duplicate snapshot — that would leave a dead undo step that
    // visibly "does nothing" the first time the user hits ⌘Z.
    const top = history.value[histPtr.value]
    if (top && JSON.stringify(top) === JSON.stringify(doc.value)) return
    // drop any redo tail, push a fresh snapshot
    history.value = history.value.slice(0, histPtr.value + 1)
    history.value.push(cloneDoc(doc.value))
    histPtr.value = history.value.length - 1
    if (history.value.length > 200) { history.value.shift(); histPtr.value-- }
    opts.onChange?.()
  }
  function undo() {
    if (histPtr.value <= 0) return
    histPtr.value--
    doc.value = cloneDoc(history.value[histPtr.value]!)
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    pathDrag = null
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    status.value = 'undo'
    opts.onChange?.()
  }
  function redo() {
    if (histPtr.value >= history.value.length - 1) return
    histPtr.value++
    doc.value = cloneDoc(history.value[histPtr.value]!)
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    pathDrag = null
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    status.value = 'redo'
    opts.onChange?.()
  }
  function canUndo() { return histPtr.value > 0 }
  function canRedo() { return histPtr.value < history.value.length - 1 }

  // Returns true when the key did something. PenOverlay reads that for
  // Escape / Enter: with nothing to cancel or finish, the key belongs to the
  // host ('cancel' / 'commit'). The "typing in a field" guard is the
  // caller's (PenOverlay's window listener runs isTypingInField once).
  // `local.cancelGesture` is the caller's own live gesture (the overlay's
  // marquee); it is offered Escape before the host's opts.cancelGesture.
  function onKeydown(ev: KeyboardEvent, local?: { cancelGesture?: () => boolean }): boolean {
    const meta = ev.metaKey || ev.ctrlKey
    if (meta) {
      const key = ev.key.toLowerCase()
      if (key === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return true }
      if ((key === 'z' && ev.shiftKey) || key === 'y') { ev.preventDefault(); redo(); return true }
      return false
    }
    // (viewport keys — ⌘0 fit, Space pan — are the host's; it handles them
    // before delegating here)

    // type-a-dimension: a draw gesture is "active" whenever pendingPath is set
    // — that covers both a pending line placement (rubber band to the next
    // anchor) and a live arc bow (pathDrag.bowed), see pathDown/pathMove/pathUp.
    // Digits + one decimal point accumulate into dimBuffer instead of doing
    // anything else; meta-combos already returned above, so this never steals
    // a Cmd/Ctrl+digit shortcut.
    const gestureActive = tool.value === 'path' && !!pendingPath.value
    if (gestureActive && /^[0-9]$/.test(ev.key)) { ev.preventDefault(); dimBuffer.value += ev.key; return true }
    if (gestureActive && ev.key === '.' && !dimBuffer.value.includes('.')) { ev.preventDefault(); dimBuffer.value += '.'; return true }

    if (ev.key === 'Escape') {
      if (pendingOp.value) { cancelPendingOp(); status.value = 'cancelled'; return true }
      // clearing a live dimension buffer takes priority over everything else —
      // a first Escape just clears the typed value, a second (now-empty-buffer)
      // Escape falls through to the normal marquee/pan/path-cancel handling.
      if (dimBuffer.value) { dimBuffer.value = ''; return true }
      // a live marquee drag or pan takes priority over path-cancel — abort
      // just that gesture (clear its state, no selection change, no doc
      // mutation) rather than falling through to cancelPath's path cleanup.
      if (local?.cancelGesture?.()) return true
      if (opts.cancelGesture?.()) return true
      if (!pendingPath.value) return false
      cancelPath()
      return true
    }
    if (ev.key === 'Enter') {
      if (gestureActive && dimBuffer.value) { ev.preventDefault(); commitDimension(); return true }
      if (pendingPath.value && pendingPath.value.anchors.length >= 2) { ev.preventDefault(); finishPath(false); return true }
      return false
    }
    if (ev.key === 'Backspace' || ev.key === 'Delete') {
      if (gestureActive && dimBuffer.value) {
        ev.preventDefault()
        dimBuffer.value = dimBuffer.value.slice(0, -1)
        return true
      }
      ev.preventDefault()   // don't let the browser interpret Backspace as back-nav
      if (pendingPath.value) { removeLastAnchor(); return true }
      if (selection.value.length) { del(); return true }
      return false
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      if (!selection.value.length) return false   // nothing selected: no-op, let the browser handle the key normally
      ev.preventDefault()
      // the step is in SCREEN pixels, so ↑ is screen-up under any view
      const step = ev.shiftKey ? NUDGE_PX_SHIFT : NUDGE_PX
      const sx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
      const sy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0   // screen y grows downward
      const d = screenDeltaToDrawing(opts.view.value, sx, sy)
      if (d) nudge(d.x, d.y)
      return true
    }
    return false
  }

  // the pen holds no key-held state of its own today (Space-pan is the
  // host's viewport); kept so a host can wire all three listeners uniformly.
  function onKeyup(_ev: KeyboardEvent) {}

  function onBlur() {}

  function apply(kind: ConstraintKind, value?: number) {
    if (selectedSegments.value.length) {
      const refs = segmentConstraintRefs(doc.value, kind, selectedSegments.value)
      if (refs) { const id = addConstraint(doc.value, kind, refs, value); sparkleAtConstraint(id) }
      clearSegSel()
      runSolve()
      commitHistory()
      return
    }
    const refs = orderRefsFor(doc.value, kind, selection.value)
    const id = addConstraint(doc.value, kind, refs, value)
    sparkleAtConstraint(id)
    clearSel()
    runSolve()
    commitHistory()
  }

  function applyWithValue(v: { kind: ConstraintKind; label: string; value?: boolean }) {
    if (!v.value) { apply(v.kind); return }
    const raw = window.prompt(v.label + ' value?', '3')
    if (raw == null) return                 // cancelled → no constraint (Bug 3)
    const n = Number(raw)
    if (!Number.isFinite(n)) return          // invalid → no constraint (Bug 3)
    apply(v.kind, n)
  }

  function del() {
    for (const id of [...selection.value]) deleteEntity(doc.value, id)
    clearSel()
    runSolve()
    commitHistory()
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

  function onArcDimClick(m: ArcDimensionMark): void {
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
    const raw = window.prompt('Radius?', current.toFixed(2))
    if (raw == null) return                  // cancelled → no change (Bug 3 pattern)
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return // invalid → no change
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
  function onConstraintMarkClick(m: ConstraintMark, ev: MouseEvent): void {
    if (m.text == null) { removeConstraintById(m.id); return }
    if (ev.shiftKey) { removeConstraintById(m.id); return }
    const c = doc.value.constraints.find(x => x.id === m.id)
    if (!c || c.value == null) return
    const raw = window.prompt((c.kind === 'radius' ? 'Radius' : 'Distance') + ' value?', c.value.toFixed(2))
    if (raw == null) return
    const n = Number(raw)
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
  function runSolve(drag?: DragTarget) {
    const plain: SketchDoc = {
      entities: doc.value.entities.map(e => ({
        ...toRaw(e),
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
  // a new point and the on-line/on-circle constraint the snap implies.
  // `construction` (guide mode) only affects a freshly-created point — a
  // coincident snap always reuses whatever the existing target point already is.
  // Every snap kind that actually captures a constraint (coincident reuse, or a
  // fresh pointOnLine/pointOnCircle) sparkles at the snapped location — see
  // sparkle() above.
  function placePoint(x: number, y: number, exclude: EntityId[] = [], construction = false): EntityId {
    // Bézier handles are construction points that belong to their anchor —
    // never a snap target (08-29 build note)
    const handles = handleIds()
    const ex = handles.size ? [...exclude, ...handles] : exclude
    const snapped = snapPoint(doc.value, x, y, { exclude: ex, tol: pxToUnits(SNAP_PX, opts.view.value) })
    if (snapped.snap?.kind === 'coincident') { sparkle(snapped.x, snapped.y); return snapped.snap.targetId }
    const id = addPoint(doc.value, snapped.x, snapped.y, { construction })
    if (snapped.snap?.kind === 'pointOnLine') { addConstraint(doc.value, 'pointOnLine', [id, snapped.snap.targetId]); sparkle(snapped.x, snapped.y) }
    else if (snapped.snap?.kind === 'pointOnCircle') { addConstraint(doc.value, 'pointOnCircle', [id, snapped.snap.targetId]); sparkle(snapped.x, snapped.y) }
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
        const p1 = placePoint(x, y, [], guideMode.value)
        pending.value = { kind: 'line', p1 }
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
        const center = placePoint(x, y, [], guideMode.value)
        const c = doc.value.entities.find(e => e.id === center) as any
        pending.value = { kind: 'circle', center, cx: c.x, cy: c.y }
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
  // Shift placement (pathPlacementXY/snapAngle, above) snaps the anchor's
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

  function pathPlacementXY(x: number, y: number, shift: boolean): Vec2 {
    const pp = pendingPath.value
    if (!shift || !pp || pp.anchors.length === 0) return { x, y }
    const prev = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
    if (!prev || prev.kind !== 'point') return { x, y }
    return snapAngle({ x: prev.x, y: prev.y }, { x, y })
  }

  function pathClick(x: number, y: number, shift = false) {
    const p = pathPlacementXY(x, y, shift)
    const id = placePoint(p.x, p.y, [], guideMode.value)
    if (!pendingPath.value) { pendingPath.value = { anchors: [id], segments: [] }; commitHistory(); return }
    const pp = pendingPath.value
    const prev = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
    if (id === pp.anchors[0] && pp.anchors.length >= 2) { finishPath(true); return }  // clicked first anchor → close (finishPath commits)
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

  function pathDown(x: number, y: number, shift = false) {
    const p = pathPlacementXY(x, y, shift)
    const id = placePoint(p.x, p.y, [], guideMode.value)
    if (!pendingPath.value) {
      pendingPath.value = { anchors: [id], segments: [] }
      pathDrag = null
      commitHistory()   // first anchor of a fresh path — a complete, standalone placement
      return
    }
    const pp = pendingPath.value
    if (id === pp.anchors[0] && pp.anchors.length >= 2) { finishPath(true); pathDrag = null; return }  // clicked first anchor → close (finishPath commits)
    if (id === pp.anchors[pp.anchors.length - 1]) { pathDrag = null; return }                            // ignore double-click same point
    const prevAnchor = pp.anchors[pp.anchors.length - 1]!
    dropLastHOut()   // a line/arc segment has no use for a Curve point's out-handle
    pp.segments.push({ kind: 'line' })
    pp.anchors.push(id)
    if (shift) captureAxisConstraint(prevAnchor, id)
    // don't commit here — this anchor+segment (and any shift-captured axis
    // constraint) settle as ONE history entry together with whatever pathUp
    // does next (a plain click, or bowing the segment into an arc)
    pathDrag = { anchor: id, prevAnchor, startX: x, startY: y, bowed: false }
  }

  function pathMove(x: number, y: number, shift = false) {
    // reactive — drives previewD/pathBowChip live, whether this came from a
    // real pointermove or a direct __sketchDraw.pathMove() call (tests)
    cursor.value = { x, y, shift }
    if (!pathDrag) return
    if (dist({ x, y }, { x: pathDrag.startX, y: pathDrag.startY }) > pxToUnits(BOW_PX, opts.view.value)) pathDrag.bowed = true
  }

  // Commits the currently-bowing segment (pathDrag.bowed) into an arc through
  // `pointer` — the "place the arc as usual" step shared by a normal pathUp
  // release and a typed-radius commit (applyArcDimension below), so the two
  // can't drift apart. Returns the new center point id, or null if bowArc
  // couldn't fit (near-collinear / enormous radius) or nothing is bowing —
  // callers treat null as "segment stayed a plain line, nothing to pin".
  function commitBowedSegment(pointer: Vec2): EntityId | null {
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
    const arc = bowArc({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, pointer, joint?.tangentDir ?? null)
    if (!arc) return null
    const c = addPoint(doc.value, arc.center.x, arc.center.y)
    pp.segments[segIndex] = { kind: 'arc', center: c, sweep: arc.sweep }
    // tangent-continuous with the previous segment: wire the joint constraint
    // so the solver keeps the flow smooth after later drags (see brief §joint)
    if (arc.snappedTangent && joint) {
      if (joint.prevKind === 'arc') addConstraint(doc.value, 'collinear', [joint.Cprev, prevAnchor, c])
      else addConstraint(doc.value, 'perpendicular', [joint.La, joint.Lb, prevAnchor, c])
      sparkle(p0.x, p0.y)   // joint anchor J
    }
    return c
  }

  function pathUp(x: number, y: number) {
    if (!pathDrag) return
    commitBowedSegment({ x, y })
    pathDrag = null
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
    const c = commitBowedSegment(cursor.value)
    pathDrag = null
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
    const dx = cursor.value.x - prev.x, dy = cursor.value.y - prev.y
    const d = Math.hypot(dx, dy)
    const dir = d > 1e-9 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 }   // cursor sitting on the anchor: fall back to +x
    const id = placePoint(prev.x + dir.x * value, prev.y + dir.y * value, [prevId], guideMode.value)
    pp.segments.push({ kind: 'line' })
    pp.anchors.push(id)
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
    const id = placePoint(x, y, [], guideMode.value)
    if (!pendingPath.value) {
      pendingPath.value = { anchors: [id], segments: [] }
      lastHOut = null
      firstHIn = null
      // no commit yet: the first point (and its handles, if dragged) settle as
      // one history entry in curveUp
      curveDrag.value = { anchor: id, startX: x, startY: y, smooth: false }
      return
    }
    const pp = pendingPath.value
    if (id === pp.anchors[0] && pp.anchors.length >= 2) { finishPath(true); curveDrag.value = null; return }  // clicked first point → close (finishPath commits)
    if (id === pp.anchors[pp.anchors.length - 1]) { curveDrag.value = null; return }                            // ignore double-click same point
    pp.segments.push({ kind: 'cubic', h1: lastHOut, h2: null })
    pp.anchors.push(id)
    curveDrag.value = { anchor: id, startX: x, startY: y, smooth: false }
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

  // low-level applies — used by both the fast path (center/axis already in the
  // selection) and the guided pick. clearSel first so the center-point click
  // that armed nothing lingers selected.
  function applyRepeat(units: EntityId[], center: EntityId, count: number) {
    if (!units.length || !Number.isFinite(count) || count < 2) return
    repeatEntities(doc.value, units, center, Math.round(count))
    clearSel(); pendingOp.value = null; runSolve(); commitHistory()
    status.value = `Repeated ×${Math.round(count)}`
  }
  function applyMirror(units: EntityId[], axisLine: EntityId) {
    if (!units.length) return
    mirrorEntities(doc.value, units, axisLine)
    clearSel(); pendingOp.value = null; runSolve(); commitHistory()
    status.value = 'Mirrored'
  }
  // kept for the test hook / fast path: exact-selection repeat (1 point + units)
  function doRepeat(count: number) {
    const ptSel = selection.value.filter(id => isPointId(id))
    const entSel = selection.value.filter(id => !ptSel.includes(id))
    if (ptSel.length !== 1 || entSel.length === 0) return
    applyRepeat(entSel, ptSel[0]!, count)
  }
  function repeatPrompt() {
    const ptSel = selection.value.filter(id => isPointId(id))
    const entSel = selection.value.filter(id => !ptSel.includes(id))
    if (entSel.length === 0) { status.value = 'Select a shape first, then Repeat…'; return }
    const raw = window.prompt('How many copies around the ring?', '6')
    if (raw == null) return
    const count = Number(raw)
    if (!Number.isFinite(count) || count < 2) { status.value = 'Repeat needs a count of 2 or more'; return }
    // fast path: a center point is already part of the selection
    if (ptSel.length === 1) { applyRepeat(entSel, ptSel[0]!, count); return }
    // guided: arm the center pick
    armRepeat(entSel, count)
  }
  // arm the guided center-pick for the given units + count (no prompt). Used by
  // repeatPrompt's guided branch and the __sketchDraw.armRepeat test hook.
  function armRepeat(units: EntityId[], count: number) {
    if (!units.length || !Number.isFinite(count) || count < 2) return
    pendingOp.value = { kind: 'repeat', units: [...units], count }
    status.value = `Now click the center of the ring (×${count})`
  }
  function doMirror() {
    const lineSel = selection.value.filter(id => (doc.value.entities.find(e => e.id === id) as any)?.kind === 'line')
    const entSel = selection.value.filter(id => !lineSel.includes(id))
    if (entSel.length === 0) { status.value = 'Select a shape first, then Mirror'; return }
    // fast path: an axis line is already part of the selection
    if (lineSel.length === 1) { applyMirror(entSel, lineSel[0]!); return }
    // guided: arm the axis pick
    pendingOp.value = { kind: 'mirror', units: entSel }
    status.value = 'Now click the mirror axis (a line)'
  }
  function flip(axis: 'h' | 'v') {
    const ptIds = pointClosure(doc.value, selection.value)
    const pts = ptIds.map(id => doc.value.entities.find(e => e.id === id)).filter((e: any) => e?.kind === 'point') as any[]
    if (!pts.length) return
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    for (const p of pts) { if (axis === 'h') p.x = 2 * cx - p.x; else p.y = 2 * cy - p.y }
    runSolve()
    commitHistory()
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
  function cleanupPendingPath() {
    const pp = pendingPath.value
    if (!pp) return
    const candidates = new Set<EntityId>(pp.anchors)
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
    pathDrag = null
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
    const lastSeg = pp.segments.length ? pp.segments.pop() : undefined
    const candidates: EntityId[] = [lastAnchor]
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
      pathDrag = null
      resetCurveState()
      cursor.value = null
    }
    if (doc.value.entities.length !== before) commitHistory()
  }

  function selectTool(t: Tool) {
    // Pen ↔ Curve mid-path keeps drawing the same path: the next segment's kind
    // follows whichever of the two is active when its end point is placed
    if (pendingPath.value && isDrawTool(tool.value) && isDrawTool(t)) {
      tool.value = t
      pathDrag = null
      curveDrag.value = null
      dimBuffer.value = ''
      return
    }
    cleanupPendingAndCommit()
    cancelPendingOp()   // a half-armed Repeat/Mirror never survives a tool switch
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
    pathDrag = null
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
  }

  function reset() {
    cleanupPendingPath()
    doc.value = { entities: [], constraints: [] }
    clearSel()
    clearSegSel()
    pending.value = null
    pendingPath.value = null
    pathDrag = null
    resetCurveState()
    cursor.value = null
    dimBuffer.value = ''
    status.value = 'ready'
    initHistory()
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
  function getPathDrag(): PathDrag { return pathDrag }

  // stop the sparkle loop — the host calls this when it unmounts
  function dispose() {
    if (sparkleRaf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(sparkleRaf)
    sparkleRaf = 0
  }

  initHistory()

  return {
    // the host's doc ref, handed back so a renderer (PenOverlay) needs only the pen
    doc,
    // state
    tool, guideMode, showLabels, status, selection, selectedSegments, pending, pendingPath,
    pendingOp, opHint, cursor, dimBuffer, nextSegment, sparkles, sparkleClock,
    // tools + view toggles
    selectTool, setGuideMode, toggleGuideMode, setShowLabels, toggleShowLabels,
    // selection
    pick, clearSel, pickSegment, clearSegSel, marqueeSelect, marqueeSelectScreen, isPointId,
    // drawing
    place, pathDown, pathMove, pathUp, finishPath, cancelPath, removeLastAnchor, getPathDrag, jointInfoForSegment,
    curveDown, curveMove, curveUp, getCurveDrag, getHeldHandles, handleIds,
    // verbs
    runSolve, apply, applyWithValue, availableConstraints, orderRefs, del, nudge, fixSelected, makeConstruction, flip,
    repeatPrompt, armRepeat, doRepeat, applyRepeat, doMirror, applyMirror, cancelPendingOp,
    setArcRadius, setConstraintValue, removeConstraintById, onArcDimClick, onConstraintMarkClick,
    commitDimension,
    // history
    undo, redo, canUndo, canRedo, reset, commitHistory, initHistory,
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
