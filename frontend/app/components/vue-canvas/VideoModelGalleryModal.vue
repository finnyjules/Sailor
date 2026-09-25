<script setup lang="ts">
/**
 * VideoModelGalleryModal — picker for the "Generate a video" node. Mirrors
 * ModelGalleryModal (image) with three video-specific additions:
 *   - mode pills on each card (T2V / I2V)
 *   - duration and resolution chips in the detail pane
 *   - MP4-aware cover preview (Replicate returns video cover URLs for these
 *     models, not just stills)
 *
 * State path matches the image gallery:
 *   node.widgetsValues[model_idx]      = selected model id
 *   node.properties.modelOptions[id]   = per-model advanced bag (JSON)
 *   node.widgetsValues[model_opts_idx] = same JSON, mirrored as a hidden widget
 */
import { Sparkles, Zap, DollarSign, Code2, Volume2, Image as ImageIcon, Film,
  Clock, Maximize2, Camera, Layers, Mic } from 'lucide-vue-next'
import {
  VIDEO_MODELS, VIDEO_MODELS_BY_ID, VIDEO_TAG_LABELS, activeVideoTagsInCatalog,
  type VideoModel, type VideoModelTag, type VideoModelMode,
} from '~/data/video-models'
import { BRAND_COLORS, getBrandIcon } from '~/data/brand-icons'
import { snapWidgetsToModel } from '~/lib/videoModelAdapt'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { galleryEntries } from '#shared/runner/modelMenus'
import { NO_FAMILIES, parseFamilies } from '#shared/runner/families'
import { videoRateLabel } from '#shared/pricing/videoRates'

// Price text from the rate card (what the model costs per second at its
// default settings; credits per second in hosted mode). The catalogue's old
// free-form price note is never shown as money.
const hostedPrices = hostedModeEnabled(useRuntimeConfig().public)
function priceLabel(m: VideoModel): string | null {
  return videoRateLabel(m.id, { hosted: hostedPrices })
}

// -- Replicate cover image fetch + cache -----------------------------------
// Same /api/replicate-cover endpoint as the image gallery. Video models
// usually return an MP4 url here; we detect by extension and render as a
// muted autoplay <video>. Falls back to <img> for stills.

interface CoverCacheEntry { url: string | null; fetchedAt: number }
const COVER_CACHE_KEY = 'video-models.coverCache.v1'
const COVER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const coverUrls = ref<Record<string, string | null>>({})
const coverLoading = ref<Set<string>>(new Set())

