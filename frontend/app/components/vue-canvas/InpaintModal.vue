<script setup lang="ts">
/**
 * Dedicated inpainting editor for an Image artifact node. Focused on one job —
 * paint a region of the node's image, describe the change, and let FLUX Fill
 * replace just that area — so it isn't crammed into the Compositor's toolbox.
 *
 * Source image (in priority order): a wired upstream image → the node's own
 * image (execution output or file widget) → an image loaded inside this modal.
 * The accepted result is uploaded into ComfyUI's input dir and written back to
 * the node (file widget + preview + lock), so it flows downstream like any
 * Image artifact. Generation runs in-modal via /api/inpaint/* (your Replicate
 * token) for instant variations/compare — not at graph-execution time.
 */
import { X, Brush, Eye, EyeOff, Wand2, ImagePlus, Loader2, FlipHorizontal2, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Sparkles } from 'lucide-vue-next'
import { useBrushMask, type MaskTarget } from '~/composables/useBrushMask'
import { useInpaint, loadImage, imageToDataUrl, capDims } from '~/composables/useInpaint'
import { useStageView } from '~/composables/useStageView'
import { useRegionFx } from '~/composables/useRegionFx'
import { useBrandLibrary } from '~/composables/useBrandLibrary'
import { recolorPrompt } from '~/lib/editActions/prompts'
import { brandSwatches } from '~~/shared/brand/resolve'
import type { ComputedRef } from 'vue'

const props = defineProps<{
  nodeId: string
  nodes: any[]
  edges: any[]
  intent?: 'remove' | 'recolor' | null
}>()
const emit = defineEmits<{ close: [] }>()

const node = computed(() => props.nodes.find((n: any) => n.id === props.nodeId))

// ── Locate the node's image port / widget (mirrors ArtifactImageNode) ────────
function inputIdx(name: string): number { return node.value?.data?.inputs?.findIndex((i: any) => i.name === name) ?? -1 }
function widgetIdx(name: string): number { return node.value?.data?.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1 }

function upstreamImageUrl(src: any): string | null {
  if (src?.data?.images?.length) return src.data.images[0]
  const wv = src?.data?.widgetsValues
  const wi = src?.data?.widgetDefs?.findIndex((w: any) => w.name === 'image') ?? -1
  if (wi >= 0 && wv?.[wi]) return `/view?${new URLSearchParams({ filename: String(wv[wi]), type: 'input' })}`
  if (src?.data?.nodeType === 'LoadImage' && wv?.[0]) return `/view?${new URLSearchParams({ filename: String(wv[0]), type: 'input' })}`
  return null
}

// The source the modal edits. A locally-loaded image overrides everything.
const loadedUrl = ref<string | null>(null)
const sourceUrl = computed<string | null>(() => {
  if (loadedUrl.value) return loadedUrl.value
  const n = node.value
  if (!n) return null
  // The node's own image FIRST — this is the selected take. Selecting a take in
  // the filmstrip projects it onto data.images (projectTake), so images[0] is
  // exactly what the node's preview shows. Prefer it over the upstream generator,
  // whose data.images[0] stays pinned to its LATEST run and ignores the user's
  // take selection. (Mirrors ArtifactImageNode's own `imageUrl` ordering.)
  if (n.data?.images?.length) return n.data.images[0]
  // No own image yet (e.g. wired but not run) → fall back to the upstream image.
  const inIdx = inputIdx('images')
  if (inIdx >= 0) {
    const edge = props.edges.find((e: any) => e.target === props.nodeId && e.targetHandle === `input-${inIdx}`)
    if (edge) {
      const src = props.nodes.find((x: any) => x.id === edge.source)
      const u = src ? upstreamImageUrl(src) : null
      if (u) return u
    }
  }
  const wi = widgetIdx('image')
  const fn = wi >= 0 ? n.data?.widgetsValues?.[wi] : ''
  if (fn) return `/view?${new URLSearchParams({ filename: String(fn), type: 'input' })}`
  return null
})

// ── Source load + display geometry (image is contain-fit into the stage) ─────
const MAX = 720
const sourceImg = ref<HTMLImageElement | null>(null)
const out = ref<{ w: number; h: number }>({ w: 0, h: 0 }) // native (capped) px sent to the model
const disp = reactive({ w: MAX, h: MAX })                   // on-screen display size
const loadingSrc = ref(false)

// NOTE: not `immediate` — it references engines/state declared below, so the
// initial load is kicked off from onMounted (after setup finishes) to avoid a
// temporal-dead-zone crash.
async function applySource(url: string | null) {
  brush.clear(); brush.resetHistory(); clearSamMask(); boxRect.value = null; history.value = []; previewResult.value = null; lastResult.value = null; maskOnly.value = false
  if (!url) { sourceImg.value = null; return }
  loadingSrc.value = true
  try {
    const img = await loadImage(url)
    sourceImg.value = img
    const nw = img.naturalWidth || MAX, nh = img.naturalHeight || MAX
    out.value = capDims(nw, nh)
    const a = nw / nh
    if (a >= 1) { disp.w = MAX; disp.h = Math.round(MAX / a) }
    else { disp.h = MAX; disp.w = Math.round(MAX * a) }
    view.reset()
  } catch {
    sourceImg.value = null
  } finally { loadingSrc.value = false }
}
watch(sourceUrl, applySource)

// ── Brush + inpaint engines ──────────────────────────────────────────────────
const brush = useBrushMask()
const inpaint = useInpaint()
brush.setActive(true)
const view = useStageView()
const spaceDown = ref(false) // hold Space to pan
// Cursor-ring screen position (mapped through the current zoom/pan).
const cursorScreen = computed(() => brush.cursor.value ? view.toScreen(brush.cursor.value.x, brush.cursor.value.y, disp.w, disp.h) : null)

const prompt = ref('')
const tier = ref<'dev' | 'pro'>('dev')
const count = ref(1)
const feather = ref(3)
const expand = ref(0)
const mode = ref<'mask' | 'describe'>('mask')
const maskOnly = ref(false) // hide the photo, show only the painted region (inspection)

