<script setup lang="ts">
/**
 * ModelGalleryModal — image-generation model picker for the "Generate an
 * image" node. Wraps CatalogModal with model-specific card + detail rendering
 * and writes the selected model + its per-model advanced settings back into
 * the node.
 *
 * State path:
 *   node.widgetsValues[model_idx]      = selected model id  (Combo widget)
 *   node.properties.modelOptions[id]   = per-model advanced bag (JSON)
 *
 * The shared inputs (prompt, aspect_ratio, seed) stay on the node as
 * regular widgets — only model selection + model-specific tuning lives
 * here.
 */
import { Sparkles, Zap, DollarSign, Type as TypeIcon, Layout, Box as VectorIcon,
  Camera, Film, Brush, Code2, Maximize2, Layers } from 'lucide-vue-next'
import {
  IMAGE_MODELS, IMAGE_MODELS_BY_ID, TAG_LABELS, activeTagsInCatalog,
  type ImageModel, type ImageModelTag, type ImageModelAdvancedField,
} from '~/data/image-models'
import { BRAND_COLORS, getBrandIcon } from '~/data/brand-icons'
import { hostedModeEnabled } from '~/lib/hostedMode'
import { galleryEntries } from '#shared/runner/modelMenus'
import { NO_FAMILIES, parseFamilies } from '#shared/runner/families'
import { imageRateLabel } from '#shared/pricing/imageRates'

// -- Replicate cover image fetch + cache -----------------------------------
//
// Each model's card uses Replicate's official `cover_image_url` when we can
// fetch it. Cached in localStorage for a week so a remount doesn't refetch.
// Negative results (no cover available) are cached too so we don't keep
// retrying empty models.
// Same pattern as LoRALibraryPanel — see its loadPreviewCache for prior art.

interface CoverCacheEntry {
  url: string | null
  fetchedAt: number
}
const COVER_CACHE_KEY = 'image-models.coverCache.v1'
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
    if (!res.ok) {
      coverUrls.value = { ...coverUrls.value, [slug]: null }
      return
    }
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
  for (const m of IMAGE_MODELS) {
    const c = cache[m.replicateSlug]
    if (c && (now - c.fetchedAt) < COVER_CACHE_TTL_MS) {
      seeded[m.replicateSlug] = c.url
    } else {
      toFetch.push(m.replicateSlug)
    }
  }
  coverUrls.value = seeded
  for (const slug of toFetch) fetchCover(slug)
}

const props = defineProps<{
  nodeId: string
  nodes: any[]
}>()

const emit = defineEmits<{ close: [] }>()

const node = computed(() => props.nodes.find(n => n.id === props.nodeId))

// -- Read the node's current model + options ---------------------------------

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

// per-node, per-model JSON bag stored in node.properties.modelOptions[modelId]
function getModelOptions(modelId: string): Record<string, any> {
  const bag = (node.value?.data?.properties as any)?.modelOptions
  if (bag && typeof bag === 'object' && bag[modelId]) return { ...bag[modelId] }
  // Seed with defaults from the catalog so the form has values to bind.
  const model = IMAGE_MODELS_BY_ID[modelId]
  if (!model) return {}
  return Object.fromEntries(model.advanced.map(f => [f.name, f.default]))
}

function setModelOptions(modelId: string, opts: Record<string, any>) {
  const data = node.value?.data
  if (!data) return
  if (!data.properties) data.properties = {}
  if (!data.properties.modelOptions) data.properties.modelOptions = {}
  data.properties.modelOptions = {
    ...data.properties.modelOptions,
    [modelId]: opts,
  }
  syncOptionsToHiddenWidget()
}

// Mirror the *active* model's options bag into the hidden `model_options`
// STRING widget so the backend's `execute()` receives the JSON without
// needing a separate `properties` channel. Idempotent — safe to call after
// every edit.
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

// Working draft — what the user is editing in the modal. Committed on
// "Use this model"; discarded on close. Keeps the canvas state stable
// while the user fiddles inside the modal.
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
// Re-seed when the node we're attached to changes (e.g. the modal is reused
// across different nodes via the same mount point).
watch(() => props.nodeId, () => loadDraftFor(currentModelId.value))

// -- Filtering + search ------------------------------------------------------

