<script setup lang="ts">
import { ChevronRight, Pause, Play, Sparkles } from 'lucide-vue-next'
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CatalogModal from '~/components/CatalogModal.vue'
import { getTypeColor } from '~/composables/useVueNodes'
import { assetUrl, fetchShaderFxCatalog, resolveEffectId } from '~/lib/shaderfx/catalog'
import { walkShaderChain } from '~/lib/shaderfx/chain'
import { parseParams, resolveUniforms, serializeParams } from '~/lib/shaderfx/params'
import { expandPasses, shaderFx } from '~/lib/shaderfx/renderer'
import type { EffectDef, ShaderFxCatalog } from '~/lib/shaderfx/types'

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

const catalog = ref<ShaderFxCatalog | null>(null)
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

const effectId = computed<string>(() => String(widgetVal('effect') ?? ''))
const effectDef = computed<EffectDef | null>(
  () => catalog.value?.effects.find(e => e.id === resolveEffectId(effectId.value)) ?? null,
)
const uniforms = computed<Record<string, number>>(() =>
  effectDef.value ? resolveUniforms(effectDef.value, parseParams(String(widgetVal('params') ?? '{}'))) : {},
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
  setWidget(name, value)
  window.dispatchEvent(new CustomEvent('sailor:shaderfx-changed', { detail: { id: props.id } }))
  if (!animating.value) renderOnce()
}

function setParam(uniform: string, value: number) {
  if (!effectDef.value) return
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
  return chain.value.passes
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

// ---- gallery picker (CatalogModal) -------------------------------------------
const pickerOpen = ref(false)
const pickerSearch = ref('')
const pickerFilter = ref('all')
const thumbs = ref<Record<string, string>>({})
const thumbCache: Record<string, string> = ((globalThis as any).__shaderFxThumbs ??= {})

function titleCase(s: string): string {
  return s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim()
}

const pickerFilters = computed(() => {
  const counts = new Map<string, number>()
  for (const e of catalog.value?.effects ?? []) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  return [
    { id: 'all', label: 'All', count: catalog.value?.effects.length ?? 0 },
    ...[...counts].map(([id, count]) => ({ id, label: titleCase(id), count })),
  ]
})

const pickerItems = computed<EffectDef[]>(() => {
  const q = pickerSearch.value.trim().toLowerCase()
  return (catalog.value?.effects ?? []).filter(e =>
    (pickerFilter.value === 'all' || e.category === pickerFilter.value)
    && (!q || e.name.toLowerCase().includes(q) || e.category.toLowerCase().includes(q)),
  )
})

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
  if (!def || thumbCache[def.id]) return
  const t = renderThumb(def)
  if (t) { thumbCache[def.id] = t; thumbs.value = { ...thumbCache } }
}

const currentThumb = computed(() => (effectDef.value ? thumbs.value[effectDef.value.id] ?? '' : ''))

async function openPicker() {
  pickerSearch.value = ''
  pickerFilter.value = 'all'
  pickerOpen.value = true
  if (!catalog.value) return
  for (const def of catalog.value.effects) ensureThumb(def)
}

function pickEffect(id: string) {
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
  draggingCenter = true
  ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
  ev.stopPropagation() // don't drag the node
}
function onCenterMove(ev: PointerEvent) {
  if (!draggingCenter || !hasCenter.value || !previewCanvas.value) return
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

onMounted(async () => {
  catalog.value = await fetchShaderFxCatalog().catch(() => null)
  lastChainIds = chain.value.nodeIds
  window.addEventListener('sailor:shaderfx-changed', onUpstreamChange)
  ensureThumb(effectDef.value)
  renderOnce()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('sailor:shaderfx-changed', onUpstreamChange)
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
        v-if="hasCenter"
        class="nopan nodrag absolute size-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white bg-black/30 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] cursor-move"
        :style="centerStyle"
        @pointerdown="onCenterDown"
        @pointermove="onCenterMove"
        @pointerup="onCenterUp"
      />
    </div>
    <div v-if="glError" class="border-t border-[#2a2a2a] text-[10px] text-red-300/90 px-3 py-1 truncate" :title="glError">{{ glError }}</div>

    <!-- Controls -->
    <div class="border-t border-[#2a2a2a] px-3 py-2.5 flex flex-col gap-2.5">
      <!-- Effect picker — mirrors the model-picker row -->
      <div>
        <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">Effect</label>
        <button
          class="nopan nodrag w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/20 transition-colors cursor-pointer text-left group"
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
            class="nopan nodrag w-full px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:border-white/20 text-[11px] text-white/85 outline-none cursor-pointer"
            :value="resolutionVal" @change="setSize('resolution', Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="r in RESOLUTIONS" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div>
          <label class="text-[9px] text-muted-foreground tracking-normal mb-0.5 block">Aspect</label>
          <select
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
          v-if="p.type === 'enum'"
          class="nopan nodrag w-full px-2 py-1 rounded border border-white/10 bg-white/[0.04] hover:border-white/20 text-[11px] text-white/85 outline-none cursor-pointer"
          :value="uniforms[p.uniform]"
          @change="setParam(p.uniform, Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="o in p.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <template v-else>
          <div class="flex items-center justify-between mb-0.5">
            <span class="text-[9px] text-white/45 tabular-nums">{{ (uniforms[p.uniform] ?? 0).toFixed(2) }}</span>
          </div>
          <input
            type="range" class="nopan nodrag w-full accent-white" :min="p.min" :max="p.max" :step="p.step"
            :value="uniforms[p.uniform]"
            @input="setParam(p.uniform, Number(($event.target as HTMLInputElement).value))"
          />
        </template>
      </div>
    </div>

    <!-- Effect gallery picker — the app's canonical CatalogModal -->
    <CatalogModal
      :open="pickerOpen"
      title="Shader Effects"
      subtitle="Pick an effect to apply"
      :items="pickerItems"
      :selected-id="effectId"
      :filters="pickerFilters"
      :active-filter-id="pickerFilter"
      :search-query="pickerSearch"
      search-placeholder="Search effects…"
      confirm-label="Use effect"
      empty-message="No effects match your search."
      @close="pickerOpen = false"
      @confirm="pickEffect(($event as EffectDef).id)"
      @update:active-filter-id="pickerFilter = $event"
      @update:search-query="pickerSearch = $event"
    >
      <template #card="{ item }">
        <div class="aspect-video bg-checker overflow-hidden">
          <img v-if="thumbs[(item as EffectDef).id]" :src="thumbs[(item as EffectDef).id]" class="w-full h-full object-cover" />
          <div v-else class="w-full h-full bg-white/[0.03]" />
        </div>
        <div class="px-2 py-1.5">
          <div class="text-[11px] text-white/85 truncate">{{ (item as EffectDef).name }}</div>
          <div class="text-[10px] text-white/35 capitalize">{{ (item as EffectDef).category }}</div>
        </div>
      </template>
    </CatalogModal>
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
