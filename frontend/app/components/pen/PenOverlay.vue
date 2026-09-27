<!-- app/components/pen/PenOverlay.vue -->
<script setup lang="ts">
// The pen's surface: draws a Pen (composables/pen/usePen) and turns pointer
// and keyboard input into its actions, over any host, through ONE affine view
// matrix (drawing → host-canvas pixels).
//
// HOST CONTRACT: see the block at the top of composables/pen/usePen.ts. In
// short — `pen` is read ONCE at setup: to open a different drawing, create a
// new pen and re-key this component (`:key`). Pass the pen a clone of the
// stored drawing; persist with cloneDoc on `commit`. `commit` (Enter with
// nothing left to finish) has already run pen.finishSession(); `cancel`
// (Escape with nothing pending) leaves the drawing as is — call pen.revert()
// if cancel means discard. `active: false` makes the overlay ignore every key
// and pointer event (it still draws), so a host can park it without unmounting.
// `keyboard` is read ONCE too, into `keyboardMode` below — like `pen`, it is
// fixed for the overlay's lifetime (re-key the overlay to switch modes): a
// reactive `props.keyboard` read separately in onMounted/onUnmounted could
// change between them and skip the removeEventListener, leaking the window
// listeners permanently.
//
// - Drawing geometry (outline, construction, hit paths, selection highlights,
//   the live draw preview) is rendered in DRAWING space under
//   `<g :transform="viewToSvg(view)">` with a non-scaling stroke, so scale
//   (even or uneven), rotation, skew and mirroring all come from the SVG
//   transform and strokes stay crisp at any zoom.
// - Points, handle arms, badges, chips and sparkles stay in screen space
//   (applyView) so they keep a constant pixel size.
// - Pointer positions are mapped client → SVG-local through the SVG's screen
//   CTM, so the overlay still lands points under the cursor inside a
//   CSS-transformed (e.g. scale()) ancestor.
// - Pan and wheel zoom are the HOST's: it intercepts them in the capture phase
//   on its own wrapper, before they reach this SVG.
// - Keyboard, `keyboard="window"` (default): window keydown / keyup / blur
//   while mounted (bubble phase). A host that owns viewport keys registers
//   its listener in the capture phase, so it runs first, and stops
//   propagation only for keys it consumed. Every key the overlay acts on —
//   including an Escape/Enter it turns into `cancel`/`commit` — is
//   preventDefault-ed and stopPropagation-ed.
// - Keyboard, `keyboard="host"`: the overlay registers NO window listeners.
//   The host owns the keyboard (its own capture-phase window listener) and
//   feeds keys in via the exposed `onHostKeydown(e): boolean` / `onHostKeyup(e)`
//   / `onHostBlur()`. `onHostKeydown` runs the same typing guard and
//   focused-control rule before touching the pen, and returns whether it
//   consumed the key.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import type { SketchDoc, EntityId, ConstraintKind, SegmentSpec } from '~/lib/sketch/model'
import { addPoint } from '~/lib/sketch/edit'
import { sketchPathData, entityPath } from '~/lib/sketch/sketchPath'
import { constraintMarks, arcDimensionMarks } from '~/lib/sketch/annotate'
import { applyView, invertView, viewToSvg, type ViewMatrix } from '~/lib/sketch/view'
import { spanPathD, SPARKLE_LIFETIME_MS, isTypingInField, type Pen } from '~/composables/pen/usePen'
import { pointRolesForDoc, type PointRole } from '~/lib/sketch/pointRoles'
import { clampChipOrigin } from '~/lib/sketch/chipClamp'
import { TOOL_KEYS } from '~/composables/pen/penKeys'

const props = withDefaults(defineProps<{
  pen: Pen
  view: ViewMatrix
  width: number
  height: number
  cursor?: string
  // false: ignore every key and pointer event (still draws)
  active?: boolean
  // 'window' (default): the overlay owns window keydown/keyup/blur itself.
  // 'host': the overlay registers NO window key listeners; the host owns the
  // keyboard and feeds keys in through the exposed onHostKeydown/onHostKeyup
  // (see the block above the keyboard section below).
  keyboard?: 'window' | 'host'
}>(), { cursor: 'crosshair', active: true, keyboard: 'window' })
// read ONCE — see the HOST CONTRACT note above (`pen` gets the same treatment)
const keyboardMode = props.keyboard
const emit = defineEmits<{
  (e: 'commit'): void   // Enter with nothing left to finish — pen.finishSession() has run
  (e: 'cancel'): void   // Escape with nothing pending — the host decides (pen.revert() to discard)
}>()

// A Mac ctrl-click is `button === 0` plus a suppressed `contextmenu` — not a
// real primary click. Treat it like any other button, so it opens the (now
// suppressed) context menu instead of placing/picking/dragging a point.
const isMacPlatform = typeof navigator !== 'undefined'
  && (/Mac|iPhone|iPad|iPod/.test((navigator as any).userAgentData?.platform || navigator.platform || ''))
function isCtrlContextClick(ev: PointerEvent) { return ev.ctrlKey && isMacPlatform }

// the pen is read ONCE — fixed for the overlay's lifetime (re-key the overlay
// to swap it); its refs are unwrapped here so the template reads them bare
const {
  doc, tool, showLabels, status, selection, selectedSegments, pendingPath, pendingOp,
  cursor: penCursor, dimBuffer, sparkles, sparkleClock, placementPreview, hoverSnap,
  pick, clearSel, pickSegment, clearSegSel, marqueeSelectScreen, dragPoint, dropPoint,
  place, pathDown, pathMove, pathUp, getPathDrag, bowPreview,
  curveDown, curveMove, curveUp, getCurveDrag, getHeldHandles, handleIds,
  applyRepeat, applyMirror, cancelPendingOp,
  onArcDimClick, onConstraintMarkClick, commitHistory, finishSession, endGesture,
  trimHover, trimHoverEnds, trimGhosts, cutHover, dissolveHover,
  trimDown, trimMove, trimUp, cutMove, cutClick, dissolveMove, dissolveClick, clearToolHover,
} = props.pen

const svgEl = ref<SVGSVGElement | null>(null)
const toScreen = (p: { x: number; y: number }) => applyView(props.view, p)
const svgTransform = computed(() => viewToSvg(props.view))

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }

// ---------- rendering ----------

// drawing-space path data (rendered under svgTransform)
const pathDrawing = computed(() => sketchPathData(doc.value))
const constructionDrawing = computed(() => {
  const d = doc.value
  const parts: string[] = []
  for (const e of d.entities) {
    if (e.kind === 'point' || !e.construction) continue
    const dstr = entityPath(d, e.id)
    if (dstr) parts.push(dstr)
  }
  return parts.join(' ')
})
function entityPathDrawing(id: EntityId): string {
  return entityPath(doc.value, id)
}
// drawing-space path data for ONE segment of a path entity — reuses
// entityPath's own line/arc emission by building a throwaway 2-anchor
// sub-path (this segment's from/to anchors plus its single SegmentSpec)
// inside a local copy of the entity list. Never touches the real doc.
function segmentPathDrawing(pathId: EntityId, segIndex: number): string {
  const d = doc.value
  const path = d.entities.find(e => e.id === pathId) as any
  if (!path || path.kind !== 'path') return ''
  const n = path.anchors.length
  const seg = path.segments[segIndex]
  const fromId = path.anchors[segIndex]
  const toId = path.anchors[(segIndex + 1) % n]
  if (!seg || !fromId || !toId) return ''
  const subDoc: SketchDoc = {
    entities: [...d.entities, { id: '__seg_hit__', kind: 'path', anchors: [fromId, toId], segments: [seg], closed: false } as any],
    constraints: [],
  }
  return entityPath(subDoc, '__seg_hit__')
}

