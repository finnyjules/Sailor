<script setup lang="ts">
import { ChevronRight, Pause, Play, Sparkles } from 'lucide-vue-next'
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ShaderEffectGallery from '~/components/vue-canvas/ShaderEffectGallery.vue'
import { getTypeColor } from '~/composables/useVueNodes'
import { assetUrl, fetchShaderFxCatalog, resolveEffectId, useShaderCatalog } from '~/lib/shaderfx/catalog'
import { walkShaderChain } from '~/lib/shaderfx/chain'
import { parseParams, resolveUniforms, serializeParams } from '~/lib/shaderfx/params'
import { expandPasses, shaderFx } from '~/lib/shaderfx/renderer'
import type { EffectDef } from '~/lib/shaderfx/types'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'

// ShaderEffect artifact node: live WebGL preview (shared singleton renderer)
// + manifest-driven param sliders. Only selected/hovered nodes animate; the
// rest keep their last rendered frame on a plain 2D canvas.
const props = defineProps<{
  id: string
  selected?: boolean
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
  }
}>()

const isMuted = computed(() => props.data.mode === 2)
const isBypassed = computed(() => props.data.mode === 4)
const imageColor = computed(() => getTypeColor('IMAGE'))

function inputIdx(name: string): number { const i = props.data.inputs?.findIndex(inp => inp.name === name) ?? -1; return i >= 0 ? i : 0 }
function outputIdx(name: string): number { const i = props.data.outputs?.findIndex(o => o.name === name) ?? -1; return i >= 0 ? i : 0 }
const imageInIdx = computed(() => inputIdx('image'))
const imageOutIdx = computed(() => outputIdx('image'))

const injectedEdges = inject<any>('vueFlowEdges', null)
const injectedNodes = inject<any>('vueFlowNodes', null)

// The live catalog: a new My effect or a draft take shows up here without a refetch.
const catalog = useShaderCatalog()
const hovered = ref(false)
const playing = ref(true)
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const glError = ref<string | null>(null)

// ---- widgets ----------------------------------------------------------------
function widgetIdx(name: string): number {
  return props.data.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1
}
function widgetVal(name: string): any {
  const i = widgetIdx(name)
  return i >= 0 ? props.data.widgetsValues?.[i] : undefined
}
function setWidget(name: string, value: any) {
  const i = widgetIdx(name)
  if (i >= 0) props.data.widgetsValues[i] = value
}

// Shader generation (stage 5): the prompt asks this node for its picture and
// effect, previews takes on it, and applies the kept one. A previewed take
// renders at its defaults and is never written to the widgets.
const previewEffectId = ref<string | null>(null)
// The node's take strip is open (sailor:shaderEffectLock): its own dials, centre handle and
// effect picker are read-only until it closes, so closing can put back exactly what was there.
const stripOpen = ref(false)
const readOnly = computed(() => stripOpen.value || previewEffectId.value != null)
const effectId = computed<string>(() => previewEffectId.value ?? String(widgetVal('effect') ?? ''))
const effectDef = computed<EffectDef | null>(
  () => catalog.value?.effects.find(e => e.id === resolveEffectId(effectId.value)) ?? null,
)
const paramsJson = computed(() => (previewEffectId.value ? '{}' : String(widgetVal('params') ?? '{}')))
const uniforms = computed<Record<string, number>>(() =>
  effectDef.value ? resolveUniforms(effectDef.value, parseParams(paramsJson.value)) : {},
)

// Generative effects synthesize from scratch (no source image), so their output
// size comes from resolution + aspect controls instead of the input.
const isGenerative = computed(() => !!effectDef.value?.generative)
const RESOLUTIONS = [512, 768, 1024, 1536]
const ASPECTS = ['1:1', '16:9', '9:16', '4:5', '3:2']
const resolutionVal = computed(() => Number(widgetVal('resolution') ?? 768))
const aspectVal = computed(() => String(widgetVal('aspect') ?? '1:1'))
function aspectRatio(a: string): number {
  const [w, h] = a.split(':').map(Number)
  return w && h ? w / h : 1
}
function setSize(name: 'resolution' | 'aspect', value: number | string) {
  if (readOnly.value) return
  setWidget(name, value)
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}

function setParam(uniform: string, value: number) {
  if (!effectDef.value || readOnly.value) return
  const next = { ...uniforms.value, [uniform]: value }
  setWidget('params', serializeParams(effectDef.value, next))
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}

