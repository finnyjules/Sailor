<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import {
  Download, Pencil, Frame as FrameIcon, ImagePlus,
  MousePointer2, Check, Type, Square, Circle, Minus, Trash2,
} from 'lucide-vue-next'
import { getTypeColor } from '~/composables/useVueNodes'
import { useLocalLayerEditor, aspectLockedResizeKind } from '~/composables/useLocalLayerEditor'
import { type LocalLayer, type TextLayer, type StackItem, type WiredLayer as UnifiedWiredLayer, drawWiredImageLayer, ensureLayerFonts, ensureLayerImages, paintLayerStack, hasAnimatedShaderFill, withWiredContent, clipClocks } from '~/composables/useCompositorLayers'
import { hasPaint } from '~/lib/paint/resolve'
import { migrateFrameToUnifiedLayers } from '~/lib/compositor/wiredMigration'
import { framePresentKeys, finalizeWiredSentinels, reconcileWiredContent, syncWiredLayerLinks, wiredReconcileKey, legacyWiredFlagsActive, isWiredSentinel } from '~/lib/compositor/frameStack'
import { createWiredMaskCache } from '~/lib/compositor/wiredMaskCache'
import { libraryFamily } from '~/data/library-fonts'
import { paintPrimaryColor } from '~/lib/spacetype/fillTile'
import { readWiredTreatments } from '~/composables/useWiredTreatments'
import type { Cloner } from '~/composables/useCloner'
import CompositorInlineToolbar from '~/components/vue-canvas/CompositorInlineToolbar.vue'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'
import AddImageSourcePopover from '~/components/vue-canvas/compositor/AddImageSourcePopover.vue'
import { registerStudioBaker, unregisterStudioBaker } from '~/lib/studio/cascade'
import { onCanvasOcclusion, createOcclusionRepaintGate } from '~/lib/studio/occlusion'
import { encodeFrames } from '~/lib/engine/encodeVideo'
import { resolveWiredSourceKind } from '~/lib/studio/frameResolve'
import { frameSourceEpoch, type StudioFrameSource } from '~/lib/studio/frameSource'
import { deriveMasterClock, slotPhase01, masterFrameIndex } from '~/lib/compositor/masterClock'
import { portOffset } from '~/lib/canvas/portLayout'
import { onFieldCatalogReady } from '~/lib/shaderfill/field'
import { readGrid } from '~/lib/frame/gridConfig'
import { resolveGrid } from '~/lib/frame/grid'
import { toast } from 'vue-sonner'

// The "Frame" — the Compositor as a first-class artboard artifact. Shows its
// live composite (wired layers from `data.images` + a live local-layer overlay),
// supports inline editing on the canvas, and outputs IMAGE. The modal ("Modal")
// remains for focused / precise work.
const props = defineProps<{
  id: string
  data: {
    nodeType: string
    title: string
    inputs: { name: string; type: string; link: number | null }[]
    outputs: { name: string; type: string; links: number[] | null }[]
    widgetsValues: any[]
    widgetDefs?: any[]
    properties?: Record<string, any>
    mode: number
    running?: boolean
    error?: boolean
    images?: string[]
    studioBusy?: boolean
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const imageColor = computed(() => getTypeColor('IMAGE'))
const injectedEdges = inject<any>('vueFlowEdges', null)
const injectedNodes = inject<any>('vueFlowNodes', null)
const { ensure: ensureGoogleFont } = useGoogleFontPreview()

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }

function outputIdx(name: string): number {
  const i = props.data.outputs?.findIndex(o => o.name === name) ?? -1
  return i >= 0 ? i : 0
}
function widgetIdx(name: string): number { return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1 }
function widgetVal(name: string): number { const i = widgetIdx(name); return i >= 0 ? Number(props.data.widgetsValues?.[i] ?? 0) : 0 }
function setWidget(name: string, value: any) { const i = widgetIdx(name); if (i >= 0 && props.data.widgetsValues) props.data.widgetsValues[i] = value }
const imageOutIdx = computed(() => outputIdx('image'))
// Per-layer transform widgets — slot s (0-based input) maps to layer{s+1}_*.
function layerTf(slot: number, prop: string): number { const v = widgetVal(`layer${slot + 1}_${prop}`); return prop === 'scale' ? (v || 1) : v }

// ── Artboard dimensions ─────────────────────────────────────────────────────
interface Preset { id: string; label: string; w: number; h: number }
const PRESETS: Preset[] = [
  { id: '1:1', label: 'Square · 1:1', w: 1024, h: 1024 },
  { id: '16:9', label: 'Wide · 16:9', w: 1280, h: 720 },
  { id: '9:16', label: 'Tall · 9:16', w: 720, h: 1280 },
  { id: '4:5', label: 'Portrait · 4:5', w: 1024, h: 1280 },
  { id: '4:3', label: 'Classic · 4:3', w: 1024, h: 768 },
  { id: 'A4', label: 'A4 · print', w: 1240, h: 1754 },
]
const frameW = computed(() => widgetVal('width'))
const frameH = computed(() => widgetVal('height'))
const hasExplicitSize = computed(() => frameW.value > 0 && frameH.value > 0)
const isResponsive = computed(() => (props.data.properties as any)?.sailor_frame?.responsive === true)
function setResponsive(on: boolean) {
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_frame = { ...(props.data.properties as any).sailor_frame, responsive: on }
}
const activePresetId = computed<string>(() => {
  if (isResponsive.value) return 'responsive'
  const match = PRESETS.find(p => p.w === frameW.value && p.h === frameH.value)
  return match ? match.id : (hasExplicitSize.value ? 'custom' : '')
})
function applyPreset(id: string) { const p = PRESETS.find(x => x.id === id); if (!p) return; setWidget('width', p.w); setWidget('height', p.h); rememberPreset(id) }
function rememberPreset(id: string) {
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_frame = { ...(props.data.properties as any).sailor_frame, preset: id }
}
function onPresetChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v === 'responsive') {
    // A frame with no explicit size follows its bottom wired image; on becoming
    // responsive, write its current effective size as a concrete design size so
    // the design size is stable (never re-derived from the live canvas). Keep an
    // already-explicit size untouched.
    if (!(frameW.value > 0 && frameH.value > 0)) {
      const L = 1024
      const a = Number.isFinite(aspect.value) && aspect.value > 0 ? aspect.value : 1
      const w = a >= 1 ? L : Math.round(L * a)
      const h = a >= 1 ? Math.round(L / a) : L
      setWidget('width', w); setWidget('height', h)
    }
    setResponsive(true); return
  }
  if (v && v !== 'custom') { setResponsive(false); applyPreset(v) }
}
function setDim(which: 'width' | 'height', e: Event) { setWidget(which, Math.max(0, Math.round(parseFloat((e.target as HTMLInputElement).value) || 0))); rememberPreset('custom') }

// Aspect: explicit dims win; else the bottom wired image's aspect; else square.
// Matching the composite means the background image fills the artboard exactly,
// so wired-layer hit-testing/handles line up.
const aspect = computed(() => {
  if (hasExplicitSize.value) return frameW.value / frameH.value
  const base = wiredLayers.value[0]
  if (base) { const d = wiredDims.value[base.url]; if (d && d.h) return d.w / d.h }
  return 1
})
// On-canvas display size (the frame's longest edge in logical px) — the size
// you *work* at on the canvas, distinct from the output resolution (the W×H
// widgets / presets). Drag the corner grip to change it; persisted on the node.
const displayEdge = computed(() => Number((props.data.properties as any)?.sailor_frame?.displayEdge) || 300)
function setDisplayEdge(v: number) {
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_frame = {
    ...(props.data.properties as any).sailor_frame, displayEdge: clamp(Math.round(v), 180, 1600),
  }
}
const box = computed(() => {
  const a = aspect.value || 1
  const E = displayEdge.value
  return a >= 1 ? { w: E, h: Math.round(E / a) } : { w: Math.round(E * a), h: E }
})

// ── Grid overlay (editor-only guide) ────────────────────────────────────────
// Read-only here: this card never writes sailor_localGrid (the modal's grid
// inspector owns edits). Purely a display aid — never consumed by
// `paintLayerStack`/`exportCompositeCanvas`/`bakeOutput`, so it can't leak into
// a bake, export, or embed no matter what `editMode` does.
const gridConfig = computed(() => readGrid(props.data.properties))
const gridResolved = computed(() => resolveGrid(gridConfig.value, box.value.w, box.value.h))
// Gate is defined here but only ever consulted from the edit-mode template
// branch below (`v-if="showGridOverlay"` sits inside the artboard, itself only
// reachable while `editMode` is true) — never from the stack-canvas paint path.
const showGridOverlay = computed(() =>
  editMode.value && gridConfig.value.mode !== 'off' && gridConfig.value.overlay)