// Bézier handles are only worth drawing while their path is being worked on —
// the pending draw, or a committed path that is selected (whole, a segment of
// it, or one of its points/handles); otherwise they are stray dots.
const visibleHandleIds = computed(() => {
  const d = doc.value
  const out = new Set<EntityId>()
  const addHandles = (segments: SegmentSpec[]) => {
    for (const seg of segments) {
      if (seg.kind !== 'cubic') continue
      if (seg.h1) out.add(seg.h1)
      if (seg.h2) out.add(seg.h2)
    }
  }
  const sel = new Set(selection.value)
  const segPaths = new Set(selectedSegments.value.map(s => s.pathId))
  for (const e of d.entities) {
    if (e.kind !== 'path') continue
    const active = sel.has(e.id) || segPaths.has(e.id) || e.anchors.some(a => sel.has(a)) ||
      e.segments.some(s => s.kind === 'cubic' && ((s.h1 && sel.has(s.h1)) || (s.h2 && sel.has(s.h2))))
    if (active) addHandles(e.segments)
  }
  if (pendingPath.value) {
    addHandles(pendingPath.value.segments)
    const held = getHeldHandles()
    if (held.lastHOut) out.add(held.lastHOut)
    if (held.firstHIn) out.add(held.firstHIn)
  }
  return out
})
const allHandleIds = computed(() => handleIds())
const pts = computed(() => (doc.value.entities.filter(e =>
  e.kind === 'point' && (!allHandleIds.value.has(e.id) || visibleHandleIds.value.has(e.id))) as any[])
  .map(p => ({ p, s: toScreen(p), handle: allHandleIds.value.has(p.id), role: pointRoleOf(p) })))

// screen-space arms (point → handle) for the handles on show
const handleArms = computed(() => {
  const d = doc.value
  const visible = visibleHandleIds.value
  const out: { x1: number; y1: number; x2: number; y2: number }[] = []
  const arm = (fromId: EntityId | undefined, hId: EntityId | null) => {
    if (!fromId || !hId || !visible.has(hId)) return
    const a = screenPt(fromId), h = screenPt(hId)
    if (a && h) out.push({ x1: a.x, y1: a.y, x2: h.x, y2: h.y })
  }
  const addArms = (anchors: EntityId[], segments: SegmentSpec[]) => {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      if (seg.kind !== 'cubic') continue
      arm(anchors[i], seg.h1)
      arm(anchors[(i + 1) % anchors.length], seg.h2)
    }
  }
  for (const e of d.entities) if (e.kind === 'path') addArms(e.anchors, e.segments)
  const pp = pendingPath.value
  if (pp && pp.anchors.length) {
    addArms(pp.anchors, pp.segments)
    const held = getHeldHandles()
    arm(pp.anchors[pp.anchors.length - 1], held.lastHOut)
    arm(pp.anchors[0], held.firstHIn)
  }
  return out
})
const marks = computed(() => constraintMarks(doc.value))
// STRUCTURAL/auto constraint kinds — internal copy-rule bookkeeping (Repeat's
// rotatedFrom, Mirror's mirroredFrom) and arc-integrity plumbing (equalDist,
// which also backs the user-facing "Equal" verb on two lines, so it can't be
// dropped from the model, only hidden from this badge layer) that nobody
// clicks to remove by hand. They are the bulk of badge clutter on a
// many-petal Repeat/Mirror drawing; hiding them is display-only.
const STRUCTURAL_MARK_KINDS: ConstraintKind[] = ['rotatedFrom', 'mirroredFrom', 'equalDist']
// a smooth point's "S" badge (its collinear rule [hIn, anchor, hOut]) sits at
// a handle; while that path's handles are hidden the badge would float in empty
// space, so it hides with them. (An arc tangent joint's collinear rule holds no
// handle and is unaffected.)
function hiddenHandleRule(m: { id: EntityId; kind: ConstraintKind }): boolean {
  if (m.kind !== 'collinear') return false
  const c = doc.value.constraints.find(x => x.id === m.id)
  if (!c) return false
  const handles = allHandleIds.value, visible = visibleHandleIds.value
  return c.refs.some(r => handles.has(r) && !visible.has(r))
}
// badges and chips are clamped to stay fully inside the overlay — a chip
// near an edge (the "R" at the right edge that motivated this) must never be
// cut off. Clamping only moves the rect/text origin; the click target (`m`)
// is unchanged, so click-to-edit still works wherever the chip actually sits.
function chipOrigin(s: { x: number; y: number }, chipWidth: number) {
  return clampChipOrigin(s.x + 6, s.y - 16, chipWidth, props.width, props.height, 14)
}
const visibleMarks = computed(() => marks.value
  .filter(m => !STRUCTURAL_MARK_KINDS.includes(m.kind) && !hiddenHandleRule(m))
  .map(m => {
    const s = toScreen(m)
    const w = m.text ? 30 : 16
    const o = chipOrigin(s, w)
    return { m, s, w, x: o.x, y: o.y }
  }))
// persistent "R n.n" radius chips on every finished arc segment — pure read
// of the doc, never solves; distinct from pathBowChip's live during-drag chip
const arcDims = computed(() => arcDimensionMarks(doc.value).map(m => {
  const s = toScreen(m)
  const w = 34
  const o = chipOrigin(s, w)
  return { m, s, w, x: o.x, y: o.y }
}))

// point-handle rendering: selection (orange, filled, r6) always wins; a
// construction point renders as a small grey hollow dot, distinct from both
// the orange selection fill and the normal solid blue / fixed-grey dots.
// a Bézier handle: a small hollow violet dot, matching its arm
const HANDLE_COLOR = '#7c3aed'
function pointRadius(p: { id: EntityId; construction?: boolean }): number {
  if (selection.value.includes(p.id)) return 6
  return p.construction ? 4 : 6
}
function pointFill(p: { id: EntityId; construction?: boolean; fixed?: boolean }): string {
  if (selection.value.includes(p.id)) return '#f59e0b'
  if (p.construction) return 'none'
  return p.fixed ? '#9ca3af' : '#2563eb'
}
function pointStroke(p: { id: EntityId; construction?: boolean }, handle = false): string {
  if (selection.value.includes(p.id)) return 'none'
  if (handle) return HANDLE_COLOR
  return p.construction ? '#9ca3af' : 'none'
}

