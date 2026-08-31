<!-- app/pages/dev/sketch-draw.vue -->
<script setup lang="ts">
// Dev harness — not linked in the app. Interactive constraint drawing surface.
definePageMeta({ layout: false })
import { ref, computed, onMounted, onUnmounted, toRaw } from 'vue'
import type { SketchDoc, SketchConstraint, EntityId, ConstraintKind, SegmentSpec } from '~/lib/sketch/model'
import { addPoint, addLine, addCircle, addConstraint, removeConstraint, deleteEntity, addPath, repeatEntities, mirrorEntities, pointClosure, isPointReferenced } from '~/lib/sketch/edit'
import { snapPoint, inferCircleTangents, tangentJointArc } from '~/lib/sketch/infer'
import { solve, type DragTarget } from '~/lib/sketch/solve'
import { sketchPathData, entityPath } from '~/lib/sketch/sketchPath'
import { dist, type Vec2 } from '~/lib/sketch/geom'
import { constraintMarks, arcDimensionMarks, type ConstraintMark, type ArcDimensionMark } from '~/lib/sketch/annotate'
import { cloneDoc } from '~/lib/sketch/clone'

type Tool = 'select' | 'point' | 'line' | 'circle' | 'path'

const doc = ref<SketchDoc>({ entities: [], constraints: [] })
const tool = ref<Tool>('select')
const status = ref('ready')
const ready = ref(false)
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

// world→screen: viewport is VIEW state, not model — pan/zoom never touch
// `doc` or history (see commitHistory below; undo must never undo a zoom/pan).
// Defaults match the old fixed constants: 34px/unit, origin lower-left of a
// 680x460 board.
const scale = ref(34)
const panX = ref(40)
const panY = ref(400)
const sx = (x: number) => panX.value + x * scale.value
const sy = (y: number) => panY.value - y * scale.value
const wx = (px: number) => (px - panX.value) / scale.value
const wy = (py: number) => (panY.value - py) / scale.value

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }

// zoom toward the cursor: keep the world point currently under (cx, cy) —
// screen-space pixels relative to the svg's own rect — fixed on screen after
// the scale change. Compute the world point BEFORE changing scale, then
// re-derive pan from `sx(w.x) === cx, sy(w.y) === cy` at the new scale.
function zoomAt(cx: number, cy: number, factor: number) {
  const w = { x: wx(cx), y: wy(cy) }
  scale.value = clamp(scale.value * factor, 4, 400)
  panX.value = cx - w.x * scale.value
  panY.value = cy + w.y * scale.value
}
function panBy(dxPx: number, dyPx: number) {
  panX.value += dxPx
  panY.value += dyPx
}
function fitView() {
  scale.value = 34
  panX.value = 40
  panY.value = 400
}
function getViewport() { return { scale: scale.value, panX: panX.value, panY: panY.value } }

// spacebar-held pan (tracked via onKeydown/onKeyup) and the live drag itself
// — screen-pixel delta from the pointerdown origin, never touches `doc`.
const spaceHeld = ref(false)
const panning = ref(false)
let panStartClientX = 0, panStartClientY = 0
let panStartPanX = 0, panStartPanY = 0
function panTrigger(ev: PointerEvent) { return spaceHeld.value || ev.button === 1 }
function startPan(ev: PointerEvent) {
  panning.value = true
  panStartClientX = ev.clientX
  panStartClientY = ev.clientY
  panStartPanX = panX.value
  panStartPanY = panY.value
  ev.preventDefault()
}
const svgCursor = computed(() => panning.value ? 'grabbing' : spaceHeld.value ? 'grab' : 'crosshair')

// in-progress multi-click draws
type Pending =
  | { kind: 'line'; p1: EntityId }
  | { kind: 'circle'; center: EntityId; cx: number; cy: number }
  | null
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
  cursor.value = null
  dimBuffer.value = ''
  status.value = 'undo'
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
  cursor.value = null
  dimBuffer.value = ''
  status.value = 'redo'
}
function canUndo() { return histPtr.value > 0 }
function canRedo() { return histPtr.value < history.value.length - 1 }

function onKeydown(ev: KeyboardEvent) {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  const meta = ev.metaKey || ev.ctrlKey
  if (meta) {
    const key = ev.key.toLowerCase()
    if (key === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return }
    if ((key === 'z' && ev.shiftKey) || key === 'y') { ev.preventDefault(); redo(); return }
    if (key === '0') { ev.preventDefault(); fitView(); return }
    return
  }
  if (ev.code === 'Space' || ev.key === ' ') { ev.preventDefault(); spaceHeld.value = true; return }

  // type-a-dimension: a draw gesture is "active" whenever pendingPath is set
  // — that covers both a pending line placement (rubber band to the next
  // anchor) and a live arc bow (pathDrag.bowed), see pathDown/pathMove/pathUp.
  // Digits + one decimal point accumulate into dimBuffer instead of doing
  // anything else; meta-combos already returned above, so this never steals
  // a Cmd/Ctrl+digit shortcut.
  const gestureActive = tool.value === 'path' && !!pendingPath.value
  if (gestureActive && /^[0-9]$/.test(ev.key)) { ev.preventDefault(); dimBuffer.value += ev.key; return }
  if (gestureActive && ev.key === '.' && !dimBuffer.value.includes('.')) { ev.preventDefault(); dimBuffer.value += '.'; return }

  if (ev.key === 'Escape') {
    if (pendingOp.value) { cancelPendingOp(); status.value = 'cancelled'; return }
    // clearing a live dimension buffer takes priority over everything else —
    // a first Escape just clears the typed value, a second (now-empty-buffer)
    // Escape falls through to the normal marquee/pan/path-cancel handling.
    if (dimBuffer.value) { dimBuffer.value = ''; return }
    // a live marquee drag or pan takes priority over path-cancel — abort
    // just that gesture (clear its state, no selection change, no doc
    // mutation) rather than falling through to cancelPath's path cleanup.
    if (marqueeStart) { marqueeStart = null; marqueeMoved = false; marqueeRect.value = null; return }
    if (panning.value) { panning.value = false; return }
    cancelPath()
    return
  }
  if (ev.key === 'Enter') {
    if (gestureActive && dimBuffer.value) { ev.preventDefault(); commitDimension(); return }
    if (pendingPath.value && pendingPath.value.anchors.length >= 2) { ev.preventDefault(); finishPath(false) }
    return
  }
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    if (gestureActive && dimBuffer.value) {
      ev.preventDefault()
      dimBuffer.value = dimBuffer.value.slice(0, -1)
      return
    }
    ev.preventDefault()   // don't let the browser interpret Backspace as back-nav
    if (pendingPath.value) removeLastAnchor()
    else if (selection.value.length) del()
    return
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    if (!selection.value.length) return   // nothing selected: no-op, let the browser handle the key normally
    ev.preventDefault()
    const step = ev.shiftKey ? 2.5 : 0.25
    const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
    const dy = ev.key === 'ArrowUp' ? step : ev.key === 'ArrowDown' ? -step : 0   // screen-up = larger world y (see sy())
    nudge(dx, dy)
  }
}

function onKeyup(ev: KeyboardEvent) {
  if (ev.code === 'Space' || ev.key === ' ') spaceHeld.value = false
}

function onBlur() {
  spaceHeld.value = false
  panning.value = false
}

function selKinds(): string[] {
  return selection.value.map(id => doc.value.entities.find(e => e.id === id)?.kind ?? '?')
}

