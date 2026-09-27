<!-- app/pages/dev/sketch-draw.vue -->
<script setup lang="ts">
// Dev harness — not linked in the app. Interactive constraint drawing surface.
// The pen's state and actions live in usePen (composables/pen) and its
// surface in PenOverlay (components/pen); this page hosts both: the viewport
// (pan, zoom, the view matrix), the toolbars and the test API.
definePageMeta({ layout: false })
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { SketchDoc, EntityId, ConstraintKind } from '~/lib/sketch/model'
import { repeatEntities, mirrorEntities } from '~/lib/sketch/edit'
import { sketchPathData } from '~/lib/sketch/sketchPath'
import { mergeSketchDoc } from '~/lib/sketch/merge'
import { applyView, invertView, type ViewMatrix } from '~/lib/sketch/view'
import { usePen, isTypingInField, isCleanupBarFocused, type PenTool } from '~/composables/pen/usePen'
import PenOverlay from '~/components/pen/PenOverlay.vue'
import PenToolbar from '~/components/pen/PenToolbar.vue'

type Tool = PenTool

const doc = ref<SketchDoc>({ entities: [], constraints: [] })
const ready = ref(false)

// viewport: VIEW state, not model — pan/zoom never touch `doc` or history
// (undo must never undo a zoom/pan). The view is one affine matrix:
// translate(pan) · scale · BASE, where BASE is the y-up mirror by default
// (34px/unit, origin lower-left of a 680x460 board) or, with the dev flag
// ?view=rotated, a 30° rotation with no y-flip (proves the pen draws through
// any similarity view, mirrored or not).
// ?view=uneven is an uneven-scale, skewed, mirrored view (34 px/unit across,
// 20 px/unit up, y leaning right) — not a similarity, so it proves the live
// preview is drawn in drawing space like the outline.
const route = useRoute()
const ROTATED = route.query.view === 'rotated'
const UNEVEN = route.query.view === 'uneven'
const ROT = Math.PI / 6
const BASE = ROTATED
  ? { a: Math.cos(ROT), b: Math.sin(ROT), c: -Math.sin(ROT), d: Math.cos(ROT) }
  : UNEVEN
    ? { a: 1, b: 0, c: 0.25, d: -20 / 34 }
    : { a: 1, b: 0, c: 0, d: -1 }
// the rotated default keeps the board's middle (world 9, 6.5) at the canvas middle
const DEFAULT_PAN = ROTATED
  ? { x: 340 - 34 * (BASE.a * 9 + BASE.c * 6.5), y: 230 - 34 * (BASE.b * 9 + BASE.d * 6.5) }
  : { x: 40, y: 400 }
const CANVAS_W = 680, CANVAS_H = 460

const scale = ref(34)
const panX = ref(DEFAULT_PAN.x)
const panY = ref(DEFAULT_PAN.y)
const view = computed<ViewMatrix>(() => ({
  a: scale.value * BASE.a, b: scale.value * BASE.b, c: scale.value * BASE.c, d: scale.value * BASE.d,
  e: panX.value, f: panY.value,
}))

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }

// zoom toward the cursor: keep the drawing point currently under (cx, cy) —
// canvas-local pixels — fixed on screen after the scale change. Take the
// drawing point BEFORE changing scale, then re-derive pan from
// `applyView(view, w) === (cx, cy)` at the new scale.
function zoomAt(cx: number, cy: number, factor: number) {
  const inv = invertView(view.value)
  if (!inv) return
  const w = applyView(inv, { x: cx, y: cy })
  scale.value = clamp(scale.value * factor, 4, 400)
  const s = scale.value
  panX.value = cx - s * (BASE.a * w.x + BASE.c * w.y)
  panY.value = cy - s * (BASE.b * w.x + BASE.d * w.y)
}
function panBy(dxPx: number, dyPx: number) {
  panX.value += dxPx
  panY.value += dyPx
}
function fitView() {
  scale.value = 34
  panX.value = DEFAULT_PAN.x
  panY.value = DEFAULT_PAN.y
}
function getViewport() { return { scale: scale.value, panX: panX.value, panY: panY.value } }

// spacebar-held pan (tracked via onKeydown/onKeyup) and the live drag itself
// — screen-pixel delta from the pointerdown origin, never touches `doc`.
// Pan is the host's, not the overlay's: the canvas wrapper takes it in the
// capture phase (onCanvasPointerDown) before PenOverlay sees the event.
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

const pen = usePen({
  doc,
  view,
  // Escape aborts a live pan before it cancels a path (the overlay offers
  // its own marquee first)
  cancelGesture: () => {
    if (panning.value) { panning.value = false; return true }
    return false
  },
})
const {
  tool, guideMode, showLabels, status, selection, selectedSegments,
  dimBuffer, nextSegment,
  selectTool, setGuideMode, setShowLabels,
  pick, clearSel, pickSegment, clearSegSel, marqueeSelect, isPointId,
  place, pathDown, pathMove, pathUp, curveDown, curveMove, curveUp, finishPath, cancelPath, removeLastAnchor,
  runSolve, apply, availableConstraints, del, nudge, makeConstruction, flip,
  armRepeat, doMirror, cancelPendingOp, pendingOp,
  valueRequest, submitValue, cancelValue,
  setArcRadius, setConstraintValue, removeConstraintById,
  commitDimension, undo, redo, canUndo, canRedo, reset, commitHistory, sparkle, sparkleCount,
} = pen

// The pen's `commit` / `cancel` (from the overlay's Enter/Escape and the
// toolbar's Done/Cancel) just log into `status` here — the dev page has no
// "finished session" concept of its own (unlike the Frame editor, which will
// store the drawing on commit and may pen.revert() on cancel).
function handlePenCommit() { status.value = 'done' }
function handlePenCancel() { status.value = 'cancelled' }