// Manual node resize — zoom-aware (mirrors StickyAnnotation). zoom is derived
// from the artboard's on-screen rect vs its logical size, so no Vue Flow dep.
let resize: { startEdge: number; sx: number; sy: number; zoom: number } | null = null
function onResizeDown(e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  const r = artboardRef.value?.getBoundingClientRect()
  const zoom = r && box.value.w ? r.width / box.value.w : 1
  resize = { startEdge: displayEdge.value, sx: e.clientX, sy: e.clientY, zoom: zoom || 1 }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp, { once: true })
}
function onResizeMove(e: PointerEvent) {
  if (!resize) return
  const d = (aspect.value >= 1 ? e.clientX - resize.sx : e.clientY - resize.sy) / resize.zoom
  setDisplayEdge(resize.startEdge + d)
}
function onResizeUp() { resize = null; window.removeEventListener('pointermove', onResizeMove) }

// ── Layer input handles + wired (connected) layers ──────────────────────────
function slotConnected(slotIdx: number): boolean {
  if (props.data.inputs?.[slotIdx]?.link != null) return true
  const edges = injectedEdges?.value ?? []
  return edges.some((e: any) => e.target === props.id && e.targetHandle === `input-${slotIdx}`)
}
const layerSlots = computed<number[]>(() => {
  const connected: number[] = []
  for (let i = 0; i < 16; i++) if (slotConnected(i)) connected.push(i)
  const next = connected.length ? Math.max(...connected) + 1 : 0
  const slots = [...connected]
  if (next < 16) slots.push(next)
  return slots
})
// Inputs stack from the node's vertical centre DOWNWARD — the shared port rule
// (portOffset / PORT_PITCH), so the Frame matches every other node and surface.
// idx 0 sits dead centre; each later slot is one pitch below. (The old formula
// spread ports across the full node height, so two slots landed at the very top
// and bottom instead of near the middle.)
function handleTop(idx: number): string {
  return `calc(50% + ${portOffset(idx)}px)`
}

function wiredOpacity(slot: number): number {
  const i = widgetIdx(`layer${slot + 1}_opacity`)
  if (i < 0) return 1
  const v = Number(props.data.widgetsValues?.[i])
  return Number.isFinite(v) ? clamp(v, 0, 1) : 1
}
// `url` is the draw/cache KEY for a layer. For a baked image it is the real /view
// URL; for a live studio slot it is a synthetic `live:<slot>` key and `live` holds
// the frame source (pulled once as a still — the animated loop is a follow-on).
interface WiredLayer { slot: number; url: string; live?: StudioFrameSource; x: number; y: number; rotation: number; scale: number; opacity: number; blend: string; cloner?: Cloner }
function wiredCloner(slot: number): Cloner | undefined {
  // Editor state on a node property (1-based slot, like layer{i}_cloner), mirrored
  // from the Compositor modal — not the widget (which only exists post-restart).
  const map = (props.data.properties as any)?.sailor_wiredCloners
  return map?.[slot + 1] as Cloner | undefined
}
const wiredLayers = computed<WiredLayer[]>(() => {
  frameSourceEpoch.value  // re-resolve when a studio (un)registers its frame source
  const edges = injectedEdges?.value ?? []
  const nodes = injectedNodes?.value ?? []
  const out: WiredLayer[] = []
  for (let s = 0; s < 16; s++) {
    if (!slotConnected(s)) continue
    const kind = resolveWiredSourceKind(String(props.id), `input-${s}`, nodes, edges)
    if (!kind) continue
    const common = { slot: s, x: layerTf(s, 'x'), y: layerTf(s, 'y'), rotation: layerTf(s, 'rotation'), scale: layerTf(s, 'scale'), opacity: wiredOpacity(s), blend: blendOf(s), cloner: wiredCloner(s) }
    if (kind.kind === 'live') out.push({ ...common, url: `live:${s}`, live: kind.source })
    else out.push({ ...common, url: kind.url })
  }
  return out
})
// Natural dimensions + decoded bitmap per wired image. Dims drive aspect-fit
// hit-testing; the bitmap is painted into the unified stack canvas.
const wiredDims = ref<Record<string, { w: number; h: number }>>({})
const wiredImages = ref<Record<string, HTMLImageElement | HTMLCanvasElement>>({})
// Re-run on wiring changes AND on frameSourceEpoch, so a live slot that registers
// late (or re-registers) gets pulled. Live slots pull once as a still here; the
// animated per-frame pull is the follow-on increment.
watch(() => wiredLayers.value.map(l => l.url).join('|') + '|' + frameSourceEpoch.value, () => {
  for (const l of wiredLayers.value) {
    if (l.live) { void pullLiveFrame(l, 0); continue }
    if (wiredImages.value[l.url]) continue
    const im = new Image()
    im.onload = () => {
      if (!im.naturalWidth) return
      wiredDims.value = { ...wiredDims.value, [l.url]: { w: im.naturalWidth, h: im.naturalHeight } }
      wiredImages.value = { ...wiredImages.value, [l.url]: im }
    }
    im.src = l.url
  }
}, { immediate: true })

// ── Wired content, expressed as the ONE host indirection paint asks for ──────
// `wiredImages`/`wiredDims` are keyed by draw URL; the unified layer model keys
// by 0-based SLOT. These three helpers are that translation, and they are the
// only thing the shared pipeline ever calls to reach this card's graph pixels.
function wiredUrlForSlot(slot: number): string | undefined {
  return wiredLayers.value.find(l => l.slot === slot)?.url
}
function wiredDimsForSlot(slot: number): { w: number; h: number } | undefined {
  const u = wiredUrlForSlot(slot)
  return u ? wiredDims.value[u] : undefined
}
// Per-slot visibility masks still live on the treatments registry (by slot), so
// they are folded in HERE — the generic paint path has no mask argument, and
// dropping them at the flip would have silently unmasked every masked frame.
const wiredMaskCache = createWiredMaskCache()
function wiredContentForSlot(slot: number): CanvasImageSource | null {
  const u = wiredUrlForSlot(slot)
  if (!u) return null
  return wiredMaskCache.apply(slot, wiredImages.value[u] ?? null, wiredMasks.value[slot] ?? null)
}

// Pull a live studio slot's frame at normalized time t01 and COPY it into a canvas we
// OWN — the source reuses its canvas across getFrame calls, so we must not hold its
// buffer. The owned canvas is created once per slot and drawn into in place on every
// pull, so per-frame animation doesn't churn the reactive wiredImages map (only the
// first pull / a size change reassigns it; the animation loop calls renderStack itself).
async function pullLiveFrame(l: WiredLayer, t01: number) {
  const src = l.live!
  const w = Math.max(1, src.width || 1024), h = Math.max(1, src.height || 1024)
  try {
    const surface = await src.getFrame(t01, w, h)
    let cv = wiredImages.value[l.url]
    if (!(cv instanceof HTMLCanvasElement) || cv.width !== w || cv.height !== h) {
      cv = document.createElement('canvas'); cv.width = w; cv.height = h
      wiredDims.value = { ...wiredDims.value, [l.url]: { w, h } }
      wiredImages.value = { ...wiredImages.value, [l.url]: cv }
    }
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)   // transparent studios (e.g. Type Studio) would otherwise stack frames
    ctx.drawImage(surface as CanvasImageSource, 0, 0, w, h)
  } catch (e) { console.warn('[Frame] live slot pull failed for', l.url, e) }
}

// LEGACY (schema < 2) per-wired-slot visibility, persisted on node properties as
// a 1-BASED slot array (layerN numbering, same as the w:N stack keys). Internal
// WiredLayer.slot stays 0-based — hence the +1 at every lookup.
// Schema 2 retired it: a wired slot is a LAYER and carries its own `visible`.
// The array is left on disk for rollback, so it has to be actively IGNORED —
// and ignored on the SAME terms the modal uses, or the two surfaces would
// disagree about whether a slot is hidden and render the frame differently.
const hiddenWiredSet = computed(() => {
  if (!legacyWiredFlagsActive((props.data.properties as any) ?? null)) return new Set<number>()
  return new Set((((props.data.properties as any)?.sailor_hiddenWired as number[]) ?? []).map(Number))
})

// Wired layers select through the SAME editor hit test as every other layer now
// (their box resolves via this card's content provider), so the separate wired hit
// test, the `selectedWiredSlot` ref and the amber handle geometry are gone.

const compositeUrl = computed<string | null>(() => props.data.images?.[0] ?? null)