// interior line-line corner of a path at anchor `pointId`: the previous and
// next anchors along the path, when both segments meeting at it are straight
// lines (an arc has no fixed direction at the joint, so any corner touching
// one is excluded). Open path: only a true interior anchor qualifies (not the
// first/last, which have just one adjacent segment). Closed path: any anchor
// qualifies, wrapping around. Returns the first path entity where this holds,
// or null if `pointId` isn't such a corner on any path.
function pathCornerInfo(pointId: EntityId): { prev: EntityId; corner: EntityId; next: EntityId } | null {
  for (const e of doc.value.entities) {
    if (e.kind !== 'path') continue
    const n = e.anchors.length
    for (let i = 0; i < n; i++) {
      if (e.anchors[i] !== pointId) continue
      if (!e.closed && (i === 0 || i === n - 1)) continue
      const prevSeg = e.segments[(i - 1 + n) % n]
      const nextSeg = e.segments[i]
      if (!prevSeg || !nextSeg) continue
      if (prevSeg.kind !== 'line' || nextSeg.kind !== 'line') continue
      return { prev: e.anchors[(i - 1 + n) % n]!, corner: pointId, next: e.anchors[(i + 1) % n]! }
    }
  }
  return null
}

// which verbs apply to the current selection (order = display order)
function availableConstraints(): { kind: ConstraintKind; label: string; value?: boolean }[] {
  const ids = selection.value
  const kinds = selKinds()
  const out: { kind: ConstraintKind; label: string; value?: boolean }[] = []
  const count = (k: string) => kinds.filter(x => x === k).length
  if (ids.length === 2 && count('point') === 2) {
    out.push({ kind: 'coincident', label: 'Coincident' }, { kind: 'distance', label: 'Distance…', value: true })
  }
  if (ids.length === 2 && count('circle') === 2) {
    out.push({ kind: 'concentric', label: 'Concentric' }, { kind: 'tangentCircleCircle', label: 'Tangent' }, { kind: 'equalRadius', label: 'Equal' })
  }
  if (ids.length === 2 && count('line') === 1 && count('circle') === 1) {
    out.push({ kind: 'tangentLineCircle', label: 'Tangent' })
  }
  if (ids.length === 2 && count('point') === 1 && count('line') === 1) {
    out.push({ kind: 'pointOnLine', label: 'Point on line' }, { kind: 'midpoint', label: 'Midpoint' })
  }
  if (ids.length === 2 && count('point') === 1 && count('circle') === 1) {
    out.push({ kind: 'pointOnCircle', label: 'Point on circle' })
  }
  if (ids.length === 1 && count('line') === 1) {
    out.push({ kind: 'horizontal', label: 'Horizontal' }, { kind: 'vertical', label: 'Vertical' })
  }
  if (ids.length === 1 && count('circle') === 1) {
    out.push({ kind: 'radius', label: 'Radius…', value: true })
  }
  if (ids.length === 2 && count('line') === 2) {
    out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
  }
  if (ids.length === 1 && count('point') === 1 && pathCornerInfo(ids[0]!)) {
    out.push({ kind: 'perpendicular', label: 'Right angle' })
  }
  // segment verbs — only offered while entity selection is empty (mutually
  // exclusive with the gates above by construction, but gated explicitly too)
  // and only for LINE segments (v1 scope — see segmentAnchorPair/isLineSegment).
  if (!ids.length && selectedSegments.value.length === 1) {
    const s = selectedSegments.value[0]!
    if (isLineSegment(s)) out.push({ kind: 'horizontal', label: 'Horizontal' }, { kind: 'vertical', label: 'Vertical' })
  }
  if (!ids.length && selectedSegments.value.length === 2) {
    const [s1, s2] = selectedSegments.value as [{ pathId: EntityId; segIndex: number }, { pathId: EntityId; segIndex: number }]
    if (isLineSegment(s1) && isLineSegment(s2)) {
      out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
    }
  }
  return out
}

// a segment's own two anchor ids, [anchors[i], anchors[(i+1)%n]] — the same
// pair the residual reads for a line (see horizontal/vertical/perpendicular/
// parallel/equalDist in residuals.ts). null if the path or index no longer
// resolves (e.g. a stale selectedSegments entry after an undo/delete).
function segmentAnchorPair(pathId: EntityId, segIndex: number): [EntityId, EntityId] | null {
  const path = doc.value.entities.find(e => e.id === pathId) as any
  if (!path || path.kind !== 'path') return null
  const n = path.anchors.length
  const a = path.anchors[segIndex]
  const b = path.anchors[(segIndex + 1) % n]
  if (!a || !b) return null
  return [a, b]
}
// v1 scope: segment verbs (H/V/perpendicular/parallel/equal) only apply to
// straight LINE segments — an arc has no single direction to pin flat or
// compare, so it's excluded from every segment-verb gate rather than papering
// over it with the chord direction.
function isLineSegment(seg: { pathId: EntityId; segIndex: number }): boolean {
  const path = doc.value.entities.find(e => e.id === seg.pathId) as any
  return !!path && path.kind === 'path' && path.segments[seg.segIndex]?.kind === 'line'
}
// map 1 or 2 selected segments to the constraint's point refs — the segment
// analogue of orderRefs, but simpler: there's exactly one ref shape per arity
// (H/V take a segment's own 2-point pair directly; perpendicular/parallel/
// equalDist take the 4-point [a1,b1,a2,b2] form two lines already use above).
// Guard: all involved segments MUST be line segments (v1 scope — arc segments
// are excluded from every segment-verb constraint).
function segmentConstraintRefs(kind: ConstraintKind, segs: { pathId: EntityId; segIndex: number }[]): EntityId[] | null {
  // Guard: reject if ANY involved segment is not a line segment
  if (!segs.every(seg => isLineSegment(seg))) return null

  if (segs.length === 1 && (kind === 'horizontal' || kind === 'vertical')) {
    return segmentAnchorPair(segs[0]!.pathId, segs[0]!.segIndex)
  }
  if (segs.length === 2 && (kind === 'perpendicular' || kind === 'parallel' || kind === 'equalDist')) {
    const p1 = segmentAnchorPair(segs[0]!.pathId, segs[0]!.segIndex)
    const p2 = segmentAnchorPair(segs[1]!.pathId, segs[1]!.segIndex)
    if (!p1 || !p2) return null
    return [p1[0], p1[1], p2[0], p2[1]]
  }
  return null
}

// refs order per kind (matches residuals.ts contract)
function orderRefs(kind: ConstraintKind, ids: EntityId[]): EntityId[] {
  const ent = (id: EntityId) => doc.value.entities.find(e => e.id === id)!
  if (kind === 'perpendicular' || kind === 'parallel') {
    // both refs are two LINE entity ids (from the two-lines-selected gate in
    // availableConstraints) — the residual wants 4 POINT refs: each line's
    // anchors, [L1.p1, L1.p2, L2.p1, L2.p2]. Fall back to the raw ids
    // (shouldn't happen given the gate) if either isn't actually a line.
    if (ids.length === 2) {
      const l1 = ent(ids[0]!), l2 = ent(ids[1]!)
      if (l1.kind === 'line' && l2.kind === 'line') return [l1.p1, l1.p2, l2.p1, l2.p2]
    }
    // single selected point that's a line-line path corner (the "Right angle"
    // gate above) — refs are [prev, corner, corner, next] so the shared
    // residual reads it as two segment directions meeting at `corner`.
    if (kind === 'perpendicular' && ids.length === 1) {
      const corner = pathCornerInfo(ids[0]!)
      if (corner) return [corner.prev, corner.corner, corner.corner, corner.next]
    }
    return ids.slice()
  }
  if (kind === 'tangentLineCircle' || kind === 'pointOnLine') {
    // [line|point-then-line]: for tangentLineCircle → [line, circle]; for pointOnLine → [point, line]
    if (kind === 'tangentLineCircle') return ids.slice().sort(a => (ent(a).kind === 'line' ? -1 : 1))
    return ids.slice().sort(a => (ent(a).kind === 'point' ? -1 : 1))
  }
  if (kind === 'pointOnCircle') return ids.slice().sort(a => (ent(a).kind === 'point' ? -1 : 1))
  if (kind === 'midpoint') {
    // 1 point + 1 line selected (the Midpoint gate above) — residual wants
    // [P, lineA, lineB]: the point, then the line's own two anchor ids.
    if (ids.length === 2) {
      const pt = ids.find(id => ent(id).kind === 'point')
      const ln = ids.find(id => ent(id).kind === 'line')
      if (pt && ln) {
        const l = ent(ln) as any
        return [pt, l.p1, l.p2]
      }
    }
    return ids.slice()
  }
  if (kind === 'equalDist' && ids.length === 2) {
    // two LINE entity ids (from the two-lines-selected gate) — the residual
    // wants 4 POINT refs: each line's anchors, [L1.p1, L1.p2, L2.p1, L2.p2].
    const l1 = ent(ids[0]!), l2 = ent(ids[1]!)
    if (l1.kind === 'line' && l2.kind === 'line') return [l1.p1, l1.p2, l2.p1, l2.p2]
    return ids.slice()
  }
  return ids.slice()
}