// ── Region tool — two tools, intent over mechanism ───────────────────────────
// 'select' (default): SAM 3 click-to-select — click an object, Shift/Alt-click
//   refine, or DRAG a box to segment within it. 'paint': freehand brush; hold
//   Alt/Option to erase (the old separate Erase/Box tools are gone).
type Tool = 'select' | 'paint'
const tool = ref<Tool>('select')
// Intent flows (Remove object / Recolor) also start on click-select.
if (props.intent) tool.value = 'select'
const clampBrushMode = (alt: boolean) => { brush.mode.value = alt ? 'erase' : 'add' }
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const boxRect = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const boxDragging = ref(false)
function boxNorm(b: { x0: number; y0: number; x1: number; y1: number }) {
  return { l: Math.min(b.x0, b.x1), t: Math.min(b.y0, b.y1), r: Math.max(b.x0, b.x1), bo: Math.max(b.y0, b.y1) }
}
const hasBox = computed(() => {
  const b = boxRect.value; if (!b) return false
  const n = boxNorm(b); return (n.r - n.l) > 0.005 && (n.bo - n.t) > 0.005
})

// ── Shared "generate in region" overlay + glimm prism sweep (same as Frame) ──
const fxOverlay = ref<HTMLCanvasElement | null>(null)
const fxSweep = ref<HTMLCanvasElement | null>(null)
const regionSilhouette = ref<HTMLCanvasElement | null>(null) // white-on-transparent, display px
const regionFx = useRegionFx({
  overlay: fxOverlay,
  sweep: fxSweep,
  getMask: () => regionSilhouette.value,
  getDims: () => ({ w: disp.w, h: disp.h }),
  busy: () => inpaint.busy.value,
})
const { sweepMaskUrl: fxSweepMaskUrl } = regionFx
// Show the animated region FX while actively defining/generating a mask — not in
// mask-only inspection (overlay draws a crisp silhouette there) or while hovering
// a candidate result (the preview replaces the stage).
const showFx = computed(() => mode.value === 'mask' && !maskOnly.value && !previewImgEl.value)
interface HistoryItem { id: string; url: string; prompt: string; mode: 'mask' | 'describe' }
const history = ref<HistoryItem[]>([])
const inpaintError = ref('')
const comparing = ref(false)

const samSelect = computed(() => tool.value === 'select')
const samMask = ref<string | null>(null)
// Accumulated SAM 3 point prompts for the current selection, in source-image
// pixel space. Plain click replaces; Shift-click adds a foreground point;
// Alt-click adds a background (subtract) point. The model re-runs on each.
const samPoints = ref<{ x: number; y: number; label: 0 | 1 }[]>([])
const samMaskImgEl = ref<HTMLImageElement | null>(null)
watch(samMask, async (url) => {
  if (!url) { samMaskImgEl.value = null; rebuildSilhouette(); renderOverlay(); return }
  try { samMaskImgEl.value = await loadImage(url) } catch { samMaskImgEl.value = null }
  rebuildSilhouette(); renderOverlay()
})
function clearSamMask() { samMask.value = null; samPoints.value = [] }
function clearMask() { brush.clear(); clearSamMask(); boxRect.value = null }
watch(mode, (m) => { if (m === 'describe') { clearMask(); tool.value = 'paint'; maskOnly.value = false } })

// Rebuild the white-on-transparent region silhouette from brush + box + SAM, then
// refresh the FX ring/sweep mask. This drives the Frame's pulsing fill + flowing
// pastel stroke around whatever the user has marked.
function rebuildSilhouette() {
  if (!hasRegion.value) { regionSilhouette.value = null; regionFx.rebuild(); return }
  const W = Math.max(1, Math.round(disp.w)), H = Math.max(1, Math.round(disp.h))
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const ctx = cv.getContext('2d'); if (!ctx) { regionSilhouette.value = null; regionFx.rebuild(); return }
  if (brush.strokes.value.length) brush.stampMask(ctx, x => x * W, y => y * H, r => r * W)
  if (hasBox.value && boxRect.value) {
    const n = boxNorm(boxRect.value)
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#fff'
    ctx.fillRect(n.l * W, n.t * H, (n.r - n.l) * W, (n.bo - n.t) * H)
  }
  if (samMaskImgEl.value) {
    // SAM masks are white-region on opaque black → convert luminance to alpha.
    const mw = samMaskImgEl.value.naturalWidth || W, mh = samMaskImgEl.value.naturalHeight || H
    const t = document.createElement('canvas'); t.width = mw; t.height = mh
    const tc = t.getContext('2d')!; tc.drawImage(samMaskImgEl.value, 0, 0)
    const img = tc.getImageData(0, 0, mw, mh), d = img.data
    for (let i = 0; i < d.length; i += 4) { const a = Math.max(d[i], d[i + 1], d[i + 2]); d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a }
    tc.putImageData(img, 0, 0)
    ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(t, 0, 0, W, H)
  }
  regionSilhouette.value = cv
  regionFx.rebuild()
}
watch([() => disp.w, () => disp.h, () => brush.strokes.value, () => brush.inverted.value, boxRect], rebuildSilhouette, { deep: true })