// ── Inline editing engine (local layers: text / shapes / dropped images) ────
const artboardRef = ref<HTMLDivElement | null>(null)
const editor = useLocalLayerEditor({
  node: () => ({ data: props.data }),
  dims: () => ({ w: box.value.w, h: box.value.h }),
  getRect: () => artboardRef.value?.getBoundingClientRect() ?? null,
  // Real decoded content dims, so the `layer{N}_*` write-through fits against the
  // pixels the server will fit against — not against a cached aspect that an
  // upstream re-run can have made stale.
  wiredDims: wiredDimsForSlot,
  wiredContent: wiredContentForSlot,
  // Deleting a wired layer must take the slot's edge with it — only the canvas
  // owns edges, so ask it. Undo (the editor's own history step, recorded by the
  // delete) brings the LAYER back; the edge does not come back with it, so the
  // restored layer reconciles to `unlinked` and the toast says how to relink.
  onWiredRemoved: (wired) => {
    for (const w of wired) {
      window.dispatchEvent(new CustomEvent('sailor:frameUnwireSlot', { detail: { nodeId: props.id, slot: w.slot } }))
    }
    if (wired.length) {
      toast('Layer removed and its input unwired', {
        description: 'Undo brings the layer back unlinked — re-wire the input to reconnect it.',
      })
    }
  },
  // ⌘D / copy on a wired layer must never clone the live link (two layers on one
  // slot). The honest copy is a SNAPSHOT of what the slot is showing, baked into
  // an ordinary image layer at the same place. Passed here so the card has verb
  // parity with the modal the moment it wires `handleEditorKey`.
  materializeWired: (w) => snapshotWiredLayer(w),
})

/**
 * Bake a wired layer's current pixels (mask included — `wiredContentForSlot`
 * already punches it) into a normal image layer at the same transform, then hide
 * the wire so you see one image, not two. The modal's "Copy into frame" in the
 * card's own terms; it uploads to the input dir exactly like a dropped file, so
 * the result survives unplugging the wire.
 */
async function snapshotWiredLayer(w: UnifiedWiredLayer) {
  const el = wiredContentForSlot(w.slot)
  const d = wiredDimsForSlot(w.slot)
  if (!el || !d?.w || !d?.h) { toast('That layer’s image isn’t ready yet'); return }
  try {
    const c = document.createElement('canvas'); c.width = d.w; c.height = d.h
    c.getContext('2d')!.drawImage(el, 0, 0, d.w, d.h)
    let dataUrl: string
    try { dataUrl = c.toDataURL('image/png') }
    catch { toast('Can’t read this image’s pixels'); return }
    const fd = new FormData()
    const safe = `framecopy_${Date.now()}.png`
    fd.append('image', new File([await (await fetch(dataUrl)).blob()], safe, { type: 'image/png' }))
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    const name = (await res.json())?.name || safe
    editor.addImageFromName(name, d.w / d.h, {
      x: w.x, y: w.y, w: w.w, rotation: w.rotation, opacity: w.opacity, blend: w.blend,
    } as any)
    // Hide (not delete) the wire: the slot's edge is untouched, so Show brings the
    // live layer back exactly as "Copy into frame" has always behaved.
    editor.setLocal(w.id, { visible: false } as any)
  } catch (err) {
    console.error('[Frame] snapshot wired layer failed:', err)
    toast('Could not copy that layer into the frame')
  }
}
/** The selection is a wired layer, so its corners resize ANCHORED + aspect-locked
 *  (a wired layer has no independent height — see `aspectLockedResizeKind`). */
const selectedCornerAnchored = computed(() =>
  !!editor.selected.value && aspectLockedResizeKind(editor.selected.value.kind))
/** The selection is a wired layer whose input has been cut — it keeps its box but
 *  paints nothing, which the badge has to say (modal parity). */
const selectedUnlinkedWired = computed(() =>
  (editor.selected.value as any)?.kind === 'wired' && !!(editor.selected.value as any)?.unlinked)

const editMode = ref(false)
function toggleEdit() { editMode.value ? exitEdit() : (editMode.value = true) }
function exitEdit() { editMode.value = false; editor.endEdit(); editor.selectLocal(null) }
function onArtboardDblClick(e: MouseEvent) {
  // Edit mode FIRST, then begin text editing. The inline textarea is gated on
  // `editMode`, and paint deliberately skips the layer being edited — so
  // beginning a text edit while the card is still idle used to make the text
  // vanish: nothing painted it and no textarea rendered to hold it. One
  // double-click now both enters edit mode and starts editing the text it hit.
  if (!editMode.value) editMode.value = true
  editor.onCanvasDblClick(e)
}

// Pointer down on the artboard: ONE selection path — the editor hit-tests every
// layer, wired included.
function onArtboardPointerDown(e: PointerEvent) {
  if (!editMode.value) return
  if ((e.target as HTMLElement)?.closest?.('[data-handle]')) return
  editor.onCanvasPointerDown(e)
}

// A wired layer's move/scale/rotate is the editor's, and it reaches the backend
// through the editor's `layer{N}_*` write-through — so the hand-rolled drag loop
// that wrote those widgets directly (and could not undo) is gone.

// Inline text editor: the editor owns "when to focus" (see its focus contract),
// the host only says WHICH element. Add text and double-click therefore both
// land with the caret in the box and the placeholder selected.
const editRef = ref<HTMLTextAreaElement | null>(null)
editor.registerEditFocus(() => editRef.value)