// ---- preview rendering --------------------------------------------------------
const PREVIEW_W = 288
const baseImage = ref<HTMLImageElement | null>(null)
const placeholder = makePlaceholder()
let lastChainIds: string[] = []

function makePlaceholder(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 288; c.height = 162
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 288, 162)
  g.addColorStop(0, '#3b2a68'); g.addColorStop(0.55, '#1f6f8b'); g.addColorStop(1, '#e8a33d')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 288, 162)
  return c
}

const chain = computed(() => walkShaderChain(props.id, injectedNodes?.value ?? [], injectedEdges?.value ?? []))

watch(() => chain.value.baseUrl, (url) => {
  baseImage.value = null
  if (!url) return
  const img = new Image()
  img.onload = () => { baseImage.value = img; if (!animating.value) renderOnce() }
  img.src = url
}, { immediate: true })

let epoch = performance.now()
let frozenTime = 0.7

function buildPasses(t: number) {
  if (!catalog.value) return []
  // Each effect expands into N ping-pong passes (multi-pass blur/bloom); chained
  // effects concatenate, so the renderer ping-pongs the whole flattened list.
  const passes = chain.value.passes
  const own = passes.length - 1 // the node itself is always the last pass
  return passes
    .map((p, i) => (i === own && previewEffectId.value ? { ...p, effectId: previewEffectId.value, params: {} } : p))
    .flatMap((p) => {
      const def = catalog.value!.effects.find(e => e.id === resolveEffectId(p.effectId))
      if (!def) return []
      // u_hasInput: 1 when a real image feeds the chain, 0 for standalone/placeholder
      // — lets hybrid effects (fbm) modulate the image or synthesize from scratch.
      const uniforms = { ...resolveUniforms(def, p.params), u_time: t, u_seed: p.seed % 10000, u_hasInput: chain.value.baseUrl ? 1 : 0, ...textureUniforms(def) }
      return expandPasses(def.id, def.source, uniforms, textureSources(def), def.passes ?? 1)
    }) as any[]
}

// Catalog textures (e.g. glyph atlas) — loaded lazily, cached module-wide
const textureImages = new Map<string, HTMLImageElement>()
function textureSources(def: EffectDef): Record<string, TexImageSource> {
  const out: Record<string, TexImageSource> = {}
  for (const t of def.textures) {
    const img = textureImages.get(t.file)
    if (img?.complete) out[t.uniform] = img
    else if (!img) {
      const el = new Image()
      el.onload = () => { if (!animating.value) renderOnce() }
      el.src = assetUrl(t.file, t.v)
      textureImages.set(t.file, el)
    }
  }
  return out
}
function textureUniforms(def: EffectDef): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of def.textures) for (const [k, v] of Object.entries(t.extraUniforms ?? {})) out[k] = v
  return out
}

function renderFrame(t: number) {
  const canvas = previewCanvas.value
  if (!canvas || !catalog.value) return
  const base = baseImage.value ?? placeholder
  const w = PREVIEW_W
  // Generative effects ignore the (placeholder) input — size the preview by the
  // chosen aspect instead of the base image's shape.
  const h = isGenerative.value
    ? Math.max(16, Math.round(w / aspectRatio(aspectVal.value)))
    : Math.max(16, Math.round((base.height / base.width) * w))
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  try {
    const out = shaderFx.render(buildPasses(t), base, w, h)
    canvas.getContext('2d')!.drawImage(out, 0, 0)
    glError.value = null
  } catch (e: any) {
    glError.value = String(e?.message ?? e)
  }
}

function renderOnce() { renderFrame(frozenTime) }

// ---- gallery picker (ShaderEffectGallery) ------------------------------------
const pickerOpen = ref(false)
const thumbs = ref<Record<string, string>>({})
const thumbCache: Record<string, string> = ((globalThis as any).__shaderFxThumbs ??= {})

function titleCase(s: string): string {
  return s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim()
}

// Render a small still of an effect (on the placeholder gradient) for the
// gallery cards and the picker-trigger badge. Returns '' if textures aren't
// ready yet — we never cache a texture-less render (it would look wrong forever).
function renderThumb(def: EffectDef): string {
  const texs = textureSources(def)
  if (def.textures.length && Object.keys(texs).length < def.textures.length) return ''
  try {
    const out = shaderFx.render(
      [{ id: def.id, source: def.source, uniforms: { ...resolveUniforms(def, {}), u_time: 1.2, u_seed: 42, ...textureUniforms(def) }, textures: texs }],
      placeholder, 192, 108,
    )
    return out.toDataURL('image/jpeg', 0.82)
  } catch { return '' }
}