// ── Floating prompt bar anchor: selection bbox (display px) → stage screen pt ─
const selBBox = ref<{ l: number; t: number; r: number; b: number } | null>(null)
function recomputeSelBBox() {
  const cv = regionSilhouette.value
  if (!cv || !cv.width || !cv.height) { selBBox.value = null; return }
  const SW = 100, SH = Math.max(1, Math.round(SW * cv.height / cv.width))
  const t = document.createElement('canvas'); t.width = SW; t.height = SH
  const tc = t.getContext('2d'); if (!tc) { selBBox.value = null; return }
  tc.drawImage(cv, 0, 0, SW, SH)
  const d = tc.getImageData(0, 0, SW, SH).data
  let minX = SW, minY = SH, maxX = -1, maxY = -1
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    if (d[(y * SW + x) * 4 + 3]! > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  if (maxX < minX) { selBBox.value = null; return }
  const sx = disp.w / SW, sy = disp.h / SH
  selBBox.value = { l: minX * sx, t: minY * sy, r: (maxX + 1) * sx, b: (maxY + 1) * sy }
}
watch(regionSilhouette, recomputeSelBBox)
// Bar sits just below the selection in stage screen space (follows zoom/pan via
// view.toScreen), clamped so it never leaves the stage.
const promptBar = computed(() => {
  const bb = selBBox.value; if (!bb) return null
  const p = view.toScreen((bb.l + bb.r) / 2, bb.b, disp.w, disp.h)
  // Sit just below the selection, but keep a comfortable margin from the stage
  // edges — a selection that fills the stage keeps the bar floating inside it
  // near the bottom rather than clipping off the edge.
  return {
    x: Math.max(155, Math.min(disp.w - 155, p.sx)),
    y: Math.max(52, Math.min(disp.h - 60, p.sy + 14)),
  }
})
// Mask-only is a pre-generation inspection aid; drop it once a result lands so
// the stage doesn't sit on a blank black backdrop (renderOverlay shows results,
// not the mask, once history exists).
watch(() => history.value.length, (len, prev) => { if (!prev && len) maskOnly.value = false })

// ── Stage pointer handling (the image fills the stage; coords normalize 0..1) ─
const stageRef = ref<HTMLDivElement | null>(null)
function clientToNorm(e: PointerEvent) {
  const r = stageRef.value?.getBoundingClientRect(); if (!r) return null
  return view.toNorm(e.clientX - r.left, e.clientY - r.top, disp.w, disp.h)
}
const panning = ref(false)
let panLast: { x: number; y: number } | null = null
// Select-tool click-vs-drag: a plain click point-selects; dragging past the
// threshold turns into a box that SAM segments within (Box folded into Select).
let selectStart: { nx: number; ny: number; add: boolean; subtract: boolean } | null = null
const DRAG_THRESH = 0.012
function onPointerDown(e: PointerEvent) {
  if (spaceDown.value || e.button === 1) {
    e.preventDefault(); panning.value = true; panLast = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    return
  }
  const p = clientToNorm(e); if (!p) return
  e.preventDefault()
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  if (tool.value === 'select') {
    // Defer the action to pointerup: we don't yet know click vs drag-box.
    selectStart = { nx: p.nx, ny: p.ny, add: e.shiftKey, subtract: e.altKey }
    return
  }
  clearSamMask()
  clampBrushMode(e.altKey)   // Alt/Option paints in erase mode
  brush.down(p.nx, p.ny, disp.w)
}
function onPointerMove(e: PointerEvent) {
  if (panning.value && panLast) {
    view.pan(e.clientX - panLast.x, e.clientY - panLast.y)
    panLast = { x: e.clientX, y: e.clientY }
    return
  }
  const p = clientToNorm(e); if (!p) return
  if (boxDragging.value && boxRect.value) {
    boxRect.value = { ...boxRect.value, x1: clamp01(p.nx), y1: clamp01(p.ny) }
    return
  }
  // Select drag past the threshold promotes the gesture to a box.
  if (selectStart) {
    if (Math.hypot(p.nx - selectStart.nx, p.ny - selectStart.ny) > DRAG_THRESH) {
      clearSamMask()
      boxDragging.value = true
      boxRect.value = { x0: selectStart.nx, y0: selectStart.ny, x1: clamp01(p.nx), y1: clamp01(p.ny) }
    }
    return
  }
  if (tool.value === 'paint') brush.move(p.nx, p.ny)
}
function onPointerUp() {
  if (panning.value) { panning.value = false; panLast = null }
  else if (boxDragging.value) {
    boxDragging.value = false
    const b = boxRect.value
    boxRect.value = null   // the box is a SAM prompt, not a raw-rect mask
    selectStart = null
    if (b) { const n = boxNorm(b); if ((n.r - n.l) > DRAG_THRESH && (n.bo - n.t) > DRAG_THRESH) void doSamBox(n) }
  }
  else if (selectStart) {
    const s = selectStart; selectStart = null
    doSamSelect(s.nx, s.ny, { add: s.add, subtract: s.subtract })   // it was a click
  }
  else brush.up()
}
function onWheel(e: WheelEvent) {
  const r = stageRef.value?.getBoundingClientRect(); if (!r) return
  e.preventDefault()
  if (e.metaKey || e.ctrlKey) {
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    view.zoomBy(factor, e.clientX - r.left, e.clientY - r.top)
  } else {
    view.pan(-e.deltaX, -e.deltaY)
  }
}

// ── Overlay render (mask wash + SAM wash + result preview) ───────────────────
const overlay = ref<HTMLCanvasElement | null>(null)
function renderOverlay() {
  const cv = overlay.value; if (!cv) return
  const W = disp.w, H = disp.h
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr))
  const ctx = cv.getContext('2d'); if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  // Mask-only inspection: draw a crisp solid silhouette over the blacked-out photo.
  if (maskOnly.value) {
    if (regionSilhouette.value) ctx.drawImage(regionSilhouette.value, 0, 0, W, H)
    return
  }
  // Candidate result preview (hidden while holding compare). The painted region
  // itself is drawn by the animated FX overlay (pulse + pastel ring), not here.
  if (previewImgEl.value && !comparing.value) ctx.drawImage(previewImgEl.value, 0, 0, W, H)
}
watch(() => [disp.w, disp.h, JSON.stringify(brush.strokes.value), brush.inverted.value, comparing.value, history.value.length, maskOnly.value] as const,
  () => renderOverlay())

// ── Candidate-result preview ─────────────────────────────────────────────────
const previewResult = ref<string | null>(null)
// The most recent generated result — kept as the persistent "current" result so
// the canvas keeps showing it (rather than snapping back to the source) once a
// batch lands, and so Apply always has a target.
const lastResult = ref<string | null>(null)
const previewImgEl = ref<HTMLImageElement | null>(null)
watch(previewResult, async (url) => {
  if (!url) { previewImgEl.value = null; renderOverlay(); return }
  try { previewImgEl.value = await loadImage(url) } catch { previewImgEl.value = null }
  renderOverlay()
})

// ── Generate / accept ────────────────────────────────────────────────────────
const hasRegion = computed(() => brush.hasMask.value || !!samMask.value || hasBox.value)