function loadCoverCache(): Record<string, CoverCacheEntry> {
  try {
    const raw = localStorage.getItem(COVER_CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function saveCoverCache(cache: Record<string, CoverCacheEntry>) {
  try { localStorage.setItem(COVER_CACHE_KEY, JSON.stringify(cache)) } catch {}
}

async function fetchCover(slug: string) {
  if (coverLoading.value.has(slug)) return
  if (slug in coverUrls.value) return
  coverLoading.value.add(slug)
  try {
    const res = await fetch(`/api/replicate-cover?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) { coverUrls.value = { ...coverUrls.value, [slug]: null }; return }
    const data = await res.json() as { url: string | null }
    coverUrls.value = { ...coverUrls.value, [slug]: data.url }
    const cache = loadCoverCache()
    cache[slug] = { url: data.url, fetchedAt: Date.now() }
    saveCoverCache(cache)
  } catch {
    coverUrls.value = { ...coverUrls.value, [slug]: null }
  } finally {
    coverLoading.value.delete(slug)
  }
}

function seedCoversFromCache() {
  const cache = loadCoverCache()
  const now = Date.now()
  const seeded: Record<string, string | null> = {}
  const toFetch: string[] = []
  for (const m of VIDEO_MODELS) {
    const c = cache[m.replicateSlug]
    if (c && (now - c.fetchedAt) < COVER_CACHE_TTL_MS) seeded[m.replicateSlug] = c.url
    else toFetch.push(m.replicateSlug)
  }
  coverUrls.value = seeded
  for (const slug of toFetch) fetchCover(slug)
}

// Heuristic: treat .mp4 / .webm covers as video; everything else as image.
function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?.*)?$/i.test(url)
}

const props = defineProps<{
  nodeId: string
  nodes: any[]
}>()

const emit = defineEmits<{ close: [] }>()

const node = computed(() => props.nodes.find(n => n.id === props.nodeId))

// -- Read node's current model + options -------------------------------------

const modelWidgetIdx = computed(() => {
  const defs = (node.value?.data?.widgetDefs ?? []) as any[]
  return defs.findIndex(d => d.name === 'model')
})

const currentModelId = computed<string | null>(() => {
  const idx = modelWidgetIdx.value
  if (idx < 0) return null
  const val = node.value?.data?.widgetsValues?.[idx]
  return typeof val === 'string' ? val : null
})

function getModelOptions(modelId: string): Record<string, any> {
  const bag = (node.value?.data?.properties as any)?.modelOptions
  if (bag && typeof bag === 'object' && bag[modelId]) return { ...bag[modelId] }
  const model = VIDEO_MODELS_BY_ID[modelId]
  if (!model) return {}
  // Seed with both `advanced` field defaults and a `resolution` if the model
  // has presets — keeps the JSON bag self-describing so a fresh save->reload
  // produces deterministic Replicate calls.
  const seed: Record<string, any> = Object.fromEntries(model.advanced.map(f => [f.name, f.default]))
  if (model.defaultResolution) seed.resolution = model.defaultResolution
  return seed
}

function setModelOptions(modelId: string, opts: Record<string, any>) {
  const data = node.value?.data
  if (!data) return
  if (!data.properties) data.properties = {}
  if (!data.properties.modelOptions) data.properties.modelOptions = {}
  data.properties.modelOptions = { ...data.properties.modelOptions, [modelId]: opts }
  syncOptionsToHiddenWidget()
}

function syncOptionsToHiddenWidget() {
  const data = node.value?.data
  if (!data) return
  const defs = (data.widgetDefs ?? []) as any[]
  const optsIdx = defs.findIndex(d => d.name === 'model_options')
  if (optsIdx < 0) return
  const modelId = data.widgetsValues?.[modelWidgetIdx.value]
  const bag = (data.properties?.modelOptions ?? {})[modelId] ?? {}
  data.widgetsValues[optsIdx] = JSON.stringify(bag)
}

const draftModelId = ref<string | null>(null)
const draftOptions = ref<Record<string, any>>({})

function loadDraftFor(modelId: string | null) {
  draftModelId.value = modelId
  draftOptions.value = modelId ? getModelOptions(modelId) : {}
}

onMounted(() => {
  loadDraftFor(currentModelId.value)
  seedCoversFromCache()
})
watch(() => props.nodeId, () => loadDraftFor(currentModelId.value))

// -- Filtering + search ------------------------------------------------------

// What this gallery offers (shared/runner/modelMenus.ts): no hidden or
// discontinued model, no model of a family switched off, and a runner-only
// model only on a class the runner takes. The node's current model always
// shows, tagged "Hidden" (or "Discontinued") when it is otherwise left out.
const runtimePublic = useRuntimeConfig().public as { runnerEnabled?: boolean, runnerFamilies?: unknown }
const runnerFamilies = runtimePublic.runnerEnabled ? parseFamilies(runtimePublic.runnerFamilies) : NO_FAMILIES
const offered = computed(() => galleryEntries(VIDEO_MODELS, {
  classType: String(node.value?.data?.nodeType ?? 'GenerateVideoNode'),
  families: runnerFamilies,
  current: currentModelId.value,
}))
const offeredModels = computed<VideoModel[]>(() => offered.value.map(e => e.model))
const hiddenTagged = computed(() => new Map(offered.value.filter(e => e.tag).map(e => [e.model.id, e.tag!] as const)))

const searchQuery = ref('')
const activeFilterId = ref<string>('all')

const filters = computed(() => {
  const tags = activeVideoTagsInCatalog()
  const counts = new Map<VideoModelTag, number>()
  for (const m of offeredModels.value) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [
    { id: 'all', label: 'All', count: offeredModels.value.length },
    ...tags.filter(t => counts.get(t)).map(t => ({ id: t, label: VIDEO_TAG_LABELS[t], count: counts.get(t) ?? 0 })),
  ]
})

const visibleItems = computed<VideoModel[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return offeredModels.value.filter((m) => {
    if (activeFilterId.value !== 'all' && !m.tags.includes(activeFilterId.value as VideoModelTag)) return false
    if (!q) return true
    return [m.label, m.brand, m.pitch, m.description ?? '', m.replicateSlug, ...m.tags, ...m.modes]
      .some(s => s.toLowerCase().includes(q))
  })
})

// -- Icons -------------------------------------------------------------------

const TAG_ICONS: Record<VideoModelTag, any> = {
  'flagship':    Sparkles,
  'fast':        Zap,
  'cheap':       DollarSign,
  'open-source': Code2,
  'audio':       Volume2,
  'reference':   ImageIcon,
  'cinematic':   Film,
  'long':        Clock,
  '4k':          Maximize2,
  'multi-shot':  Layers,
  'lip-sync':    Mic,
}

const MODE_LABELS: Record<VideoModelMode, string> = {
  't2v': 'Text → Video',
  'i2v': 'Image → Video',
}

function brandHue(brand: string): string {
  return (BRAND_COLORS as Record<string, string>)[brand] ?? '#888'
}

// -- Commit ------------------------------------------------------------------

function onConfirm(item: VideoModel) {
  const idx = modelWidgetIdx.value
  if (idx < 0) { emit('close'); return }
  node.value!.data.widgetsValues[idx] = item.id
  // Snap duration/aspect to the new model's supported values so a Veo→Kling
  // switch doesn't leave duration '8' stranded on a 5/10 model.
  const snapDefs = node.value!.data.widgetDefs ?? []
  for (const fix of snapWidgetsToModel(snapDefs, node.value!.data.widgetsValues ?? [], item.id)) {
    const i = snapDefs.findIndex((d: any) => d?.name === fix.name)
    if (i >= 0) node.value!.data.widgetsValues[i] = fix.value
  }
  setModelOptions(item.id, draftOptions.value)
  emit('close')
}

watch(() => draftModelId.value, (id) => { if (id) draftOptions.value = getModelOptions(id) })

const focusedModel = computed<VideoModel | null>(() =>
  draftModelId.value ? VIDEO_MODELS_BY_ID[draftModelId.value] ?? null : null,
)
</script>

<template>
  <CatalogModal
    :open="true"
    :title="`Pick a model for &quot;Generate a video&quot;`"
    :subtitle="`${offeredModels.length} models`"
    :items="visibleItems"
    :selected-id="currentModelId"
    :filters="filters"
    :active-filter-id="activeFilterId"
    :search-query="searchQuery"
    search-placeholder="Search by name, brand, capability…"
    :confirm-label="focusedModel ? `Use ${focusedModel.label}` : 'Use this'"
    empty-message="No models match those filters."
    @close="emit('close')"
    @confirm="(item: any) => onConfirm(item as VideoModel)"
    @update:selected-id="(id: string) => loadDraftFor(id)"
    @update:active-filter-id="(id: string) => activeFilterId = id"
    @update:search-query="(q: string) => searchQuery = q"
  >
    <!-- Card -->
    <template #card="{ item, focused }">
      <div
        class="aspect-[16/10] w-full relative overflow-hidden"
        :style="{ background: `linear-gradient(135deg, ${brandHue((item as VideoModel).brand)}33 0%, ${brandHue((item as VideoModel).brand)}11 60%, transparent 100%)` }"
      >
        <!-- Brand wordmark sits behind the cover until it loads. -->
        <div
          class="absolute inset-0 flex items-center justify-center text-[28px] font-bold tracking-tight select-none"
          :style="{ color: brandHue((item as VideoModel).brand) }"
        >
          {{ (item as VideoModel).brand }}
        </div>
        <!-- Cover: <video> when MP4, <img> otherwise. Autoplay muted loop
             so the user gets a feel for motion without needing to click. -->
        <video
          v-if="coverUrls[(item as VideoModel).replicateSlug] && isVideoUrl(coverUrls[(item as VideoModel).replicateSlug]!)"
          :src="coverUrls[(item as VideoModel).replicateSlug]!"
          class="absolute inset-0 w-full h-full object-cover transition-transform duration-500"
          :class="focused ? 'scale-105' : 'group-hover:scale-105'"
          muted
          loop
          autoplay
          playsinline
          preload="metadata"
        />
        <img
          v-else-if="coverUrls[(item as VideoModel).replicateSlug]"
          :src="coverUrls[(item as VideoModel).replicateSlug]!"
          class="absolute inset-0 w-full h-full object-cover transition-transform duration-500"
          :class="focused ? 'scale-105' : 'group-hover:scale-105'"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <div
          v-if="coverUrls[(item as VideoModel).replicateSlug]"
          class="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/45 to-transparent pointer-events-none"
        />
        <!-- Price badge: the rate card's per-second price at the default settings. -->
        <span
          v-if="priceLabel(item as VideoModel)"
          class="absolute top-2 right-2 text-[9px] tabular-nums leading-none px-1.5 py-1 rounded bg-black/55 text-amber-200 border border-amber-400/20 backdrop-blur-sm"
        >{{ priceLabel(item as VideoModel) }}</span>
        <!-- Mode pills: bottom-left so they don't fight the price. -->
        <div class="absolute bottom-2 left-2 flex gap-1">
          <span
            v-for="m in (item as VideoModel).modes"
            :key="m"
            class="text-[9px] uppercase tracking-[0.06em] font-medium leading-none px-1.5 py-1 rounded bg-black/55 text-white/80 border border-white/15 backdrop-blur-sm"
          >{{ m }}</span>
        </div>
      </div>
      <!-- Body -->
      <div class="px-3 pt-2.5 pb-3 flex flex-col gap-1.5">
        <div class="flex flex-col gap-1 min-w-0">
          <span class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-semibold text-white/90 truncate leading-tight">{{ (item as VideoModel).label }}</span>
            <span
              v-if="hiddenTagged.has((item as VideoModel).id)"
              class="shrink-0 text-[9px] leading-none px-1.5 py-0.5 rounded bg-white/[0.08] text-white/60"
              data-testid="model-hidden-tag"
            >{{ hiddenTagged.get((item as VideoModel).id) }}</span>
          </span>
          <span
            class="self-start inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.08em] font-medium px-1.5 py-0.5 rounded leading-none bg-white/[0.05] text-white/55"
          >
            <span
              v-if="getBrandIcon((item as VideoModel).brand)"
              :class="getBrandIcon((item as VideoModel).brand)!.cssClass"
              :style="getBrandIcon((item as VideoModel).brand)!.style === 'mono'
                ? { backgroundColor: 'rgba(255,255,255,0.55)' }
                : undefined"
              class="size-2.5"
            />
            {{ (item as VideoModel).brand }}
          </span>
        </div>
        <p class="text-[11px] leading-snug text-white/55 line-clamp-2 min-h-[2.4em]">
          {{ (item as VideoModel).pitch }}
        </p>
        <div class="flex flex-wrap gap-1 mt-0.5">
          <span
            v-for="t in (item as VideoModel).tags.slice(0, 3)"
            :key="t"
            class="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 border border-white/[0.05]"
          >
            <component :is="TAG_ICONS[t]" class="size-2.5" />
            {{ VIDEO_TAG_LABELS[t] }}
          </span>
        </div>
      </div>
    </template>

    <!-- Detail pane -->
    <template #detail="{ item }">
      <div class="space-y-5">
        <!-- Hero: MP4 or still cover. Same fallback chain as cards. -->
        <div
          v-if="coverUrls[(item as VideoModel).replicateSlug]"
          class="relative aspect-[16/10] w-full overflow-hidden"
          :style="{ background: `linear-gradient(135deg, ${brandHue((item as VideoModel).brand)}33 0%, ${brandHue((item as VideoModel).brand)}11 60%, transparent 100%)` }"
        >
          <video
            v-if="isVideoUrl(coverUrls[(item as VideoModel).replicateSlug]!)"
            :src="coverUrls[(item as VideoModel).replicateSlug]!"
            class="absolute inset-0 w-full h-full object-cover"
            muted loop autoplay playsinline
            preload="metadata"
          />
          <img
            v-else
            :src="coverUrls[(item as VideoModel).replicateSlug]!"
            class="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div class="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#1b1b1b] via-[#1b1b1b]/55 to-transparent pointer-events-none" />
        </div>
        <div class="p-5 space-y-5" :class="coverUrls[(item as VideoModel).replicateSlug] ? '-mt-5 relative z-10' : ''">

          <!-- Header -->
          <div>
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="text-sm font-semibold text-white/95">{{ (item as VideoModel).label }}</span>
              <span
                class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] font-medium px-1.5 py-0.5 rounded bg-white/[0.06] text-white/65"
              >
                <span
                  v-if="getBrandIcon((item as VideoModel).brand)"
                  :class="getBrandIcon((item as VideoModel).brand)!.cssClass"
                  :style="getBrandIcon((item as VideoModel).brand)!.style === 'mono'
                    ? { backgroundColor: 'rgba(255,255,255,0.7)' }
                    : undefined"
                  class="size-3 inline-block"
                />
                {{ (item as VideoModel).brand }}
              </span>
              <!-- Mode pills inline with the title so it reads as a header. -->
              <span
                v-for="m in (item as VideoModel).modes"
                :key="m"
                class="text-[10px] uppercase tracking-[0.06em] font-medium px-1.5 py-0.5 rounded bg-white/15 text-white/70 border border-white/20"
                :title="MODE_LABELS[m]"
              >{{ m }}</span>
            </div>
            <p class="text-[11.5px] text-white/65 leading-relaxed">
              {{ (item as VideoModel).description ?? (item as VideoModel).pitch }}
            </p>
            <a
              :href="`https://replicate.com/${(item as VideoModel).replicateSlug}`"
              target="_blank"
              rel="noopener"
              class="inline-block mt-2 text-[10px] text-white/40 hover:text-white/70 font-mono transition-colors"
            >
              replicate.com/{{ (item as VideoModel).replicateSlug }} ↗
            </a>
          </div>

          <!-- Price + tag chips -->
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              v-if="priceLabel(item as VideoModel)"
              class="inline-flex items-center gap-1 text-[10px] tabular-nums px-2 py-1 rounded bg-amber-500/10 text-amber-200 border border-amber-400/15"
            >
              {{ priceLabel(item as VideoModel) }}
            </span>
            <span
              v-for="t in (item as VideoModel).tags"
              :key="t"
              class="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 border border-white/[0.05]"
            >
              <component :is="TAG_ICONS[t]" class="size-2.5" />
              {{ VIDEO_TAG_LABELS[t] }}
            </span>
          </div>

          <!-- Duration + resolution presets ----------------------------------
               Duration is a node-level widget (model dispatcher remaps) so we
               just show what's supported. Resolution lives in the bag, so we
               offer a picker here for models that have presets. -->
          <div class="grid grid-cols-2 gap-3 pt-3 border-t border-white/[0.06]">
            <div>
              <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold mb-2 flex items-center gap-1.5">
                <Clock class="size-3" /> Durations
              </div>
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="d in (item as VideoModel).durations"
                  :key="d"
                  class="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-white/[0.04] text-white/55 border border-white/[0.05]"
                >{{ d }}s</span>
              </div>
            </div>
            <div v-if="(item as VideoModel).resolutions?.length">
              <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold mb-2 flex items-center gap-1.5">
                <Maximize2 class="size-3" /> Resolution
              </div>
              <!-- Resolution selector — writes into the bag immediately. -->
              <select
                :value="draftOptions.resolution ?? (item as VideoModel).defaultResolution"
                class="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 cursor-pointer outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                @change="draftOptions = { ...draftOptions, resolution: ($event.target as HTMLSelectElement).value }"
              >
                <option v-for="r in (item as VideoModel).resolutions" :key="r" :value="r" class="bg-[#1b1b1b]">{{ r }}</option>
              </select>
            </div>
          </div>

          <!-- Advanced settings -->
          <div v-if="(item as VideoModel).advanced.length" class="space-y-3 pt-3 border-t border-white/[0.06]">
            <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold">
              Advanced settings
            </div>
            <div class="space-y-3">
              <div
                v-for="field in (item as VideoModel).advanced"
                :key="field.name"
                class="space-y-1"
              >
                <label class="block text-[10.5px] text-white/65" :title="field.description">
                  {{ field.label }}
                  <span v-if="field.description" class="text-white/30">— {{ field.description }}</span>
                </label>
                <select
                  v-if="field.type === 'select'"
                  :value="draftOptions[field.name] ?? field.default"
                  class="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 cursor-pointer outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                  @change="draftOptions = { ...draftOptions, [field.name]: ($event.target as HTMLSelectElement).value }"
                >
                  <option v-for="opt in field.options" :key="opt" :value="opt" class="bg-[#1b1b1b]">{{ opt }}</option>
                </select>
                <input
                  v-else-if="field.type === 'integer' || field.type === 'float'"
                  type="number"
                  :value="draftOptions[field.name] ?? field.default"
                  :min="field.min"
                  :max="field.max"
                  :step="field.step ?? (field.type === 'integer' ? 1 : 0.1)"
                  class="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                  @input="draftOptions = { ...draftOptions, [field.name]: field.type === 'integer'
                    ? parseInt(($event.target as HTMLInputElement).value, 10)
                    : parseFloat(($event.target as HTMLInputElement).value) }"
                />
                <label v-else-if="field.type === 'boolean'" class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    :checked="!!(draftOptions[field.name] ?? field.default)"
                    class="size-3.5 rounded border-white/20 bg-white/[0.04] cursor-pointer accent-white"
                    @change="draftOptions = { ...draftOptions, [field.name]: ($event.target as HTMLInputElement).checked }"
                  />
                  <span class="text-[11px] text-white/65">
                    {{ (draftOptions[field.name] ?? field.default) ? 'On' : 'Off' }}
                  </span>
                </label>
                <input
                  v-else
                  type="text"
                  :value="draftOptions[field.name] ?? field.default"
                  class="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                  @input="draftOptions = { ...draftOptions, [field.name]: ($event.target as HTMLInputElement).value }"
                />
              </div>
            </div>
          </div>

          <!-- Aspect ratios this model supports -->
          <div class="pt-3 border-t border-white/[0.06]">
            <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold mb-2">
              Supported aspect ratios
            </div>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="ar in (item as VideoModel).aspectRatios"
                :key="ar"
                class="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-white/[0.04] text-white/55 border border-white/[0.05]"
              >{{ ar }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </CatalogModal>
</template>
