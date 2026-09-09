<script setup lang="ts">
/**
 * Product Shot app — a 3-step studio pipeline (no canvas, no nodes):
 *
 *   1. Background  — generate one with Flux, or upload your own.
 *   2. Object      — upload a product; we remove its background (local, free
 *                    BackgroundRemove) and you drag / resize the cutout onto
 *                    the backdrop.
 *   3. Lighting    — describe the light; we flatten the composite + a keep-mask
 *                    client-side and run BlendScene (Flux Kontext / Nano Banana)
 *                    to relight and add contact shadows, keeping the product
 *                    pixel-exact via ImageToMask → keep_subject.
 *
 * Each step submits its own tiny prompt graph to /prompt and polls /history.
 */
import { ArrowRight, Bookmark, Check, Copy, Download, Image as ImageIcon, Loader2, RefreshCcw, Sparkles, Upload, X } from 'lucide-vue-next'
import TakesStrip from '~/components/vue-canvas/TakesStrip.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

type Step = 1 | 2 | 3
const step = ref<Step>(1)

// ---- shared helpers -------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A fresh seed per run so ComfyUI never treats an identical re-run as a cache
// hit (a cached prompt finishes "successfully" but emits no outputs).
const randomSeed = () => Math.floor(Math.random() * 2_000_000_000) + 1