// Inline text editor positioning (mirrors the modal).
const editingStyle = computed(() => {
  const l = editor.editingLayer.value
  if (!l) return {}
  const b = editor.boxPx(l)
  const W = box.value.w, H = box.value.h
  return {
    left: l.x * W + 'px', top: l.y * H + 'px',
    width: Math.max(b.w + 8, 30) + 'px', height: Math.max(b.h + 6, 20) + 'px',
    transform: `translate(-50%, -50%) rotate(${l.rotation}deg)`,
    fontFamily: /\s/.test(l.fontFamily) ? `"${l.fontFamily}", sans-serif` : `${l.fontFamily}, sans-serif`,
    fontWeight: String(l.fontWeight), fontSize: l.fontSize * W + 'px',
    lineHeight: String(l.lineHeight), color: paintPrimaryColor(l.color, '#ffffff'), textAlign: l.align as any,
    letterSpacing: `${l.letterSpacing || 0}em`,
    textTransform: (l.textTransform || 'none') as any,
    textDecoration: [l.underline && 'underline', l.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none',
    opacity: String(l.opacity), caretColor: paintPrimaryColor(l.color, '#ffffff'),
  }
})

// ── Unified z-order stack (wired + local layers in ONE ordered list) ─────────
// Keys: `w:<slot>` for a wired/connected layer, `l:<id>` for a local layer.
// Persisted on the node as `sailor_stackOrder`; array order is bottom→top.
// This is the single source of truth for depth, so any layer — a dropped shape
// or a wired image — can sit above or below any other, like Figma/Photoshop.
type StackKey = string
// Wired keys are 1-BASED (`w:1` = the backend's layer1) so the persisted
// order round-trips with CompositorModal, which numbers slots the same way.
// The frame's internal WiredLayer.slot stays 0-based (input-port index), so
// the +1/-1 happens only at the persistence boundary here.
function wiredKey(slot: number): StackKey { return `w:${slot + 1}` }
function localKey(id: string): StackKey { return `l:${id}` }

// Present layers in the legacy default order: wired at the bottom, locals on top
// (matches how the editor behaved before unification). Used to seed/append.
// A migrated slot is a LAYER, so it contributes `l:<id>` and NOT also its legacy
// `w:` key — counting it twice gives one layer two depths. Slots with no layer
// claiming them (a pre-schema-2 frame, or an edge that just landed) still emit
// `w:`, which is what keeps legacy frames rendering unchanged.
const presentKeys = computed<StackKey[]>(() =>
  framePresentKeys(wiredLayers.value.map(l => l.slot), editor.localLayers.value))
// Reconcile the saved order against what's actually present: keep saved order
// for layers still here, then append any newcomers on top. So adding a shape or
// wiring an image floats it to the top, and removing one just drops out.
const stackKeys = computed<StackKey[]>(() => {
  const saved = ((props.data.properties as any)?.sailor_stackOrder as StackKey[]) ?? []
  const present = new Set(presentKeys.value)
  const kept = saved.filter(k => present.has(k))
  const keptSet = new Set(kept)
  return [...kept, ...presentKeys.value.filter(k => !keptSet.has(k))]
})
function resolveKey(key: StackKey):
  | { type: 'wired'; layer: WiredLayer }
  | { type: 'local'; layer: LocalLayer }
  | null {
  if (key.startsWith('w:')) {
    const slot = Number(key.slice(2)) - 1 // persisted keys are 1-based (layerN)
    const layer = wiredLayers.value.find(l => l.slot === slot)
    return layer ? { type: 'wired', layer } : null
  }
  const id = key.slice(2)
  const layer = editor.localLayers.value.find(l => l.id === id)
  return layer ? { type: 'local', layer } : null
}
const selectedStackKey = computed<StackKey | null>(() => (
  editor.selectedId.value ? localKey(editor.selectedId.value) : null
))
// Reorder by swapping a key with its neighbour, then persist the full present
// order (which also bakes in the current reconciliation).
function moveStackZ(key: StackKey, dir: -1 | 1) {
  const arr = [...stackKeys.value]
  const i = arr.findIndex(k => k === key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  if (!props.data.properties) (props.data as any).properties = {}
  ;(props.data.properties as any).sailor_stackOrder = arr
}
function moveSelectedZ(dir: number) {
  const key = selectedStackKey.value
  if (key) moveStackZ(key, dir < 0 ? -1 : 1)
}

// ── Unified stack render (one canvas, wired + local in z-order → WYSIWYG) ─────
// A MIGRATED wired slot draws through the generic layer pipeline (it is a layer);
// this legacy draw survives only for a connected slot no layer has claimed yet,
// and still shares `drawWiredImageLayer` with the modal so the two can't drift.
function drawWiredLayer(ctx: CanvasRenderingContext2D, l: WiredLayer, W: number, H: number) {
  drawWiredImageLayer(ctx, wiredImages.value[l.url], l, W, H, wiredMasks.value[l.slot] ?? null)
}
// Shared by the live preview AND the export/download so masking and z-order are
// applied identically (drawn in logical W×H coords; export scales the ctx up).
function buildStackItems(): StackItem[] {
  return stackKeys.value.map((key): StackItem | null => {
    const r = resolveKey(key)
    if (!r) return null
    if (r.type === 'wired') {
      if (hiddenWiredSet.value.has(r.layer.slot + 1)) return null
      return { type: 'wired', key, draw: (c, w, h) => drawWiredLayer(c, r.layer, w, h) }
    }
    return { type: 'local', key, layer: r.layer }
  }).filter((x): x is StackItem => x != null)
}

const stackCanvas = ref<HTMLCanvasElement | null>(null)
// `t` is the Frame's own master-timeline seconds (see `animateFrame` below) — real
// elapsed time, not the wrapped/bounded master-clock period. Omitted (`undefined`) for
// the plain watch-driven repaint below, which is correct: with no animated slot AND no
// live shader fill there is nothing time-dependent to paint, so `paintLayerStack`
// defaulting to t=0 is byte-identical to "no clock needed" — see `hasAnimatedFill` below
// for the predicate that decides whether that default is actually being exercised.
function renderStack(t?: number, live = false) {
  if (!repaintGate.shouldPaint()) return
  const cv = stackCanvas.value
  if (!cv) return
  const W = box.value.w, H = box.value.h
  const deviceDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  // Live-preview cost cap. A device-resolution composite with visible post-effects
  // (bloom especially) costs ~5ms on a small Frame and ~17-40ms on a large retina one —
  // enough to blow the frame budget during hover-play even at content fps. While
  // ANIMATING with post-effects on, cap the composite's backing store to a pixel budget
  // so each paint stays cheap (bloom's radius is width-normalized, so it scales down with
  // it and stays correct). The idle poster, static repaints, and every bake/export are
  // never `live`, so they keep full device resolution — exported quality is unchanged.
  // Trade-off: post-effects look slightly softer WHILE the card is playing, sharp at rest.
  const hasPost = !!editor.postEffects.value?.some((e: any) => e?.visible)
  const dpr = (live && hasPost)
    ? Math.max(1, Math.min(deviceDpr, Math.sqrt(LIVE_PREVIEW_MAXPX / Math.max(1, W * H))))
    : deviceDpr
  // Resize ONLY when the size actually changes. Assigning canvas.width/height reallocates
  // and clears the backing store every time — doing it each animation frame (renderStack
  // runs per tick) is a classic source of playback jank. clearRect below handles the
  // per-frame clear. During steady playback `dpr` is constant so this never reallocates;
  // it changes once when the live cap engages/releases on hover enter/leave.
  const dw = Math.max(1, Math.round(W * dpr)), dh = Math.max(1, Math.round(H * dpr))
  if (cv.width !== dw) cv.width = dw
  if (cv.height !== dh) cv.height = dh
  const ctx = cv.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  // `motion` (Kinetic Slate per-layer animation) intentionally stays undefined here —
  // out of scope for this fix, and passing a truthy `motion` alongside `t` would also
  // activate the slate-motion path in paintLayerStack, which the Frame card has never
  // driven. Only the shader-fill clock (`t`) is being wired up.
  // Scoped to THIS card's slots: the wired resolver is a module global, and a
  // second live host (the modal, or another Frame) numbers its slots the same way.
  withWiredContent(wiredContentForSlot, () =>
    paintLayerStack(ctx, W, H, buildStackItems(), editor.localLayers.value, l => l.id === editor.editingId.value,
      t, undefined, wiredTreatments.value, editor.background.value, editor.localGroups.value, editor.postEffects.value))
}

// ── Live animation loop ──────────────────────────────────────────────────────
// The Frame owns one master timeline derived from its live slots (longest duration,
// max fps), or the config override. Each animated slot plays at its native speed and
// loops within it. Runs a rAF loop only when a slot is actually animated OR a shader
// fill is actually live (speed !== 0) — otherwise the static watch-driven render below
// is unchanged, so a Frame with nothing time-dependent never pays for a rAF loop.
const MAX_LIVE_SLOTS = 8   // soft cap on concurrently-animated slots (perf bound)
const masterClock = computed(() => deriveMasterClock(
  [
    ...wiredLayers.value.filter(l => l.live).map(l => ({ duration: l.live!.duration, fps: l.live!.fps })),
    ...clipClocks(editor.localLayers.value),
  ],
  (props.data.properties as any)?.sailor_frame?.clock ?? null))
const hasAnimatedSlot = computed(() =>
  wiredLayers.value.some(l => l.live && l.live.duration > 0)
  || clipClocks(editor.localLayers.value).length > 0)
// A `speed: 0` shader fill must NOT start this loop (it's deliberately frozen); only a
// live (speed !== 0) fill counts. See `hasAnimatedShaderFill`'s doc for why this needs
// to be pure/shared rather than re-derived per host.
const hasAnimatedFill = computed(() => hasAnimatedShaderFill(buildStackItems(), editor.background.value))
const needsClock = computed(() => hasAnimatedSlot.value || hasAnimatedFill.value)
// Preview fps for a shader-fill-only Frame (no animated slot ⇒ no master clock fps).
// Matches the Space Type surface's default preview cadence — smooth, and far below a
// 120Hz repaint rate.
const SHADER_PREVIEW_FPS = 30
// Backing-store pixel budget for a LIVE composite when post-effects are on (see
// renderStack). ~0.64MP keeps a post-processed paint ≈6ms even on a large retina Frame;
// small Frames stay at full device resolution.
const LIVE_PREVIEW_MAXPX = 640_000
let animRaf = 0, animStart = 0, animInFlight = false, cappedWarned = false, lastRenderedFrame = -1
function animateFrame(ts: number) {
  if (!animStart) animStart = ts
  const mc = masterClock.value
  // Raw elapsed seconds — NOT wrapped to the master period. Each slot loops on its OWN
  // duration via slotPhase01's `% slotDuration`, so an endless live preview stays seamless
  // per slot. Wrapping by mc.duration here reset every slot whose duration didn't evenly
  // divide the master, yanking it back to phase 0 mid-loop once per master period (the
  // "scene resets every few seconds" jump). The bounded master clock is still the guard
  // below and drives the finite video export (renderCompositeAtTime), which must stay wrapped.
  // This SAME clock feeds shader fills (via renderStack(t)) so a fill and an animated
  // slot in the same Frame agree on what time it is — one clock, not two.
  const t = (ts - animStart) / 1000
  // Render at CONTENT fps, not display refresh rate. rAF fires once per repaint (up to
  // 120Hz on ProMotion), but a pull+device-res composite is expensive and the content
  // only has `fps` distinct frames — repainting the same frame 2-4× is the janky-preview
  // bug (same class the Space Type surface fixed in b5377cb1e). Skip any tick that maps
  // to the already-rendered frame index; edits still show within one frame.
  const previewFps = mc && mc.duration > 0 ? mc.fps : SHADER_PREVIEW_FPS
  const frameIdx = masterFrameIndex(t, previewFps)
  const frameChanged = frameIdx !== lastRenderedFrame
  // Two mutually-exclusive paths keyed on whether an animated slot exists, so the
  // frame-index bookkeeping belongs to exactly one path per tick.
  if (mc && mc.duration > 0) {
    // Animated-slot path OWNS the render; a live shader fill just rides along in
    // renderStack(t). getFrame is async — skip a tick rather than queue, so a slow slot
    // lowers the frame rate instead of piling up. Draws land in owned canvases; then
    // renderStack paints.
    if (!animInFlight && frameChanged) {
      lastRenderedFrame = frameIdx
      animInFlight = true
      let animated = wiredLayers.value.filter(l => l.live && l.live.duration > 0)
      if (animated.length > MAX_LIVE_SLOTS) {
        if (!cappedWarned) { console.warn(`[Frame] ${animated.length} animated slots > cap ${MAX_LIVE_SLOTS}; extras shown as stills`); cappedWarned = true }
        animated = animated.slice(0, MAX_LIVE_SLOTS)
      }
      Promise.all(animated.map(l => pullLiveFrame(l, slotPhase01(t, l.live!.duration))))
        .then(() => renderStack(t, true))
        .finally(() => { animInFlight = false })
    }
  } else if (hasAnimatedFill.value && frameChanged) {
    // No animated wired slot (mc idle), but a shader fill still needs a fresh paint to
    // advance — throttled to SHADER_PREVIEW_FPS, not the repaint rate. No async work here.
    lastRenderedFrame = frameIdx
    renderStack(t, true)
  }
  animRaf = requestAnimationFrame(animateFrame)
}
function startAnim() { cancelAnimationFrame(animRaf); animStart = 0; animInFlight = false; lastRenderedFrame = -1; if (needsClock.value && gateOk()) animRaf = requestAnimationFrame(animateFrame) }
function stopAnim() { cancelAnimationFrame(animRaf); animRaf = 0 }
// Pause the live loop whenever its frames can't be seen: the card scrolled out of the
// viewport, the tab hidden, or a fullscreen Compositor modal covering the canvas. The
// modal runs its OWN pull loop (CompositorModal's liveFrameTick), so an ungated card
// doubles every full-res WebGL readback + stack composite for pixels nobody sees —
// measured ~2× per-tick main-thread cost with one animated wired studio, which is what
// pushed a 60fps wired scene over the 16.7ms frame budget (the "janky playback" bug).
// Same gate pattern as SpaceTypeNode's applyGate. `editorOpen` tracks the ONE
// canonical canvas-occlusion signal (any fullscreen studio modal covering the
// canvas), so this Frame pauses behind every such modal — not just the Compositor.
const gate = { visible: true, tabActive: true, editorOpen: false, hovered: false }
function gateOk() { return gate.visible && gate.tabActive && !gate.editorOpen && gate.hovered }
// `gate`/`applyGate` above only pause the rAF loop. `renderStack`'s poster repaints
// are watch-driven (fire even with no loop running), so they need their own gate —
// see createOcclusionRepaintGate's doc comment for why.
const repaintGate = createOcclusionRepaintGate()
function applyGate() {
  const shouldRun = needsClock.value && gateOk()
  if (shouldRun && !animRaf) startAnim()
  else if (!shouldRun && animRaf) stopAnim()
}
watch(needsClock, applyGate)
// Hover-to-play: a canvas scene animates only while the pointer is over its card
// (gate.hovered). On leave, snap the composite back to its first frame (t=0) so the idle
// card shows a stable poster instead of freezing mid-motion. Nothing loops until hovered,
// so the whole canvas's ambient render load collapses to just the card you're pointing at.
function renderPosterFrame() {
  const animated = wiredLayers.value.filter(l => l.live && l.live.duration > 0).slice(0, MAX_LIVE_SLOTS)
  if (animated.length) Promise.all(animated.map(l => pullLiveFrame(l, 0))).then(() => renderStack(0)).catch(() => {})
  else renderStack(hasAnimatedFill.value ? 0 : undefined)
}
function onFrameHoverEnter() { gate.hovered = true; applyGate() }
function onFrameHoverLeave() { gate.hovered = false; applyGate(); renderPosterFrame() }
// Declared BEFORE the `{ immediate: true }` watch below — that watch's getter reads
// wiredTreatments during setup, so a later `const` would throw a TDZ ReferenceError
// (which cascaded into VueFlow and broke adding any node).
const wiredTreatments = computed(() => readWiredTreatments({ data: props.data }))
// Decoded per-slot visibility masks, kept in sync with `wiredTreatments`. Keyed
// by SLOT (0-based, matching `WiredLayer.slot` — persisted keys are `w:<slot+1>`,
// converted below), NOT by url: two slots can share the same baked `/view` url
// (or a live studio slot's synthetic `live:<slot>` url), and keying by url would
// let one slot's mask bleed onto another (or two masked slots collide
// nondeterministically). White = hidden, in the wired image's pixel space (see
// drawWiredImageLayer).
const wiredMasks = ref<Record<number, HTMLImageElement | null>>({})
watch(wiredTreatments, (tr) => {
  const liveSlots = new Set<number>()
  for (const [key, t] of Object.entries(tr)) {
    const m = /^w:(\d+)$/.exec(key); if (!m) continue
    const slot = Number(m[1]) - 1 // persisted keys are 1-based (layerN), same as resolveKey
    const maskUrl = (t as any).maskUrl as string | undefined
    if (!maskUrl) { if (wiredMasks.value[slot]) { const n = { ...wiredMasks.value }; delete n[slot]; wiredMasks.value = n } continue }
    liveSlots.add(slot)
    const cur = wiredMasks.value[slot]
    if (cur && cur.dataset.url === maskUrl) continue
    const im = new Image(); im.onload = () => { im.dataset.url = maskUrl; wiredMasks.value = { ...wiredMasks.value, [slot]: im }; renderStack() }
    im.src = maskUrl
  }
  // Prune cache entries whose treatment key vanished entirely (e.g. Clear mask
  // drops the `w:<slot+1>` entry rather than leaving maskUrl empty) — otherwise
  // the loop above never revisits that slot and a stale decoded mask lingers.
  const stale = Object.keys(wiredMasks.value).map(Number).filter(slot => !liveSlots.has(slot))
  if (stale.length) {
    const n = { ...wiredMasks.value }
    for (const slot of stale) delete n[slot]
    wiredMasks.value = n
    renderStack()
  }
}, { deep: true, immediate: true })
// ── Schema 2: a connected slot IS a layer ───────────────────────────────────
// Runs on every wiring change and self-no-ops once the frame is schema 2. It is
// deliberately skipped while NO slot is connected: stamping the schema then would
// freeze an empty frame whose edges simply hadn't been restored yet, and the fold
// would find nothing to fold.
const connectedSlotList = computed<number[]>(() => {
  const out: number[] = []
  for (let i = 0; i < 16; i++) if (slotConnected(i)) out.push(i)
  return out
})
function slotDimsMap(): Record<number, { w: number; h: number } | undefined> {
  const out: Record<number, { w: number; h: number } | undefined> = {}
  for (const s of connectedSlotList.value) out[s] = wiredDimsForSlot(s)
  return out
}
watch(() => connectedSlotList.value.join(','), () => {
  const slots = connectedSlotList.value
  if (slots.length) {
    migrateFrameToUnifiedLayers({ data: props.data as any, connectedSlots: [...slots] }, slotDimsMap())
  }
  // Edge lifecycle: a new edge mints a layer, a cut edge marks its layer
  // `unlinked` (never deletes it — placement, name, mask and z-position survive),
  // and re-wiring the same slot relinks it. No history step: this mirrors the
  // graph, and undoing it would only fight the graph on the next tick.
  const linked = syncWiredLayerLinks(editor.localLayers.value, slots)
  if (linked) {
    editor.commit(linked.layers)
    const last = linked.addedIds[linked.addedIds.length - 1]
    // A freshly-minted wired layer is always a `w <= 0` sentinel (no content has
    // resolved yet) — invisible and zero-size. Selecting it left the user staring
    // at nothing, and ⌘2 (zoom to selection) maxed out the zoom on a degenerate
    // box. Skip selection here; the layer becomes selectable once the finalizer
    // resolves its box from real content.
    const lastLayer = last ? linked.layers.find(l => l.id === last) : undefined
    if (last && editMode.value && lastLayer && !isWiredSentinel(lastLayer)) editor.selectLocal(last)
  }
}, { immediate: true })

/** Everything the reconciler needs to know about a slot's content this tick. */
function wiredContentInfo(slot: number) {
  const url = wiredUrlForSlot(slot)
  return { dims: wiredDimsForSlot(slot), depthKey: url && !url.startsWith('live:') ? url : undefined }
}
// First real content resolves the migration's `w <= 0` sentinels (preserving the
// surviving `layer{N}_scale`); every later content change refreshes the cached
// aspect + depth key so the write-through's fit can't drift after an upstream
// re-run. Committed WITHOUT recordHistory — reconciliation is bookkeeping, not an
// edit, and must never become a step the user has to undo through.
// The layer array is part of the key (via the sentinel set) so an undo that lands
// BACK on a sentinel re-finalizes instead of leaving the layer invisible until the
// next resize — see `wiredReconcileKey`.
watch(
  () => wiredReconcileKey(
    connectedSlotList.value, wiredContentInfo,
    { w: box.value.w, h: box.value.h },
    editor.localLayers.value,
  ),
  () => {
    const canvas = { w: box.value.w, h: box.value.h }
    const fin = finalizeWiredSentinels(editor.localLayers.value, props.data as any, canvas, wiredDimsForSlot)
    if (fin) editor.commit(fin)
    const rec = reconcileWiredContent(editor.localLayers.value, wiredContentInfo)
    if (rec) editor.commit(rec)
  },
  { immediate: true },
)

watch(
  () => [
    JSON.stringify(editor.localLayers.value), editor.editingId.value,
    box.value.w, box.value.h,
    JSON.stringify(wiredLayers.value), JSON.stringify(stackKeys.value),
    Object.keys(wiredImages.value).length,
    JSON.stringify([...hiddenWiredSet.value]),
    JSON.stringify(wiredTreatments.value),
    JSON.stringify(editor.background.value ?? null),
    JSON.stringify(editor.postEffects.value ?? []),
    JSON.stringify(editor.localGroups.value),
  ] as const,
  async () => {
    for (const l of editor.localLayers.value) if (l.kind === 'text') {
      const fam = (l as TextLayer).fontFamily
      if (libraryFamily(fam)) useLibraryFonts().ensure(fam)
      else ensureGoogleFont(fam)
    }
    await ensureLayerFonts(editor.localLayers.value, box.value.w)
    await ensureLayerImages(editor.localLayers.value)
    renderStack()
  },
  { immediate: true },
)
const hasAnyLayer = computed(() => wiredLayers.value.length > 0 || editor.localLayers.value.length > 0)

// ── Inline add-toolbar (image upload) ───────────────────────────────────────
const imageInputRef = ref<HTMLInputElement | null>(null)
function triggerAddImage() { imageInputRef.value?.click() }
async function onAddImageFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) { try { await editor.addImageFromFile(file) } catch (err) { console.error('[Frame] add image:', err) } }
}
const addMenuOpen = ref(false)
function onUploadChoice() { addMenuOpen.value = false; triggerAddImage() }
async function onPickCanvasImage(src: string) {
  addMenuOpen.value = false
  try { await editor.addImageFromCanvasSrc(src) } catch (err) { console.error('[Frame] add canvas image:', err) }
}

