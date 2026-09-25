<!-- app/components/pen/PenOverlay.vue -->
<script setup lang="ts">
// The pen's surface: draws a Pen (composables/pen/usePen) and turns pointer
// and keyboard input into its actions, over any host, through ONE affine view
// matrix (drawing → host-canvas pixels).
//
// - Drawing geometry (outline, construction, hit paths, selection highlights)
//   is rendered in DRAWING space under `<g :transform="viewToSvg(view)">`
//   with a non-scaling stroke, so scale, rotation and mirroring all come from
//   the SVG transform and strokes stay crisp at any zoom.
// - Points, badges, chips, sparkles and the live preview stay in screen space
//   (applyView). The preview's arcs are computed in drawing space; their sweep
//   flips only when the view is mirrored.
// - Pan and wheel zoom are the HOST's: it intercepts them in the capture phase
//   on its own wrapper, before they reach this SVG.
// - Keyboard: window keydown / keyup / blur while mounted (bubble phase). A
//   host that owns viewport keys registers its listener in the capture phase,
//   so it runs first, and stops propagation only for keys it consumed.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { SketchDoc, EntityId, ConstraintKind, SegmentSpec } from '~/lib/sketch/model'
import { addPoint } from '~/lib/sketch/edit'
import { sketchPathData, entityPath } from '~/lib/sketch/sketchPath'
import { constraintMarks, arcDimensionMarks } from '~/lib/sketch/annotate'
import { applyView, invertView, pxPerUnit, isMirrored, viewToSvg, type ViewMatrix } from '~/lib/sketch/view'
import { snapAngle, bowArc, SPARKLE_LIFETIME_MS, isTypingInField, type Pen } from '~/composables/pen/usePen'

const props = withDefaults(defineProps<{
  pen: Pen
  view: ViewMatrix
  width: number
  height: number
  cursor?: string
}>(), { cursor: 'crosshair' })
const emit = defineEmits<{
  (e: 'commit'): void   // Enter with nothing left to finish
  (e: 'cancel'): void   // Escape with nothing pending
}>()

