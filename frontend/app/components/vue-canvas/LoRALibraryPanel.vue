<script setup lang="ts">
/**
 * LoRA Library — visual picker for curated public Flux LoRAs.
 *
 * Click a tile → adds a "Flux Dev + LoRA (Replicate)" node to the canvas
 * with the `lora_url` widget pre-filled (HuggingFace path). The example
 * prompt and trigger word are surfaced in the tile so the user knows what
 * to type.
 */
import {
  Search as SearchIcon,
  X,
  Library,
  Sparkles,
  Copy,
  ArrowUpRight,
  Drama,
  LayoutGrid,
  Settings2,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'

import {
  LORA_LIBRARY,
  type LoRALibraryEntry,
} from '~/data/lora-library'
import { useNodeSearch } from '~/composables/useNodeSearch'
import { useLocalLoras, type LocalLora } from '~/composables/useLocalLoras'
import StyleHubModal from '~/components/StyleHubModal.vue'

defineEmits<{ close: [] }>()

const { addNode } = useNodeSearch()
const hubOpen = ref(false)

// ── Tabs + search ─────────────────────────────────────────────────────────
// Two tabs only: "Your Styles" (your trained, non-character LoRAs) and
// "Legacy" (the curated public LoRA library). Characters live in their own
// panel, so they never appear here.

type FilterTab = 'Your Styles' | 'Legacy'
const FILTER_TABS: FilterTab[] = ['Your Styles', 'Legacy']
const activeTab = ref<FilterTab>('Your Styles')
const searchQuery = ref('')

const visibleEntries = computed<LoRALibraryEntry[]>(() => {
  if (activeTab.value !== 'Legacy') return []
  const q = searchQuery.value.trim().toLowerCase()
  return LORA_LIBRARY.filter(e =>
    !q
    || e.label.toLowerCase().includes(q)
    || e.blurb.toLowerCase().includes(q)
    || e.trigger.toLowerCase().includes(q)
    || e.author.toLowerCase().includes(q)
    || e.hfPath.toLowerCase().includes(q)
    || e.category.toLowerCase().includes(q),
  )
})

// A trained LoRA lives in exactly one place: characters go to the Characters
// panel, everything else is a style here.
const localStyleLoras = computed(() => localLoras.value.filter(l => l.kind !== 'character'))

function tabCount(tab: FilterTab): number {
  return tab === 'Your Styles' ? localStyleLoras.value.length : LORA_LIBRARY.length
}

// ── Adding to canvas ──────────────────────────────────────────────────────

function useEntry(entry: LoRALibraryEntry) {
  addNode('FluxLoRARemoteNode', {
    widgetOverrides: {
      lora_url: entry.hfPath,
      // Pre-fill the prompt if the LoRA shipped an example.
      ...(entry.examplePrompt ? { prompt: entry.examplePrompt } : {}),
      ...(entry.suggestedScale != null ? { lora_scale: entry.suggestedScale } : {}),
    },
  })
  toast.success(`Added ${entry.label}`, {
    description: `Trigger: ${entry.trigger}`,
  })
}

async function copyHfPath(entry: LoRALibraryEntry, e: Event) {
  e.stopPropagation()
  try {
    await navigator.clipboard.writeText(entry.hfPath)
    toast.success('Copied HF path', { description: entry.hfPath })
  } catch {
    toast.error('Couldn\'t copy — paste manually')
  }
}

function openHfPage(entry: LoRALibraryEntry, e: Event) {
  e.stopPropagation()
  window.open(`https://huggingface.co/${entry.hfPath}`, '_blank', 'noopener')
}

// ── Tile color (deterministic from author) ───────────────────────────────
// Used as a backdrop while the HF preview image loads, and as a fallback
// when no example image can be resolved. Same author → same hue across
// reloads.

function entryColor(entry: LoRALibraryEntry): { bg: string; accent: string } {
  let h = 0
  for (let i = 0; i < entry.author.length; i++) {
    h = ((h * 31) + entry.author.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return {
    bg: `linear-gradient(135deg, hsl(${hue}, 45%, 22%) 0%, hsl(${(hue + 30) % 360}, 50%, 14%) 100%)`,
    accent: `hsl(${hue}, 75%, 75%)`,
  }
}

// ── HuggingFace preview image fetch + cache ──────────────────────────────
//
// One preview URL per LoRA, resolved by /api/lora-preview (Nuxt server route
// that talks to HF). Cached in localStorage for a week so we don't refetch
// every panel mount.

interface PreviewCacheEntry {
  url: string | null
  fetchedAt: number
}
const PREVIEW_CACHE_KEY = 'lora-library.previewCache.v1'
const PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const previewUrls = ref<Record<string, string | null>>({})
const previewLoading = ref<Set<string>>(new Set())

function loadPreviewCache(): Record<string, PreviewCacheEntry> {
  try {
    const raw = localStorage.getItem(PREVIEW_CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function savePreviewCache(cache: Record<string, PreviewCacheEntry>) {
  try { localStorage.setItem(PREVIEW_CACHE_KEY, JSON.stringify(cache)) } catch {}
}

async function fetchPreview(hfPath: string) {
  if (previewLoading.value.has(hfPath)) return
  if (hfPath in previewUrls.value) return
  previewLoading.value.add(hfPath)
  try {
    const res = await fetch(`/api/lora-preview?path=${encodeURIComponent(hfPath)}`)
    if (!res.ok) {
      previewUrls.value = { ...previewUrls.value, [hfPath]: null }
      return
    }
    const data = await res.json() as { url: string | null }
    previewUrls.value = { ...previewUrls.value, [hfPath]: data.url }
    // Persist (negative cache included — saves re-querying broken LoRAs).
    const cache = loadPreviewCache()
    cache[hfPath] = { url: data.url, fetchedAt: Date.now() }
    savePreviewCache(cache)
  } catch {
    previewUrls.value = { ...previewUrls.value, [hfPath]: null }
  } finally {
    previewLoading.value.delete(hfPath)
  }
}

onMounted(() => {
  // Seed from cache + queue fresh fetches for anything missing/expired.
  const cache = loadPreviewCache()
  const now = Date.now()
  const seeded: Record<string, string | null> = {}
  const toFetch: string[] = []
  for (const e of LORA_LIBRARY) {
    const c = cache[e.hfPath]
    if (c && (now - c.fetchedAt) < PREVIEW_CACHE_TTL_MS) {
      seeded[e.hfPath] = c.url
    } else {
      toFetch.push(e.hfPath)
    }
  }
  previewUrls.value = seeded
  // Fire-and-forget — UI will reactively update as each resolves.
  for (const p of toFetch) fetchPreview(p)
})

// ── Your trained LoRAs (local library/loras + sidecars) ────────────────────
// Shared cached client with loading/error state, so the tab can show a
// spinner or a retry line instead of a false "No trained styles yet."
const { loras: localLoras, loading: lorasLoading, error: lorasError, refresh: refreshLocalLoras } = useLocalLoras()
onMounted(() => { void refreshLocalLoras() })

const visibleLocal = computed<LocalLora[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  // Shown only on the "Your Styles" tab.
  if (activeTab.value !== 'Your Styles') return []
  return localStyleLoras.value.filter(l =>
    !q || l.name.toLowerCase().includes(q) || l.filename.toLowerCase().includes(q))
})

// Loading/error only gate the "Your Styles" tab — the Legacy library is a
// static import and can't fail.
const showLorasLoading = computed(() =>
  activeTab.value === 'Your Styles' && lorasLoading.value && !visibleLocal.value.length)
const showLorasError = computed(() =>
  activeTab.value === 'Your Styles' && !lorasLoading.value && !!lorasError.value)

function useLocalLora(l: LocalLora) {
  // The style block (aesthetic + trigger) goes in the node's collapsed
  // "Style" field — stored as a node PROPERTY, not a ComfyUI input, so the schema
  // stays stable — and is folded into the prompt at run time. Keeps the prompt
  // box clean for the user's scene.
  const trig = l.trigger?.trim()
  const style = [l.aesthetic?.trim(), trig ? `${trig},` : ''].filter(Boolean).join(' ')
  addNode('FluxLoRARemoteNode', {
    // Drive by filename — the node resolves it server-side via the sidecar and
    // runs the user's own trained model directly (LoRA baked in, private). NEVER
    // pass the .tar `url` into lora_url: flux-dev-lora can't parse it, and the
    // trained model is private so its weights aren't anonymously fetchable.
    widgetOverrides: { lora_name: l.filename },
    ...(style ? { propertyOverrides: { aesthetic: style } } : {}),
  })
  toast.success(`Added ${l.name}`, {
    description: l.trigger ? `Trigger: ${l.trigger}` : (l.baseModel ? `Base: ${l.baseModel}` : undefined),
  })
}

// Promote a trained LoRA to a character — it moves to the Characters panel,
// where it can be stacked with a style. Tag lives in the sidecar (PATCH kind).
const promoting = ref<Set<string>>(new Set())
async function markAsCharacter(l: LocalLora, e: Event) {
  e.stopPropagation()
  promoting.value.add(l.filename)
  try {
    const res = await fetch('/api/loras-local', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: l.filename, kind: 'character' }),
    })
    if (!res.ok) throw new Error()
    const target = localLoras.value.find(x => x.filename === l.filename)
    if (target) target.kind = 'character'  // drops it from this list, into Characters
    toast.success(`${l.name} is now a character`, {
      description: 'Find it in the Characters panel.',
    })
  } catch {
    toast.error('Couldn\'t update — try again')
  } finally {
    promoting.value.delete(l.filename)
  }
}

const searchInputRef = ref<HTMLInputElement | null>(null)
function clearSearch() {
  searchQuery.value = ''
  searchInputRef.value?.focus()
}
</script>

<template>
  <div class="h-full bg-[#1a1a1a]/95 backdrop-blur-md border-r border-white/10 flex flex-col shadow-2xl">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
      <div class="flex items-center gap-2">
        <Library class="size-4 text-white/70" />
        <span class="text-sm font-semibold text-white/90">Styles</span>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="flex items-center gap-1 px-2 h-6 rounded text-xs text-white/60 hover:bg-white/10 hover:text-white/90"
          title="Browse the style library"
          @click="hubOpen = true"
        >
          <LayoutGrid class="size-3.5" />
          Browse
        </button>
        <NuxtLink
          to="/dev/style-publisher"
          target="_blank"
          class="flex items-center gap-1 px-2 h-6 rounded text-xs text-white/60 hover:bg-white/10 hover:text-white/90"
          title="Manage & publish styles (Style Publisher)"
        >
          <Settings2 class="size-3.5" />
          Manage
        </NuxtLink>
        <button
          class="flex items-center justify-center size-6 rounded hover:bg-white/10 transition-colors cursor-pointer"
          @click="$emit('close')"
        >
          <X class="size-4 text-white/60" />
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="px-3 pt-3 pb-2">
      <div class="relative">
        <SearchIcon class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-white/40 pointer-events-none" />
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          placeholder="Search styles…"
          class="w-full bg-white/[0.04] border border-white/10 rounded pl-7 pr-7 py-1.5 text-xs text-white/85 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
          @keydown.esc="clearSearch"
        />
        <button
          v-if="searchQuery"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 size-4 rounded hover:bg-white/10 flex items-center justify-center cursor-pointer"
          title="Clear search"
          @click="clearSearch"
        >
          <X class="size-3 text-white/50" />
        </button>
      </div>
    </div>

    <!-- Tabs: Your Styles · Legacy -->
    <div class="px-2 pb-2 flex gap-1">
      <button
        v-for="tab in FILTER_TABS"
        :key="tab"
        class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] transition-colors cursor-pointer"
        :class="activeTab === tab
          ? 'bg-white/[0.12] text-white font-medium'
          : 'text-white/50 hover:text-white/80 hover:bg-white/[0.05]'"
        @click="activeTab = tab"
      >
        <span>{{ tab }}</span>
        <span class="text-white/35 tabular-nums">{{ tabCount(tab) }}</span>
      </button>
    </div>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto px-2 pb-3 space-y-2">
      <!-- Your trained LoRAs (own filter tab) -->
      <div v-if="visibleLocal.length" class="grid grid-cols-2 gap-2 pt-1">
          <button
            v-for="l in visibleLocal"
            :key="l.filename"
            class="group relative rounded border border-white/[0.08] hover:border-white/20 transition-colors cursor-pointer overflow-hidden aspect-[4/3] text-left"
            :title="l.aesthetic ? `Add ${l.name}\n\nStyle profile (added to prompt):\n${l.aesthetic}` : `Add ${l.name}`"
            @click="useLocalLora(l)"
          >
            <!-- Cover image, or a violet gradient fallback when none exists yet -->
            <img
              v-if="l.coverUrl"
              :src="l.coverUrl"
              class="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
            />
            <div
              v-else
              class="absolute inset-0 flex items-center justify-center"
              style="background: linear-gradient(135deg, hsl(265,42%,20%) 0%, hsl(292,46%,12%) 100%)"
            >
              <Sparkles class="size-6 text-white/30" />
            </div>
            <!-- Hover action: promote to a character -->
            <button
              class="absolute top-1.5 right-1.5 size-6 rounded bg-black/55 hover:bg-white/15 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-100"
              :title="`Make &quot;${l.name}&quot; a character`"
              :disabled="promoting.has(l.filename)"
              @click="markAsCharacter(l, $event)"
            >
              <Drama class="size-3 text-white/90" />
            </button>
            <!-- Name on a bottom scrim so it stays legible over any cover -->
            <div class="absolute inset-x-0 bottom-0 px-2 pt-5 pb-1.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent">
              <div class="text-[11px] font-medium text-white truncate">{{ l.name }}</div>
            </div>
          </button>
      </div>

      <!-- Loading: the trained-styles fetch is pending — never show the
           "No trained styles yet" empty state while we simply don't know. -->
      <div v-if="showLorasLoading" class="py-12 text-center text-xs text-white/40">
        Loading your styles…
      </div>

      <!-- Fetch failed: say so, offer a retry (stale list, if any, stays). -->
      <div v-else-if="showLorasError" class="px-4 py-3 text-center text-xs text-amber-400/90">
        {{ lorasError }}
        <button
          class="block mx-auto mt-2 text-white/70 hover:text-white underline underline-offset-2 cursor-pointer"
          @click="refreshLocalLoras()"
        >
          Retry
        </button>
      </div>

      <div
        v-else-if="visibleEntries.length === 0 && !visibleLocal.length"
        class="px-4 py-12 text-center text-xs text-white/40"
      >
        <template v-if="searchQuery.trim()">
          No styles match <span class="text-white/70">"{{ searchQuery }}"</span>.
          <button class="block mx-auto mt-2 text-white/70 hover:text-white underline underline-offset-2 cursor-pointer" @click="clearSearch">
            Clear search
          </button>
        </template>
        <template v-else-if="activeTab === 'Your Styles'">
          No trained styles yet.
          <button class="block mx-auto mt-2 text-white/70 hover:text-white underline underline-offset-2 cursor-pointer" @click="activeTab = 'Legacy'">
            Browse the Legacy library
          </button>
        </template>
        <template v-else>
          Nothing here yet.
        </template>
      </div>

      <div
        v-for="entry in visibleEntries"
        :key="entry.hfPath"
        class="group relative rounded-lg border border-white/[0.06] hover:border-white/15 transition-colors cursor-pointer overflow-hidden h-[260px]"
        :style="!previewUrls[entry.hfPath] ? { background: entryColor(entry).bg } : undefined"
        @click="useEntry(entry)"
      >
        <!-- Full-card background image (with subtle hover zoom) -->
        <div
          v-if="previewUrls[entry.hfPath]"
          class="absolute inset-0 transition-transform duration-500 group-hover:scale-105"
          :style="{
            backgroundImage: `url(&quot;${previewUrls[entry.hfPath]}&quot;)`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }"
        />

        <!-- Top vignette — just behind the category badge -->
        <div class="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/40 to-transparent pointer-events-none" />

        <!-- Bottom gradient: transparent at top, deep at bottom so the
             title/blurb/trigger sit on a readable surface. ~55% of the card. -->
        <div class="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/85 via-black/55 to-transparent pointer-events-none" />

        <!-- Category badge (top-left) -->
        <span
          class="absolute top-2.5 left-3 text-[10px] uppercase tracking-[0.1em] font-semibold pointer-events-none"
          :style="{
            color: previewUrls[entry.hfPath] ? '#ffffff' : entryColor(entry).accent,
            textShadow: previewUrls[entry.hfPath] ? '0 1px 3px rgba(0,0,0,0.7)' : undefined,
          }"
        >
          {{ entry.category }}
        </span>

        <!-- Top-right actions: HF link, copy path -->
        <div class="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            class="size-6 rounded bg-black/50 hover:bg-black/80 backdrop-blur-sm flex items-center justify-center"
            title="Copy HF path"
            @click="copyHfPath(entry, $event)"
          >
            <Copy class="size-3 text-white/85" />
          </button>
          <button
            class="size-6 rounded bg-black/50 hover:bg-black/80 backdrop-blur-sm flex items-center justify-center"
            title="Open on HuggingFace"
            @click="openHfPage(entry, $event)"
          >
            <ArrowUpRight class="size-3 text-white/85" />
          </button>
        </div>

        <!-- Loading indicator while the preview resolves -->
        <span
          v-if="previewLoading.has(entry.hfPath)"
          class="absolute top-2.5 right-3 text-[9px] uppercase tracking-wider text-white/55 pointer-events-none"
        >Loading…</span>

        <!-- Card content — pinned to the bottom over the dark gradient -->
        <div class="absolute inset-x-0 bottom-0 px-3 pb-3 pt-2">
          <div
            class="text-[13px] font-semibold text-white truncate mb-0.5"
            style="text-shadow: 0 1px 4px rgba(0,0,0,0.6)"
          >
            {{ entry.label }}
          </div>
          <div
            class="text-[10.5px] text-white/55 truncate mb-1.5"
            style="text-shadow: 0 1px 2px rgba(0,0,0,0.6)"
          >
            {{ entry.hfPath }}
          </div>
          <p
            class="text-[11px] text-white/75 leading-snug line-clamp-2 mb-2"
            style="text-shadow: 0 1px 3px rgba(0,0,0,0.55)"
          >
            {{ entry.blurb }}
          </p>
          <span class="inline-flex items-center gap-1 text-[10px] text-white/90 bg-black/55 backdrop-blur-sm border border-white/[0.08] px-1.5 py-0.5 rounded">
            <Sparkles class="size-2.5" />
            <span class="font-mono">{{ entry.trigger }}</span>
          </span>
        </div>
      </div>
    </div>

    <!-- Footer hint -->
    <div class="px-3 py-2 border-t border-white/[0.06] text-[10px] text-white/35 leading-snug">
      Click a Style to add a node with its URL pre-filled.
      Need something not here? Paste any HuggingFace path or .safetensors URL
      into the node's <span class="text-white/55 font-mono">Style URL</span> field.
    </div>

    <StyleHubModal :open="hubOpen" @close="hubOpen = false" />
  </div>
</template>