function apply(kind: ConstraintKind, value?: number) {
  if (selectedSegments.value.length) {
    const refs = segmentConstraintRefs(kind, selectedSegments.value)
    if (refs) { const id = addConstraint(doc.value, kind, refs, value); sparkleAtConstraint(id) }
    clearSegSel()
    runSolve()
    commitHistory()
    return
  }
  const refs = orderRefs(kind, selection.value)
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
// below). Purely visual: no doc mutation, no solve, no history entry. Page-
// only — performance.now/requestAnimationFrame are fine on this page (see
// CLAUDE.md's "page, not lib/sketch" carve-out) but never belong in lib/sketch.
const SPARKLE_LIFETIME_MS = 380
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
  if (!sparkleRaf) sparkleRaf = requestAnimationFrame(sparkleTick)
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

// screen-space render data for every live sparkle: a small burst of short
// rays radiating from the point, ease-out pop (quick to full extent, within
// the first half of its life) + linear fade to 0 opacity by SPARKLE_LIFETIME_MS.
const SPARKLE_RAYS = 6
const sparkleRender = computed(() => sparkles.value.map(s => {
  const t = clamp((sparkleClock.value - s.born) / SPARKLE_LIFETIME_MS, 0, 1)
  const pop = 1 - Math.pow(1 - Math.min(t * 2, 1), 3)
  const opacity = 1 - t
  const cx = sx(s.x), cy = sy(s.y)
  const inner = 3 + 4 * pop
  const outer = inner + 4 * pop
  const rays = Array.from({ length: SPARKLE_RAYS }, (_, k) => {
    const ang = (k / SPARKLE_RAYS) * Math.PI * 2
    return { x1: cx + Math.cos(ang) * inner, y1: cy + Math.sin(ang) * inner,
             x2: cx + Math.cos(ang) * outer, y2: cy + Math.sin(ang) * outer }
  })
  return { id: s.id, opacity, rays }
}))

// place a point, honoring a snap: reuse the snapped point (coincident) or create
// a new point and the on-line/on-circle constraint the snap implies.
// `construction` (guide mode) only affects a freshly-created point — a
// coincident snap always reuses whatever the existing target point already is.
// Every snap kind that actually captures a constraint (coincident reuse, or a
// fresh pointOnLine/pointOnCircle) sparkles at the snapped location — see
// sparkle() above.
function placePoint(x: number, y: number, exclude: EntityId[] = [], construction = false): EntityId {
  const snapped = snapPoint(doc.value, x, y, { exclude })
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
      const r = Math.max(0.2, dist({ x, y }, { x: pending.value.cx, y: pending.value.cy }))
      const cid = addCircle(doc.value, pending.value.center, r, { construction: guideMode.value })
      // auto-capture tangency to existing geometry
      for (const t of inferCircleTangents(doc.value, pending.value.cx, pending.value.cy, r, { exclude: [cid] })) {
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
type PendingPath = { anchors: EntityId[]; segments: SegmentSpec[] } | null
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

// Shift-constrain (Illustrator/Figma-style): rotate `pt` about `prev` to the
// nearest 45° increment, preserving the distance between them. Pure — no doc
// reads/writes. Used for path line-segment placement only (see
// pathPlacementXY and previewD's rubber-band branch); arc-bow drags ignore it.
function snapAngle(prev: Vec2, pt: Vec2): Vec2 {
  const d = dist(prev, pt)
  if (d < 1e-9) return pt
  const ang = Math.atan2(pt.y - prev.y, pt.x - prev.x)
  const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
  return { x: prev.x + d * Math.cos(snapped), y: prev.y + d * Math.sin(snapped) }
}

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
function bowArc(J: Vec2, end: Vec2, pointer: Vec2, tangentDir: Vec2 | null): { center: Vec2; r: number; sweep: 0 | 1; large: 0 | 1; mid: Vec2; snappedTangent: boolean } | null {
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
// segment to be tangent to) — bowArc then falls back to a free arc, same as
// before this joint-tangent wiring existed.
type JointInfo =
  | { tangentDir: Vec2; prevKind: 'line'; La: EntityId; Lb: EntityId }
  | { tangentDir: Vec2; prevKind: 'arc'; Cprev: EntityId }
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
type PathDrag = { anchor: EntityId; prevAnchor: EntityId; startX: number; startY: number; bowed: boolean } | null
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
  if (dist({ x, y }, { x: pathDrag.startX, y: pathDrag.startY }) > 0.15) pathDrag.bowed = true
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

// closing segment between last and first anchors — the path tool always closes with a line.
function closingSegment(): SegmentSpec {
  return { kind: 'line' }
}

function finishPath(close = false) {
  const pp = pendingPath.value
  pendingPath.value = null
  dimBuffer.value = ''
  if (!pp || pp.anchors.length < 2) return
  if (close) {
    // closing segment of the current kind between last and first anchors
    if (nextSegment.value === 'arc') {
      const a = doc.value.entities.find(e => e.id === pp.anchors[pp.anchors.length - 1]) as any
      const b = doc.value.entities.find(e => e.id === pp.anchors[0]) as any
      const c = addPoint(doc.value, (a.x + b.x) / 2 - (b.y - a.y) / 2, (a.y + b.y) / 2 + (b.x - a.x) / 2)
      pp.segments.push({ kind: 'arc', center: c, sweep: 1 })
    } else pp.segments.push(closingSegment())
  }
  addPath(doc.value, pp.anchors, pp.segments, close, { construction: guideMode.value })
  runSolve()
  commitHistory()
}

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
function copySvg(): string {
  const d = sketchPathData(doc.value)
  try { navigator.clipboard?.writeText(d)?.catch?.(() => {}) } catch {}
  return d
}

// rendering: remap to screen via a shadow doc (points scaled, radii * scale)
// the y-flip mirrors arc winding, so arc segments carried into the shadow doc
// have their sweep flipped to keep the rendered curve on the correct side
function toShadowEntities(d: SketchDoc) {
  return d.entities.map(e => e.kind === 'point'
    ? { ...e, x: sx(e.x), y: sy(e.y) }
    : e.kind === 'circle' ? { ...e, r: e.r * scale.value }
    : e.kind === 'path' ? { ...e, segments: e.segments.map(s => s.kind === 'arc' ? { ...s, sweep: (1 - s.sweep) as 0 | 1 } : s) }
    : { ...e })
}
const shadowDoc = computed<SketchDoc>(() => ({ entities: toShadowEntities(doc.value), constraints: [] }))
const pathScreen = computed(() => sketchPathData(shadowDoc.value))
const constructionScreen = computed(() => {
  const d = doc.value
  const shadow = shadowDoc.value
  const parts: string[] = []
  for (const e of d.entities) {
    if (e.kind === 'point' || !e.construction) continue
    const dstr = entityPath(shadow, e.id)
    if (dstr) parts.push(dstr)
  }
  return parts.join(' ')
})
const pts = computed(() => doc.value.entities.filter(e => e.kind === 'point') as any[])
const marks = computed(() => constraintMarks(doc.value))
// STRUCTURAL/auto constraint kinds — internal copy-rule bookkeeping (Repeat's
// rotatedFrom, Mirror's mirroredFrom) and arc-integrity plumbing (equalDist,
// which also backs the user-facing "Equal" verb on two lines — see
// availableConstraints — so it can't be dropped from the model, only hidden
// from this badge layer) that nobody clicks to remove by hand. These are the
// bulk of badge clutter on a many-petal Repeat/Mirror drawing (a 24-petal
// mandala buries itself under hundreds of ↻/E badges); filtering them out of
// the render is display-only — removeConstraintById still allows removing
// them by kind (see its own comment), just not via a badge that no longer
// exists for them.
const STRUCTURAL_MARK_KINDS: ConstraintKind[] = ['rotatedFrom', 'mirroredFrom', 'equalDist']
const visibleMarks = computed(() => marks.value.filter(m => !STRUCTURAL_MARK_KINDS.includes(m.kind)))
// persistent "R n.n" radius chips on every finished arc segment — pure read of
// the doc, never solves; distinct from pathBowChip's live during-drag chip
const arcDims = computed(() => arcDimensionMarks(doc.value))

// point-handle rendering: selection (orange, filled, r6) always wins; a
// construction point (a guide — the pen/smooth-handle use of construction
// points is retired from this UI) renders as a small grey hollow dot, distinct
// from both the orange selection fill and the normal solid blue/fixed-grey
// dots below.
function pointRadius(p: { id: EntityId; construction?: boolean }): number {
  if (selection.value.includes(p.id)) return 6
  return p.construction ? 4 : 6
}
function pointFill(p: { id: EntityId; construction?: boolean; fixed?: boolean }): string {
  if (selection.value.includes(p.id)) return '#f59e0b'
  if (p.construction) return 'none'
  return p.fixed ? '#9ca3af' : '#2563eb'
}
function pointStroke(p: { id: EntityId; construction?: boolean }): string {
  if (selection.value.includes(p.id)) return 'none'
  return p.construction ? '#9ca3af' : 'none'
}

// screen coords of a live (already-in-doc) point entity — used by the preview,
// which never goes through the shadow-doc clone
function screenPt(id: EntityId): { x: number; y: number } | null {
  const p = doc.value.entities.find(e => e.id === id) as any
  if (!p || p.kind !== 'point') return null
  return { x: sx(p.x), y: sy(p.y) }
}

// live path draw preview: the already-placed pending segments, plus either a
// rubber band out to the cursor (hovering) or — mid drag past the bow
// threshold — the just-placed segment bending live under the pointer. Pure
// read of doc + cursor + pathDrag; never solves, never mutates the doc.
const previewD = computed(() => {
  if (tool.value !== 'path') return ''
  const pp = pendingPath.value
  if (!pp || pp.anchors.length === 0) return ''
  const first = screenPt(pp.anchors[0]!)
  if (!first) return ''
  let d = `M ${first.x} ${first.y}`
  const segCount = pp.segments.length
  const lastAnchorId = pp.anchors[pp.anchors.length - 1]!
  const bowing = !!pathDrag && pathDrag.bowed && pathDrag.anchor === lastAnchorId && !!cursor.value
  for (let i = 0; i < segCount; i++) {
    const seg = pp.segments[i]!
    const fromId = pp.anchors[i]!
    const toId = pp.anchors[i + 1]!
    const to = screenPt(toId)
    if (!to) break
    if (bowing && i === segCount - 1) {
      // just-placed segment bowing live under the pointer — bowArc works in
      // world (doc) coords, then flip sweep for the screen's y-flip (see toShadowEntities)
      const p0 = doc.value.entities.find(e => e.id === fromId) as any
      const p1 = doc.value.entities.find(e => e.id === toId) as any
      const joint = jointInfoForSegment(pp, i)
      const arc = (p0 && p1 && cursor.value) ? bowArc({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, cursor.value, joint?.tangentDir ?? null) : null
      if (arc) {
        const rScreen = arc.r * scale.value
        const sweepScreen = (1 - arc.sweep) as 0 | 1
        d += ` A ${rScreen} ${rScreen} 0 ${arc.large} ${sweepScreen} ${to.x} ${to.y}`
      } else {
        d += ` L ${to.x} ${to.y}`
      }
    } else if (seg.kind === 'arc') {
      const from = screenPt(fromId)
      const c = screenPt(seg.center)
      if (from && c) {
        const r = Math.hypot(from.x - c.x, from.y - c.y)
        const a0 = Math.atan2(from.y - c.y, from.x - c.x)
        const a1 = Math.atan2(to.y - c.y, to.x - c.x)
        const TAU = Math.PI * 2
        const ccw = ((a1 - a0) % TAU + TAU) % TAU
        const sweep = (1 - seg.sweep) as 0 | 1   // screen space is y-flipped (see toShadowEntities)
        const span = sweep === 1 ? ccw : TAU - ccw
        const large = span > Math.PI ? 1 : 0
        d += ` A ${r} ${r} 0 ${large} ${sweep} ${to.x} ${to.y}`
      } else d += ` L ${to.x} ${to.y}`
    } else {
      d += ` L ${to.x} ${to.y}`
    }
  }
  if (!bowing && cursor.value) {
    const last = screenPt(lastAnchorId)
    const lastWorld = doc.value.entities.find(e => e.id === lastAnchorId) as any
    if (last) {
      // Shift held → show the 45°-snapped cursor position, not the raw one,
      // so the rubber-band preview matches where pathDown/pathClick will
      // actually place the anchor (scope: line-segment placement, not
      // mid-bow — `bowing` above already excludes the arc-drag branch).
      const cursorWorld = cursor.value.shift && lastWorld && lastWorld.kind === 'point'
        ? snapAngle({ x: lastWorld.x, y: lastWorld.y }, cursor.value)
        : cursor.value
      const ptr = { x: sx(cursorWorld.x), y: sy(cursorWorld.y) }
      d += ` M ${last.x} ${last.y} L ${ptr.x} ${ptr.y}`
    }
  }
  return d
})

// live radius chip shown near the bowed arc's midpoint while the path tool
// drags a segment into a curve — same "R n.n" badge style as constraint marks.
// When the bow is joint-tangent-locked to the previous segment (snappedTangent),
// also carries J's screen position so the template can drop a small "T" chip there.
const pathBowChip = computed(() => {
  if (tool.value !== 'path' || !pathDrag || !pathDrag.bowed || !cursor.value) return null
  const pp = pendingPath.value
  const p0 = doc.value.entities.find(e => e.id === pathDrag!.prevAnchor) as any
  const p1 = doc.value.entities.find(e => e.id === pathDrag!.anchor) as any
  if (!p0 || !p1 || !pp) return null
  const joint = jointInfoForSegment(pp, pp.segments.length - 1)
  const arc = bowArc({ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }, cursor.value, joint?.tangentDir ?? null)
  if (!arc) return null
  return {
    x: sx(arc.mid.x), y: sy(arc.mid.y),
    // type-a-dimension: while dimBuffer has a typed value, show it (with a
    // trailing caret so it reads like a live input) instead of the measured
    // radius — same chip, same position, just a different label.
    text: dimBuffer.value ? dimBuffer.value + '|' : `R ${arc.r.toFixed(1)}`,
    snappedTangent: arc.snappedTangent, jointX: sx(p0.x), jointY: sy(p0.y),
  }
})

// type-a-dimension: the line-length counterpart to pathBowChip, above.
// Unlike the arc bow there's no pre-existing live length readout for a
// straight rubber-band segment, so this chip only appears once dimBuffer has
// something in it — nothing renders while the buffer is empty.
const lineDimChip = computed(() => {
  if (tool.value !== 'path' || !dimBuffer.value) return null
  if (pathDrag && pathDrag.bowed) return null   // the arc bow owns the chip via pathBowChip instead
  const pp = pendingPath.value
  if (!pp || !cursor.value) return null
  const last = screenPt(pp.anchors[pp.anchors.length - 1]!)
  if (!last) return null
  const ptr = { x: sx(cursor.value.x), y: sy(cursor.value.y) }
  return { x: (last.x + ptr.x) / 2, y: (last.y + ptr.y) / 2, text: dimBuffer.value + '|' }
})

// pointer handling
let dragId: EntityId | null = null
let moved = false
// handle points riding the dragged anchor (Fix 3): translated by the same
// delta as the anchor each move, so their arms keep shape and the solver's
// collinear constraint has something consistent to hold onto
let dragHandleIds: EntityId[] = []
let dragLast: { x: number; y: number } | null = null

// --- select-tool marquee + click-empty-deselect ---
// A pointerdown on EMPTY canvas (select tool only — entity/point pointerdowns
// stopPropagation before reaching onPointerDownSvg, so this only ever starts
// for a miss) always starts a marquee candidate. It resolves on pointerup:
// no movement past the threshold → a plain click-on-empty-space, which clears
// the selection (unless additive/shift, which is a no-op — shift implies
// "keep what I have"); movement past the threshold → an actual box-select via
// marqueeSelect(). marqueeStart/marqueeMoved/marqueeAdditive are screen
// (svg-local pixel) state, mirroring the panStart*/dragLast pattern above —
// never touches `doc`, so none of this is a history-mutating action.
const marqueeRect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
let marqueeStart: { x: number; y: number } | null = null
let marqueeMoved = false
let marqueeAdditive = false
const MARQUEE_THRESHOLD_PX = 3

// select every entity with ANY point-closure point (pointClosure — same
// expansion nudge()/flip() use) inside the world rect [x0,y0]–[x1,y1] — a
// forgiving "any point touches" test rather than requiring the whole entity
// inside. additive=true adds to the current selection (shift-marquee);
// additive=false replaces it. Exposed directly as __sketchDraw.marqueeSelect
// so E2E can drive the exact same path a real drag resolves to.
function marqueeSelect(x0: number, y0: number, x1: number, y1: number, additive = false) {
  clearSegSel()
  const loX = Math.min(x0, x1), hiX = Math.max(x0, x1)
  const loY = Math.min(y0, y1), hiY = Math.max(y0, y1)
  const hits: EntityId[] = []
  for (const e of doc.value.entities) {
    const closure = pointClosure(doc.value, [e.id])
    const inRect = closure.some(pid => {
      const p = doc.value.entities.find(x => x.id === pid) as any
      return p && p.kind === 'point' && p.x >= loX && p.x <= hiX && p.y >= loY && p.y <= hiY
    })
    if (inRect) hits.push(e.id)
  }
  if (!additive) { selection.value = hits; return }
  const set = new Set(selection.value)
  for (const id of hits) set.add(id)
  selection.value = Array.from(set)
}

// handle ids attached to a given anchor: h1 of the segment leaving it, h2 of
// the segment arriving at it (same adjacency handleArms walks)
function handleIdsForAnchor(id: EntityId): EntityId[] {
  const out: EntityId[] = []
  for (const e of doc.value.entities) {
    if (e.kind !== 'path') continue
    const n = e.anchors.length
    for (let i = 0; i < e.segments.length; i++) {
      const seg = e.segments[i]!
      if (seg.kind !== 'cubic') continue
      const fromId = e.anchors[i]!
      const toId = e.anchors[(i + 1) % n]!
      if (fromId === id && seg.h1) out.push(seg.h1)
      if (toId === id && seg.h2) out.push(seg.h2)
    }
  }
  return out
}

// svg-local pixel coords (no world conversion) — the same frame sx()/sy()
// render into (the <svg> has no viewBox scaling, so client-rect-relative
// pixels ARE that frame). Used by the marquee overlay, which draws in screen
// space so it stays a crisp 1px-ish rect regardless of zoom.
function svgLocalXY(ev: PointerEvent) {
  const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
  return { x: ev.clientX - r.left, y: ev.clientY - r.top }
}
function svgXY(ev: PointerEvent) {
  const { x, y } = svgLocalXY(ev)
  return { x: wx(x), y: wy(y) }
}
function onWheel(ev: WheelEvent) {
  ev.preventDefault()
  const r = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
  const cx = ev.clientX - r.left, cy = ev.clientY - r.top
  const f = ev.deltaY < 0 ? 1.1 : 1 / 1.1
  zoomAt(cx, cy, f)
}
function onEntityPointerDown(id: EntityId, ev: PointerEvent) {
  if (panTrigger(ev)) { startPan(ev); ev.stopPropagation(); return }
  // guided Mirror: a line click supplies the axis
  if (tool.value === 'select' && pendingOp.value?.kind === 'mirror' && (doc.value.entities.find(e => e.id === id) as any)?.kind === 'line') {
    applyMirror(pendingOp.value.units, id)
    ev.stopPropagation(); return
  }
  // non-point entities (line/circle/path hit-paths) never drag via pointer —
  // only points do (see onPointerDownPoint) — so there's no click-vs-drag
  // ambiguity here: select immediately, replacing unless shift-held.
  if (tool.value === 'select') { pick(id, ev.shiftKey); ev.stopPropagation() }
}
function onPointerDownPoint(id: EntityId, ev: PointerEvent) {
  if (panTrigger(ev)) { startPan(ev); ev.stopPropagation(); return }
  if (tool.value !== 'select') return
  // guided Repeat: this point is the ring center
  if (pendingOp.value?.kind === 'repeat') {
    applyRepeat(pendingOp.value.units, id, pendingOp.value.count)
    ev.stopPropagation(); return
  }
  dragId = id; moved = false
  const p = doc.value.entities.find(e => e.id === id) as any
  dragHandleIds = p?.kind === 'point' ? handleIdsForAnchor(id) : []
  dragLast = p?.kind === 'point' ? { x: p.x, y: p.y } : null
  ev.stopPropagation()
}
function onPointerUpPoint(id: EntityId, ev: PointerEvent) {
  // a click without a drag replaces the selection (or shift-toggles this
  // point into/out of it); onPointerDownPoint never touched `selection` —
  // only sets dragId — so a pointer-down on an already-selected point still
  // starts a drag cleanly, and the selection only changes here, once we know
  // it was a click and not a drag.
  if (tool.value === 'select' && dragId === id && !moved) { pick(id, ev.shiftKey); ev.stopPropagation() }
  dragId = null; dragHandleIds = []; dragLast = null
}
function entityPathScreen(id: EntityId): string {
  return entityPath(shadowDoc.value, id)
}
// screen-space path-data for ONE segment of a path entity — reuses entityPath's
// own line/arc emission (sweep-flip, large-arc-flag math already correct for
// screen space, same as entityPathScreen above) by building a throwaway
// 2-anchor sub-path — this segment's own from/to anchor ids plus its single
// SegmentSpec — inside the SAME shadow (already-screen-coords) doc, rather
// than duplicating that math here. Never touches the real doc; the sub-path
// entity only ever exists inside this one call's local `subDoc`.
function segmentPathScreen(pathId: EntityId, segIndex: number): string {
  const shadow = shadowDoc.value
  const path = shadow.entities.find(e => e.id === pathId) as any
  if (!path || path.kind !== 'path') return ''
  const n = path.anchors.length
  const seg = path.segments[segIndex]
  const fromId = path.anchors[segIndex]
  const toId = path.anchors[(segIndex + 1) % n]
  if (!seg || !fromId || !toId) return ''
  const subDoc: SketchDoc = {
    entities: [...shadow.entities, { id: '__seg_hit__', kind: 'path', anchors: [fromId, toId], segments: [seg], closed: false } as any],
    constraints: [],
  }
  return entityPath(subDoc, '__seg_hit__')
}
function onSegmentPointerDown(pathId: EntityId, segIndex: number, ev: PointerEvent) {
  if (panTrigger(ev)) { startPan(ev); ev.stopPropagation(); return }
  if (tool.value !== 'select') return
  // guided ops treat a path-body click as picking the whole path (the unit),
  // never a segment — fall through to the whole-path selection below.
  if (pendingOp.value) { pick(pathId, ev.shiftKey); ev.stopPropagation(); return }
  // Default: a plain click selects the WHOLE path (what Repeat/Mirror/Delete/
  // Construction all operate on — the intuitive "click the shape, select the
  // shape"). Alt/Option-click drills in to the single segment under the cursor
  // for the per-segment verbs (Horizontal/Vertical/Right-angle on one edge).
  if (ev.altKey) pickSegment(pathId, segIndex, ev.shiftKey)
  else pick(pathId, ev.shiftKey)
  ev.stopPropagation()
}
function onPointerDownSvg(ev: PointerEvent) {
  if (panTrigger(ev)) { startPan(ev); return }
  if (tool.value === 'select') {
    // guided Repeat with an empty-canvas click: drop a fresh FIXED center right
    // where they clicked and repeat around it (so a ring never needs a
    // pre-made center point). Mirror needs a real line, so an empty click there
    // just cancels the armed op.
    if (pendingOp.value?.kind === 'repeat') {
      const w = svgXY(ev)
      const center = addPoint(doc.value, w.x, w.y, { fixed: true })
      applyRepeat(pendingOp.value.units, center, pendingOp.value.count)
      return
    }
    if (pendingOp.value?.kind === 'mirror') { cancelPendingOp(); status.value = 'Mirror cancelled — click a line to reflect across'; return }
    // a miss — entity/point pointerdowns stopPropagation before this handler
    // ever runs. Start a marquee candidate; resolved on pointerup as either a
    // click-empty-deselect or a real box-select (see marqueeStart's comment).
    const { x, y } = svgLocalXY(ev)
    marqueeStart = { x, y }
    marqueeMoved = false
    marqueeAdditive = ev.shiftKey
    marqueeRect.value = { x, y, w: 0, h: 0 }
    return
  }
  const { x, y } = svgXY(ev)
  if (tool.value === 'path') { pathDown(x, y, ev.shiftKey); return }
  place(x, y)
}
function onPointerMove(ev: PointerEvent) {
  if (panning.value) {
    panX.value = panStartPanX + (ev.clientX - panStartClientX)
    panY.value = panStartPanY + (ev.clientY - panStartClientY)
    return
  }
  if (marqueeStart) {
    if (ev.buttons === 0) return   // button released off-canvas — pointerup/leave settles it
    const { x, y } = svgLocalXY(ev)
    if (!marqueeMoved && Math.hypot(x - marqueeStart.x, y - marqueeStart.y) > MARQUEE_THRESHOLD_PX) marqueeMoved = true
    marqueeRect.value = {
      x: Math.min(marqueeStart.x, x), y: Math.min(marqueeStart.y, y),
      w: Math.abs(x - marqueeStart.x), h: Math.abs(y - marqueeStart.y),
    }
    return
  }
  if (tool.value === 'path') {
    // always track too — drives the rubber-band hover preview even when not
    // mid-drag, and the live bow while pathDrag is active
    const { x, y } = svgXY(ev)
    pathMove(x, y, ev.shiftKey)
    return
  }
  if (!dragId || ev.buttons === 0) return
  const { x, y } = svgXY(ev)
  moved = true
  if (dragHandleIds.length && dragLast) {
    const dx = x - dragLast.x, dy = y - dragLast.y
    for (const hid of dragHandleIds) {
      const h = doc.value.entities.find(e => e.id === hid) as any
      if (h && h.kind === 'point') { h.x += dx; h.y += dy }
    }
    dragLast = { x, y }
  }
  runSolve({ point: dragId, x, y })
}
function onPointerUp(ev: PointerEvent) {
  if (panning.value) { panning.value = false; return }
  if (tool.value === 'path' && pathDrag) {
    const { x, y } = svgXY(ev)
    pathUp(x, y)
    return
  }
  if (marqueeStart) {
    const start = marqueeStart, additive = marqueeAdditive, didMove = marqueeMoved
    marqueeStart = null; marqueeMoved = false; marqueeRect.value = null
    if (!didMove) {
      // plain click on empty canvas: deselect (both entity AND segment
      // selection). Shift+click-empty is a no-op (shift signals "keep what
      // I have" — nothing to add from empty space).
      if (!additive) { clearSel(); clearSegSel() }
      return
    }
    const { x: ex, y: ey } = svgLocalXY(ev)
    const w0 = { x: wx(start.x), y: wy(start.y) }
    const w1 = { x: wx(ex), y: wy(ey) }
    marqueeSelect(w0.x, w0.y, w1.x, w1.y, additive)
    return   // selection change only — no commitHistory (not a doc mutation)
  }
  // settle a select-tool point drag as ONE history entry — release can land
  // off the point circle (onPointerUpPoint never fires then), so this is the
  // single reliable place to commit; `moved` isn't reset by onPointerUpPoint,
  // so this still fires correctly when release does land back on the point.
  if (tool.value === 'select' && moved) commitHistory()
  dragId = null; dragHandleIds = []; dragLast = null
  moved = false
}
function onPointerLeaveSvg(ev: PointerEvent) {
  onPointerUp(ev)
  cursor.value = null
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
  for (const id of candidates) {
    const p = doc.value.entities.find(e => e.id === id) as any
    if (p && p.kind === 'point' && !p.fixed && !isPointReferenced(doc.value, id)) deleteEntity(doc.value, id)
  }
  if (pp.anchors.length === 0) {
    cleanupPendingPath()
    pendingPath.value = null
    pathDrag = null
    cursor.value = null
  }
  if (doc.value.entities.length !== before) commitHistory()
}

function selectTool(t: Tool) {
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
  cursor.value = null
  dimBuffer.value = ''
  status.value = 'ready'
  initHistory()
}

onMounted(() => {
  ;(window as any).__sketchDraw = {
    get doc() { return doc.value },
    get tool() { return tool.value },
    get selection() { return selection.value.slice() },
    // Task 4 test hooks — segment selection is its own channel, mutually
    // exclusive with entity `selection` above (see pick()/pickSegment()).
    get selectedSegments() { return selectedSegments.value.slice() },
    pickSegment: (pathId: EntityId, segIndex: number, additive = false) => pickSegment(pathId, segIndex, additive),
    clearSegSel: () => clearSegSel(),
    status: () => status.value,
    pathData: () => sketchPathData(doc.value),
    entityCount: () => doc.value.entities.length,
    constraintCount: () => doc.value.constraints.length,
    setTool: (t: Tool) => selectTool(t),
    // Task 5 test hook: guide mode — while on, Point/Line/Circle/Path place
    // construction geometry directly (see place/pathClick/pathDown/finishPath).
    get guideMode() { return guideMode.value },
    setGuideMode: (on: boolean) => setGuideMode(on),
    // Labels toggle test hook — mirrors the toolbar button's own setter
    // exactly (see showLabels/setShowLabels above); VIEW state, no history.
    get showLabels() { return showLabels.value },
    setShowLabels: (on: boolean) => setShowLabels(on),
    reset,
    place: (x: number, y: number) => place(x, y),
    pathDown: (x: number, y: number) => pathDown(x, y),
    pathMove: (x: number, y: number) => pathMove(x, y),
    pathUp: (x: number, y: number) => pathUp(x, y),
    // test-only hook: same code path as a real shift-click pointerdown on the
    // path tool (pathDown with shift=true) — real pointer events carry
    // shiftKey directly, but the __sketchDraw API otherwise has no way to
    // express a modifier key, so this exists purely for deterministic E2E
    // coverage of the 45° angle snap (see tests/sketch-draw.spec.ts).
    placeShift: (x: number, y: number) => pathDown(x, y, true),
    drag: (id: EntityId, x: number, y: number) => { runSolve({ point: id, x, y }); commitHistory() },
    pick: (id: EntityId, additive = false) => pick(id, additive),
    clearSel: () => clearSel(),
    // Task 5 test hook: mirrors the real marquee-drag pointerup resolution
    // (see onPointerUp) — same marqueeSelect() call, just fed a world rect
    // directly instead of two svg-local pixel points.
    marqueeSelect: (x0: number, y0: number, x1: number, y1: number, additive = false) => marqueeSelect(x0, y0, x1, y1, additive),
    apply: (kind: ConstraintKind, value?: number) => apply(kind, value),
    del: () => del(),
    availableConstraints: () => availableConstraints(),
    setNextSegment: (k: 'line' | 'arc') => { nextSegment.value = k },
    finishPath: (close = false) => finishPath(close),
    repeat: (ids: EntityId[], centerId: EntityId, count: number) => { repeatEntities(doc.value, ids, centerId, count); runSolve(); commitHistory() },
    mirror: (ids: EntityId[], axisId: EntityId) => { mirrorEntities(doc.value, ids, axisId); runSolve(); commitHistory() },
    // guided-op test hooks: armRepeat/armMirror set pendingOp exactly as the
    // Repeat…/Mirror verb buttons do (minus the window.prompt); pendingOp
    // exposes the armed state so E2E can assert the "now click the center/axis"
    // step, and the real point/line/empty clicks resolve it.
    armRepeat: (count: number) => {
      const ptSel = selection.value.filter(id => isPointId(id))
      const entSel = selection.value.filter(id => !ptSel.includes(id))
      armRepeat(entSel, count)
    },
    armMirror: () => doMirror(),
    pendingOp: () => (pendingOp.value ? { kind: pendingOp.value.kind, units: [...pendingOp.value.units] } : null),
    cancelOp: () => cancelPendingOp(),
    flipH: () => flip('h'),
    flipV: () => flip('v'),
    makeConstruction: () => makeConstruction(),
    copySvg: () => copySvg(),
    undo: () => undo(),
    redo: () => redo(),
    canUndo: () => canUndo(),
    canRedo: () => canRedo(),
    // Task 2 test hooks — each mirrors the real onKeydown path exactly
    // (Escape/Backspace/arrows) so E2E coverage is deterministic without
    // dispatching real KeyboardEvents.
    cancelPath: () => cancelPath(),
    removeLastAnchor: () => removeLastAnchor(),
    nudge: (dx: number, dy: number) => nudge(dx, dy),
    // Task 3 test hooks — viewport (pan/zoom) is VIEW state, never touches
    // `doc` or history, so these bypass commitHistory entirely (see zoomAt/
    // panBy/fitView above).
    zoomAt: (px: number, py: number, factor: number) => zoomAt(px, py, factor),
    panBy: (dxPx: number, dyPx: number) => panBy(dxPx, dyPx),
    fitView: () => fitView(),
    getViewport: () => getViewport(),
    // Task 4 test hooks — editable dimension chips: identical code path as
    // the arc-radius-chip / constraint-value-chip click (minus the prompt).
    setArcRadius: (pathId: EntityId, segIndex: number, value: number) => setArcRadius(pathId, segIndex, value),
    setConstraintValue: (constraintId: EntityId, value: number) => setConstraintValue(constraintId, value),
    // Task 3 test hook: mirrors a constraint-badge click's removal path
    // exactly (removeConstraint + solve + commit) — see removeConstraintById.
    removeConstraintById: (id: EntityId) => removeConstraintById(id),
    // Task 6 test hooks — type-a-dimension: typeDimension sets the buffer
    // directly (bypassing onKeydown's per-key routing), commitDimension
    // applies it via the exact same code path Enter uses.
    get dimBuffer() { return dimBuffer.value },
    typeDimension: (str: string) => { dimBuffer.value = str },
    commitDimension: () => commitDimension(),
    // Task 7 test hooks — sparkle-on-snap delight (pure visual; see sparkle()
    // above). sparkle() spawns one directly (same code the capture sites
    // call), sparkleCount() reads the live/pruned count.
    sparkle: (x: number, y: number) => sparkle(x, y),
    sparkleCount: () => sparkleCount(),
  }
  ready.value = true
  initHistory()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onBlur)
  if (sparkleRaf) cancelAnimationFrame(sparkleRaf)
})
</script>

<template>
  <div :data-ready="ready ? '' : undefined" style="font-family: ui-sans-serif, system-ui; padding: 12px; color: #e5e5e5; background: #0b0b0b; min-height: 100vh">
    <h1 style="font-size: 14px; margin: 0 0 8px">Sketch Draw</h1>
    <div style="display: flex; gap: 6px; margin-bottom: 8px; align-items: center">
      <button v-for="t in (['select','point','line','circle','path'] as Tool[])" :key="t"
              :data-tool="t" @click="() => selectTool(t)"
              :style="{ padding: '4px 10px', borderRadius: '6px', border: '1px solid #333', cursor: 'pointer',
                        background: tool === t ? '#2563eb' : '#1a1a1a', color: '#fff' }">{{ t }}</button>
      <button data-act="guide" @click="toggleGuideMode" :title="'While on, Point/Line/Circle/Path place construction (guide) geometry'"
              :style="{ padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                        border: guideMode ? '1px dashed #60a5fa' : '1px solid #333',
                        background: guideMode ? '#152036' : '#1a1a1a',
                        color: guideMode ? '#93c5fd' : '#9ca3af' }">Guide: {{ guideMode ? 'on' : 'off' }}</button>
      <button data-act="labels" @click="toggleShowLabels" :title="'Toggle constraint badges + dimension chips (declutter a large drawing)'"
              :style="{ padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                        border: showLabels ? '1px dashed #60a5fa' : '1px solid #333',
                        background: showLabels ? '#152036' : '#1a1a1a',
                        color: showLabels ? '#93c5fd' : '#9ca3af' }">Labels: {{ showLabels ? 'on' : 'off' }}</button>
      <button data-act="reset" @click="reset" style="padding: 4px 10px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer">reset</button>
      <span data-status style="margin-left: 8px; font-size: 12px; color: #9ca3af">{{ status }}</span>
    </div>
    <div v-if="opHint" data-op-hint
         style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px; padding: 6px 12px; border-radius: 8px; border: 1px solid #2563eb; background: #10203f; color: #bfdbfe; font-size: 13px">
      <span>👉 {{ opHint }}</span>
      <button data-act="op-cancel" @click="cancelPendingOp"
              style="padding: 2px 8px; border-radius: 6px; border: 1px solid #334155; background: #0b1220; color: #93c5fd; cursor: pointer; font-size: 12px">cancel (Esc)</button>
    </div>
    <div v-if="tool === 'path'" style="display: flex; gap: 6px; margin-bottom: 8px; align-items: center">
      <span style="font-size: 12px; color: #9ca3af">click to place a point — drag before releasing to curve the segment into an arc; click the first point to close</span>
      <button data-act="close" @click="finishPath(true)"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">close</button>
      <button data-act="finish" @click="finishPath(false)"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">finish</button>
    </div>
    <div style="display: flex; gap: 6px; margin: 8px 0; min-height: 28px; align-items: center; flex-wrap: wrap">
      <span style="font-size: 12px; color: #9ca3af">sel: {{ selection.length }}{{ selectedSegments.length ? ' · seg: ' + selectedSegments.length : '' }}</span>
      <span v-if="tool === 'select' && !selection.length && !selectedSegments.length" data-select-hint style="font-size: 12px; color: #6b7280">drag a point to move it · click a shape to select it · ⌥click an edge for one segment</span>
      <button v-for="v in availableConstraints()" :key="v.kind" :data-verb="v.kind"
              @click="() => applyWithValue(v)"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">{{ v.label }}</button>
      <button v-if="selection.length" data-verb="fix" @click="fixSelected"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Fix</button>
      <button v-if="selection.length" data-verb="repeat" @click="repeatPrompt"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Repeat…</button>
      <button v-if="selection.length" data-verb="mirror" @click="doMirror"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Mirror</button>
      <button v-if="selection.length" data-verb="construction" @click="makeConstruction"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Make construction</button>
      <button v-if="selection.length" data-verb="flip-h" @click="flip('h')"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Flip H</button>
      <button v-if="selection.length" data-verb="flip-v" @click="flip('v')"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Flip V</button>
      <button data-verb="copy-svg" @click="copySvg"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer; font-size: 12px">Copy SVG</button>
      <button v-if="selection.length" data-act="delete" @click="del"
              style="padding: 3px 9px; border-radius: 6px; border: 1px solid #7f1d1d; background: #1a1a1a; color: #fca5a5; cursor: pointer; font-size: 12px">Delete</button>
    </div>
    <svg width="680" height="460" :style="{ background: '#fafafa', borderRadius: '8px', touchAction: 'none', cursor: svgCursor }"
         @pointerdown="onPointerDownSvg" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointerleave="onPointerLeaveSvg" @wheel="onWheel">
      <path :d="pathScreen" fill="none" stroke="#3730a3" stroke-width="1.5" />
      <path :d="constructionScreen" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="4 3" />
      <template v-for="e in doc.entities" :key="'hit-' + e.id">
        <!-- path-kind entities are hit-tested PER SEGMENT below instead of as
             one whole-entity hit-path — clicking anywhere on a path now picks
             the segment under the cursor. Whole-entity selection (set via the
             __sketchDraw.pick API, e.g. for Repeat/Mirror/Construction) still
             renders its orange highlight here regardless. -->
        <path v-if="e.kind !== 'point' && e.kind !== 'path'" :d="entityPathScreen(e.id)" fill="none" stroke="transparent" stroke-width="12"
              :style="{ cursor: 'pointer' }" @pointerdown="(ev) => onEntityPointerDown(e.id, ev)" :data-ent="e.id" />
        <path v-if="e.kind !== 'point' && selection.includes(e.id)" :d="entityPathScreen(e.id)" fill="none" stroke="#f59e0b" stroke-width="2.5" pointer-events="none" />
        <template v-if="e.kind === 'path'">
          <path v-for="(seg, i) in ((e as any).segments as SegmentSpec[])" :key="'seghit-' + e.id + '-' + i"
                :d="segmentPathScreen(e.id, i as number)" fill="none" stroke="transparent" stroke-width="12"
                :style="{ cursor: 'pointer' }" @pointerdown="(ev) => onSegmentPointerDown(e.id, i as number, ev)"
                :data-seg="e.id + ':' + i" />
        </template>
      </template>
      <template v-for="s in selectedSegments" :key="'segsel-' + s.pathId + '-' + s.segIndex">
        <path :d="segmentPathScreen(s.pathId, s.segIndex)" fill="none" stroke="#f59e0b" stroke-width="2.5" pointer-events="none" data-seg-selected />
      </template>
      <path v-if="previewD" :d="previewD" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="5 3"
            pointer-events="none" data-path-preview />
      <circle v-for="p in pts" :key="p.id" :cx="sx(p.x)" :cy="sy(p.y)" :r="pointRadius(p)"
              :fill="pointFill(p)" :stroke="pointStroke(p)" stroke-width="1.5"
              :style="{ cursor: tool === 'select' ? 'grab' : 'crosshair' }"
              @pointerdown="(e) => onPointerDownPoint(p.id, e)" @pointerup="(e) => onPointerUpPoint(p.id, e)"
              :data-point="p.id" :data-construction="p.construction ? '' : null" />
      <template v-if="showLabels">
        <g v-for="m in visibleMarks" :key="m.id" class="constraint-badge" pointer-events="auto" style="cursor: pointer"
           :data-constraint="m.id" :data-constraint-kind="m.kind"
           @pointerdown.stop @click.stop="onConstraintMarkClick(m, $event)">
          <title>{{ m.text != null ? 'click to edit · shift+click to remove' : 'click to remove' }}</title>
          <rect :x="sx(m.x) + 6" :y="sy(m.y) - 16" :width="m.text ? 30 : 16" height="14" rx="3" fill="#111827" opacity="0.85" />
          <text :x="sx(m.x) + 9" :y="sy(m.y) - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.glyph }}{{ m.text ? ' ' + m.text : '' }}</text>
        </g>
        <g v-for="m in arcDims" :key="m.id" pointer-events="auto" style="cursor: pointer"
           @pointerdown.stop @click.stop="onArcDimClick(m)">
          <rect :x="sx(m.x) + 6" :y="sy(m.y) - 16" width="34" height="14" rx="3" fill="#111827" opacity="0.85" />
          <text :x="sx(m.x) + 9" :y="sy(m.y) - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.text }}</text>
        </g>
      </template>
      <g v-if="pathBowChip" pointer-events="none">
        <rect :x="pathBowChip.x - 18" :y="pathBowChip.y - 20" width="40" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="pathBowChip.x - 15" :y="pathBowChip.y - 9" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ pathBowChip.text }}</text>
      </g>
      <g v-if="pathBowChip && pathBowChip.snappedTangent" pointer-events="none">
        <rect :x="pathBowChip.jointX + 6" :y="pathBowChip.jointY - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="pathBowChip.jointX + 9" :y="pathBowChip.jointY - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
      </g>
      <g v-if="lineDimChip" pointer-events="none">
        <rect :x="lineDimChip.x - 18" :y="lineDimChip.y - 20" width="40" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="lineDimChip.x - 15" :y="lineDimChip.y - 9" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ lineDimChip.text }}</text>
      </g>
      <rect v-if="marqueeRect" :x="marqueeRect.x" :y="marqueeRect.y" :width="marqueeRect.w" :height="marqueeRect.h"
            fill="rgba(37,99,235,0.08)" stroke="#2563eb" stroke-width="1" stroke-dasharray="4 3" pointer-events="none" data-marquee />
      <g v-for="p in sparkleRender" :key="'sparkle-' + p.id" pointer-events="none" data-sparkle :style="{ opacity: p.opacity }">
        <line v-for="(r, i) in p.rays" :key="i" :x1="r.x1" :y1="r.y1" :x2="r.x2" :y2="r.y2"
              stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" />
      </g>
    </svg>
    <p style="font-size: 12px; color: #6b7280; margin-top: 8px">
      Pick a tool. Point/Line/Circle click to place (snaps to nearby geometry). Path click to chain anchors, drag before releasing to bow a segment into an arc, click the first anchor to close. Select drags points; the drawing re-solves.
    </p>
  </div>
</template>

<style scoped>
/* constraint badges: subtle hover cue so click-to-remove/edit reads as
   interactive without changing layout (no scale — badges sit tight next to
   the geometry they annotate; a scale transform would visibly jump them) */
.constraint-badge rect { transition: opacity 120ms ease; }
.constraint-badge:hover rect { opacity: 1; }
.constraint-badge:hover text { fill: #fff; }
</style>