// ── Actions ──────────────────────────────────────────────────────────────────
function openEditor() { window.dispatchEvent(new CustomEvent('sailor:openCompositor', { detail: { nodeId: props.id } })) }
// Render the WYSIWYG stack (wired + local layers, in z-order) to an offscreen
// canvas at full output resolution. This is what the artboard shows — so Save
// matches the canvas exactly, including local shapes/text, with no dependency
// on a backend run having happened or the live-preview being fresh.
function exportCompositeCanvas(): HTMLCanvasElement | null {
  const keys = stackKeys.value
  if (!keys.length) return null
  const W = box.value.w, H = box.value.h
  if (!(W > 0 && H > 0)) return null
  // Target resolution: explicit artboard size, else bottom wired image's native
  // size, else a 4× upscale of the display box.
  let outW = frameW.value, outH = frameH.value
  if (!(outW > 0 && outH > 0)) {
    const base = wiredLayers.value[0]
    const d = base ? wiredDims.value[base.url] : undefined
    if (d && d.w && d.h) { outW = d.w; outH = d.h }
    else { outW = W * 4; outH = H * 4 }
  }
  const sx = outW / W, sy = outH / H
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(W * sx))
  cv.height = Math.max(1, Math.round(H * sy))
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.scale(sx, sy)  // draw in logical box coords; output is full resolution
  // Route through the same masked renderer as the preview (no editing-skip — an
  // export includes every visible layer), so silhouette masks apply on download.
  // bake=true (Task 10): full-res download/publish, not the live preview — shader-fill
  // fields must render unclamped and stay live past LIVE_FIELD_CEILING.
  withWiredContent(wiredContentForSlot, () =>
    paintLayerStack(ctx, W, H, buildStackItems(), editor.localLayers.value,
      undefined, undefined, undefined, wiredTreatments.value, editor.background.value, editor.localGroups.value, editor.postEffects.value, true))
  return cv
}