// Bake the brush mask and composite the box rect into it (output px, black bg +
// white region) → data URL. Returns null when neither brush nor box is set.
function bakeRegionMask(): string | null {
  const target: MaskTarget = {
    artW: disp.w, artH: disp.h, cxPx: disp.w / 2, cyPx: disp.h / 2,
    dwPx: disp.w, dhPx: disp.h, rotationDeg: 0, outW: out.value.w, outH: out.value.h,
  }
  const brushCv = brush.hasMask.value ? brush.bakeMask(target, { featherPx: feather.value, expandPx: expand.value }) : null
  if (!brushCv && !hasBox.value) return null
  const W = Math.max(1, Math.round(out.value.w)), H = Math.max(1, Math.round(out.value.h))
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  if (brushCv) ctx.drawImage(brushCv, 0, 0, W, H)
  if (hasBox.value && boxRect.value) {
    const n = boxNorm(boxRect.value)
    ctx.save()
    if (feather.value > 0) ctx.filter = `blur(${feather.value}px)`
    ctx.fillStyle = '#fff'
    ctx.fillRect(n.l * W, n.t * H, (n.r - n.l) * W, (n.bo - n.t) * H)
    ctx.restore()
  }
  return cv.toDataURL('image/png')
}

async function runInpaint(removeMode = false) {
  inpaintError.value = ''
  if (!sourceImg.value) { inpaintError.value = 'Load an image first.'; return }
  if (mode.value === 'mask' && !hasRegion.value) {
    inpaintError.value = removeMode ? 'Mark the area to remove first.' : 'Paint or click-select a region first.'
    return
  }
  // "remove the gun" is a REMOVAL instruction, not a description of what to paint:
  // fed to the model as a positive prompt it just re-draws the thing ("gun" → a
  // new gun). So a pure-removal prompt on Regenerate runs the empty-prompt content
  // fill (identical to the Remove button). Guard against "remove X and add Y".
  const raw = prompt.value.trim()
  const isPureRemoval = /^(remove|delete|erase|get rid of|take out|clear away|clean up)\b/i.test(raw)
    && !/\b(add|replace|with|into|instead|put|give|make|turn|change)\b/i.test(raw)
  const p = (removeMode || isPureRemoval) ? '' : raw
  try {
    const source = imageToDataUrl(sourceImg.value, out.value.w, out.value.h)
    let images: string[]
    if (mode.value === 'describe') {
      images = await inpaint.kontext(source, p, { count: count.value })
    } else {
      let maskUrl = samMask.value
      if (!maskUrl) maskUrl = bakeRegionMask()
      if (!maskUrl) { inpaintError.value = 'Paint or click-select a region first.'; return }
      images = await inpaint.fluxFill(source, maskUrl, p, { tier: tier.value, count: count.value })
    }
    const stamp = Date.now()
    const items: HistoryItem[] = images.map((url, i) => ({ id: `${stamp}_${i}`, url, prompt: p, mode: mode.value }))
    history.value = [...items, ...history.value]
    // Show the newest result on the canvas immediately, instead of leaving the
    // source up and making the user hunt for it in History. It stays shown (via
    // lastResult) until the user Applies or generates again.
    lastResult.value = items[0]?.url ?? null
    previewResult.value = lastResult.value
    // Remove intent: each click is a fresh paid removal that should build on the
    // last one, not the original photo — otherwise "remove lamppost" then "remove
    // trash can" would erase the trash can from an image that still has the
    // lamppost. Promote this result to be the working source for the next click,
    // and drop the stale SAM mask so the next click segments against it.
    if (removeMode && lastResult.value) {
      await applySourceFromResult(lastResult.value)
    }
  } catch (err: any) {
    inpaintError.value = err?.data?.message || err?.message || 'Inpaint failed'
  }
}

// Promote a generated result to be the modal's working source image, without
// resetting the history/results state that applySource() normally clears (this
// is used mid-flow, right after a successful remove-intent generation).
async function applySourceFromResult(url: string) {
  try {
    const img = await loadImage(url)
    sourceImg.value = img
    const nw = img.naturalWidth || MAX, nh = img.naturalHeight || MAX
    out.value = capDims(nw, nh)
  } catch {
    // Keep the previous sourceImg on failure — the result is still applyable.
  }
  clearSamMask()
}

// Commit whatever result is currently on the canvas (a hovered preview, else the
// latest generated result) back onto the node.
function applyResult() {
  const url = previewResult.value ?? lastResult.value
  if (url) acceptInpaint(url)
}

async function acceptInpaint(dataUrl: string) {
  const n = node.value; if (!n) return
  try {
    const filename = await inpaint.uploadDataUrl(dataUrl, `inpaint_${props.nodeId}`)
    // Write the result back onto the node like a locked Image artifact.
    const wi = widgetIdx('image')
    if (wi >= 0 && n.data.widgetsValues) n.data.widgetsValues[wi] = filename
    const def = n.data.widgetDefs?.find((d: any) => d.name === 'image')
    if (def && Array.isArray(def.options) && !def.options.includes(filename)) def.options.push(filename)
    n.data.images = [`/view?${new URLSearchParams({ filename, type: 'input' })}`]
    if (!n.data.properties) n.data.properties = {}
    n.data.properties.locked = true
    emit('close')
  } catch (err: any) {
    inpaintError.value = err?.data?.message || err?.message || 'Could not save result'
  }
}

// ── SAM 3 click-to-select (promptable; falls back to brushing on any error) ──
const samBusy = ref(false)
/** A click on the stage in Select mode. `mods.add` (Shift) appends a foreground
 *  point that grows the selection; `mods.subtract` (Alt/Option) appends a
 *  background point that carves it back; a plain click replaces the selection.
 *  SAM 3 re-runs with the full accumulated point set and returns THE object's
 *  mask — no client-side segment guessing. */