// the pen is fixed for the overlay's lifetime; its refs are unwrapped here so
// the template reads them bare
const {
  doc, tool, showLabels, status, selection, selectedSegments, pendingPath, pendingOp,
  cursor: penCursor, dimBuffer, sparkles, sparkleClock,
  pick, clearSel, pickSegment, clearSegSel, marqueeSelect,
  place, pathDown, pathMove, pathUp, getPathDrag, jointInfoForSegment,
  runSolve, applyRepeat, applyMirror, cancelPendingOp,
  onArcDimClick, onConstraintMarkClick, commitHistory,
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

const pts = computed(() => (doc.value.entities.filter(e => e.kind === 'point') as any[])
  .map(p => ({ p, s: toScreen(p) })))
const marks = computed(() => constraintMarks(doc.value))
// STRUCTURAL/auto constraint kinds — internal copy-rule bookkeeping (Repeat's
// rotatedFrom, Mirror's mirroredFrom) and arc-integrity plumbing (equalDist,
// which also backs the user-facing "Equal" verb on two lines, so it can't be
// dropped from the model, only hidden from this badge layer) that nobody
// clicks to remove by hand. They are the bulk of badge clutter on a
// many-petal Repeat/Mirror drawing; hiding them is display-only.
const STRUCTURAL_MARK_KINDS: ConstraintKind[] = ['rotatedFrom', 'mirroredFrom', 'equalDist']
const visibleMarks = computed(() => marks.value
  .filter(m => !STRUCTURAL_MARK_KINDS.includes(m.kind))
  .map(m => ({ m, s: toScreen(m) })))
// persistent "R n.n" radius chips on every finished arc segment — pure read
// of the doc, never solves; distinct from pathBowChip's live during-drag chip
const arcDims = computed(() => arcDimensionMarks(doc.value).map(m => ({ m, s: toScreen(m) })))

// point-handle rendering: selection (orange, filled, r6) always wins; a
// construction point renders as a small grey hollow dot, distinct from both
// the orange selection fill and the normal solid blue / fixed-grey dots.
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

function worldPt(id: EntityId): { x: number; y: number } | null {
  const p = doc.value.entities.find(e => e.id === id) as any
  if (!p || p.kind !== 'point') return null
  return { x: p.x, y: p.y }
}
function screenPt(id: EntityId): { x: number; y: number } | null {
  const w = worldPt(id)
  return w ? toScreen(w) : null
}

// live path draw preview (screen space): the already-placed pending segments,
// plus either a rubber band out to the cursor (hovering) or — mid drag past
// the bow threshold — the just-placed segment bending live under the pointer.
// Arcs are solved in drawing space; a screen arc's radius is r·pxPerUnit and
// its sweep flips only for a mirrored view. Pure read; never mutates the doc.
const previewD = computed(() => {
  if (tool.value !== 'path') return ''
  const pp = pendingPath.value
  if (!pp || pp.anchors.length === 0) return ''
  const first = screenPt(pp.anchors[0]!)
  if (!first) return ''
  const view = props.view
  const k = pxPerUnit(view)
  const mirrored = isMirrored(view)
  let d = `M ${first.x} ${first.y}`
  const segCount = pp.segments.length
  const lastAnchorId = pp.anchors[pp.anchors.length - 1]!
  const pathDrag = getPathDrag()
  const bowing = !!pathDrag && pathDrag.bowed && pathDrag.anchor === lastAnchorId && !!penCursor.value
  for (let i = 0; i < segCount; i++) {
    const seg = pp.segments[i]!
    const fromId = pp.anchors[i]!
    const toId = pp.anchors[i + 1]!
    const to = screenPt(toId)
    if (!to) break
    if (bowing && i === segCount - 1) {
      // just-placed segment bowing live under the pointer
      const p0 = worldPt(fromId)
      const p1 = worldPt(toId)
      const joint = jointInfoForSegment(pp, i)
      const arc = (p0 && p1 && penCursor.value) ? bowArc(p0, p1, penCursor.value, joint?.tangentDir ?? null) : null
      if (arc) {
        const rScreen = arc.r * k
        const sweepScreen = (mirrored ? 1 - arc.sweep : arc.sweep) as 0 | 1
        d += ` A ${rScreen} ${rScreen} 0 ${arc.large} ${sweepScreen} ${to.x} ${to.y}`
      } else {
        d += ` L ${to.x} ${to.y}`
      }
    } else if (seg.kind === 'arc') {
      const from = worldPt(fromId)
      const c = worldPt(seg.center)
      const tw = worldPt(toId)
      if (from && c && tw) {
        const r = Math.hypot(from.x - c.x, from.y - c.y)
        const a0 = Math.atan2(from.y - c.y, from.x - c.x)
        const a1 = Math.atan2(tw.y - c.y, tw.x - c.x)
        const TAU = Math.PI * 2
        const ccw = ((a1 - a0) % TAU + TAU) % TAU
        const span = seg.sweep === 1 ? ccw : TAU - ccw
        const large = span > Math.PI ? 1 : 0
        const sweepScreen = (mirrored ? 1 - seg.sweep : seg.sweep) as 0 | 1
        d += ` A ${r * k} ${r * k} 0 ${large} ${sweepScreen} ${to.x} ${to.y}`
      } else d += ` L ${to.x} ${to.y}`
    } else {
      d += ` L ${to.x} ${to.y}`
    }
  }
  if (!bowing && penCursor.value) {
    const last = screenPt(lastAnchorId)
    const lastWorld = worldPt(lastAnchorId)
    if (last) {
      // Shift held → show the 45°-snapped cursor position, not the raw one,
      // so the rubber band matches where pathDown will place the anchor.
      const cursorWorld = penCursor.value.shift && lastWorld ? snapAngle(lastWorld, penCursor.value) : penCursor.value
      const ptr = toScreen(cursorWorld)
      d += ` M ${last.x} ${last.y} L ${ptr.x} ${ptr.y}`
    }
  }
  return d
})

// live radius chip near the bowed arc's midpoint while the path tool drags a
// segment into a curve. When the bow is joint-tangent-locked to the previous
// segment (snappedTangent), it also carries J's screen position for a "T" chip.
const pathBowChip = computed(() => {
  const pathDrag = getPathDrag()
  if (tool.value !== 'path' || !pathDrag || !pathDrag.bowed || !penCursor.value) return null
  const pp = pendingPath.value
  const p0 = worldPt(pathDrag.prevAnchor)
  const p1 = worldPt(pathDrag.anchor)
  if (!p0 || !p1 || !pp) return null
  const joint = jointInfoForSegment(pp, pp.segments.length - 1)
  const arc = bowArc(p0, p1, penCursor.value, joint?.tangentDir ?? null)
  if (!arc) return null
  const mid = toScreen(arc.mid)
  const j = toScreen(p0)
  return {
    x: mid.x, y: mid.y,
    // type-a-dimension: a typed value (with a caret) replaces the measured radius
    text: dimBuffer.value ? dimBuffer.value + '|' : `R ${arc.r.toFixed(1)}`,
    snappedTangent: arc.snappedTangent, jointX: j.x, jointY: j.y,
  }
})

// type-a-dimension: the line-length counterpart to pathBowChip — only
// appears once dimBuffer has something in it.
const lineDimChip = computed(() => {
  if (tool.value !== 'path' || !dimBuffer.value) return null
  const pathDrag = getPathDrag()
  if (pathDrag && pathDrag.bowed) return null   // the arc bow owns the chip via pathBowChip instead
  const pp = pendingPath.value
  if (!pp || !penCursor.value) return null
  const last = screenPt(pp.anchors[pp.anchors.length - 1]!)
  if (!last) return null
  const ptr = toScreen(penCursor.value)
  return { x: (last.x + ptr.x) / 2, y: (last.y + ptr.y) / 2, text: dimBuffer.value + '|' }
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
// box-select via marqueeSelect(). Screen-pixel state; never touches `doc`.
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

// svg-local pixels — the frame the view matrix maps drawing space into
function localXY(ev: PointerEvent) {
  const el = svgEl.value ?? (ev.currentTarget as SVGSVGElement)
  const r = el.getBoundingClientRect()
  return { x: ev.clientX - r.left, y: ev.clientY - r.top }
}
function toDrawing(p: { x: number; y: number }) {
  const inv = invertView(props.view)
  return inv ? applyView(inv, p) : { x: 0, y: 0 }
}
function drawingXY(ev: PointerEvent) {
  return toDrawing(localXY(ev))
}

function onEntityPointerDown(id: EntityId, ev: PointerEvent) {
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
  // point); the selection only changes here, once we know it was a click.
  if (tool.value === 'select' && dragId === id && !moved) { pick(id, ev.shiftKey); ev.stopPropagation() }
  dragId = null; dragHandleIds = []; dragLast = null
}
function onSegmentPointerDown(pathId: EntityId, segIndex: number, ev: PointerEvent) {
  if (tool.value !== 'select') return
  // guided ops treat a path-body click as picking the whole path (the unit)
  if (pendingOp.value) { pick(pathId, ev.shiftKey); ev.stopPropagation(); return }
  // a plain click selects the WHOLE path; Alt/Option-click drills in to the
  // single segment under the cursor for the per-segment verbs
  if (ev.altKey) pickSegment(pathId, segIndex, ev.shiftKey)
  else pick(pathId, ev.shiftKey)
  ev.stopPropagation()
}
function onPointerDownSvg(ev: PointerEvent) {
  if (tool.value === 'select') {
    // guided Repeat with an empty-canvas click: drop a fresh FIXED center
    // where they clicked and repeat around it. Mirror needs a real line, so
    // an empty click there just cancels the armed op.
    if (pendingOp.value?.kind === 'repeat') {
      const w = drawingXY(ev)
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
  const { x, y } = drawingXY(ev)
  if (tool.value === 'path') { pathDown(x, y, ev.shiftKey); return }
  place(x, y)
}
function onPointerMove(ev: PointerEvent) {
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
    const { x, y } = drawingXY(ev)
    pathMove(x, y, ev.shiftKey)
    return
  }
  if (!dragId || ev.buttons === 0) return
  const { x, y } = drawingXY(ev)
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
  if (tool.value === 'path' && getPathDrag()) {
    const { x, y } = drawingXY(ev)
    pathUp(x, y)
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
    const w0 = toDrawing(start)
    const w1 = drawingXY(ev)
    marqueeSelect(w0.x, w0.y, w1.x, w1.y, additive)
    return   // selection change only — no commitHistory (not a doc mutation)
  }
  // settle a select-tool point drag as ONE history entry — release can land
  // off the point circle (onPointerUpPoint never fires then), so this is the
  // single reliable place to commit
  if (tool.value === 'select' && moved) commitHistory()
  dragId = null; dragHandleIds = []; dragLast = null
  moved = false
}
function onPointerLeave(ev: PointerEvent) {
  onPointerUp(ev)
  penCursor.value = null
}

// ---------- keyboard ----------

function onKeydown(ev: KeyboardEvent) {
  if (isTypingInField()) return
  const handled = props.pen.onKeydown(ev, { cancelGesture: cancelMarquee })
  if (handled) return
  if (ev.key === 'Escape') emit('cancel')
  else if (ev.key === 'Enter' && !(ev.metaKey || ev.ctrlKey)) emit('commit')
}
function onKeyup(ev: KeyboardEvent) { props.pen.onKeyup(ev) }
function onBlur() { props.pen.onBlur() }

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <svg ref="svgEl" :width="width" :height="height"
       :style="{ position: 'absolute', left: 0, top: 0, display: 'block', touchAction: 'none', cursor }"
       @pointerdown="onPointerDownSvg" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointerleave="onPointerLeave">
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
    <path v-if="previewD" :d="previewD" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-dasharray="5 3"
          pointer-events="none" data-path-preview />
    <circle v-for="{ p, s } in pts" :key="p.id" :cx="s.x" :cy="s.y" :r="pointRadius(p)"
            :fill="pointFill(p)" :stroke="pointStroke(p)" stroke-width="1.5"
            :style="{ cursor: tool === 'select' ? 'grab' : 'crosshair' }"
            @pointerdown="(ev) => onPointerDownPoint(p.id, ev)" @pointerup="(ev) => onPointerUpPoint(p.id, ev)"
            :data-point="p.id" :data-construction="p.construction ? '' : null" />
    <template v-if="showLabels">
      <g v-for="{ m, s } in visibleMarks" :key="m.id" class="constraint-badge" pointer-events="auto" style="cursor: pointer"
         :data-constraint="m.id" :data-constraint-kind="m.kind"
         @pointerdown.stop @click.stop="onConstraintMarkClick(m, $event)">
        <title>{{ m.text != null ? 'click to edit · shift+click to remove' : 'click to remove' }}</title>
        <rect :x="s.x + 6" :y="s.y - 16" :width="m.text ? 30 : 16" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="s.x + 9" :y="s.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.glyph }}{{ m.text ? ' ' + m.text : '' }}</text>
      </g>
      <g v-for="{ m, s } in arcDims" :key="m.id" pointer-events="auto" style="cursor: pointer"
         @pointerdown.stop @click.stop="onArcDimClick(m)">
        <rect :x="s.x + 6" :y="s.y - 16" width="34" height="14" rx="3" fill="#111827" opacity="0.85" />
        <text :x="s.x + 9" :y="s.y - 5" fill="#e5e7eb" font-size="10" font-family="ui-monospace, monospace">{{ m.text }}</text>
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
</template>

<style scoped>
/* constraint badges: subtle hover cue so click-to-remove/edit reads as
   interactive without changing layout */
.constraint-badge rect { transition: opacity 120ms ease; }
.constraint-badge:hover rect { opacity: 1; }
.constraint-badge:hover text { fill: #fff; }
</style>