// Headless full-res composite for the studio render cascade — reuses the faithful
// WYSIWYG export (wired + local layers + masks). The Frame is its own output, so the
// cascade publishes this back onto the Frame's data.images (see publishStudioOutput).
async function bakeOutput(): Promise<Blob | null> {
  const cv = exportCompositeCanvas()
  if (!cv) return null
  return await new Promise<Blob | null>(res => cv.toBlob(b => res(b), 'image/png'))
}
// CRITICAL 1 fix (final review): a shader fill in a static (no live/animated slot) Frame
// only ever gets ONE renderStack() call — the `{ immediate: true }` watch above, which runs
// at mount time. Nothing else re-renders this canvas afterward. If that first paintLayerStack
// call raced `resolveField`'s catalog fetch (the normal case on a fresh reload — see
// field.ts's doc), the fill fell back to its input gradient FOREVER: no node card, and no
// Compositor render path, ever called `fetchShaderFxCatalog()` itself. field.ts now kicks that
// fetch on every miss, but a host with no per-frame loop still needs an explicit nudge to
// re-render once it lands — this is that nudge, for exactly this host.
const unsubFieldCatalog = onFieldCatalogReady(() => renderStack())
const rootEl = ref<HTMLElement | null>(null)
let gateIo: IntersectionObserver | null = null
let onGateVisibility: (() => void) | null = null
let unsubOcclusion: (() => void) | null = null
onMounted(() => {
  registerStudioBaker(props.id, bakeOutput)
  gateIo = new IntersectionObserver(([entry]) => { gate.visible = !!entry?.isIntersecting; applyGate() }, { threshold: 0.01 })
  if (rootEl.value) gateIo.observe(rootEl.value)
  onGateVisibility = () => { gate.tabActive = !document.hidden; applyGate() }
  document.addEventListener('visibilitychange', onGateVisibility)
  // One canonical signal for "a fullscreen studio modal now covers the canvas" (any of
  // ~20 studios, not just the Compositor/Space Type). Without this the Frame keeps
  // rendering the wired scene behind the modal, and that per-frame render competes with
  // the studio preview for the main thread (measured ~13fps). Fires immediately with the
  // current state, so a Frame dropped onto the canvas mid-modal starts out paused.
  unsubOcclusion = onCanvasOcclusion((open) => {
    gate.editorOpen = open
    applyGate()
    if (repaintGate.setOccluded(open)) renderPosterFrame()
  })
  applyGate()
})
onBeforeUnmount(() => {
  unregisterStudioBaker(props.id); stopAnim(); unsubFieldCatalog()
  gateIo?.disconnect(); gateIo = null
  if (onGateVisibility) document.removeEventListener('visibilitychange', onGateVisibility)
  unsubOcclusion?.()
})

// Record the baked composite as a project asset so saved frames show up in the
// Assets panel — same treatment as generator outputs. Best-effort: never blocks
// or breaks the local download.
const { recordAsset } = useProjectGenerations()
const { activeTab } = useTabs()
async function recordFrameToAssets(blob: Blob) {
  try {
    const { uploadFrameBatch } = await import('~/lib/studio/frameUpload')
    const [filename] = await uploadFrameBatch([blob], 'frame')
    if (filename) await recordAsset(activeTab.value?.projectUuid, 'image', filename)
  } catch (err) {
    console.warn('[Frame] record to Assets failed:', err)
  }
}

// Composite the full stack at master time `t` (seconds): pull every animated slot to
// its phase for `t`, then paint. Used by the video export so each baked frame reflects
// that instant of the animation.
async function renderCompositeAtTime(t: number): Promise<HTMLCanvasElement | null> {
  const animated = wiredLayers.value.filter(l => l.live && l.live.duration > 0)
  await Promise.all(animated.map(l => pullLiveFrame(l, slotPhase01(t, l.live!.duration))))
  return exportCompositeCanvas()
}

// Export an animated Frame as an mp4 (reuses the studios' bake→encode pipeline). Renders
// N frames over the master clock, encodes server-side, downloads the file, and records it
// to Assets. The live preview loop is paused during the bake so it can't interleave pulls.
async function downloadVideo() {
  const mc = masterClock.value
  if (!mc || mc.duration <= 0) return
  stopAnim()
  try {
    const first = await renderCompositeAtTime(0)
    if (!first) return
    const W = first.width, H = first.height
    const total = Math.max(1, Math.round(mc.fps * mc.duration))
    const { ensureSpaceTypeBake } = await import('~/lib/spacetype/bake')
    const bakeCfg = { fps: mc.fps, loopDuration: mc.duration, W, H, seed: 'frame', sig: JSON.stringify({ id: props.id, n: total, w: W, h: H }) }
    const bake = await ensureSpaceTypeBake(bakeCfg as any, undefined, {
      renderFrame: async (i) => {
        const cv = await renderCompositeAtTime(i / mc.fps)
        return await new Promise<Blob>((res, rej) => cv ? cv.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png') : rej(new Error('no composite')))
      },
    })
    let encoded: Awaited<ReturnType<typeof encodeFrames>>
    try {
      encoded = await encodeFrames({ frames: bake.frames, fps: mc.fps, width: W, height: H, alpha: !hasPaint(editor.background.value) })
    } catch (err) {
      console.error('[Frame] video encode failed', err)
      return
    }
    await recordAsset(activeTab.value?.projectUuid, 'video', encoded.filename)
    const vres = await fetch(`/view?${new URLSearchParams({ filename: encoded.filename, type: 'input' })}`)
    const blob = await vres.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = obj; a.download = `frame-${props.id}.${encoded.ext}`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(obj)
  } catch (err) { console.error('[Frame] video export failed:', err) }
  finally { applyGate() }
}

async function downloadImage() {
  // An animated Frame downloads as a video over its master clock.
  if (hasAnimatedSlot.value) { await downloadVideo(); return }
  const triggerDownload = (obj: string) => {
    const a = document.createElement('a'); a.href = obj; a.download = `frame-${props.id}.png`
    document.body.appendChild(a); a.click(); a.remove()
  }
  // Prefer the live WYSIWYG composite so Save matches the artboard exactly.
  try {
    const cv = exportCompositeCanvas()
    if (cv) {
      const blob: Blob | null = await new Promise(res => cv.toBlob(res, 'image/png'))
      if (blob) {
        const obj = URL.createObjectURL(blob)
        triggerDownload(obj); URL.revokeObjectURL(obj)
        void recordFrameToAssets(blob)
        return
      }
    }
  } catch (err) {
    // A tainted canvas (cross-origin wired image without CORS) blocks toBlob —
    // fall through to the backend composite below.
    console.warn('[Frame] client composite export failed, using backend output:', err)
  }
  // Fallback: the backend composite output, if any.
  const url = compositeUrl.value
  if (!url) return
  try {
    const res = await fetch(url); const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    triggerDownload(obj); URL.revokeObjectURL(obj)
    void recordFrameToAssets(blob)
  } catch (err) { console.error('[Frame] download failed:', err) }
}

const dragOver = ref(false)
function onDragOver(e: DragEvent) { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); dragOver.value = true } }
function onDragLeave() { dragOver.value = false }
function onDrop(e: DragEvent) {
  if (!e.dataTransfer?.files?.length) return
  e.preventDefault(); dragOver.value = false
  window.dispatchEvent(new CustomEvent('sailor:frameDropImage', { detail: { nodeId: props.id, files: e.dataTransfer.files } }))
}