function ensureThumb(def: EffectDef | null | undefined) {
  // Drafts (unkept takes) are never thumbnailed: the ids are one-off and the code is untrusted.
  if (!def || def.draft || thumbCache[def.id]) return
  const t = renderThumb(def)
  if (t) { thumbCache[def.id] = t; thumbs.value = { ...thumbCache } }
}

const currentThumb = computed(() => (effectDef.value ? thumbs.value[effectDef.value.id] ?? '' : ''))

function openPicker() {
  if (readOnly.value) return
  pickerOpen.value = true
}
// Thumbnails for just what the gallery lists (its `visible` event).
function onPickerVisible(defs: EffectDef[]) { if (pickerOpen.value) for (const def of defs) ensureThumb(def) }

// Make one / Remix start the canvas prompt's effect takes on this node — the same chip the
// node toolbar's New effect… / Remix… set (nodeActions), Remix starting from the card's effect.
function effectModeFromGallery(label: 'New effect' | 'Remix', effectId?: string) {
  pickerOpen.value = false
  window.dispatchEvent(new CustomEvent('sailor:promptMode', { detail: { label, kind: 'new-effect', nodeId: props.id, ...(effectId ? { effectId } : {}) } }))
}

function pickEffect(id: string) {
  if (readOnly.value) return
  setWidget('effect', id)
  setWidget('params', '{}') // params are per-effect; reset on switch
  pickerOpen.value = false
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}

// ---- center handle -----------------------------------------------------------
const hasCenter = computed(() => (effectDef.value?.centerParam?.length ?? 0) === 2)
const centerStyle = computed(() => {
  if (!hasCenter.value) return {}
  const [cx, cy] = effectDef.value!.centerParam!
  const x = uniforms.value[cx!] ?? 0.5
  const y = uniforms.value[cy!] ?? 0.5
  return { left: `${x * 100}%`, top: `${(1 - y) * 100}%` }
})

let draggingCenter = false
function onCenterDown(ev: PointerEvent) {
  if (readOnly.value) return
  draggingCenter = true
  ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
  ev.stopPropagation() // don't drag the node
}
function onCenterMove(ev: PointerEvent) {
  if (!draggingCenter || !hasCenter.value || !previewCanvas.value || readOnly.value) return
  const r = previewCanvas.value.getBoundingClientRect()
  const x = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1)
  const y = 1 - Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1)
  const [cx, cy] = effectDef.value!.centerParam!
  if (!effectDef.value) return
  const next = { ...uniforms.value, [cx!]: x, [cy!]: y }
  setWidget('params', serializeParams(effectDef.value, next))
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}
function onCenterUp() { draggingCenter = false }

// ---- animation lifecycle: only selected/hovered nodes run a rAF loop ---------
const animating = computed(() => (props.selected || hovered.value) && playing.value && !glError.value)
let raf = 0
function loop() {
  frozenTime = (performance.now() - epoch) / 1000
  renderFrame(frozenTime)
  raf = requestAnimationFrame(loop)
}
watch(animating, (on) => {
  cancelAnimationFrame(raf)
  if (on) raf = requestAnimationFrame(loop)
}, { immediate: false })

// Upstream param changes: single-frame refresh so chained previews never go stale
function onUpstreamChange(ev: Event) {
  const changedId = (ev as CustomEvent).detail?.id
  if (changedId === props.id) return
  if (lastChainIds.includes(changedId) && !animating.value) renderOnce()
}

// Registered synchronously so the watcher lives in the component's effect scope
// (registering after an await in onMounted would leak it past unmount).
watch(() => chain.value.nodeIds, (ids) => { lastChainIds = ids; if (!animating.value) renderOnce() })

// Keep the picker-trigger badge showing the current effect's thumbnail.
watch(effectDef, def => ensureThumb(def))

