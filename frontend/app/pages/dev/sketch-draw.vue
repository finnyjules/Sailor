<!-- app/pages/dev/sketch-draw.vue -->
<script setup lang="ts">
// Dev harness — not linked in the app. Interactive constraint drawing surface.
// The pen's state and actions live in usePen (composables/pen); this page
// hosts it: the viewport, rendering, pointer handlers and the test API.
definePageMeta({ layout: false })
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { SketchDoc, EntityId, ConstraintKind, SegmentSpec } from '~/lib/sketch/model'
import { addPoint, repeatEntities, mirrorEntities } from '~/lib/sketch/edit'
import { sketchPathData, entityPath } from '~/lib/sketch/sketchPath'
import { constraintMarks, arcDimensionMarks } from '~/lib/sketch/annotate'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, snapAngle, bowArc, SPARKLE_LIFETIME_MS, type PenTool } from '~/composables/pen/usePen'

type Tool = PenTool

const doc = ref<SketchDoc>({ entities: [], constraints: [] })
const ready = ref(false)

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

// the pen — its tolerances read this view; the page still renders with sx/sy
const view = computed<ViewMatrix>(() => ({ a: scale.value, b: 0, c: 0, d: -scale.value, e: panX.value, f: panY.value }))
const pen = usePen({
  doc,
  view,
  // Escape aborts a live marquee drag or pan before it cancels a path
  cancelGesture: () => {
    if (marqueeStart) { marqueeStart = null; marqueeMoved = false; marqueeRect.value = null; return true }
    if (panning.value) { panning.value = false; return true }
    return false
  },
})
const {
  tool, guideMode, showLabels, status, selection, selectedSegments, pending, pendingPath,
  pendingOp, opHint, cursor, dimBuffer, nextSegment, sparkles, sparkleClock,
  selectTool, setGuideMode, toggleGuideMode, setShowLabels, toggleShowLabels,
  pick, clearSel, pickSegment, clearSegSel, marqueeSelect, isPointId,
  place, pathDown, pathMove, pathUp, finishPath, cancelPath, removeLastAnchor, getPathDrag, jointInfoForSegment,
  runSolve, apply, applyWithValue, availableConstraints, del, nudge, fixSelected, makeConstruction, flip,
  repeatPrompt, armRepeat, applyRepeat, doMirror, applyMirror, cancelPendingOp,
  setArcRadius, setConstraintValue, removeConstraintById, onArcDimClick, onConstraintMarkClick,
  commitDimension, undo, redo, canUndo, canRedo, reset, commitHistory, sparkle, sparkleCount,
} = pen

// keyboard: the viewport keys (⌘0 fit, Space pan) are the page's and run
// first; everything else is the pen's.
function onKeydown(ev: KeyboardEvent) {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  const meta = ev.metaKey || ev.ctrlKey
  if (meta && ev.key.toLowerCase() === '0') { ev.preventDefault(); fitView(); return }
  if (!meta && (ev.code === 'Space' || ev.key === ' ')) { ev.preventDefault(); spaceHeld.value = true; return }
  pen.onKeydown(ev)
}

function onKeyup(ev: KeyboardEvent) {
  if (ev.code === 'Space' || ev.key === ' ') spaceHeld.value = false
  pen.onKeyup(ev)
}

function onBlur() {
  spaceHeld.value = false
  panning.value = false
  pen.onBlur()
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
  const pathDrag = getPathDrag()
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
  const pathDrag = getPathDrag()
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
  const pathDrag = getPathDrag()
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

// marqueeSelect (the world-rect resolution a real drag lands on) is the pen's.

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
  if (tool.value === 'path' && getPathDrag()) {
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
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onBlur)
  pen.dispose()
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