async function doSamSelect(nx: number, ny: number, mods: { add?: boolean; subtract?: boolean } = {}) {
  // Busy guards: segmentPoints() doesn't set inpaint.busy, so a local samBusy
  // prevents stacking SAM requests; we also check inpaint.busy for the paid
  // phase (fluxFill inside runInpaint when intent === 'remove').
  if (samBusy.value || inpaint.busy.value) return
  if (!sourceImg.value) { inpaintError.value = 'Load an image first.'; return }
  inpaintError.value = ''
  const w = out.value.w, h = out.value.h
  const point = { x: Math.round(nx * w), y: Math.round(ny * h), label: (mods.subtract ? 0 : 1) as 0 | 1 }
  // Refine only when there's already a selection to refine; otherwise a lone
  // Shift/Alt click starts a fresh foreground selection.
  const refining = (mods.add || mods.subtract) && samPoints.value.length > 0
  samPoints.value = refining ? [...samPoints.value, point] : [{ ...point, label: 1 }]
  samBusy.value = true
  try {
    const source = imageToDataUrl(sourceImg.value, w, h)
    const mask = await inpaint.segmentPoints(source, samPoints.value)
    samMask.value = mask
    brush.clear()
    // Remove intent: a fresh plain click IS the command — erase immediately.
    // While refining (Shift/Alt), hold off so the user can adjust first.
    if (props.intent === 'remove' && !refining) await runInpaint(true)
  } catch {
    // Roll back the point we optimistically added so a retry starts clean.
    samPoints.value = refining ? samPoints.value.slice(0, -1) : []
    inpaintError.value = 'Click-select unavailable (check SAM model); paint the area instead.'
    if (!refining) tool.value = 'paint'
  } finally {
    samBusy.value = false
  }
}

/** Select-tool drag-box: SAM 3 segments the object(s) within the box. `n` is the
 *  normalized box {l,t,r,bo}; it replaces any point selection. */
async function doSamBox(n: { l: number; t: number; r: number; bo: number }) {
  if (samBusy.value || inpaint.busy.value) return
  if (!sourceImg.value) { inpaintError.value = 'Load an image first.'; return }
  inpaintError.value = ''
  samPoints.value = []
  const w = out.value.w, h = out.value.h
  const box = { xMin: Math.round(n.l * w), yMin: Math.round(n.t * h), xMax: Math.round(n.r * w), yMax: Math.round(n.bo * h) }
  samBusy.value = true
  try {
    const source = imageToDataUrl(sourceImg.value, w, h)
    const mask = await inpaint.segmentBox(source, box)
    samMask.value = mask
    brush.clear()
    if (props.intent === 'remove') await runInpaint(true)
  } catch {
    inpaintError.value = 'Box-select unavailable (check SAM model); paint the area instead.'
    tool.value = 'paint'
  } finally {
    samBusy.value = false
  }
}

// ── Recolor intent: brand-kit swatches + free picker ─────────────────────────
const projectBrand = inject<{ activeKitId: ComputedRef<string | null>; setBrandKit: (id: string | null) => void } | null>('sailor:brand', null)
const brandLib = useBrandLibrary(projectBrand?.activeKitId)
/** Active-kit colors first (deduped), else a small neutral default set. */
const recolorSwatches = computed<{ label: string; hex: string }[]>(() => {
  const out: { label: string; hex: string }[] = []
  for (const s of brandSwatches(brandLib.activeKit.value)) {
    if (!out.some(x => x.hex.toLowerCase() === s.hex.toLowerCase())) out.push({ label: s.name, hex: s.hex })
  }
  if (!out.length) {
    out.push(
      { label: 'red', hex: '#e5484d' }, { label: 'blue', hex: '#3e63dd' },
      { label: 'green', hex: '#30a46c' }, { label: 'yellow', hex: '#f5d90a' },
      { label: 'black', hex: '#1c1c1c' }, { label: 'white', hex: '#f2f2f2' },
    )
  }
  return out
})
const customColor = ref('#3e63dd')

async function runRecolor(label: string, hex: string) {
  if (inpaint.busy.value) return
  if (!sourceImg.value) { inpaintError.value = 'Click or paint the object to recolor first.'; return }
  const maskUrl = samMask.value ?? bakeRegionMask()
  if (!maskUrl) { inpaintError.value = 'Click or paint the object to recolor first.'; return }
  inpaintError.value = ''
  try {
    const source = imageToDataUrl(sourceImg.value, out.value.w, out.value.h)
    const p = recolorPrompt(`${label} (${hex})`)
    const images = await inpaint.fluxFill(source, maskUrl, p, { tier: tier.value, count: count.value })
    const stamp = Date.now()
    const items: HistoryItem[] = images.map((url, i) => ({ id: `${stamp}_${i}`, url, prompt: p, mode: 'mask' }))
    history.value = [...items, ...history.value]
    lastResult.value = items[0]?.url ?? null
    previewResult.value = lastResult.value
  } catch (err: any) {
    inpaintError.value = err?.data?.message || err?.message || 'Recolor failed'
  }
}

// ── Load an image inside the modal (empty state) ─────────────────────────────
const fileInputRef = ref<HTMLInputElement | null>(null)
function triggerLoad() { fileInputRef.value?.click() }
async function onLoadFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file) return
  const fr = new FileReader()
  fr.onload = () => { loadedUrl.value = String(fr.result) }
  fr.readAsDataURL(file)
}

// ── Keyboard: Esc close, [ ] brush size, X paint/erase ───────────────────────
function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
  if (e.key === 'Escape') { e.stopPropagation(); emit('close'); return }
  if (e.code === 'Space' && !typing) { e.preventDefault(); spaceDown.value = true; return }
  if (typing) return
  const meta = e.metaKey || e.ctrlKey
  if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) brush.redo(); else brush.undo(); return }
  if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); brush.redo(); return }
  if (e.key === '[' || e.key === ']') { e.preventDefault(); brush.sizePx.value = Math.max(4, Math.min(400, brush.sizePx.value + (e.key === ']' ? 8 : -8))) }
  else if ((e.key === 'x' || e.key === 'X') && mode.value === 'mask') { e.preventDefault(); tool.value = tool.value === 'select' ? 'paint' : 'select' }
}
function onKeyup(e: KeyboardEvent) { if (e.code === 'Space') spaceDown.value = false }
// Releasing focus (alt-tab, Spotlight, system dialog) can swallow the Space keyup
// and leave the stage stuck in pan mode — clear it on blur.
function onBlur() { spaceDown.value = false; panning.value = false; panLast = null }
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', onBlur)
  applySource(sourceUrl.value) // initial load (watches above are non-immediate)
  renderOverlay()
  regionFx.start() // animate the region overlay + prism sweep while the modal is open
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('keyup', onKeyup, true)
  window.removeEventListener('blur', onBlur)
})
</script>