function onKeydown(e: KeyboardEvent) {
  if (!editMode.value) return
  const ae = document.activeElement
  // Where the key was actually pressed, not only where focus is NOW: the inline
  // textarea's own Escape handler ends the edit, Vue unmounts the textarea in the
  // microtask before this window listener runs, and focus has already fallen back
  // to <body> by then. `e.target` still names the box the key was typed into.
  const tgt = e.target as Element | null
  const typing = (tgt instanceof Element && !!tgt.closest('input, textarea, [contenteditable]'))
    || (ae instanceof Element && ae.matches('input, textarea, [contenteditable]'))
  if (e.key === 'Escape') {
    if (addMenuOpen.value) { addMenuOpen.value = false; return }
    if (editor.editingId.value) { editor.endEdit(); return }
    // Escape #1 leaves the text box, Escape #2 leaves edit mode — without this
    // guard the textarea's own handler and this one would fire as one gesture
    // and drop the whole card out of edit mode.
    if (typing) return
    exitEdit()
  }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selectedId.value && !typing) {
    e.preventDefault(); editor.deleteLocal(editor.selectedId.value)
  }
}
// ── Floating inline toolbar — screen-space, tracks the active selection ──────
// One selection, so one branch: whatever the editor has selected, wired layers
// included (their opacity/blend live on the layer and write through to the slot
// widgets like every other edit).
function blendOf(slot: number): string {
  const i = widgetIdx(`layer${slot + 1}_blend`)
  return i >= 0 ? String(props.data.widgetsValues?.[i] ?? 'normal') : 'normal'
}
const toolbarLayer = computed<any>(() => editor.selected.value ?? null)
function onToolbarSet(patch: Record<string, any>) {
  if (editor.selectedId.value) editor.setLocal(editor.selectedId.value, patch)
}

const toolbarPos = ref<{ left: number; top: number; below: boolean } | null>(null)
let toolbarRaf = 0
function updateToolbarPos() {
  const r = artboardRef.value?.getBoundingClientRect()
  if (!editMode.value || !r) { toolbarPos.value = null; return }
  const zoom = box.value.w ? r.width / box.value.w : 1
  let cx: number, cy: number, halfH: number
  const l = editor.selected.value
  if (l) {
    cx = r.left + l.x * r.width
    cy = r.top + l.y * r.height
    halfH = (editor.boxPx(l).h / 2) * zoom
  } else { toolbarPos.value = null; return }
  const aboveTop = cy - halfH - 12
  const below = aboveTop < 52
  toolbarPos.value = { left: cx, top: below ? cy + halfH + 12 : aboveTop, below }
}
function toolbarTick() { updateToolbarPos(); toolbarRaf = requestAnimationFrame(toolbarTick) }
watch(() => editMode.value && editor.selectedId.value != null, (on) => {
  cancelAnimationFrame(toolbarRaf)
  if (on) toolbarTick()
  else toolbarPos.value = null
}, { immediate: true })
const toolbarStyle = computed(() => {
  const p = toolbarPos.value
  if (!p) return {}
  return {
    position: 'fixed', left: p.left + 'px', top: p.top + 'px',
    transform: p.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
    zIndex: 60,
  } as any
})

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointermove', onResizeMove)
  cancelAnimationFrame(toolbarRaf)
})
</script>