// keyboard: the viewport keys (⌘0 fit, Space pan) are the page's. This
// listener is registered on window in the CAPTURE phase, so it runs before
// PenOverlay's bubble-phase window listener whatever the mount order, and it
// stops propagation only for the keys it consumed.
function onKeydown(ev: KeyboardEvent) {
  if (isTypingInField()) return
  const meta = ev.metaKey || ev.ctrlKey
  if (meta && ev.key.toLowerCase() === '0') { ev.preventDefault(); ev.stopImmediatePropagation(); fitView(); return }
  // Space on a focused Clean up control (strength, Cancel, Apply) presses it
  if (!meta && (ev.code === 'Space' || ev.key === ' ') && !isCleanupBarFocused()) { ev.preventDefault(); ev.stopImmediatePropagation(); spaceHeld.value = true; return }
}
function onKeyup(ev: KeyboardEvent) {
  if (ev.code === 'Space' || ev.key === ' ') spaceHeld.value = false
}
function onBlur() {
  spaceHeld.value = false
  panning.value = false
}

// canvas wrapper: pan + wheel zoom, in the capture phase
function onCanvasPointerDown(ev: PointerEvent) {
  if (!panTrigger(ev)) return
  startPan(ev)
  ev.stopPropagation()
}
function onCanvasPointerMove(ev: PointerEvent) {
  if (!panning.value) return
  panX.value = panStartPanX + (ev.clientX - panStartClientX)
  panY.value = panStartPanY + (ev.clientY - panStartClientY)
  ev.stopPropagation()
}
function onCanvasPointerUp(ev: PointerEvent) {
  if (!panning.value) return
  panning.value = false
  ev.stopPropagation()
}
function onCanvasPointerLeave() { panning.value = false }
function onWheel(ev: WheelEvent) {
  ev.preventDefault()
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const cx = ev.clientX - r.left, cy = ev.clientY - r.top
  const f = ev.deltaY < 0 ? 1.1 : 1 / 1.1
  zoomAt(cx, cy, f)
}

function copySvg(): string {
  const d = sketchPathData(doc.value)
  try { navigator.clipboard?.writeText(d)?.catch?.(() => {}) } catch {}
  return d
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
    // the Curve (Bézier) tool's gesture — same calls a real down→drag→up makes
    curveDown: (x: number, y: number) => curveDown(x, y),
    curveMove: (x: number, y: number) => curveMove(x, y),
    curveUp: (x: number, y: number) => curveUp(x, y),
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
    // Task 2 test hooks — the inline value request that replaced
    // window.prompt (Distance/Radius/Copies): valueRequest mirrors the armed
    // state, submitValue/cancelValue resolve it exactly as PenValueRow's
    // ✓/Enter and Escape/Cancel do.
    get valueRequest() { return valueRequest.value ? { ...valueRequest.value } : null },
    submitValue: (v: number) => submitValue(v),
    cancelValue: () => cancelValue(),
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
    // pen stage 5 — Clean up: `load` sets up a drawing whose gaps are finer
    // than the pen's own snap (the trimmed flower) as one settled step;
    // `cleanup` reads the preview (never changes it)
    load: (raw: unknown) => { reset(); doc.value = mergeSketchDoc(raw); commitHistory() },
    cleanup: () => {
      const s = pen.cleanup.value
      return s ? { strength: s.strength, fixes: s.result.fixes.map(f => ({ id: f.id, kind: f.kind, label: f.label, on: f.on })) } : null
    },
  }
  ready.value = true
  window.addEventListener('keydown', onKeydown, { capture: true })
  window.addEventListener('keyup', onKeyup, { capture: true })
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
  window.removeEventListener('keyup', onKeyup, { capture: true })
  window.removeEventListener('blur', onBlur)
  pen.dispose()
})
</script>

<template>
  <div :data-ready="ready ? '' : undefined" style="font-family: ui-sans-serif, system-ui; padding: 12px; color: #e5e5e5; background: #0b0b0b; min-height: 100vh">
    <h1 style="font-size: 14px; margin: 0 0 8px">Sketch Draw</h1>
    <div style="display: flex; gap: 6px; margin-bottom: 8px; align-items: center">
      <button data-verb="copy-svg" @click="copySvg"
              style="padding: 4px 10px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer">Copy SVG</button>
      <button data-act="reset" @click="reset" style="padding: 4px 10px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #fff; cursor: pointer">Reset</button>
      <span data-status style="margin-left: 8px; font-size: 12px; color: #9ca3af">{{ status }}</span>
    </div>
    <div :style="{ position: 'relative', width: CANVAS_W + 'px', height: CANVAS_H + 'px', background: '#fafafa', borderRadius: '8px', overflow: 'hidden', touchAction: 'none' }"
         @pointerdown.capture="onCanvasPointerDown" @pointermove.capture="onCanvasPointerMove"
         @pointerup.capture="onCanvasPointerUp" @pointerleave="onCanvasPointerLeave" @wheel="onWheel">
      <PenOverlay :pen="pen" :view="view" :width="CANVAS_W" :height="CANVAS_H" :cursor="svgCursor"
                  @commit="handlePenCommit" @cancel="handlePenCancel" />
    </div>
    <!-- the dev page has no overlay dock, so it places the toolbar below the
         canvas — a host with one (the Frame editor) puts it there instead. -->
    <PenToolbar :pen="pen" style="margin-top: 12px" @commit="handlePenCommit" @cancel="handlePenCancel" />
  </div>
</template>