<template>
  <div class="fixed inset-0 z-[100] bg-black/95 backdrop-blur-md flex items-center justify-center p-6" @click.self="emit('close')">
    <div class="w-full h-full max-w-[1200px] max-h-[860px] bg-[#0a0a0a] rounded-xl border border-white/10 shadow-2xl flex text-white/85 overflow-hidden">
      <!-- Stage -->
      <div class="flex-1 relative flex items-center justify-center overflow-hidden bg-[#0d0d0d]">
        <div v-if="sourceUrl" class="absolute top-4 left-4 z-10 flex items-center gap-1 bg-black/40 border border-white/10 rounded-md p-0.5">
          <button class="flex items-center justify-center size-7 rounded bg-white/5 hover:bg-white/10 cursor-pointer disabled:opacity-30 disabled:cursor-default" title="Undo (⌘Z)" aria-label="Undo" :disabled="!brush.canUndo.value" @click="brush.undo()"><Undo2 class="size-4" /></button>
          <button class="flex items-center justify-center size-7 rounded bg-white/5 hover:bg-white/10 cursor-pointer disabled:opacity-30 disabled:cursor-default" title="Redo (⌘⇧Z)" aria-label="Redo" :disabled="!brush.canRedo.value" @click="brush.redo()"><Redo2 class="size-4" /></button>
        </div>
        <button class="absolute top-4 right-4 z-10 flex items-center justify-center size-8 rounded bg-white/5 hover:bg-white/10 cursor-pointer" title="Close (Esc)" @click="emit('close')">
          <X class="size-4" />
        </button>

        <!-- Empty: load an image -->
        <button v-if="!sourceUrl" class="flex flex-col items-center justify-center gap-2 text-white/45 hover:text-white/80" @click="triggerLoad">
          <ImagePlus class="size-9" :stroke-width="1.5" />
          <span class="text-sm">Load an image to inpaint</span>
        </button>

        <!-- Image + mask stage -->
        <div
          v-else
          ref="stageRef"
          class="relative rounded-md overflow-hidden ring-1 ring-white/10"
          :class="panning ? 'cursor-grabbing' : spaceDown ? 'cursor-grab' : samSelect ? 'cursor-crosshair' : 'cursor-none'"
          :style="{ width: disp.w + 'px', height: disp.h + 'px' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @wheel.prevent="onWheel"
        >
          <div class="absolute inset-0" :style="{ transform: view.transform.value, transformOrigin: '0 0', width: disp.w + 'px', height: disp.h + 'px' }">
            <img v-if="sourceImg" :src="sourceImg.src" class="absolute inset-0 w-full h-full object-contain select-none pointer-events-none transition-opacity" :class="maskOnly ? 'opacity-0' : 'opacity-100'" draggable="false" />
            <div v-if="maskOnly" class="absolute inset-0 bg-black pointer-events-none" />
            <canvas ref="overlay" class="absolute inset-0 pointer-events-none" :style="{ width: disp.w + 'px', height: disp.h + 'px' }" />
            <!-- Region FX: pulsing fill + flowing pastel stroke (same as the Frame modal). -->
            <canvas
              v-show="showFx"
              ref="fxOverlay"
              class="absolute inset-0 pointer-events-none"
              :style="{ width: disp.w + 'px', height: disp.h + 'px', opacity: 0.9 }"
            />
            <!-- glimm prism sweep while generating, clipped to the region silhouette. -->
            <canvas
              v-show="showFx"
              ref="fxSweep"
              class="absolute inset-0 pointer-events-none"
              :style="{
                width: disp.w + 'px',
                height: disp.h + 'px',
                opacity: inpaint.busy.value ? 1 : 0,
                transition: 'opacity 240ms ease',
                maskImage: fxSweepMaskUrl ? `url(${fxSweepMaskUrl})` : 'none',
                WebkitMaskImage: fxSweepMaskUrl ? `url(${fxSweepMaskUrl})` : 'none',
                maskSize: '100% 100%', WebkitMaskSize: '100% 100%',
                maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
              }"
            />
            <!-- Live box-drag outline (crisp dashed rect while dragging the Box tool). -->
            <div
              v-if="boxRect"
              class="absolute pointer-events-none border border-white/90 bg-white/5"
              :style="{
                left: boxNorm(boxRect).l * disp.w + 'px',
                top: boxNorm(boxRect).t * disp.h + 'px',
                width: (boxNorm(boxRect).r - boxNorm(boxRect).l) * disp.w + 'px',
                height: (boxNorm(boxRect).bo - boxNorm(boxRect).t) * disp.h + 'px',
              }"
            />
          </div>
          <!-- brush cursor ring (screen space; scales with zoom) -->
          <div
            v-if="tool === 'paint' && !spaceDown && !panning && cursorScreen"
            class="absolute pointer-events-none rounded-full border-2"
            :class="brush.mode.value === 'erase' ? 'border-rose-400/90' : 'border-white/90'"
            :style="{ left: cursorScreen.sx + 'px', top: cursorScreen.sy + 'px', width: brush.sizePx.value * view.scale.value + 'px', height: brush.sizePx.value * view.scale.value + 'px', transform: 'translate(-50%, -50%)', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)' }"
          />
          <!-- Floating prompt bar — anchored under the selection (screen space). -->
          <div
            v-if="mode === 'mask' && promptBar && !maskOnly"
            class="absolute z-30 flex items-center gap-1 rounded-lg border border-white/15 bg-[#141416]/95 p-1 pl-2.5 shadow-xl backdrop-blur"
            :style="{ left: promptBar.x + 'px', top: promptBar.y + 'px', transform: 'translate(-50%, 0)', width: '300px' }"
            @pointerdown.stop
            @pointerup.stop
            @wheel.stop
          >
            <input
              v-model="prompt"
              type="text"
              :placeholder="samBusy ? 'Selecting…' : 'Describe the fill — or leave empty to remove'"
              class="min-w-0 flex-1 bg-transparent px-1 text-[12px] text-white/90 outline-none placeholder:text-white/30"
              @keydown.enter.prevent="runInpaint(false)"
            />
            <button
              class="flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-[11px] font-medium cursor-pointer transition-colors disabled:cursor-default disabled:opacity-50"
              :class="prompt.trim() ? 'bg-white text-neutral-900 hover:bg-white/90' : 'bg-white/10 text-white/80 hover:bg-white/15'"
              :disabled="inpaint.busy.value || samBusy"
              :title="prompt.trim() ? 'Generate the fill (Enter)' : 'Remove — fill from the surroundings (Enter)'"
              @click="runInpaint(false)"
            >
              <Loader2 v-if="inpaint.busy.value" class="size-3.5 animate-spin" />
              <Sparkles v-else class="size-3.5" />
              {{ prompt.trim() ? 'Generate' : 'Remove' }}
            </button>
          </div>
          <div v-if="loadingSrc" class="absolute inset-0 flex items-center justify-center bg-black/30"><Loader2 class="size-6 animate-spin text-white/60" /></div>
        </div>
        <div v-if="sourceUrl" class="absolute bottom-4 left-4 z-10 flex items-center gap-1 bg-black/40 border border-white/10 rounded-md p-0.5 text-white/70">
          <button class="flex items-center justify-center size-7 rounded hover:bg-white/10 cursor-pointer" title="Zoom out" aria-label="Zoom out" @click="view.zoomBy(1 / 1.2, disp.w / 2, disp.h / 2)"><ZoomOut class="size-4" /></button>
          <span class="min-w-[3rem] text-center text-[11px] tabular-nums select-none">{{ view.percent.value }}%</span>
          <button class="flex items-center justify-center size-7 rounded hover:bg-white/10 cursor-pointer" title="Zoom in" aria-label="Zoom in" @click="view.zoomBy(1.2, disp.w / 2, disp.h / 2)"><ZoomIn class="size-4" /></button>
          <span class="w-px h-4 bg-white/15 mx-0.5" />
          <button class="flex items-center justify-center size-7 rounded hover:bg-white/10 cursor-pointer" title="Fit" aria-label="Fit to screen" @click="view.reset()"><Maximize class="size-3.5" /></button>
        </div>
        <input ref="fileInputRef" type="file" accept="image/*" class="hidden" @change="onLoadFile" />
      </div>

      <!-- Controls -->
      <div class="w-80 border-l border-white/10 shrink-0 flex flex-col">
        <div class="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <Wand2 class="size-3.5 text-white/70" />
          <span class="text-sm font-semibold tracking-tight">Inpaint</span>
        </div>

        <div class="p-5 flex flex-col gap-7 flex-1 min-h-0 overflow-y-auto">
          <!-- Method -->
          <div>
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-2.5">Method</div>
            <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05]">
              <button class="flex-1 h-8 rounded text-[11px] cursor-pointer transition-colors" :class="mode === 'mask' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'" @click="mode = 'mask'">Paint mask</button>
              <button class="flex-1 h-8 rounded text-[11px] cursor-pointer transition-colors" :class="mode === 'describe' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'" @click="mode = 'describe'">Describe</button>
            </div>
          </div>

          <!-- Region tool -->
          <div v-if="mode === 'mask'">
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-2.5">Tool</div>
            <div class="flex items-center gap-1 p-0.5 rounded-md bg-white/[0.05]">
              <button class="flex-1 h-8 rounded flex items-center justify-center gap-1.5 text-[11px] cursor-pointer transition-colors" :class="tool === 'select' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'" title="Click an object to select it — Shift-click adds, Alt-click subtracts, drag a box to frame one (X)" @click="tool = 'select'"><Wand2 class="size-3.5" /> Select</button>
              <button class="flex-1 h-8 rounded flex items-center justify-center gap-1.5 text-[11px] cursor-pointer transition-colors" :class="tool === 'paint' ? 'bg-white text-neutral-900 font-medium' : 'text-white/70 hover:bg-white/10'" title="Brush the area — hold Alt/Option to erase (X)" @click="tool = 'paint'"><Brush class="size-3.5" /> Brush</button>
            </div>

            <div v-if="tool === 'paint'" class="flex items-center gap-2 mt-3.5">
              <span class="text-[10px] text-white/40 w-12 shrink-0">Size</span>
              <input type="range" min="4" max="200" :value="brush.sizePx.value" class="flex-1 accent-white cursor-pointer" title="Brush size ([ / ])" @input="brush.sizePx.value = +($event.target as HTMLInputElement).value" />
              <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ brush.sizePx.value }}</span>
            </div>
            <p v-else class="text-[10px] text-white/35 mt-3.5 leading-relaxed">
              <span v-if="samBusy" class="inline-flex items-center gap-1 text-white/55"><Loader2 class="size-3 animate-spin" /> Selecting…</span>
              <span v-else>Click an object to select it. Shift-click adds, Alt-click subtracts, or drag a box to frame one.</span>
            </p>

            <div class="flex items-center gap-1.5 mt-3.5">
              <button class="h-7 px-2 rounded flex items-center gap-1 text-[11px] cursor-pointer transition-colors" :class="brush.inverted.value ? 'bg-amber-400/90 text-neutral-900' : 'bg-white/[0.06] text-white/70 hover:bg-white/12'" title="Invert: keep the painted area, change everything else" @click="brush.toggleInvert()"><FlipHorizontal2 class="size-3.5" /> Invert</button>
              <button class="h-7 px-2 rounded flex items-center gap-1 text-[11px] cursor-pointer transition-colors" :class="maskOnly ? 'bg-white/20 text-white' : 'bg-white/[0.06] text-white/70 hover:bg-white/12'" title="Show only the mask (hide the photo)" @click="maskOnly = !maskOnly"><component :is="maskOnly ? EyeOff : Eye" class="size-3.5" /> Mask</button>
              <button class="ml-auto h-7 px-2 rounded bg-white/[0.06] text-white/70 hover:bg-white/12 text-[11px] cursor-pointer transition-colors" title="Clear region" @click="clearMask()">Clear</button>
            </div>
          </div>

          <!-- Prompt — mask mode types in the floating bar on the selection; the
               side field stays only for Describe (no selection to anchor to). -->
          <div v-if="mode === 'describe'">
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-2.5">Prompt</div>
            <textarea
              v-model="prompt" rows="3"
              placeholder="describe the edit, e.g. make the sky a sunset"
              class="pastel-hairline block w-full rounded-md text-[12px] px-2 py-1.5 outline-none resize-none placeholder:text-white/25"
              style="--pastel-hairline-bg: #141416;"
              @keydown.enter.exact.prevent="runInpaint(false)"
            />
          </div>

          <!-- Options -->
          <div>
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/40 mb-2.5">Options</div>
            <div class="grid grid-cols-2 gap-2.5">
              <label class="flex items-center gap-1.5 text-[11px] text-white/50">Model
                <select v-model="tier" class="flex-1 h-8 bg-white/[0.06] rounded text-[11px] px-1 outline-none cursor-pointer">
                  <option value="dev">Dev · cheap</option>
                  <option value="pro">Pro · best</option>
                </select>
              </label>
              <label class="flex items-center gap-1.5 text-[11px] text-white/50">Variations
                <select v-model.number="count" class="flex-1 h-8 bg-white/[0.06] rounded text-[11px] px-1 outline-none cursor-pointer">
                  <option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option>
                </select>
              </label>
            </div>
            <div v-if="mode === 'mask'" class="mt-3.5 flex flex-col gap-3">
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-white/40 w-12 shrink-0">Feather</span>
                <input type="range" min="0" max="40" v-model.number="feather" class="flex-1 accent-white cursor-pointer" />
                <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ feather }}</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-white/40 w-12 shrink-0">Expand</span>
                <input type="range" min="0" max="40" v-model.number="expand" class="flex-1 accent-white cursor-pointer" />
                <span class="text-[10px] text-white/50 w-8 text-right tabular-nums">{{ expand }}</span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div>
            <div v-if="intent === 'recolor' && hasRegion" class="flex items-center gap-1.5 flex-wrap mb-2.5">
              <span class="text-[10px] text-white/40 select-none">Recolor to</span>
              <button v-for="s in recolorSwatches" :key="s.hex"
                      class="size-6 rounded border border-white/15 cursor-pointer hover:scale-110 transition-transform"
                      :style="{ background: s.hex }" :title="`${s.label} ${s.hex}`"
                      :disabled="inpaint.busy.value"
                      @click="runRecolor(s.label, s.hex)" />
              <label class="relative size-6 rounded-md border border-dashed border-white/25 cursor-pointer overflow-hidden" title="Custom color">
                <input v-model="customColor" type="color" class="absolute inset-0 opacity-0 cursor-pointer"
                       @change="runRecolor('custom', customColor)" />
                <span class="absolute inset-0 grid place-items-center text-[10px] text-white/50">+</span>
              </label>
            </div>
            <div class="flex items-center gap-1.5">
              <button v-if="mode === 'mask'" class="h-8 px-2.5 rounded bg-white/[0.06] hover:bg-white/12 text-[11px] cursor-pointer disabled:opacity-30 disabled:cursor-default" :disabled="inpaint.busy.value || !sourceImg || !hasRegion" title="Remove what's under the mask" @click="runInpaint(true)">Remove</button>
              <button class="gen-pastel flex-1 h-8 rounded text-neutral-900 text-[12px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-default" :disabled="inpaint.busy.value || !sourceImg || (mode === 'mask' && !hasRegion)" @click="runInpaint(false)">
                {{ inpaint.busy.value ? 'Generating…' : (history.length ? 'Regenerate' : 'Generate') }}
              </button>
            </div>
            <p v-if="mode === 'mask' && !hasRegion" class="text-[10px] text-white/30 mt-1.5">Mark a region on the image to enable Generate.</p>
            <!-- Apply the result showing on the canvas back onto the node. Appears
                 once a result exists so the save action isn't buried in History. -->
            <button v-if="lastResult"
              class="mt-1.5 w-full h-8 rounded bg-action hover:bg-action/85 text-white text-[12px] font-semibold cursor-pointer transition-colors"
              title="Apply the result shown on the canvas to the node"
              @click="applyResult">
              Apply to canvas
            </button>
          </div>

          <!-- History -->
          <div v-if="history.length" class="pt-2 border-t border-white/10">
            <div class="flex items-center justify-between mb-2 text-[11px] uppercase tracking-wide text-white/40">
              <span>History</span>
              <button class="flex items-center gap-1 normal-case tracking-normal text-white/50 hover:text-white cursor-pointer select-none" title="Hold to see the original"
                @pointerdown.stop="comparing = true" @pointerup="comparing = false" @pointerleave="comparing = false"><Eye class="size-3.5" /> Compare</button>
            </div>
            <div class="grid grid-cols-4 gap-2">
              <button v-for="item in history" :key="item.id"
                class="relative group rounded overflow-hidden border cursor-pointer"
                :class="previewResult === item.url ? 'border-white/90 ring-1 ring-white/30' : 'border-white/10 hover:border-white/40'"
                :title="item.prompt || (item.mode === 'describe' ? 'described edit' : 'inpaint')"
                @mouseenter="previewResult = item.url" @mouseleave="previewResult = lastResult" @click="acceptInpaint(item.url)">
                <img :src="item.url" class="w-full aspect-square object-cover" draggable="false" />
                <span class="absolute inset-x-0 bottom-0 py-0.5 text-center text-[10px] bg-black/60 opacity-0 group-hover:opacity-100">Use</span>
              </button>
            </div>
            <p class="mt-1.5 text-[10px] text-white/30">Newest first · hover to preview · click to apply.</p>
          </div>

          <div v-if="inpaintError" class="text-[11px] text-rose-400">{{ inpaintError }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