async function uploadBlob(blob: Blob, filename: string): Promise<string> {
  // Unique name per upload so LoadImage inputs differ across runs (avoids the
  // same cache-hit-with-empty-outputs trap for the removal / blend steps).
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${filename}`
  const fd = new FormData()
  fd.append('image', blob, unique)
  fd.append('overwrite', 'true')
  const res = await fetch('/upload/image', { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  const data = await res.json()
  return data?.name ?? unique
}

async function submit(prompt: Record<string, any>): Promise<string> {
  const res = await fetch('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error((await res.text()) || `Comfy returned ${res.status}`)
  const data = await res.json()
  if (!data?.prompt_id) throw new Error('No prompt_id — is ComfyUI running on port 8188?')
  return data.prompt_id
}

async function pollHistory(promptId: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(700)
    try {
      const r = await fetch(`/history/${promptId}`)
      if (!r.ok) continue
      const entry = (await r.json())?.[promptId]
      if (!entry) continue
      if (entry?.status?.status_str === 'error') throw new Error(extractComfyError(entry))
      if (entry?.outputs) return entry.outputs
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Comfy:')) throw e
    }
  }
  throw new Error('Timed out waiting for the result.')
}

function pickImage(
  outputs: Record<string, any>,
  opts: { nodeId?: string; preferType?: string } = {},
): { filename: string; subfolder: string; type: string } | null {
  const nodes = opts.nodeId ? [outputs[opts.nodeId]].filter(Boolean) : Object.values(outputs)
  let fallback: any = null
  for (const node of nodes as any[]) {
    const imgs = node?.images
    if (!Array.isArray(imgs) || !imgs.length) continue
    if (opts.preferType) {
      const m = imgs.find((i: any) => i.type === opts.preferType)
      if (m) return m
    }
    fallback ??= imgs[0]
  }
  return fallback
}

// Sailor's SaveImage requires the full export-param set (not just images +
// filename_prefix like stock ComfyUI), so supply sane defaults every time.
function saveImageInputs(images: [string, number], prefix: string) {
  return {
    images,
    filename_prefix: prefix,
    format: 'png',
    quality: 90,
    lossless_webp: false,
    png_compression: 4,
    scale: 1.0,
    max_dimension: 0,
    embed_metadata: true,
  }
}

function viewUrl(img: { filename: string; subfolder: string; type: string }): string {
  return `/view?${new URLSearchParams({
    filename: img.filename,
    type: img.type,
    ...(img.subfolder ? { subfolder: img.subfolder } : {}),
    t: String(Date.now()),
  })}`
}

function extractComfyError(entry: any): string {
  const msg = (entry?.status?.messages ?? []).find((m: any) => m[0] === 'execution_error')?.[1]
  return msg?.exception_message ? `Comfy: ${msg.exception_message}` : 'Comfy: execution failed.'
}

function humanizeError(msg: string): string {
  if (msg.includes('ISNet model not found')) {
    return 'The background-remover model isn’t installed yet. Open a canvas, find “Background Remove” in the toolbox, and click it to download (~179 MB), then try again.'
  }
  if (msg.includes('REPLICATE_API_TOKEN') || /token/i.test(msg)) {
    return 'Replicate API token missing. Paste it in Settings → AI.'
  }
  return msg
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

const error = ref<string | null>(null)
const busy = ref(false)
const progress = ref('')

// =========================================================================
// Step 1 — Background
// =========================================================================

const bgMode = ref<'generate' | 'upload'>('generate')
const bgPrompt = ref('')
const bgAspect = ref<'1:1' | '4:5' | '3:2'>('1:1')
const bgUrl = ref<string | null>(null)        // displayable URL of the chosen background
const bgDims = ref<{ w: number; h: number } | null>(null)
// Server-side reference to the background file (input/output type), so a saved
// look can rebuild the exact same backdrop even after a page reload.
const bgRef = ref<{ filename: string; subfolder: string; type: string } | null>(null)

const BG_PRESETS = [
  'clean white marble countertop, soft window light, minimal studio',
  'warm wooden table, cozy morning sunlight',
  'smooth pastel gradient backdrop, soft even studio light',
  'concrete pedestal, dark moody background, dramatic light',
  'lush green leaves and plants, dappled natural light',
]
const BG_ASPECTS: { id: '1:1' | '4:5' | '3:2'; label: string }[] = [
  { id: '1:1', label: 'Square' },
  { id: '4:5', label: 'Portrait' },
  { id: '3:2', label: 'Landscape' },
]

async function setBackgroundFromRef(ref: { filename: string; subfolder: string; type: string }) {
  const url = viewUrl(ref)
  const img = await loadImage(url)
  bgDims.value = { w: img.naturalWidth, h: img.naturalHeight }
  bgRef.value = ref
  bgUrl.value = url
}

async function generateBackground() {
  if (busy.value) return
  error.value = null; busy.value = true; progress.value = 'Generating background…'
  try {
    const prompt = (bgPrompt.value || '').trim() || BG_PRESETS[0]!
    const promptId = await submit({
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt, aspect_ratio: bgAspect.value, seed: randomSeed(), model_options: '{}' } },
      '2': { class_type: 'SaveImage', inputs: saveImageInputs(['1', 0], 'product_bg') },
    })
    const out = pickImage(await pollHistory(promptId), { preferType: 'output' })
    if (!out) throw new Error('Background generation produced no image.')
    await setBackgroundFromRef(out)
  } catch (e: any) {
    error.value = humanizeError(e?.message ?? String(e))
  } finally {
    busy.value = false
  }
}

const bgInputRef = ref<HTMLInputElement | null>(null)
async function uploadBackground(file: File | null | undefined) {
  if (!file) return
  error.value = null; busy.value = true; progress.value = 'Uploading background…'
  try {
    // Upload to the server so the background is a durable file (survives reload
    // and can be re-referenced by a saved look), not an ephemeral blob URL.
    const name = await uploadBlob(file, file.name)
    await setBackgroundFromRef({ filename: name, subfolder: '', type: 'input' })
  } catch (e: any) {
    error.value = humanizeError(e?.message ?? String(e))
  } finally {
    busy.value = false
  }
}

// =========================================================================
// Step 2 — Object (upload + background removal + placement)
// =========================================================================

const productInputRef = ref<HTMLInputElement | null>(null)
const cutoutUrl = ref<string | null>(null)     // transparent PNG of the product
const cutoutDims = ref<{ w: number; h: number } | null>(null)
// Placement, expressed in BACKGROUND-NATIVE pixels.
const placement = reactive({ x: 0, y: 0, w: 0, h: 0 })

// A *relative* placement (center + width as fractions of the background) captured
// from one product and re-applied to the next — so a reused "look" reproduces the
// same composition regardless of the new product's pixel dimensions.
const pendingPlacement = ref<{ cx: number; cy: number; wFrac: number } | null>(null)
function currentRelPlacement() {
  const bg = bgDims.value!
  return {
    cx: (placement.x + placement.w / 2) / bg.w,
    cy: (placement.y + placement.h / 2) / bg.h,
    wFrac: placement.w / bg.w,
  }
}
function applyRelPlacement(rel: { cx: number; cy: number; wFrac: number }) {
  const bg = bgDims.value!, cd = cutoutDims.value!
  const w = rel.wFrac * bg.w
  const h = w / (cd.w / cd.h)
  placement.w = w; placement.h = h
  placement.x = rel.cx * bg.w - w / 2
  placement.y = rel.cy * bg.h - h / 2
}

async function uploadAndCutout(file: File | null | undefined) {
  if (!file || !bgDims.value) return
  error.value = null; busy.value = true; progress.value = 'Removing background…'
  try {
    const productName = await uploadBlob(file, file.name)
    const promptId = await submit({
      '1': { class_type: 'LoadImage', inputs: { image: productName } },
      '2': { class_type: 'BackgroundRemove', inputs: { frames: ['1', 0], output: 'transparent', edge_softness: 1.5 } },
    })
    const out = pickImage(await pollHistory(promptId), { nodeId: '2' })
    if (!out) throw new Error('Background removal produced no image.')
    const url = viewUrl(out)
    const img = await loadImage(url)
    cutoutDims.value = { w: img.naturalWidth, h: img.naturalHeight }
    cutoutUrl.value = url
    // Reuse a saved look's composition when we have one; otherwise center at ~45%.
    if (pendingPlacement.value) {
      applyRelPlacement(pendingPlacement.value)
    } else {
      const bg = bgDims.value
      const targetW = bg.w * 0.45
      const scale = targetW / img.naturalWidth
      placement.w = targetW
      placement.h = img.naturalHeight * scale
      placement.x = (bg.w - placement.w) / 2
      placement.y = (bg.h - placement.h) / 2
    }
  } catch (e: any) {
    error.value = humanizeError(e?.message ?? String(e))
  } finally {
    busy.value = false
  }
}

// ---- drag & resize over the preview --------------------------------------

const stageRef = ref<HTMLDivElement | null>(null)
// Display size of the background inside the preview (fit into a max box).
const displaySize = computed(() => {
  if (!bgDims.value) return { w: 0, h: 0, scale: 1 }
  const maxW = 680, maxH = 560
  const { w, h } = bgDims.value
  const scale = Math.min(maxW / w, maxH / h, 1)
  return { w: w * scale, h: h * scale, scale }
})
// Cutout rect in DISPLAY px.
const cutoutStyle = computed(() => {
  const s = displaySize.value.scale
  return {
    left: `${placement.x * s}px`,
    top: `${placement.y * s}px`,
    width: `${placement.w * s}px`,
    height: `${placement.h * s}px`,
  }
})

let drag: { mode: 'move' | 'resize'; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null = null
function onPointerDown(mode: 'move' | 'resize', e: PointerEvent) {
  e.preventDefault(); e.stopPropagation()
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  drag = { mode, sx: e.clientX, sy: e.clientY, ox: placement.x, oy: placement.y, ow: placement.w, oh: placement.h }
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return
  const s = displaySize.value.scale || 1
  const dx = (e.clientX - drag.sx) / s
  const dy = (e.clientY - drag.sy) / s
  if (drag.mode === 'move') {
    placement.x = drag.ox + dx
    placement.y = drag.oy + dy
  } else {
    const aspect = drag.ow / drag.oh
    const newW = Math.max(24, drag.ow + dx)
    placement.w = newW
    placement.h = newW / aspect
  }
}
function onPointerUp() { drag = null }

// =========================================================================
// Step 3 — Lighting & blend
// =========================================================================

const lighting = ref('')
const blendModel = ref<'Flux Kontext Pro' | 'Nano Banana'>('Flux Kontext Pro')
// Each re-create stacks as a take; the displayed result is the active take.
const { takes, activeTakeId, activeTake, addTake, selectTake, pinTake, discardTake, reset: resetTakes } = useAppTakes()
const finalUrl = computed<string | null>(() => activeTake.value?.images?.[0] ?? null)
// How strongly the original product is kept (1 = pixel-exact, 0 = fully relit).
// Baked into the keep-mask's gray level so BlendScene cross-fades original↔relit.
const preserve = ref(0.7)
// Pixels of feather on the keep-mask edge so the product melts into the scene.
const edgeBlend = ref(4)

const LIGHT_PRESETS = [
  { label: 'Soft daylight', prompt: 'soft natural daylight from the left, gentle diffused shadows' },
  { label: 'Golden hour', prompt: 'warm golden-hour light, long soft shadows, cozy ambience' },
  { label: 'Studio softbox', prompt: 'bright even studio softbox lighting, clean minimal shadows' },
  { label: 'Dramatic', prompt: 'a single dramatic spotlight from above, deep contrast, dark surroundings' },
  { label: 'Cool morning', prompt: 'cool soft morning light, fresh airy tone' },
]

// Flatten background + cutout into a single composite PNG, and a white-on-black
// keep-mask of the product — both at the background's native resolution.
async function buildComposite(): Promise<{ composite: Blob; mask: Blob }> {
  const bg = await loadImage(bgUrl.value!)
  const cut = await loadImage(cutoutUrl.value!)
  const W = bg.naturalWidth, H = bg.naturalHeight

  const comp = document.createElement('canvas')
  comp.width = W; comp.height = H
  const cctx = comp.getContext('2d')!
  cctx.drawImage(bg, 0, 0, W, H)
  cctx.drawImage(cut, placement.x, placement.y, placement.w, placement.h)

  // Mask: white silhouette of the cutout (its alpha) on black.
  const mask = document.createElement('canvas')
  mask.width = W; mask.height = H
  const mctx = mask.getContext('2d')!
  mctx.fillStyle = 'black'; mctx.fillRect(0, 0, W, H)
  const sil = document.createElement('canvas')
  sil.width = Math.max(1, Math.round(placement.w)); sil.height = Math.max(1, Math.round(placement.h))
  const sctx = sil.getContext('2d')!
  sctx.drawImage(cut, 0, 0, sil.width, sil.height)
  sctx.globalCompositeOperation = 'source-in'
  // Gray (not pure white) encodes the preserve amount: BlendScene reads this as
  // the keep-mask strength, cross-fading the original product with the relit one.
  const v = Math.round(Math.max(0, Math.min(1, preserve.value)) * 255)
  sctx.fillStyle = `rgb(${v},${v},${v})`; sctx.fillRect(0, 0, sil.width, sil.height)
  mctx.drawImage(sil, placement.x, placement.y, placement.w, placement.h)

  const toBlob = (c: HTMLCanvasElement) =>
    new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
  return { composite: await toBlob(comp), mask: await toBlob(mask) }
}

async function runBlend() {
  if (busy.value || !bgUrl.value || !cutoutUrl.value) return
  // Keep the previous result on screen under the loading overlay (don't null it).
  error.value = null; busy.value = true; progress.value = 'Flattening composite…'
  try {
    // The keep-mask cross-fades the *original* product pixels back over the result,
    // which only lines up when the engine edits in place. Flux Kontext Pro does;
    // Nano Banana regenerates the whole scene and relocates the product, so the
    // preserved pixels land off-register and ghost. Only wire the mask for Kontext.
    const usePreserve = blendModel.value === 'Flux Kontext Pro'

    const { composite, mask } = await buildComposite()
    progress.value = 'Uploading…'
    const compositeName = await uploadBlob(composite, 'product_composite.png')
    const maskName = usePreserve ? await uploadBlob(mask, 'product_mask.png') : null

    const light = (lighting.value || '').trim() || LIGHT_PRESETS[0]!.prompt
    const blendPrompt =
      `Blend this composite into one cohesive, photorealistic product photo. ${light}. ` +
      'Add soft, realistic contact shadows where the product meets the surface, and unify the ' +
      "color temperature and ambient light across the whole scene. Keep the product's shape, " +
      'proportions and identity unchanged.'

    progress.value = 'Relighting & blending…'
    const graph: Record<string, any> = {
      '1': { class_type: 'LoadImage', inputs: { image: compositeName } },
    }
    const blendInputs: Record<string, any> = {
      model: blendModel.value,
      image: ['1', 0],
      prompt: blendPrompt,
      // keep_feather isn't optional in the node schema, so always send it — the
      // node only applies it when keep_subject is wired (Flux Kontext Pro).
      keep_feather: edgeBlend.value,
      seed: randomSeed(),
      output_format: 'png',
    }
    if (usePreserve) {
      graph['2'] = { class_type: 'LoadImage', inputs: { image: maskName } }
      graph['3'] = { class_type: 'ImageToMask', inputs: { image: ['2', 0], channel: 'red' } }
      blendInputs.keep_subject = ['3', 0]
    }
    graph['4'] = { class_type: 'BlendSceneNode', inputs: blendInputs }
    graph['5'] = { class_type: 'SaveImage', inputs: saveImageInputs(['4', 0], 'product_shot') }
    const promptId = await submit(graph)
    const out = pickImage(await pollHistory(promptId), { preferType: 'output' })
    if (!out) throw new Error('Blend finished but produced no output.')
    addTake({ images: [viewUrl(out)], promptId, sig: `${out.subfolder}/${out.filename}` })
  } catch (e: any) {
    error.value = humanizeError(e?.message ?? String(e))
  } finally {
    busy.value = false
  }
}

// =========================================================================
// Navigation
// =========================================================================

function goto(s: Step) {
  // Only allow jumping to a step whose prerequisites are met.
  if (!tabLocked(s)) step.value = s
}
// A tab is locked until its prerequisite output exists.
function tabLocked(n: Step): boolean {
  return (n === 2 && !bgUrl.value) || (n === 3 && (!bgUrl.value || !cutoutUrl.value))
}
// Show a check on a step once it has produced its result.
function stepDone(n: Step): boolean {
  return n === 1 ? !!bgUrl.value : n === 2 ? !!cutoutUrl.value : !!finalUrl.value
}

function startOver() {
  step.value = 1
  bgUrl.value = null; bgDims.value = null; bgRef.value = null
  cutoutUrl.value = null; cutoutDims.value = null
  resetTakes(); error.value = null
  pendingPlacement.value = null
}

function download() {
  if (!finalUrl.value) return
  const a = document.createElement('a')
  a.href = finalUrl.value
  a.download = 'product-shot.png'
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
}

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Background' },
  { n: 2, label: 'Object' },
  { n: 3, label: 'Lighting' },
]

// =========================================================================
// Reusable "looks" — keep the same packshot recipe across products
// =========================================================================

interface LookPreset {
  id: string
  name: string
  bgMode: 'generate' | 'upload'
  bgPrompt: string
  bgAspect: '1:1' | '4:5' | '3:2'
  bgRef: { filename: string; subfolder: string; type: string }
  placement: { cx: number; cy: number; wFrac: number }
  lighting: string
  preserve: number
  edgeBlend: number
  blendModel: 'Flux Kontext Pro' | 'Nano Banana'
}

const LOOKS_KEY = 'sailor-packshot-looks'
const presets = ref<LookPreset[]>([])
const lookName = ref('')

onMounted(() => {
  try { presets.value = JSON.parse(localStorage.getItem(LOOKS_KEY) || '[]') } catch { /* ignore */ }
})
function persistLooks() {
  try { localStorage.setItem(LOOKS_KEY, JSON.stringify(presets.value)) } catch { /* ignore */ }
}

// "New product, same look": keep backdrop + lighting + sliders + placement,
// clear only the product, and jump back to the Object step to add the next one.
function shootAnother() {
  if (bgDims.value && placement.w > 0) pendingPlacement.value = currentRelPlacement()
  cutoutUrl.value = null; cutoutDims.value = null; resetTakes(); error.value = null
  step.value = 2
}

function saveLook() {
  if (!bgRef.value || !bgDims.value) return
  const rel = placement.w > 0 ? currentRelPlacement() : { cx: 0.5, cy: 0.5, wFrac: 0.45 }
  presets.value.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: (lookName.value || '').trim() || `Look ${presets.value.length + 1}`,
    bgMode: bgMode.value, bgPrompt: bgPrompt.value, bgAspect: bgAspect.value,
    bgRef: { ...bgRef.value },
    placement: rel,
    lighting: lighting.value, preserve: preserve.value, edgeBlend: edgeBlend.value, blendModel: blendModel.value,
  })
  persistLooks()
  lookName.value = ''
}

async function applyLook(p: LookPreset) {
  bgMode.value = p.bgMode; bgPrompt.value = p.bgPrompt; bgAspect.value = p.bgAspect
  lighting.value = p.lighting; preserve.value = p.preserve; edgeBlend.value = p.edgeBlend; blendModel.value = p.blendModel
  pendingPlacement.value = p.placement
  cutoutUrl.value = null; cutoutDims.value = null; resetTakes(); error.value = null
  busy.value = true; progress.value = 'Loading look…'
  try {
    await setBackgroundFromRef(p.bgRef)
    step.value = 2
  } catch {
    error.value = 'This look’s background image is no longer available — re-create or upload it.'
  } finally {
    busy.value = false
  }
}

function deleteLook(id: string) {
  presets.value = presets.value.filter((p) => p.id !== id)
  persistLooks()
}
</script>

<template>
  <div class="h-full flex bg-[#0a0a0a]" @pointermove="onPointerMove" @pointerup="onPointerUp">
    <!-- ============ LEFT: image stage ============ -->
    <div class="flex-1 min-w-0 relative flex flex-col items-center justify-center p-8 overflow-auto">
      <!-- Final result -->
      <div v-if="step === 3 && finalUrl" class="w-full max-w-[720px] flex flex-col items-center">
        <img :src="finalUrl" class="w-full rounded-xl border border-white/[0.06] bg-black object-contain shadow-2xl" />
        <TakesStrip
          v-if="takes.length >= 1"
          :takes="takes"
          :active-take-id="activeTakeId"
          class="mt-3 w-full rounded-lg bg-black/40 border border-white/10"
          @select="selectTake"
          @pin="pinTake"
          @discard="discardTake"
        />
      </div>

      <!-- Placement stage: background + draggable cutout -->
      <div v-else-if="cutoutUrl && bgUrl" class="flex flex-col items-center">
        <div
          ref="stageRef"
          class="relative rounded-xl overflow-hidden border border-white/[0.06] bg-black select-none touch-none shadow-2xl"
          :style="{ width: `${displaySize.w}px`, height: `${displaySize.h}px` }"
        >
          <img :src="bgUrl" class="absolute inset-0 size-full object-cover pointer-events-none" />
          <div class="absolute cursor-move" :style="cutoutStyle" @pointerdown="(e) => onPointerDown('move', e)">
            <img :src="cutoutUrl" class="size-full object-contain pointer-events-none" draggable="false" />
            <div class="absolute inset-0 ring-1 ring-[#ffb55c]/70 ring-dashed rounded-sm pointer-events-none" />
            <div
              class="absolute -bottom-1.5 -right-1.5 size-4 rounded-full bg-[#ffb55c] border-2 border-[#0a0a0a] cursor-nwse-resize"
              @pointerdown="(e) => onPointerDown('resize', e)"
            />
          </div>
        </div>
        <p class="text-[11px] text-white/40 mt-3">Drag to move · drag the corner dot to resize</p>
      </div>

      <!-- Background only -->
      <img
        v-else-if="bgUrl"
        :src="bgUrl"
        class="max-h-[78vh] max-w-full rounded-xl border border-white/[0.06] bg-black object-contain shadow-2xl"
      />

      <!-- Empty -->
      <div v-else class="text-center">
        <ImageIcon class="size-12 mx-auto mb-3 text-white/20" :stroke-width="1.5" />
        <div class="text-[13px] text-white/45">Your product shot will appear here</div>
        <div class="text-[11px] text-white/25 mt-1">Start by setting a background on the right →</div>
      </div>

      <!-- Loading overlay — sits on top of the previous image instead of replacing it -->
      <div v-if="busy" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/45 backdrop-blur-[2px]">
        <Loader2 class="size-7 animate-spin text-white/85" />
        <span class="text-[12px] text-white/75">{{ progress || 'Working…' }}</span>
      </div>
    </div>

    <!-- ============ RIGHT: inspector ============ -->
    <div class="w-[400px] shrink-0 border-l border-white/[0.06] flex flex-col h-full bg-[#0c0c0c]">
      <!-- Header -->
      <div class="px-6 pt-6 pb-4">
        <div class="text-[10px] uppercase tracking-[0.16em] text-white/35 font-medium mb-1.5">App · Image</div>
        <h1 class="text-[22px] font-medium text-white tracking-tight">Product Shot</h1>
      </div>

      <!-- Step tabs -->
      <div class="flex px-4 border-b border-white/[0.06]">
        <button
          v-for="s in STEPS" :key="s.n"
          class="relative flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-medium -mb-px border-b-2 transition-colors"
          :class="step === s.n
            ? 'text-white border-[#ffb55c]'
            : tabLocked(s.n) ? 'text-white/25 border-transparent cursor-not-allowed' : 'text-white/55 hover:text-white/85 border-transparent cursor-pointer'"
          :disabled="tabLocked(s.n)"
          @click="goto(s.n)"
        >
          <span
            class="size-4 rounded-full flex items-center justify-center text-[9px] font-semibold shrink-0"
            :class="step === s.n ? 'bg-[#ffb55c] text-[#0a0a0a]' : stepDone(s.n) ? 'bg-[#ffb55c]/25 text-[#ffb55c]' : 'bg-white/10 text-white/45'"
          >
            <Check v-if="stepDone(s.n)" class="size-2.5" />
            <template v-else>{{ s.n }}</template>
          </span>
          {{ s.label }}
        </button>
      </div>

      <!-- Tab content -->
      <div class="flex-1 overflow-y-auto px-6 py-5">
        <!-- ===== TAB 1: Background ===== -->
        <div v-show="step === 1" class="space-y-4">
          <!-- Saved looks -->
          <div v-if="presets.length" class="space-y-2 pb-4 border-b border-white/[0.06]">
            <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-white/40 font-medium">
              <Bookmark class="size-3" /> Saved looks
            </div>
            <div class="flex flex-wrap gap-1.5">
              <div
                v-for="p in presets" :key="p.id"
                class="group inline-flex items-center rounded-full bg-white/[0.06] hover:bg-white/[0.12] transition-colors overflow-hidden"
              >
                <button class="pl-3 pr-1.5 py-1 text-[11.5px] text-white/80 hover:text-white cursor-pointer" @click="applyLook(p)">{{ p.name }}</button>
                <button class="pr-2 py-1 text-white/25 hover:text-rose-300 cursor-pointer" title="Delete look" @click="deleteLook(p.id)"><X class="size-3" /></button>
              </div>
            </div>
            <p class="text-[10.5px] text-white/30 leading-snug">Pick a look to reuse its background, lighting &amp; placement — then just add a product.</p>
          </div>

          <p class="text-[12.5px] text-white/55 leading-relaxed">Generate a backdrop or upload your own.</p>
          <div class="inline-flex rounded-lg bg-white/[0.04] p-0.5 gap-0.5">
            <button
              v-for="m in (['generate','upload'] as const)" :key="m"
              class="px-3.5 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors cursor-pointer"
              :class="bgMode === m ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:text-white/80'"
              @click="bgMode = m"
            >{{ m }}</button>
          </div>

          <div v-if="bgMode === 'generate'" class="space-y-3">
            <textarea
              v-model="bgPrompt"
              rows="3"
              placeholder="Describe the backdrop — e.g. clean marble countertop with soft window light"
              class="w-full rounded-xl bg-white/[0.03] border border-white/12 focus:border-white/30 focus:outline-none text-[13px] text-white/90 placeholder:text-white/30 px-3.5 py-3 resize-none"
            />
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="p in BG_PRESETS" :key="p"
                class="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.05] hover:bg-white/[0.12] text-white/65 hover:text-white transition-colors cursor-pointer"
                @click="bgPrompt = p"
              >{{ p.split(',')[0] }}</button>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[12px] text-white/55">Format</span>
              <div class="inline-flex rounded-lg bg-white/[0.04] p-0.5 gap-0.5">
                <button
                  v-for="a in BG_ASPECTS" :key="a.id"
                  class="px-2.5 py-1.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer"
                  :class="bgAspect === a.id ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:text-white/80'"
                  @click="bgAspect = a.id"
                >{{ a.label }}</button>
              </div>
            </div>
            <button
              class="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[13px] text-white font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="busy"
              @click="generateBackground"
            >
              <Sparkles v-if="!busy" class="size-4" /><Loader2 v-else class="size-4 animate-spin" />
              {{ bgUrl ? 'Regenerate' : 'Generate background' }}
            </button>
          </div>

          <div v-else>
            <input ref="bgInputRef" type="file" accept="image/*" class="hidden" @change="(e) => uploadBackground((e.target as HTMLInputElement).files?.[0])" />
            <button
              class="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[13px] text-white font-medium transition-colors cursor-pointer"
              @click="bgInputRef?.click()"
            >
              <Upload class="size-4" /> {{ bgUrl ? 'Replace background' : 'Upload background' }}
            </button>
          </div>

          <button
            v-if="bgUrl"
            class="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg bg-[#ffb55c] hover:bg-[#ffc278] text-[#0a0a0a] text-[13px] font-medium transition-colors cursor-pointer"
            @click="goto(2)"
          >
            Continue to product <ArrowRight class="size-4" />
          </button>
        </div>

        <!-- ===== TAB 2: Object ===== -->
        <div v-show="step === 2" class="space-y-4">
          <p class="text-[12.5px] text-white/55 leading-relaxed">
            Upload your product — we knock out its background, then you drag &amp; resize it on the backdrop (left).
          </p>
          <input ref="productInputRef" type="file" accept="image/*" class="hidden" @change="(e) => uploadAndCutout((e.target as HTMLInputElement).files?.[0])" />

          <button
            class="w-full inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] text-[13px] text-white font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="busy"
            @click="productInputRef?.click()"
          >
            <ImageIcon v-if="!busy" class="size-4" /><Loader2 v-else class="size-4 animate-spin" />
            {{ cutoutUrl ? 'Use a different product' : 'Upload product photo' }}
          </button>

          <p v-if="cutoutUrl" class="text-[11.5px] text-white/40 leading-relaxed">
            Drag the product to position it, and drag the corner dot to resize. Happy? Move on to lighting.
          </p>

          <button
            v-if="cutoutUrl"
            class="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-lg bg-[#ffb55c] hover:bg-[#ffc278] text-[#0a0a0a] text-[13px] font-medium transition-colors cursor-pointer"
            @click="goto(3)"
          >
            Continue to lighting <ArrowRight class="size-4" />
          </button>
        </div>

        <!-- ===== TAB 3: Lighting & blend ===== -->
        <div v-show="step === 3" class="space-y-5">
          <div class="space-y-2.5">
            <p class="text-[12.5px] text-white/55 leading-relaxed">Describe the lighting; we relight the scene and add contact shadows.</p>
            <textarea
              v-model="lighting"
              rows="2"
              placeholder="e.g. soft daylight from the left with gentle shadows"
              class="w-full rounded-xl bg-white/[0.03] border border-white/12 focus:border-white/30 focus:outline-none text-[13px] text-white/90 placeholder:text-white/30 px-3.5 py-3 resize-none"
            />
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="p in LIGHT_PRESETS" :key="p.label"
                class="px-2.5 py-1 rounded-full text-[11px] bg-white/[0.05] hover:bg-white/[0.12] text-white/65 hover:text-white transition-colors cursor-pointer"
                @click="lighting = p.prompt"
              >{{ p.label }}</button>
            </div>
          </div>

          <!-- Engine -->
          <div class="flex items-center gap-2">
            <span class="text-[12px] text-white/55">Engine</span>
            <div class="inline-flex rounded-lg bg-white/[0.04] p-0.5 gap-0.5">
              <button
                v-for="m in (['Flux Kontext Pro','Nano Banana'] as const)" :key="m"
                class="px-2.5 py-1.5 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer"
                :class="blendModel === m ? 'bg-white/[0.12] text-white' : 'text-white/50 hover:text-white/80'"
                @click="blendModel = m"
              >{{ m }}</button>
            </div>
          </div>

          <!-- Preserve controls: only Flux Kontext Pro edits in place, so the
               pixel-exact keep-mask only makes sense there. Nano Banana relights
               by regenerating the whole scene, which moves the product. -->
          <div v-if="blendModel === 'Flux Kontext Pro'" class="space-y-4">
            <div>
              <StudioSlider v-model="preserve" label="Preserve product" :min="0" :max="1" :step="0.05" :bindable="false" />
              <p class="text-[10.5px] text-white/35 mt-1 leading-snug">
                Higher keeps it pixel-exact (crisp labels, can look pasted). Lower lets it relight into the scene.
              </p>
            </div>
            <div>
              <StudioSlider v-model="edgeBlend" label="Edge blend" :min="0" :max="20" :step="1" :bindable="false" />
              <p class="text-[10.5px] text-white/35 mt-1 leading-snug">How softly the product’s edges melt into the scene.</p>
            </div>
          </div>
          <p v-else class="text-[10.5px] text-white/35 leading-snug">
            Nano Banana reimagines the whole scene for the most natural relight, so it can subtly restyle the product. For pixel-exact labels, switch to Flux Kontext Pro.
          </p>

          <!-- Run -->
          <button
            class="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg bg-white text-[#0a0a0a] font-medium text-[13px] hover:bg-white/90 transition-colors cursor-pointer disabled:bg-white/15 disabled:text-white/40 disabled:cursor-not-allowed"
            :disabled="busy"
            @click="runBlend"
          >
            <span>{{ busy ? 'Blending…' : finalUrl ? 'Re-create shot' : 'Create shot' }}</span>
            <ArrowRight v-if="!busy" class="size-4" /><Loader2 v-else class="size-4 animate-spin" />
          </button>

          <!-- Result actions -->
          <div v-if="finalUrl" class="flex items-center gap-2 pt-1">
            <button class="flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-[#ffb55c] hover:bg-[#ffc278] text-[#0a0a0a] text-[12px] font-medium transition-colors cursor-pointer" @click="download">
              <Download class="size-3.5" /> Download
            </button>
            <button class="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/80 transition-colors cursor-pointer" @click="startOver">
              <RefreshCcw class="size-3.5" /> Start over
            </button>
          </div>

          <!-- Reuse this look -->
          <div v-if="bgUrl" class="pt-4 mt-1 border-t border-white/[0.06] space-y-2">
            <button
              class="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/85 transition-colors cursor-pointer"
              @click="shootAnother"
            >
              <Copy class="size-3.5" /> New product, same look
            </button>
            <div class="flex gap-2">
              <input
                v-model="lookName"
                placeholder="Name this look…"
                class="flex-1 min-w-0 rounded-lg bg-white/[0.03] border border-white/12 focus:border-white/30 focus:outline-none text-[12px] text-white/90 placeholder:text-white/30 px-3 h-9"
                @keydown.enter="saveLook"
              />
              <button
                class="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[12px] text-white/85 transition-colors cursor-pointer"
                @click="saveLook"
              >
                <Bookmark class="size-3.5" /> Save look
              </button>
            </div>
            <p class="text-[10.5px] text-white/30 leading-snug">Saved looks appear on the Background tab — reuse them anytime, even after reload.</p>
          </div>
        </div>

        <!-- Error -->
        <p v-if="error" class="text-[12px] text-rose-400 mt-5 leading-relaxed">{{ error }}</p>
      </div>
    </div>
  </div>
</template>