// ---- shader generation (stage 5): the canvas prompt's effect takes ------------
function onEffectTarget(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id || typeof d?.reply !== 'function') return
  // The saved effect (never a previewed take) and the name the header shows for it.
  const own = String(widgetVal('effect') ?? '')
  const def = catalog.value?.effects.find(x => x.id === resolveEffectId(own)) ?? null
  d.reply({ image: baseImage.value ?? null, effectId: own, title: def?.name ?? '' })
}
function onEffectPreview(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id) return
  previewEffectId.value = d.effectId ?? null
  if (!animating.value) renderOnce()
}
function onEffectApply(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id || !d.effectId) return
  previewEffectId.value = null
  stripOpen.value = false
  const id = String(d.effectId)
  const values = d.values ?? {}
  // Only non-default values are stored, as everywhere else on the node (the kept def is
  // registered before Keep applies it; the raw values are the fallback).
  const def = catalog.value?.effects.find(x => x.id === resolveEffectId(id)) ?? null
  setWidget('effect', id)
  setWidget('params', def ? serializeParams(def, values) : JSON.stringify(values))
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}

function onEffectLock(e: Event) {
  const d = (e as CustomEvent).detail
  if (String(d?.nodeId) !== props.id) return
  stripOpen.value = !!d.locked
  if (stripOpen.value) { draggingCenter = false; pickerOpen.value = false }
}

// WebGL context loss (AI in Sailor spec §7.5): the renderer drops every GL
// handle and refuses to render until restored; redraw once it comes back.
const offContextChange = shaderFx.onContextChange((s) => { if (s === 'restored') renderOnce() })

onMounted(async () => {
  // Before the catalog fetch: the prompt may ask as soon as the node is on screen.
  window.addEventListener('sailor:shaderEffectTarget', onEffectTarget)
  window.addEventListener('sailor:shaderEffectPreview', onEffectPreview)
  window.addEventListener('sailor:shaderEffectApply', onEffectApply)
  window.addEventListener('sailor:shaderEffectLock', onEffectLock)
  await fetchShaderFxCatalog().catch(() => null)
  lastChainIds = chain.value.nodeIds
  window.addEventListener('sailor:shaderfx-changed', onUpstreamChange)
  ensureThumb(effectDef.value)
  renderOnce()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('sailor:shaderfx-changed', onUpstreamChange)
  window.removeEventListener('sailor:shaderEffectTarget', onEffectTarget)
  window.removeEventListener('sailor:shaderEffectPreview', onEffectPreview)
  window.removeEventListener('sailor:shaderEffectApply', onEffectApply)
  window.removeEventListener('sailor:shaderEffectLock', onEffectLock)
  offContextChange()
})
</script>