// What this gallery offers (shared/runner/modelMenus.ts): no hidden or
// discontinued model, no model of a family switched off, and a runner-only
// model only on a class the runner takes. The node's current model always
// shows, tagged "Hidden" when it is otherwise left out, and still works.
const runtimePublic = useRuntimeConfig().public as { runnerEnabled?: boolean, runnerFamilies?: unknown }
const runnerFamilies = runtimePublic.runnerEnabled ? parseFamilies(runtimePublic.runnerFamilies) : NO_FAMILIES
const offered = computed(() => galleryEntries(IMAGE_MODELS, {
  classType: String(node.value?.data?.nodeType ?? 'GenerateImageNode'),
  families: runnerFamilies,
  current: currentModelId.value,
}))
const offeredModels = computed<ImageModel[]>(() => offered.value.map(e => e.model))
const hiddenTagged = computed(() => new Set(offered.value.filter(e => e.hiddenTag).map(e => e.model.id)))

const searchQuery = ref('')
const activeFilterId = ref<string>('all')

const filters = computed(() => {
  const tags = activeTagsInCatalog()
  const counts = new Map<ImageModelTag, number>()
  for (const m of offeredModels.value) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [
    { id: 'all', label: 'All', count: offeredModels.value.length },
    ...tags.filter(t => counts.get(t)).map(t => ({ id: t, label: TAG_LABELS[t], count: counts.get(t) ?? 0 })),
  ]
})

const visibleItems = computed<ImageModel[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return offeredModels.value.filter((m) => {
    if (activeFilterId.value !== 'all' && !m.tags.includes(activeFilterId.value as ImageModelTag)) return false
    if (!q) return true
    return [m.label, m.brand, m.pitch, m.description ?? '', m.replicateSlug, ...m.tags]
      .some(s => s.toLowerCase().includes(q))
  })
})

// -- Tag → icon (small chip glyph) -------------------------------------------

const TAG_ICONS: Record<ImageModelTag, any> = {
  'flagship':    Sparkles,
  'fast':        Zap,
  'cheap':       DollarSign,
  'typography':  TypeIcon,
  'design':      Layout,
  'svg':         VectorIcon,
  'photoreal':   Camera,
  'cinematic':   Film,
  'anime':       Brush,
  'open-source': Code2,
  '4k':          Maximize2,
  'multi-image': Layers,
}

// Brand colors + icons live in ~/data/brand-icons (single source of truth
// shared with the launcher widget). `brandHue` is the thin lookup wrapper
// the templates below use.

function brandHue(brand: string): string {
  return (BRAND_COLORS as Record<string, string>)[brand] ?? '#888'
}

// Price text from the rate card: one picture at the model's default settings,
// and "up to" the dearest size or quality when that costs more (credits in
// hosted mode). The default figure is the catalogue's pricePerImage (a test
// pins the two together).
const hostedPrices = hostedModeEnabled(useRuntimeConfig().public)
function priceLabel(m: ImageModel): string | null {
  return imageRateLabel(m.id, m.defaultAspectRatio, { hosted: hostedPrices })
}

// -- Commit ------------------------------------------------------------------

function onConfirm(item: ImageModel) {
  const idx = modelWidgetIdx.value
  if (idx < 0) {
    emit('close')
    return
  }
  // 1) Set the model combo value.
  node.value!.data.widgetsValues[idx] = item.id
  // 2) Persist the per-model options bag.
  setModelOptions(item.id, draftOptions.value)
  // 3) Manual model choice wins (moodboards Plan B, Task B3): drop the
  // moodboard auto-switch marker so a later apply never re-switches over a
  // model the user picked here on purpose.
  const p = node.value!.data.properties as Record<string, any> | undefined
  if (p && 'sailor_moodboard_switched' in p) delete p.sailor_moodboard_switched
  emit('close')
}

// When the user focuses a different model in the gallery, load its draft
// options too so the right pane reflects that model's settings. Re-uses
// any prior state stored on the node.
watch(() => draftModelId.value, (id) => {
  if (id) draftOptions.value = getModelOptions(id)
})

const focusedModel = computed<ImageModel | null>(() =>
  draftModelId.value ? IMAGE_MODELS_BY_ID[draftModelId.value] ?? null : null,
)
</script>