<template>
  <div
    ref="rootEl"
    class="artifact-frame-node relative select-none"
    :class="{ 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed }"
    :style="{ width: box.w + 'px', '--port-color': imageColor } as any"
    :data-running="data.running || undefined"
    @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
    @pointerenter="onFrameHoverEnter" @pointerleave="onFrameHoverLeave"
  >
    <VueCanvasNodeReadyBadge :node-id="id" />
    <Handle
      v-for="(slot, i) in layerSlots" :key="slot" :id="`input-${slot}`"
      type="target" :position="Position.Left"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: imageColor, top: handleTop(i) }"
    />
    <Handle
      :id="`output-${imageOutIdx}`" type="source" :position="Position.Right"
      class="!w-3 !h-3 !rounded-full !border-2 !bg-[#1a1a1a]"
      :style="{ borderColor: imageColor, top: '50%' }"
    />

    <div
      class="frame-shell rounded-lg overflow-hidden bg-[#0e0e0e] border"
      :class="data.error ? 'border-red-500 ring-2 ring-red-500' : editMode ? 'border-cyan-400/70 ring-2 ring-cyan-400/40' : 'border-white/10'"
    >
      <!-- Header: title + dimensions -->
      <div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5">
        <FrameIcon class="size-3 text-white/45 shrink-0" />
        <select
          class="nopan nodrag bg-transparent text-[10.5px] text-white/70 outline-none cursor-pointer hover:text-white/90 max-w-[120px]"
          :value="activePresetId" @change="onPresetChange"
        >
          <option value="" disabled hidden>Size…</option>
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
          <option value="responsive">Responsive</option>
          <option value="custom" disabled hidden>Custom</option>
        </select>
        <span class="flex-1" />
        <span
          v-if="masterClock && masterClock.duration > 0"
          class="flex items-center gap-0.5 text-[10px] text-white/40 tabular-nums whitespace-nowrap shrink-0"
          :title="`Loops every ${Math.round(masterClock.duration)}s${masterClock.capped ? ' (capped)' : ''}`"
        >⟲ {{ Math.round(masterClock.duration) }}s<span v-if="masterClock.capped" class="text-amber-400">!</span></span>
        <span class="text-[10px] uppercase tracking-wide text-white/40 shrink-0">{{ isResponsive ? 'Designed at' : 'Size' }}</span>
        <div class="flex items-center gap-1 text-[10px] text-white/40 tabular-nums">
          <input type="number" min="0" :value="frameW || ''" placeholder="W"
            class="nopan nodrag w-14 bg-white/[0.04] rounded px-1.5 py-0.5 text-right text-white/70 outline-none focus:bg-white/[0.08] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @change="setDim('width', $event)" />
          <span>×</span>
          <input type="number" min="0" :value="frameH || ''" placeholder="H"
            class="nopan nodrag w-14 bg-white/[0.04] rounded px-1.5 py-0.5 text-right text-white/70 outline-none focus:bg-white/[0.08] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @change="setDim('height', $event)" />
        </div>
        <button class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/40 hover:text-white/85 hover:bg-white/[0.08] cursor-pointer disabled:opacity-40" :disabled="!hasAnyLayer && !compositeUrl" title="Download" @click.stop="downloadImage"><Download class="size-3" /></button>
      </div>

      <!-- Artboard -->
      <div
        ref="artboardRef"
        class="artboard group relative bg-checker overflow-hidden"
        :class="editMode ? 'nopan nodrag cursor-default' : 'cursor-pointer'"
        :style="{ width: box.w + 'px', height: box.h + 'px' }"
        @dblclick.capture="onArtboardDblClick"
        @pointerdown.capture="onArtboardPointerDown"
      >
        <canvas ref="stackCanvas" data-testid="frame-card-stack-canvas" class="absolute inset-0 pointer-events-none" :style="{ width: box.w + 'px', height: box.h + 'px' }" />

        <!-- Grid overlay — editor guide only. Gated on edit mode + grid config;
             lives entirely outside the paint/export/bake path (see gridConfig
             above), so it can never appear in a rendered frame. -->
        <svg
          v-if="showGridOverlay"
          data-testid="frame-card-grid-overlay"
          class="absolute inset-0 pointer-events-none"
          :width="box.w" :height="box.h" :viewBox="`0 0 ${box.w} ${box.h}`"
        >
          <rect
            v-for="(r, i) in gridResolved.regions" :key="'region-' + i"
            :x="r.x" :y="r.y" :width="r.w" :height="r.h"
            fill="#22d3ee" fill-opacity="0.05" stroke="none"
          />
          <line
            v-for="(x, i) in gridResolved.xs" :key="'x-' + i"
            :x1="x" :y1="0" :x2="x" :y2="box.h"
            stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"
          />
          <line
            v-for="(y, i) in gridResolved.ys" :key="'y-' + i"
            :x1="0" :y1="y" :x2="box.w" :y2="y"
            stroke="#22d3ee" stroke-opacity="0.35" stroke-width="1" vector-effect="non-scaling-stroke"
          />
        </svg>

        <!-- Quick inline edit — appears over the preview on hover -->
        <button v-if="!editMode" class="nopan nodrag absolute left-2 top-2 z-10 h-6 px-2 rounded flex items-center gap-1 text-[10px] bg-black/55 backdrop-blur-sm text-white/85 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/75 cursor-pointer"
          title="Edit directly on the canvas" @pointerdown.stop @click.stop="toggleEdit">
          <MousePointer2 class="size-2.5" /> Edit here
        </button>

        <div v-if="!hasAnyLayer" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/35 pointer-events-none">
          <ImagePlus class="size-7" :stroke-width="1.5" />
          <span class="text-[11px]">Empty frame</span>
          <span class="text-[10px] text-white/25">Wire or drop images · double-click to edit</span>
        </div>

        <!-- Local-layer selection (cyan = overlay layer) -->
        <template v-if="editMode && editor.handlePositions.value">
          <svg class="absolute inset-0 w-full h-full pointer-events-none" :viewBox="`0 0 ${box.w} ${box.h}`">
            <polygon
              :points="`${editor.handlePositions.value.tl.x},${editor.handlePositions.value.tl.y} ${editor.handlePositions.value.tr.x},${editor.handlePositions.value.tr.y} ${editor.handlePositions.value.br.x},${editor.handlePositions.value.br.y} ${editor.handlePositions.value.bl.x},${editor.handlePositions.value.bl.y}`"
              fill="none" stroke="#22d3ee" stroke-width="1.5" vector-effect="non-scaling-stroke" />
            <line :x1="editor.handlePositions.value.topCenter.x" :y1="editor.handlePositions.value.topCenter.y" :x2="editor.handlePositions.value.rot.x" :y2="editor.handlePositions.value.rot.y" stroke="#22d3ee" stroke-width="1.5" vector-effect="non-scaling-stroke" />
          </svg>
          <!-- Wired layers take the ANCHORED corner resize (grabbed corner follows,
               opposite corner pinned, aspect locked); everything else keeps this
               card's uniform-from-centre scale. -->
          <div v-for="corner in (['tl', 'tr', 'br', 'bl'] as const)" :key="'h-' + corner" data-handle
            class="nopan nodrag absolute size-2.5 bg-white border border-cyan-400 cursor-nwse-resize"
            :style="{ left: (editor.handlePositions.value as any)[corner].x + 'px', top: (editor.handlePositions.value as any)[corner].y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="selectedCornerAnchored ? editor.startResize(corner, $event) : editor.startScale($event)" />
          <div data-handle class="nopan nodrag absolute size-3 rounded-full bg-cyan-400 cursor-grab border-2 border-[#0e0e0e]"
            :style="{ left: editor.handlePositions.value.rot.x + 'px', top: editor.handlePositions.value.rot.y + 'px', transform: 'translate(-50%, -50%)' }"
            @pointerdown="editor.startRotate($event)" />
          <!-- Unlinked: the slot's edge is gone, so the layer keeps its last size
               and placement but has no pixels. Say so on the selection itself —
               an empty box with handles otherwise reads as a bug. -->
          <div v-if="selectedUnlinkedWired"
            class="absolute z-20 pointer-events-none rounded px-1 py-px text-[8px] uppercase tracking-wide bg-amber-400/20 text-amber-200 border border-amber-400/40 whitespace-nowrap"
            :style="{ left: editor.handlePositions.value.topCenter.x + 'px', top: (editor.handlePositions.value.topCenter.y - 14) + 'px', transform: 'translate(-50%, -100%)' }"
          >unlinked</div>
        </template>

        <!-- Inline text editor -->
        <textarea v-if="editMode && editor.editingLayer.value" ref="editRef" data-testid="frame-card-text-edit" :value="editor.editingLayer.value.text"
          class="nopan nodrag absolute bg-transparent outline-none resize-none overflow-hidden border border-dashed border-cyan-400/70 px-0.5"
          :style="editingStyle"
          @input="editor.setLocal(editor.editingLayer.value!.id, { text: ($event.target as HTMLTextAreaElement).value })"
          @blur="editor.endEdit()" @keydown.escape.prevent="editor.endEdit()" @pointerdown.stop />
      </div>

      <!-- Inline edit toolbar -->
      <div v-if="editMode" class="flex items-center gap-0.5 px-1.5 py-1 border-t border-white/5 bg-cyan-400/[0.04]">
        <button class="nopan nodrag size-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10" title="Add text" @click="editor.addText()"><Type class="size-3" /></button>
        <button class="nopan nodrag size-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10" title="Add rectangle" @click="editor.addRect()"><Square class="size-3" /></button>
        <button class="nopan nodrag size-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10" title="Add ellipse" @click="editor.addEllipse()"><Circle class="size-3" /></button>
        <button class="nopan nodrag size-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10" title="Add line" @click="editor.addLine()"><Minus class="size-3" /></button>
        <div class="relative inline-flex">
          <button class="nopan nodrag size-6 rounded flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10" title="Add image" @click="addMenuOpen = !addMenuOpen"><ImagePlus class="size-3" /></button>
          <AddImageSourcePopover :open="addMenuOpen" @upload="onUploadChoice" @pick="onPickCanvasImage" @close="addMenuOpen = false" />
        </div>
        <input ref="imageInputRef" type="file" accept="image/*" class="hidden" @change="onAddImageFile" />
        <BrandImagePicker @add="(name, aspect) => editor.addImageFromName(name, aspect)" />
        <span class="w-px h-4 bg-white/10 mx-0.5" />
        <button v-if="editor.selectedId.value" class="nopan nodrag size-6 rounded flex items-center justify-center text-white/50 hover:text-rose-300 hover:bg-rose-500/10" title="Delete layer" @click="editor.deleteLocal(editor.selectedId.value)"><Trash2 class="size-3" /></button>
        <span class="flex-1" />
        <button class="nopan nodrag h-6 px-2 rounded flex items-center gap-1 text-[10px] text-cyan-300 hover:bg-cyan-400/10" title="Done editing" @click="exitEdit"><Check class="size-3" /> Done</button>
      </div>

      <!-- Footer: Edit (opens the modal) + Render, like the studios -->
      <div v-else class="flex items-center gap-1.5 px-2 py-2 border-t border-white/5">
        <button class="nopan nodrag flex flex-1 items-center justify-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-[11px] text-white/80 transition hover:bg-white/20 cursor-pointer" title="Open the full editor" @click.stop="openEditor">
          <Pencil class="h-3 w-3" /> Edit
        </button>
        <StudioRenderButton class="flex-1" :node-id="id" :busy="!!data?.studioBusy || !!data?.running" />
      </div>
    </div>

    <!-- Corner resize grip — sets the on-canvas display size (not output res) -->
    <div
      class="nopan nodrag absolute -bottom-1.5 -right-1.5 size-4 cursor-nwse-resize group/resize"
      title="Resize frame (display size)"
      @pointerdown="onResizeDown"
    >
      <div class="absolute bottom-1 right-1 size-2 border-b-2 border-r-2 border-white/30 group-hover/resize:border-cyan-400 rounded-[1px]" />
    </div>

    <!-- Floating contextual toolbar (screen-space, above the selected layer) -->
    <Teleport to="body">
      <CompositorInlineToolbar
        v-if="toolbarPos && editMode && toolbarLayer"
        :layer="toolbarLayer"
        :px-base="frameW || box.w"
        :style="toolbarStyle"
        @set="onToolbarSet"
        @movez="moveSelectedZ"
        @remove="() => editor.selectedId.value && editor.deleteLocal(editor.selectedId.value)"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.frame-shell { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.2); }
.artifact-frame-node[data-running] .frame-shell { box-shadow: 0 0 0 2px var(--port-color, #fff), 0 4px 16px rgba(0, 0, 0, 0.4); }
.bg-checker {
  background-color: #141414;
  background-image:
    linear-gradient(45deg, #1c1c1c 25%, transparent 25%),
    linear-gradient(-45deg, #1c1c1c 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1c1c1c 75%),
    linear-gradient(-45deg, transparent 75%, #1c1c1c 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