<template>
  <!-- Ports sit outside the card so its background occludes their inner half. -->
  <div class="relative w-fit">
    <VueCanvasNodePort :id="`input-${imageInIdx}`" type="target" side="left" :index="0" :data-type="'IMAGE'" label="image" />
    <VueCanvasNodePort :id="`output-${imageOutIdx}`" type="source" side="right" :index="0" :data-type="'IMAGE'" label="image" />

  <div
    class="shader-effect-node relative z-10 rounded-xl border w-[288px] select-none backdrop-blur-sm"
    :class="[
      data.error ? 'border-red-500 ring-2 ring-red-500' : 'border-white/10',
      { 'opacity-45 grayscale': isMuted, 'opacity-85': isBypassed },
    ]"
    :style="{ background: 'linear-gradient(180deg, #252525 0%, #1e1e1e 100%)', '--port-color': imageColor } as any"
    :data-running="data.running || undefined"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <!-- Header -->
    <div
      class="flex items-center gap-2 px-3 py-2 border-b border-white/5 rounded-t-xl"
      :style="{ background: `linear-gradient(135deg, ${imageColor}15 0%, transparent 60%)` }"
    >
      <Sparkles class="size-4 shrink-0 text-white/70" :stroke-width="1.75" />
      <span class="text-xs font-semibold text-white/90 truncate flex-1">{{ effectDef?.name || 'Shader Effect' }}</span>
      <button
        class="nopan nodrag shrink-0 size-5 rounded flex items-center justify-center text-white/55 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer"
        :title="playing ? 'Pause preview' : 'Play preview'" @click.stop="playing = !playing"
      >
        <Pause v-if="playing" class="size-3" />
        <Play v-else class="size-3" />
      </button>
    </div>


    <!-- Live preview (full-bleed band) -->
    <div class="relative border-t border-[#2a2a2a]">
      <canvas ref="previewCanvas" class="w-full block bg-checker" />
      <!-- Draggable center handle (only for effects with centerParam) -->
      <div
        v-if="hasCenter && !readOnly"
        class="nopan nodrag absolute size-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white bg-black/30 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] cursor-move"
        :style="centerStyle"
        @pointerdown="onCenterDown"
        @pointermove="onCenterMove"
        @pointerup="onCenterUp"
      />
    </div>
    <div v-if="glError" class="border-t border-[#2a2a2a] text-[10px] text-red-300/90 px-3 py-1 truncate" :title="glError">{{ glError }}</div>

    <!-- Controls -->
    <div
      class="border-t border-[#2a2a2a] px-3 py-2.5 flex flex-col gap-2.5 transition-opacity"
      :class="{ 'opacity-40 pointer-events-none': readOnly }"
      :inert="readOnly || undefined" :aria-disabled="readOnly || undefined" data-testid="shader-effect-controls"
    >
      <!-- Effect picker — mirrors the model-picker row -->
      <div>
        <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">Effect</label>
        <button
          class="nopan nodrag w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/20 transition-colors cursor-pointer text-left group"
          :disabled="readOnly" data-testid="shader-effect-picker"
          @click="openPicker"
        >
          <span class="size-5 rounded-md shrink-0 flex items-center justify-center bg-white/[0.06] overflow-hidden relative">
            <img v-if="currentThumb" :src="currentThumb" class="absolute inset-0 w-full h-full object-cover" />
            <Sparkles v-else class="size-3 text-white/70" :stroke-width="1.75" />
          </span>
          <span class="flex flex-col min-w-0 flex-1">
            <span class="text-[11px] font-medium text-white/90 truncate leading-tight">{{ effectDef?.name ?? 'Pick an effect' }}</span>
            <span class="text-[9px] text-white/40 truncate uppercase tracking-[0.06em] leading-tight">{{ effectDef ? titleCase(effectDef.category) : 'Shader effect' }}</span>
          </span>
          <ChevronRight class="size-3.5 text-white/30 group-hover:text-white/55 shrink-0 transition-colors" />
        </button>
      </div>

      <!-- Generative effects synthesize from scratch — pick output size here -->
      <div v-if="isGenerative" class="grid grid-cols-2 gap-2">
        <div>
          <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">Resolution</label>
          <select
            :disabled="readOnly"
            class="nopan nodrag w-full px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:border-white/20 text-[11px] text-white/85 outline-none cursor-pointer"
            :value="resolutionVal" @change="setSize('resolution', Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="r in RESOLUTIONS" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div>
          <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">Aspect</label>
          <select
            :disabled="readOnly"
            class="nopan nodrag w-full px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:border-white/20 text-[11px] text-white/85 outline-none cursor-pointer"
            :value="aspectVal" @change="setSize('aspect', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="a in ASPECTS" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>
      </div>

      <!-- Manifest-driven param sliders/selects, as labeled fields -->
      <div v-for="p in effectDef?.params ?? []" :key="p.uniform">
        <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">{{ p.label }}</label>
        <select
            :disabled="readOnly"
          v-if="p.type === 'enum'"
          class="nopan nodrag w-full px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:border-white/20 text-[11px] text-white/85 outline-none cursor-pointer"
          :value="uniforms[p.uniform]"
          @change="setParam(p.uniform, Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <template v-else>
          <div class="nodrag nopan nowheel">
            <StudioSlider
              :model-value="uniforms[p.uniform] ?? 0"
              @update:model-value="(v) => setParam(p.uniform, v)"
              :min="p.min"
              :max="p.max"
              :step="p.step"
              :bindable="false"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- Effect gallery picker: My effects, Make one and Remix (spec §7.3) -->
    <ShaderEffectGallery
      :open="pickerOpen"
      :effects="catalog?.effects ?? []"
      :selected-id="effectId"
      :thumbs="thumbs"
      can-make
      @close="pickerOpen = false"
      @confirm="pickEffect"
      @make="effectModeFromGallery('New effect')"
      @remix="effectModeFromGallery('Remix', $event.id)"
      @visible="onPickerVisible"
    />
  </div>
  </div>
</template>

<style scoped>
.shader-effect-node { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 4px rgba(0, 0, 0, 0.2); }
.shader-effect-node[data-running] { box-shadow: 0 0 0 2px var(--port-color, #fff), 0 4px 16px rgba(0, 0, 0, 0.4); }
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