<template>
  <CatalogModal
    :open="true"
    :title="`Pick a model for &quot;Generate an image&quot;`"
    :subtitle="`${IMAGE_MODELS.length} models · Replicate`"
    :items="visibleItems"
    :selected-id="currentModelId"
    :filters="filters"
    :active-filter-id="activeFilterId"
    :search-query="searchQuery"
    search-placeholder="Search by name, brand, capability…"
    :confirm-label="focusedModel ? `Use ${focusedModel.label}` : 'Use this'"
    empty-message="No models match those filters."
    @close="emit('close')"
    @confirm="(item: any) => onConfirm(item as ImageModel)"
    @update:selected-id="(id: string) => loadDraftFor(id)"
    @update:active-filter-id="(id: string) => activeFilterId = id"
    @update:search-query="(q: string) => searchQuery = q"
  >
    <!-- Card -->
    <template #card="{ item, focused }">
      <!-- Thumbnail: Replicate cover image when fetched, brand wordmark
           swatch underneath until it loads / on failure. -->
      <div
        class="aspect-[16/10] w-full relative overflow-hidden"
        :style="{ background: `linear-gradient(135deg, ${brandHue((item as ImageModel).brand)}33 0%, ${brandHue((item as ImageModel).brand)}11 60%, transparent 100%)` }"
      >
        <!-- Brand wordmark sits behind the cover so the card stays visually
             populated while the cover image is in-flight or absent. -->
        <div
          class="absolute inset-0 flex items-center justify-center text-[28px] font-bold tracking-tight select-none"
          :style="{ color: brandHue((item as ImageModel).brand) }"
        >
          {{ (item as ImageModel).brand }}
        </div>
        <img
          v-if="coverUrls[(item as ImageModel).replicateSlug]"
          :src="coverUrls[(item as ImageModel).replicateSlug]!"
          class="absolute inset-0 w-full h-full object-cover transition-transform duration-500"
          :class="focused ? 'scale-105' : 'group-hover:scale-105'"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <!-- Top vignette darkens the cover image just enough that the price
             badge stays legible no matter what's behind it. -->
        <div
          v-if="coverUrls[(item as ImageModel).replicateSlug]"
          class="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/45 to-transparent pointer-events-none"
        />
        <!-- Price badge -->
        <span
          v-if="priceLabel(item as ImageModel)"
          class="absolute top-2 right-2 text-[9px] tabular-nums leading-none px-1.5 py-1 rounded bg-black/55 text-amber-200 border border-amber-400/20 backdrop-blur-sm"
        >{{ priceLabel(item as ImageModel) }}</span>
      </div>
      <!-- Body -->
      <div class="px-3 pt-2.5 pb-3 flex flex-col gap-1.5">
        <div class="flex flex-col gap-1 min-w-0">
          <span class="flex items-center gap-1.5 min-w-0">
            <span class="text-[13px] font-semibold text-white/90 truncate leading-tight">{{ (item as ImageModel).label }}</span>
            <span
              v-if="hiddenTagged.has((item as ImageModel).id)"
              class="shrink-0 text-[9px] leading-none px-1.5 py-0.5 rounded bg-white/[0.08] text-white/60"
              data-testid="model-hidden-tag"
            >Hidden</span>
          </span>
          <!-- Brand chip: neutral pill with the brand icon as a leading bullet.
               Color icons keep their baked-in gradients; mono icons fall in
               with the muted text tone so the chip reads as one unit. -->
          <span
            class="self-start inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.08em] font-medium px-1.5 py-0.5 rounded leading-none bg-white/[0.05] text-white/55"
          >
            <span
              v-if="getBrandIcon((item as ImageModel).brand)"
              :class="getBrandIcon((item as ImageModel).brand)!.cssClass"
              :style="getBrandIcon((item as ImageModel).brand)!.style === 'mono'
                ? { backgroundColor: 'rgba(255,255,255,0.55)' }
                : undefined"
              class="size-2.5"
            />
            {{ (item as ImageModel).brand }}
          </span>
        </div>
        <p class="text-[11px] leading-snug text-white/55 line-clamp-2 min-h-[2.4em]">
          {{ (item as ImageModel).pitch }}
        </p>
        <div class="flex flex-wrap gap-1 mt-0.5">
          <span
            v-for="t in (item as ImageModel).tags.slice(0, 3)"
            :key="t"
            class="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 border border-white/[0.05]"
          >
            <component :is="TAG_ICONS[t]" class="size-2.5" />
            {{ TAG_LABELS[t] }}
          </span>
        </div>
      </div>
    </template>

    <!-- Detail pane -->
    <template #detail="{ item }">
      <div class="space-y-5">
        <!-- Cover hero — when available, gives a big preview of the model's
             aesthetic so the user can pick by vibe, not just spec sheet. -->
        <div
          v-if="coverUrls[(item as ImageModel).replicateSlug]"
          class="relative aspect-[16/10] w-full overflow-hidden"
          :style="{ background: `linear-gradient(135deg, ${brandHue((item as ImageModel).brand)}33 0%, ${brandHue((item as ImageModel).brand)}11 60%, transparent 100%)` }"
        >
          <img
            :src="coverUrls[(item as ImageModel).replicateSlug]!"
            class="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div class="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#1b1b1b] via-[#1b1b1b]/55 to-transparent pointer-events-none" />
        </div>
        <div class="p-5 space-y-5" :class="coverUrls[(item as ImageModel).replicateSlug] ? '-mt-5 relative z-10' : ''">
        <!-- Header -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-sm font-semibold text-white/95">{{ (item as ImageModel).label }}</span>
            <span
              class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] font-medium px-1.5 py-0.5 rounded bg-white/[0.06] text-white/65"
            >
              <span
                v-if="getBrandIcon((item as ImageModel).brand)"
                :class="getBrandIcon((item as ImageModel).brand)!.cssClass"
                :style="getBrandIcon((item as ImageModel).brand)!.style === 'mono'
                  ? { backgroundColor: 'rgba(255,255,255,0.7)' }
                  : undefined"
                class="size-3 inline-block"
              />
              {{ (item as ImageModel).brand }}
            </span>
          </div>
          <p class="text-[11.5px] text-white/65 leading-relaxed">
            {{ (item as ImageModel).description ?? (item as ImageModel).pitch }}
          </p>
          <a
            :href="`https://replicate.com/${(item as ImageModel).replicateSlug}`"
            target="_blank"
            rel="noopener"
            class="inline-block mt-2 text-[10px] text-white/40 hover:text-white/70 font-mono transition-colors"
          >
            replicate.com/{{ (item as ImageModel).replicateSlug }} ↗
          </a>
        </div>

        <!-- Price + tag chips -->
        <div class="flex flex-wrap items-center gap-1.5">
          <span
            v-if="priceLabel(item as ImageModel)"
            class="inline-flex items-center gap-1 text-[10px] tabular-nums px-2 py-1 rounded bg-amber-500/10 text-amber-200 border border-amber-400/15"
          >
            {{ priceLabel(item as ImageModel) }} per image
          </span>
          <span
            v-for="t in (item as ImageModel).tags"
            :key="t"
            class="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.05em] px-1.5 py-0.5 rounded bg-white/[0.05] text-white/55 border border-white/[0.05]"
          >
            <component :is="TAG_ICONS[t]" class="size-2.5" />
            {{ TAG_LABELS[t] }}
          </span>
        </div>

        <!-- Advanced settings -->
        <div v-if="(item as ImageModel).advanced.length" class="space-y-3 pt-1 border-t border-white/[0.06]">
          <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold pt-3">
            Advanced settings
          </div>
          <div class="space-y-3">
            <div
              v-for="field in (item as ImageModel).advanced"
              :key="field.name"
              class="space-y-1"
            >
              <label class="block text-[10.5px] text-white/65" :title="field.description">
                {{ field.label }}
                <span v-if="field.description" class="text-white/30">— {{ field.description }}</span>
              </label>
              <!-- Select -->
              <select
                v-if="field.type === 'select'"
                :value="draftOptions[field.name] ?? field.default"
                class="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white/85 cursor-pointer outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                @change="draftOptions = { ...draftOptions, [field.name]: ($event.target as HTMLSelectElement).value }"
              >
                <option v-for="opt in field.options" :key="opt" :value="opt" class="bg-[#1b1b1b]">{{ opt }}</option>
              </select>
              <!-- Integer / Float -->
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
              <!-- Boolean -->
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
              <!-- String -->
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
        <div v-else class="pt-3 border-t border-white/[0.06] text-[11px] text-white/40 italic">
          No advanced settings — this model uses sane defaults.
        </div>

        <!-- Aspect ratios this model supports -->
        <div class="pt-3 border-t border-white/[0.06]">
          <div class="text-[10px] uppercase tracking-[0.08em] text-white/40 font-semibold mb-2">
            Supported aspect ratios
          </div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="ar in (item as ImageModel).aspectRatios"
              :key="ar"
              class="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-white/[0.04] text-white/55 border border-white/[0.05]"
            >
              {{ ar }}
            </span>
          </div>
        </div>
        </div>
      </div>
    </template>
  </CatalogModal>
</template>