// How points look (spec "Stage 3 — How points look"): a point shared by two
// or more pieces, or pinned onto a curve as a T-junction, reads as a small
// solid JOINT dot; a loose line/path END is a hollow square; an arc/circle
// CENTRE is a hollow circle; everything else is FREE (today's plain dot).
// Selection and construction both override this (checked first) and a
// Bézier handle keeps its own separate look entirely — none of them get the
// distinct glyph below. The hit circle underneath stays at today's radius
// either way, so `[data-point]` keeps receiving pointer events at the same
// size regardless of the visual role on top of it.
const pointRoles = computed(() => pointRolesForDoc(doc.value))
function pointRoleOf(p: { id: EntityId }): PointRole { return pointRoles.value.get(p.id) ?? 'free' }
function hasDistinctRoleGlyph(p: { id: EntityId; construction?: boolean }, role: PointRole, handle: boolean): boolean {
  return !handle && !p.construction && !selection.value.includes(p.id) && (role === 'joint' || role === 'end' || role === 'centre')
}
function roleGlyphColor(p: { fixed?: boolean }): string {
  return p.fixed ? '#9ca3af' : '#2563eb'
}

function worldPt(id: EntityId): { x: number; y: number } | null {
  const p = doc.value.entities.find(e => e.id === id) as any
  if (!p || p.kind !== 'point') return null
  return { x: p.x, y: p.y }
}
function screenPt(id: EntityId): { x: number; y: number } | null {
  const w = worldPt(id)
  return w ? toScreen(w) : null
}

// live path draw preview, in DRAWING space (rendered under svgTransform like
// the outline, so it coincides with what gets committed under any view —
// uneven scale, skew and mirroring included): the already-placed pending
// segments, plus either a rubber band out to the cursor (hovering) or — mid
// drag past the bow threshold — the just-placed segment bending live under
// the pointer. Arcs use the same sweep/large convention as sketchPath's
// committed outline. Pure read; never mutates the doc.
const previewD = computed(() => {
  if (tool.value !== 'path' && tool.value !== 'curve') return ''
  const pp = pendingPath.value
  if (!pp || pp.anchors.length === 0) return ''
  const first = worldPt(pp.anchors[0]!)
  if (!first) return ''
  let d = `M ${first.x} ${first.y}`
  const segCount = pp.segments.length
  const lastAnchorId = pp.anchors[pp.anchors.length - 1]!
  const pathDrag = tool.value === 'path' ? getPathDrag() : null
  const bowing = !!pathDrag && pathDrag.bowed && pathDrag.anchor === lastAnchorId && !!penCursor.value
  const curveDrag = tool.value === 'curve' ? getCurveDrag() : null
  const dragging = !!curveDrag && curveDrag.anchor === lastAnchorId
  for (let i = 0; i < segCount; i++) {
    const seg = pp.segments[i]!
    const fromId = pp.anchors[i]!
    const toId = pp.anchors[i + 1]!
    const to = worldPt(toId)
    if (!to) break
    if (bowing && i === segCount - 1) {
      // just-placed segment bowing live under the pointer
      // (bowPreview: the same arc the ghost circle shows and the release commits,
      // tangent snap included)
      const arc = bowPreview(penCursor.value)
      if (arc) d += ` A ${arc.r} ${arc.r} 0 ${arc.large} ${arc.sweep} ${to.x} ${to.y}`
      else d += ` L ${to.x} ${to.y}`
    } else if (seg.kind === 'arc') {
      const from = worldPt(fromId)
      const c = worldPt(seg.center)
      if (from && c) {
        const r = Math.hypot(from.x - c.x, from.y - c.y)
        const a0 = Math.atan2(from.y - c.y, from.x - c.x)
        const a1 = Math.atan2(to.y - c.y, to.x - c.x)
        const TAU = Math.PI * 2
        const ccw = ((a1 - a0) % TAU + TAU) % TAU
        const span = seg.sweep === 1 ? ccw : TAU - ccw
        const large = span > Math.PI ? 1 : 0
        d += ` A ${r} ${r} 0 ${large} ${seg.sweep} ${to.x} ${to.y}`
      } else d += ` L ${to.x} ${to.y}`
    } else if (seg.kind === 'cubic') {
      const c1 = (seg.h1 && worldPt(seg.h1)) || worldPt(fromId) || to
      if (dragging && curveDrag!.smooth && i === segCount - 1 && penCursor.value) {
        // bending live: c2 is the pointer mirrored through the point being
        // placed (what addSmoothHandles will make of it on release)
        const ptr = penCursor.value
        d += ` C ${c1.x} ${c1.y} ${2 * to.x - ptr.x} ${2 * to.y - ptr.y} ${to.x} ${to.y}`
      } else {
        const c2 = (seg.h2 && worldPt(seg.h2)) || to
        d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`
      }
    } else {
      d += ` L ${to.x} ${to.y}`
    }
  }
  const last = worldPt(lastAnchorId)
  if (tool.value === 'curve') {
    // rubber band: a curve out of the last point's held out-handle, if any
    if (!dragging && penCursor.value && last) {
      const ptr = penCursor.value
      const hId = getHeldHandles().lastHOut
      const h = hId ? worldPt(hId) : null
      d += h ? ` M ${last.x} ${last.y} C ${h.x} ${h.y} ${ptr.x} ${ptr.y} ${ptr.x} ${ptr.y}`
             : ` M ${last.x} ${last.y} L ${ptr.x} ${ptr.y}`
    }
    return d
  }
  if (!bowing && penCursor.value && last) {
    // the snapped placement (Shift 45° / right-angle), not the raw cursor,
    // so the rubber band matches where pathDown will place the anchor.
    const ptr = placementPreview.value ?? penCursor.value
    d += ` M ${last.x} ${last.y} L ${ptr.x} ${ptr.y}`
  }
  return d
})

// the two handles a Curve drag is pulling out: point→pointer and its mirror
const previewDragHandles = computed(() => {
  const curveDrag = getCurveDrag()
  if (tool.value !== 'curve' || !curveDrag || !curveDrag.smooth || !penCursor.value) return null
  const anchor = screenPt(curveDrag.anchor)
  if (!anchor) return null
  const ptr = toScreen(penCursor.value)
  return { anchor, ptr, mirror: { x: 2 * anchor.x - ptr.x, y: 2 * anchor.y - ptr.y } }
})

// live radius chip while the path tool drags a segment into a curve, sat on
// the dashed radius leader from the arc's centre to its bow midpoint. It also
// carries the ghost circle (the arc's full circle, drawing space) and the
// leader's ends (screen space). When the bow is joint-tangent-locked to the
// previous segment (snappedTangent), it carries J's screen position for a "T"
// chip; when it snapped tangent onto nearby geometry, `touch` is where it touches.
const pathBowChip = computed(() => {
  const pathDrag = getPathDrag()
  if (tool.value !== 'path' || !pathDrag || !pathDrag.bowed || !penCursor.value) return null
  const p0 = worldPt(pathDrag.prevAnchor)
  if (!p0) return null
  const pv = bowPreview(penCursor.value)
  if (!pv) return null
  const mid = toScreen(pv.mid)
  const c = toScreen(pv.center)
  const j = toScreen(p0)
  return {
    x: (c.x + mid.x) / 2, y: (c.y + mid.y) / 2,
    center: pv.center, r: pv.r, cx: c.x, cy: c.y, midX: mid.x, midY: mid.y,
    // type-a-dimension: a typed value (with a caret) replaces the measured radius
    text: dimBuffer.value ? dimBuffer.value + '|' : `R ${pv.r.toFixed(1)}`,
    snappedTangent: pv.snappedTangent, jointX: j.x, jointY: j.y,
    // snapped tangent onto nearby geometry: where it touches (screen)
    touch: pv.touch ? toScreen(pv.touch.touch) : null,
  }
})

// length dimension line on the straight rubber band: parallel to last
// anchor → placement point, DIM_OFFSET_PX to the side that reads as above
// (left, for a vertical band), with extension ticks at both ends and the
// length in drawing units on a chip. Type-a-dimension: a typed value (with a
// caret) replaces the measured length, and stays up even on a short band.
const DIM_OFFSET_PX = 14
const DIM_MIN_PX = 24
const lineDim = computed(() => {
  if (tool.value !== 'path') return null
  const pathDrag = getPathDrag()
  if (pathDrag && pathDrag.bowed) return null   // the arc bow owns the chip via pathBowChip instead
  const pp = pendingPath.value
  const place = placementPreview.value
  if (!pp || !place) return null
  const lastW = worldPt(pp.anchors[pp.anchors.length - 1]!)
  if (!lastW) return null
  const a = toScreen(lastW), b = toScreen(place)
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < DIM_MIN_PX && !dimBuffer.value) return null
  const ux = len > 1e-9 ? (b.x - a.x) / len : 1, uy = len > 1e-9 ? (b.y - a.y) / len : 0
  let nx = uy, ny = -ux
  if (ny > 1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) { nx = -nx; ny = -ny }
  const off = (p: { x: number; y: number }, k: number) => ({ x: p.x + nx * k, y: p.y + ny * k })
  const d0 = off(a, DIM_OFFSET_PX), d1 = off(b, DIM_OFFSET_PX)
  const t0a = off(a, 3), t0b = off(a, DIM_OFFSET_PX + 3), t1a = off(b, 3), t1b = off(b, DIM_OFFSET_PX + 3)
  const text = dimBuffer.value ? dimBuffer.value + '|' : Math.hypot(place.x - lastW.x, place.y - lastW.y).toFixed(1)
  return {
    x1: d0.x, y1: d0.y, x2: d1.x, y2: d1.y,
    ticks: [{ x1: t0a.x, y1: t0a.y, x2: t0b.x, y2: t0b.y }, { x1: t1a.x, y1: t1a.y, x2: t1b.x, y2: t1b.y }],
    x: (d0.x + d1.x) / 2, y: (d0.y + d1.y) / 2, text, w: text.length * 6 + 8,
  }
})

// "⊥" chip at the corner while the next anchor is snapping square to the
// last line segment (usePen's right-angle snap)
const rightAngleChip = computed(() => {
  if (tool.value !== 'path' || getPathDrag() || !placementPreview.value?.perpendicular) return null
  const pp = pendingPath.value
  return pp ? screenPt(pp.anchors[pp.anchors.length - 1]!) : null
})

// "T" chip at the joint while the next anchor is snapping onto the tangent of
// the arc it leaves (usePen's snapArcTangent)
const tangentChip = computed(() => {
  if (tool.value !== 'path' || getPathDrag() || !placementPreview.value?.tangent) return null
  const pp = pendingPath.value
  return pp ? screenPt(pp.anchors[pp.anchors.length - 1]!) : null
})

const drawPressing = () => (tool.value === 'path' && !!getPathDrag()) || (tool.value === 'curve' && !!getCurveDrag())

// soft ring under the pointer while a path/curve press is live
const cursorGlow = computed(() => {
  const c = penCursor.value
  if (!c || !drawPressing()) return null
  return toScreen(c)
})

// hovering a drawing tool where the next point would join existing geometry
// (usePen's hoverSnap): a chip at the snapped spot saying what will happen —
// ⊙ onto a point, a bar with a centre tick onto a middle, a dot on an arc
// onto a curve. It stands in for the glow ring there, and sits up-left of
// the spot so it never covers the R / rule chips that sit up-right.
const snapPreview = computed(() => {
  const h = hoverSnap.value
  if (!h || drawPressing()) return null
  return { ...toScreen(h), kind: h.kind }
})

// Trim: the piece under the pointer, in drawing space (drawn thick and tinted
// — the "will be removed" look), plus a small screen-space ring at each end
// where a crossing cuts it. Cut: the point a click would add. Dissolve: the
// point a click would remove (green when its two pieces line up).
const trimHoverD = computed(() => (tool.value === 'trim' && trimHover.value ? spanPathD(doc.value, trimHover.value) : ''))
const trimHoverRings = computed(() => trimHoverEnds.value.map(p => toScreen(p)))
const cutHoverScreen = computed(() => (tool.value === 'cut' && cutHover.value ? toScreen(cutHover.value) : null))
const dissolveHoverScreen = computed(() => {
  const h = tool.value === 'dissolve' ? dissolveHover.value : null
  return h ? { ...toScreen(h), ok: h.ok } : null
})

// screen-space sparkles: a small burst of short rays radiating from the
// point, ease-out pop + linear fade to 0 by SPARKLE_LIFETIME_MS.
const SPARKLE_RAYS = 6
const sparkleRender = computed(() => sparkles.value.map(s => {
  const t = clamp((sparkleClock.value - s.born) / SPARKLE_LIFETIME_MS, 0, 1)
  const pop = 1 - Math.pow(1 - Math.min(t * 2, 1), 3)
  const opacity = 1 - t
  const { x: cx, y: cy } = toScreen(s)
  const inner = 3 + 4 * pop
  const outer = inner + 4 * pop
  const rays = Array.from({ length: SPARKLE_RAYS }, (_, k) => {
    const ang = (k / SPARKLE_RAYS) * Math.PI * 2
    return { x1: cx + Math.cos(ang) * inner, y1: cy + Math.sin(ang) * inner,
             x2: cx + Math.cos(ang) * outer, y2: cy + Math.sin(ang) * outer }
  })
  return { id: s.id, opacity, rays }
}))

// ---------- pointer input ----------

let dragId: EntityId | null = null
let moved = false
// handle points riding the dragged anchor: translated by the same delta as
// the anchor each move, so their arms keep shape
let dragHandleIds: EntityId[] = []
let dragLast: { x: number; y: number } | null = null

// select-tool marquee + click-empty-deselect. A pointerdown on EMPTY canvas
// (entity/point pointerdowns stopPropagation first) starts a marquee
// candidate, resolved on pointerup: no movement past the threshold → a plain
// click on empty space (clears the selection unless shift); past it → a
// box-select via marqueeSelectScreen() — the pixel rectangle itself, so it is
// right under a rotated or mirrored view. Screen-pixel state; never touches `doc`.
const marqueeRect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
let marqueeStart: { x: number; y: number } | null = null
let marqueeMoved = false
let marqueeAdditive = false
const MARQUEE_THRESHOLD_PX = 3

// Escape aborts a live marquee (offered to the pen's Escape order right
// after a pending op / typed dimension, before the host's pan)
function cancelMarquee(): boolean {
  if (!marqueeStart) return false
  marqueeStart = null; marqueeMoved = false; marqueeRect.value = null
  return true
}

// handle ids attached to a given anchor: h1 of the segment leaving it, h2 of
// the segment arriving at it
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

// svg-local pixels — the frame the view matrix maps drawing space into.
// Mapped through the inverse screen CTM, so a CSS transform on an ancestor
// (a host's scale() zoom wrapper) is undone too; the bounding-rect fallback
// still corrects for a uniform/uneven scale.
function localXY(ev: PointerEvent) {
  const el = svgEl.value ?? (ev.currentTarget as SVGSVGElement)
  const ctm = el.getScreenCTM?.()
  const inv = ctm && typeof DOMPoint !== 'undefined' ? ctm.inverse() : null
  if (inv && Number.isFinite(inv.a)) {
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(inv)
    return { x: p.x, y: p.y }
  }
  const r = el.getBoundingClientRect()
  const kx = r.width > 0 ? props.width / r.width : 1
  const ky = r.height > 0 ? props.height / r.height : 1
  return { x: (ev.clientX - r.left) * kx, y: (ev.clientY - r.top) * ky }
}
// null for a singular view: the event is ignored rather than mapped anywhere
function toDrawing(p: { x: number; y: number }): { x: number; y: number } | null {
  const inv = invertView(props.view)
  return inv ? applyView(inv, p) : null
}
function drawingXY(ev: PointerEvent) {
  return toDrawing(localXY(ev))
}

function onEntityPointerDown(id: EntityId, ev: PointerEvent) {
  if (!props.active || ev.button !== 0 || isCtrlContextClick(ev)) return
  // guided Mirror: a line click supplies the axis
  if (tool.value === 'select' && pendingOp.value?.kind === 'mirror' && (doc.value.entities.find(e => e.id === id) as any)?.kind === 'line') {
    applyMirror(pendingOp.value.units, id)
    ev.stopPropagation(); return
  }
  // non-point entities never drag via pointer — select immediately,
  // replacing unless shift-held.
  if (tool.value === 'select') { pick(id, ev.shiftKey); ev.stopPropagation() }
}
function onPointerDownPoint(id: EntityId, ev: PointerEvent) {
  if (!props.active || ev.button !== 0 || isCtrlContextClick(ev) || tool.value !== 'select') return
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
  if (!props.active) return
  // a click without a drag replaces the selection (or shift-toggles this
  // point); the selection only changes here, once we know it was a click.
  // (Shift or Option adds: a point + an Option-clicked segment stay paired)
  if (tool.value === 'select' && dragId === id && !moved) { pick(id, ev.shiftKey || ev.altKey); ev.stopPropagation() }
  // a real drag bubbles on to onPointerUp, which settles it (and the join)
  if (!moved) { dragId = null; dragHandleIds = []; dragLast = null }
}
function onSegmentPointerDown(pathId: EntityId, segIndex: number, ev: PointerEvent) {
  if (!props.active || ev.button !== 0 || isCtrlContextClick(ev) || tool.value !== 'select') return
  // guided ops treat a path-body click as picking the whole path (the unit)
  if (pendingOp.value) { pick(pathId, ev.shiftKey); ev.stopPropagation(); return }
  // a plain click selects the WHOLE path; Alt/Option-click drills in to the
  // single segment under the cursor for the per-segment verbs
  if (ev.altKey) pickSegment(pathId, segIndex, ev.shiftKey)
  else pick(pathId, ev.shiftKey)
  ev.stopPropagation()
}
function onPointerDownSvg(ev: PointerEvent) {
  if (!props.active || ev.button !== 0 || isCtrlContextClick(ev)) return
  if (tool.value === 'select') {
    // guided Repeat with an empty-canvas click: drop a fresh FIXED center
    // where they clicked and repeat around it. Mirror needs a real line, so
    // an empty click there just cancels the armed op.
    if (pendingOp.value?.kind === 'repeat') {
      const w = drawingXY(ev)
      if (!w) return
      const center = addPoint(doc.value, w.x, w.y, { fixed: true })
      applyRepeat(pendingOp.value.units, center, pendingOp.value.count)
      return
    }
    if (pendingOp.value?.kind === 'mirror') { cancelPendingOp(); status.value = 'Mirror cancelled — click a line to reflect across'; return }
    // a miss: start a marquee candidate
    const { x, y } = localXY(ev)
    marqueeStart = { x, y }
    marqueeMoved = false
    marqueeAdditive = ev.shiftKey
    marqueeRect.value = { x, y, w: 0, h: 0 }
    return
  }
  const w = drawingXY(ev)
  if (!w) return
  if (tool.value === 'trim') { trimDown(w.x, w.y); return }
  if (tool.value === 'cut') { cutClick(w.x, w.y); return }
  if (tool.value === 'dissolve') { dissolveClick(w.x, w.y); return }
  if (tool.value === 'path') { pathDown(w.x, w.y, ev.shiftKey); return }
  if (tool.value === 'curve') { curveDown(w.x, w.y); return }
  const { x, y } = w
  place(x, y)
}
function onPointerMove(ev: PointerEvent) {
  if (!props.active) return
  if (marqueeStart) {
    if (ev.buttons === 0) return   // button released off-canvas — pointerup/leave settles it
    const { x, y } = localXY(ev)
    if (!marqueeMoved && Math.hypot(x - marqueeStart.x, y - marqueeStart.y) > MARQUEE_THRESHOLD_PX) marqueeMoved = true
    marqueeRect.value = {
      x: Math.min(marqueeStart.x, x), y: Math.min(marqueeStart.y, y),
      w: Math.abs(x - marqueeStart.x), h: Math.abs(y - marqueeStart.y),
    }
    return
  }
  if (tool.value === 'path') {
    // always track — drives the rubber band even when not mid-drag, and the
    // live bow while a drag is active
    const w = drawingXY(ev)
    if (w) pathMove(w.x, w.y, ev.shiftKey)
    return
  }
  if (tool.value === 'curve') {
    const w = drawingXY(ev)
    if (w) curveMove(w.x, w.y)
    return
  }
  if (tool.value === 'trim' || tool.value === 'cut' || tool.value === 'dissolve') {
    const w = drawingXY(ev)
    if (!w) { clearToolHover(); return }
    if (tool.value === 'trim') trimMove(w.x, w.y)
    else if (tool.value === 'cut') cutMove(w.x, w.y)
    else dissolveMove(w.x, w.y)
    return
  }
  if (tool.value === 'point' || tool.value === 'line' || tool.value === 'circle') {
    // hover only — feeds the pen's hoverSnap (the cursor glow)
    const w = drawingXY(ev)
    penCursor.value = w ? { x: w.x, y: w.y, shift: ev.shiftKey } : null
    return
  }
  if (!dragId || ev.buttons === 0) return
  const w = drawingXY(ev)
  if (!w) return
  const { x, y } = w
  moved = true
  // the pen moves the point — onto the spot it would join, while one is in
  // reach (⌘ / Ctrl: a plain move) — then its handles follow by the same step
  dragPoint(dragId, x, y, noJoinKey(ev))
  if (dragHandleIds.length && dragLast) {
    const p = doc.value.entities.find(e => e.id === dragId) as any
    if (p && p.kind === 'point') {
      const dx = p.x - dragLast.x, dy = p.y - dragLast.y
      for (const hid of dragHandleIds) {
        const h = doc.value.entities.find(e => e.id === hid) as any
        if (h && h.kind === 'point') { h.x += dx; h.y += dy }
      }
      dragLast = { x: p.x, y: p.y }
    }
  }
}
// ⌘ (Mac) / Ctrl held: move a point without joining it to anything
function noJoinKey(ev: PointerEvent) { return ev.metaKey || ev.ctrlKey }
function onPointerUp(ev: PointerEvent) {
  if (!props.active) return
  if (tool.value === 'trim') {
    const w = drawingXY(ev)
    if (w) trimUp(w.x, w.y)
    else trimUp()
    return
  }
  if (tool.value === 'path' && getPathDrag()) {
    const w = drawingXY(ev)
    if (w) pathUp(w.x, w.y)
    return
  }
  if (tool.value === 'curve' && getCurveDrag()) {
    const w = drawingXY(ev)
    if (w) curveUp(w.x, w.y)
    return
  }
  if (marqueeStart) {
    const start = marqueeStart, additive = marqueeAdditive, didMove = marqueeMoved
    marqueeStart = null; marqueeMoved = false; marqueeRect.value = null
    if (!didMove) {
      // plain click on empty canvas: deselect (entity AND segment selection);
      // shift+click-empty is a no-op
      if (!additive) { clearSel(); clearSegSel() }
      return
    }
    const end = localXY(ev)
    marqueeSelectScreen(start.x, start.y, end.x, end.y, additive)
    return   // selection change only — no commitHistory (not a doc mutation)
  }
  // settle a select-tool point drag as ONE history entry, joining the point
  // onto what it was dropped on — release can land off the point circle
  // (onPointerUpPoint never fires then), so this is the single reliable place
  // to settle. Leaving the canvas mid-drag settles as a plain move.
  if (tool.value === 'select' && moved && dragId) dropPoint(dragId, noJoinKey(ev) || ev.type === 'pointerleave')
  else if (tool.value === 'select' && moved) commitHistory()
  dragId = null; dragHandleIds = []; dragLast = null
  moved = false
}
function onPointerLeave(ev: PointerEvent) {
  if (!props.active) return
  onPointerUp(ev)
  penCursor.value = null
  clearToolHover()
}

// badge / chip clicks, gated like every other input
function onMarkClick(m: Parameters<typeof onConstraintMarkClick>[0], ev: MouseEvent) {
  if (props.active) onConstraintMarkClick(m, ev)
}
function onDimClick(m: Parameters<typeof onArcDimClick>[0]) {
  if (props.active) onArcDimClick(m)
}

// parked mid-gesture: drop the overlay's own live gesture state (a marquee or
// a point drag) so nothing resumes when it becomes active again — and end the
// PEN's own live gesture too (fix b: a path/curve down→drag never left
// hanging without a pointerup would otherwise resume mid-air on reactivation)
watch(() => props.active, (on) => {
  if (on) return
  settleOverlayGesture()
  endGesture()
})
// the overlay's own live gesture, settled: a marquee is dropped (no selection
// change); a moved point drag commits as its own step with no join
function settleOverlayGesture(): void {
  cancelMarquee()
  if (moved && tool.value === 'select') { if (dragId) dropPoint(dragId, true); else commitHistory() }
  dragId = null; dragHandleIds = []; dragLast = null; moved = false
}
// a single-letter tool key the pen will act on (penKeys.ts: no modifier, a
// tool this host offers)
function isToolKey(ev: KeyboardEvent): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.key.length !== 1) return false
  const t = TOOL_KEYS[ev.key.toLowerCase()]
  return !!t && props.pen.options.tools.includes(t)
}

// ---------- keyboard ----------

// a focused button / link / select owns Enter (it activates it) — the pen
// must not also finish a path or commit. Escape still reaches the pen (a
// focused toolbar button is the normal state right after picking a tool, and
// Escape must still cancel a path), but is not handed to the host as 'cancel'.
function focusedControl(ev: KeyboardEvent): boolean {
  const CONTROLS = 'button, a[href], select, [role="button"], [role="link"]'
  const t = ev.target as Element | null
  const a = typeof document !== 'undefined' ? document.activeElement : null
  return !!(t?.closest?.(CONTROLS) || a?.closest?.(CONTROLS))
}
// Key ownership: a key the pen acts on is preventDefault-ed and
// stopPropagation-ed inside pen.onKeydown; an Escape/Enter the overlay turns
// into `cancel`/`commit` is too, so a host that closes on Escape (unless
// defaultPrevented) does not also close. Keys nobody acts on pass untouched.
//
// The typing guard (isTypingInField) and the focused-control rule run FIRST,
// before the key ever reaches the pen — this holds in both keyboard modes.
// In `keyboard="host"` this function IS onHostKeydown, called from the
// host's own CAPTURE-phase window listener, which runs before an input's own
// handlers; a field's `stopPropagation` (e.g. PenValueRow's) cannot protect
// it there, so the guard has to be the first thing this function does, not
// something a caller is trusted to check beforehand.
// Returns whether the key was consumed (by the pen, or by the overlay's own
// commit/cancel) — a key ignored because the user is typing returns false.
function handleKeydownEvent(ev: KeyboardEvent): boolean {
  if (!props.active || isTypingInField()) return false
  const onControl = (ev.key === 'Enter' || ev.key === 'Escape') && focusedControl(ev)
  if (onControl && ev.key === 'Enter') return false
  // switching tools mid marquee or mid point drag: settle it first, or the
  // marquee stays live (swallowing later moves) and the dragged point is left
  // mid-solve, folded into whatever step comes next
  if (isToolKey(ev)) settleOverlayGesture()
  const handled = props.pen.onKeydown(ev, { cancelGesture: cancelMarquee })
  if (handled) return true
  if (onControl) return false
  if (ev.key === 'Escape') {
    ev.preventDefault(); ev.stopPropagation()
    emit('cancel')
    return true
  } else if (ev.key === 'Enter' && !(ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault(); ev.stopPropagation()
    finishSession()   // no orphan start point / lone anchor reaches the host
    emit('commit')
    return true
  }
  return false
}
function onKeydown(ev: KeyboardEvent) { handleKeydownEvent(ev) }
function onKeyup(ev: KeyboardEvent) { if (props.active) props.pen.onKeyup(ev) }
function onBlur() { props.pen.onBlur() }

onMounted(() => {
  if (keyboardMode === 'host') return
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  if (keyboardMode === 'host') return
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onBlur)
})

// HOST CONTRACT (keyboard="host"): the host must call onHostKeydown from its
// OWN capture-phase window keydown listener and stop propagation when it
// returns true; onHostKeyup similarly for keyup, and onHostBlur for blur. The
// overlay does not touch window listeners itself in this mode (see onMounted
// above).
defineExpose({
  onHostKeydown: handleKeydownEvent,
  onHostKeyup: onKeyup,
  onHostBlur: onBlur,
})
</script>

<template>
  <svg ref="svgEl" :width="width" :height="height"
       :style="{ position: 'absolute', left: 0, top: 0, display: 'block', touchAction: 'none', cursor, pointerEvents: active ? undefined : 'none' }"
       @pointerdown="onPointerDownSvg" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointerleave="onPointerLeave"
       @contextmenu.prevent>
    <!-- drawing space: the view matrix does scale, rotation and mirroring -->
    <g :transform="svgTransform">
      <path :d="pathDrawing" fill="none" stroke="#3730a3" stroke-width="1.5" vector-effect="non-scaling-stroke" />
      <path :d="constructionDrawing" fill="none" stroke="#9ca3af" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
      <template v-for="e in doc.entities" :key="'hit-' + e.id">
        <!-- path-kind entities are hit-tested PER SEGMENT below instead of as
             one whole-entity hit-path. Whole-entity selection still renders
             its orange highlight here. -->
        <path v-if="e.kind !== 'point' && e.kind !== 'path'" :d="entityPathDrawing(e.id)" fill="none" stroke="transparent" stroke-width="12"
              vector-effect="non-scaling-stroke"
              :style="{ cursor: 'pointer' }" @pointerdown="(ev) => onEntityPointerDown(e.id, ev)" :data-ent="e.id" />
        <path v-if="e.kind !== 'point' && selection.includes(e.id)" :d="entityPathDrawing(e.id)" fill="none" stroke="#f59e0b" stroke-width="2.5"
              vector-effect="non-scaling-stroke" pointer-events="none" />
        <template v-if="e.kind === 'path'">
          <path v-for="(seg, i) in ((e as any).segments as SegmentSpec[])" :key="'seghit-' + e.id + '-' + i"
                :d="segmentPathDrawing(e.id, i as number)" fill="none" stroke="transparent" stroke-width="12"
                vector-effect="non-scaling-stroke"
                :style="{ cursor: 'pointer' }" @pointerdown="(ev) => onSegmentPointerDown(e.id, i as number, ev)"
                :data-seg="e.id + ':' + i" />
        </template>
      </template>
      <template v-for="s in selectedSegments" :key="'segsel-' + s.pathId + '-' + s.segIndex">
        <path :d="segmentPathDrawing(s.pathId, s.segIndex)" fill="none" stroke="#f59e0b" stroke-width="2.5"
              vector-effect="non-scaling-stroke" pointer-events="none" data-seg-selected />
      </template>
    </g>
    <!-- screen space -->
    <line v-for="(a, i) in handleArms" :key="'arm-' + i" :x1="a.x1" :y1="a.y1" :x2="a.x2" :y2="a.y2"
          :stroke="HANDLE_COLOR" stroke-width="1" pointer-events="none" data-handle-arm />
    <!-- live draw preview: drawing space, like the outline it previews -->
    <g v-if="previewD" :transform="svgTransform" pointer-events="none">
      <path :d="previewD" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="5 3"
            vector-effect="non-scaling-stroke" data-path-preview />
    </g>
    <!-- Trim: removed pieces as faint dotted ghosts, and the piece under the
         pointer drawn thick and tinted — drawing space, like the outline -->
    <g v-if="trimGhosts.length && tool === 'trim'" :transform="svgTransform" pointer-events="none">
      <path v-for="(d, i) in trimGhosts" :key="'ghost-' + i" :d="d" fill="none" stroke="#3730a3" stroke-width="1"
            stroke-dasharray="1 3" opacity="0.35" vector-effect="non-scaling-stroke" data-trim-ghost />
    </g>
    <g v-if="trimHoverD" :transform="svgTransform" pointer-events="none" data-trim-hover>
      <path :d="trimHoverD" fill="none" stroke="#ef4444" stroke-opacity="0.55" stroke-width="4" stroke-linecap="round"
            vector-effect="non-scaling-stroke" />
    </g>
    <circle v-for="(r, i) in trimHoverRings" :key="'trimring-' + i" :cx="r.x" :cy="r.y" r="4" fill="none"
            stroke="#ef4444" stroke-width="1.5" pointer-events="none" data-trim-ring />
    <!-- bowing: the arc's full circle, faint, in drawing space -->
    <g v-if="pathBowChip" :transform="svgTransform" pointer-events="none" data-bow-ghost :data-tangent="pathBowChip.touch ? '' : null">
      <circle :cx="pathBowChip.center.x" :cy="pathBowChip.center.y" :r="pathBowChip.r" fill="none"
              :stroke="pathBowChip.touch ? '#16a34a' : '#6366f1'" stroke-width="1" stroke-dasharray="3 4" :opacity="pathBowChip.touch ? 0.7 : 0.35" vector-effect="non-scaling-stroke" />
    </g>
    <g v-if="pathBowChip" pointer-events="none" data-bow-leader>
      <line :x1="pathBowChip.cx" :y1="pathBowChip.cy" :x2="pathBowChip.midX" :y2="pathBowChip.midY"
            stroke="#6366f1" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />
      <circle :cx="pathBowChip.cx" :cy="pathBowChip.cy" r="2.5" fill="#6366f1" />
    </g>
    <g v-if="cursorGlow" pointer-events="none" data-cursor-glow>
      <circle :cx="cursorGlow.x" :cy="cursorGlow.y" r="10" fill="#6366f1" fill-opacity="0.18" />
    </g>
    <g v-if="previewDragHandles" pointer-events="none" data-drag-handles>
      <line :x1="previewDragHandles.anchor.x" :y1="previewDragHandles.anchor.y" :x2="previewDragHandles.ptr.x" :y2="previewDragHandles.ptr.y"
            :stroke="HANDLE_COLOR" stroke-width="1" />
      <line :x1="previewDragHandles.anchor.x" :y1="previewDragHandles.anchor.y" :x2="previewDragHandles.mirror.x" :y2="previewDragHandles.mirror.y"
            :stroke="HANDLE_COLOR" stroke-width="1" />
      <circle :cx="previewDragHandles.ptr.x" :cy="previewDragHandles.ptr.y" r="3" :fill="HANDLE_COLOR" />
      <circle :cx="previewDragHandles.mirror.x" :cy="previewDragHandles.mirror.y" r="3" :fill="HANDLE_COLOR" />
    </g>
    <template v-for="{ p, s, handle, role } in pts" :key="p.id">
      <!-- the hit target: same size and pointer behaviour as before a role
           had a distinct look — [data-point] click/drag specs rely on this.
           When a distinct glyph is drawn on top (below), this stays invisible
           and only the glyph carries the visible look. -->
      <circle :cx="s.x" :cy="s.y" :r="pointRadius(p)"
              :fill="hasDistinctRoleGlyph(p, role, handle) ? 'transparent' : pointFill(p)"
              :stroke="hasDistinctRoleGlyph(p, role, handle) ? 'transparent' : pointStroke(p, handle)" stroke-width="1.5"
              :style="{ cursor: tool === 'select' ? 'grab' : 'crosshair' }"
              @pointerdown="(ev) => onPointerDownPoint(p.id, ev)" @pointerup="(ev) => onPointerUpPoint(p.id, ev)"
              :pointer-events="active ? (handle ? 'all' : undefined) : 'none'"
              :data-point="p.id" :data-construction="p.construction ? '' : null" :data-handle="handle ? '' : null"
              :data-point-role="handle ? null : role" />
      <!-- JOINT: small solid dot -->
      <circle v-if="hasDistinctRoleGlyph(p, role, handle) && role === 'joint'" :cx="s.x" :cy="s.y" r="3"
              :fill="roleGlyphColor(p)" pointer-events="none" />
      <!-- END: hollow square -->
      <rect v-if="hasDistinctRoleGlyph(p, role, handle) && role === 'end'" :x="s.x - 3.5" :y="s.y - 3.5" width="7" height="7"
            fill="none" :stroke="roleGlyphColor(p)" stroke-width="1.5" pointer-events="none" />
      <!-- CENTRE: hollow circle -->
      <circle v-if="hasDistinctRoleGlyph(p, role, handle) && role === 'centre'" :cx="s.x" :cy="s.y" r="5"
              fill="none" :stroke="roleGlyphColor(p)" stroke-width="1.5" pointer-events="none" />
    </template>
    <circle v-if="cutHoverScreen" :cx="cutHoverScreen.x" :cy="cutHoverScreen.y" r="5" fill="#fff" stroke="#ef4444"
            stroke-width="1.5" pointer-events="none" data-cut-hover />
    <circle v-if="dissolveHoverScreen" :cx="dissolveHoverScreen.x" :cy="dissolveHoverScreen.y" r="9" fill="none"
            :stroke="dissolveHoverScreen.ok ? '#16a34a' : '#9ca3af'" stroke-width="2" pointer-events="none"
            :data-dissolve-hover="dissolveHoverScreen.ok ? 'ok' : 'no'" />
    <template v-if="showLabels">
      <g v-for="{ m, w, x, y } in visibleMarks" :key="m.id" class="constraint-badge" :pointer-events="active ? 'auto' : 'none'" style="cursor: pointer"
         :data-constraint="m.id" :data-constraint-kind="m.kind"
         @pointerdown.stop @click.stop="onMarkClick(m, $event)">
        <title>{{ m.text != null ? 'click to edit · shift+click to remove' : 'click to remove' }}</title>
        <rect :x="x" :y="y" :width="w" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="x + 3" :y="y + 11" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.glyph }}{{ m.text ? ' ' + m.text : '' }}</text>
      </g>
      <g v-for="{ m, w, x, y } in arcDims" :key="m.id" :pointer-events="active ? 'auto' : 'none'" style="cursor: pointer"
         @pointerdown.stop @click.stop="onDimClick(m)">
        <rect :x="x" :y="y" :width="w" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="x + 3" :y="y + 11" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.text }}</text>
      </g>
    </template>
    <g v-if="pathBowChip" pointer-events="none" data-bow-chip>
      <rect :x="pathBowChip.x - 20" :y="pathBowChip.y - 7" width="40" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="pathBowChip.x - 17" :y="pathBowChip.y + 4" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ pathBowChip.text }}</text>
    </g>
    <g v-if="pathBowChip && pathBowChip.snappedTangent" pointer-events="none">
      <rect :x="pathBowChip.jointX + 6" :y="pathBowChip.jointY - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="pathBowChip.jointX + 9" :y="pathBowChip.jointY - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
    </g>
    <g v-if="pathBowChip && pathBowChip.touch" pointer-events="none" data-bow-tangent>
      <circle :cx="pathBowChip.touch.x" :cy="pathBowChip.touch.y" r="3" fill="none" stroke="#16a34a" stroke-width="1.5" />
      <rect :x="pathBowChip.touch.x + 6" :y="pathBowChip.touch.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="pathBowChip.touch.x + 9" :y="pathBowChip.touch.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
    </g>
    <g v-if="snapPreview" pointer-events="none" data-snap-preview :data-snap-kind="snapPreview.kind">
      <circle :cx="snapPreview.x" :cy="snapPreview.y" r="3" fill="none" stroke="#6366f1" stroke-width="1.5" />
      <rect :x="snapPreview.x - 22" :y="snapPreview.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text v-if="snapPreview.kind === 'point'" :x="snapPreview.x - 19" :y="snapPreview.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">⊙</text>
      <g v-else-if="snapPreview.kind === 'midpoint'" stroke="#e5e7eb" stroke-width="1.2" stroke-linecap="round">
        <line :x1="snapPreview.x - 19" :y1="snapPreview.y - 9" :x2="snapPreview.x - 9" :y2="snapPreview.y - 9" />
        <line :x1="snapPreview.x - 14" :y1="snapPreview.y - 12" :x2="snapPreview.x - 14" :y2="snapPreview.y - 6" />
      </g>
      <g v-else>
        <path :d="`M ${snapPreview.x - 19.5} ${snapPreview.y - 6} Q ${snapPreview.x - 14} ${snapPreview.y - 14} ${snapPreview.x - 8.5} ${snapPreview.y - 6}`"
              fill="none" stroke="#e5e7eb" stroke-width="1.2" stroke-linecap="round" />
        <circle :cx="snapPreview.x - 14" :cy="snapPreview.y - 10" r="1.8" fill="#e5e7eb" />
      </g>
    </g>
    <g v-if="rightAngleChip" pointer-events="none" data-right-angle>
      <rect :x="rightAngleChip.x + 6" :y="rightAngleChip.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="rightAngleChip.x + 9" :y="rightAngleChip.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">⊥</text>
    </g>
    <g v-if="tangentChip" pointer-events="none" data-tangent-chip>
      <rect :x="tangentChip.x + 6" :y="tangentChip.y - 16" width="16" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="tangentChip.x + 9" :y="tangentChip.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">T</text>
    </g>
    <g v-if="lineDim" pointer-events="none" data-line-dim>
      <line :x1="lineDim.x1" :y1="lineDim.y1" :x2="lineDim.x2" :y2="lineDim.y2" stroke="#6366f1" stroke-width="1" opacity="0.7" />
      <line v-for="(t, i) in lineDim.ticks" :key="'dimtick-' + i" :x1="t.x1" :y1="t.y1" :x2="t.x2" :y2="t.y2"
            stroke="#6366f1" stroke-width="1" opacity="0.7" />
      <rect :x="lineDim.x - lineDim.w / 2" :y="lineDim.y - 7" :width="lineDim.w" height="14" rx="3" fill="#111827" opacity="0.85" />
      <text :x="lineDim.x" :y="lineDim.y + 4" text-anchor="middle" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ lineDim.text }}</text>
    </g>
    <rect v-if="marqueeRect" :x="marqueeRect.x" :y="marqueeRect.y" :width="marqueeRect.w" :height="marqueeRect.h"
          fill="rgba(37,99,235,0.08)" stroke="#2563eb" stroke-width="1" stroke-dasharray="4 3" pointer-events="none" data-marquee />
    <g v-for="p in sparkleRender" :key="'sparkle-' + p.id" pointer-events="none" data-sparkle :style="{ opacity: p.opacity }">
      <line v-for="(r, i) in p.rays" :key="i" :x1="r.x1" :y1="r.y1" :x2="r.x2" :y2="r.y2"
            stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" />
    </g>
  </svg>
</template>

<style scoped>
/* constraint badges: subtle hover cue so click-to-remove/edit reads as
   interactive without changing layout */
.constraint-badge rect { transition: opacity 120ms ease; }
.constraint-badge:hover rect { opacity: 1; }
.constraint-badge:hover text { fill: #fff; }
</style>
