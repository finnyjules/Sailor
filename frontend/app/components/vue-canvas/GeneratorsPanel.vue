<script setup lang="ts">
/**
 * Actions panel — AI-driven verbs (generate / edit / enhance / analyze),
 * fetched live from /object_info (`api node/<domain>/<provider>` categories)
 * so new Replicate and fal actions appear automatically (Comfy-billed partner
 * nodes are retired, shared/runner/retired.ts).
 *
 * Organization is intent-first (see ~/data/action-catalog.ts): a pinned hero
 * tier of the highest-frequency actions, then Create / Edit / Enhance /
 * Analyze sections. Provider is a detail on the card (brand chip), never the
 * grouping — users pick by what they want done, not by whose API runs it.
 */
import {
  X, WandSparkles,
  Search as SearchIcon, ChevronDown,
  Image as ImageDomainIcon, AudioWaveform as AudioIcon, Video as VideoIcon, Box as BoxIcon,
  MessageSquareText as TextDomainIcon,
  // Provider-flavored icons
  Film, Sparkles, Wand2, Palette, Bot, Mic, Sun, Maximize2, Type as TypeIcon, Atom,
  PenTool, Music, Cloud,
} from 'lucide-vue-next'
import { useNodeSearch } from '~/composables/useNodeSearch'
import { getGeneratorIcon, getModelBrand } from '~/data/generator-icons'
import {
  ACTION_CATALOG, HERO_BY_DOMAIN, groupByIntent, offeredInActionsPanel,
  type ActionDomain, type ActionSection,
} from '~/data/action-catalog'

// Pick which brand to show on the corner chip. Replicate is just transport;
// the chip should say BFL for a Flux node, Ideogram for an Ideogram node,
// etc. Falls back to the actual API provider when no model brand is known
// (multi-model nodes, indie models with no dedicated brand chip).
function chipProvider(item: PartnerNode): string {
  return getModelBrand(item.nodeType) || item.provider
}

defineEmits<{ close: [] }>()

type Domain = ActionDomain
interface PartnerNode {
  nodeType: string
  label: string
  description: string
  provider: string
  domain: Domain
  price: string | null         // pretty-formatted, e.g. "$0.06" or "$0.35–$2.80"
  priceSuffix: string | null   // unit hint, e.g. "/1K chars"
  priceApprox: boolean         // show a "~" prefix
  priceVaries: boolean         // dynamic depending on widgets
}

// -- Price parsing ----------------------------------------------------------
//
// Partner-node prices live in `price_badge.expr` as either a literal JSON
// object or a JSONata expression. We extract the numeric prices and produce
// a compact display string. For dynamic prices we return a min–max range
// so the user gets a feel for the cost without us shipping a JSONata
// evaluator.

function formatUsd(n: number): string {
  if (n >= 1)    return `$${n.toFixed(2)}`
  if (n >= 0.1)  return `$${n.toFixed(2)}`
  if (n >= 0.01) return `$${n.toFixed(3).replace(/0$/, '')}`
  return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
}

function parsePrice(priceBadge: any): {
  price: string | null; suffix: string | null; approx: boolean; varies: boolean
} {
  const empty = { price: null, suffix: null, approx: false, varies: false }
  if (!priceBadge?.expr) return empty
  const expr = String(priceBadge.expr).trim()

  // Static literal: `{"type":"usd","usd":0.06,...}`. Try JSON.parse first.
  try {
    const parsed = JSON.parse(expr)
    if (typeof parsed?.usd === 'number') {
      return {
        price: formatUsd(parsed.usd),
        suffix: parsed?.format?.suffix ?? null,
        approx: !!parsed?.format?.approximate,
        varies: false,
      }
    }
  } catch { /* not literal JSON — fall through */ }

  // Dynamic JSONata. Only extract numbers from explicit `"usd": <value>`
  // slots — anything else (string-arg digits, $round's precision, etc.)
  // is noise. Each slot is either a literal number or a math expression
  // referencing widget values; the latter marks the price as "varies".
  let varies = false
  const usdNums: number[] = []
  for (const m of expr.matchAll(/"usd"\s*:\s*([^,}]+)/g)) {
    const valExpr = m[1]!.trim()
    if (/^[0-9]+\.?[0-9]*$/.test(valExpr)) {
      usdNums.push(parseFloat(valExpr))
    } else {
      varies = true
      const first = valExpr.match(/([0-9]+\.?[0-9]*)/)
      if (first) {
        const n = parseFloat(first[1]!)
        if (Number.isFinite(n) && n > 0 && n <= 100) usdNums.push(n)
      }
    }
  }
  if (usdNums.length === 0) {
    return { price: 'varies', suffix: null, approx: false, varies: true }
  }
  const min = Math.min(...usdNums)
  // Multiple literals OR any expression means it varies.
  const reallyVaries = varies || usdNums.length > 1
  return {
    price: reallyVaries ? `from ${formatUsd(min)}` : formatUsd(min),
    suffix: null,
    approx: false,
    varies: reallyVaries,
  }
}
// Domain accent colors match the homepage prompt-chip palette (pages/index.vue)
// so the same surface = the same hue across the app. `text` reuses the
// voiceover red since the homepage doesn't have a text chip.
const DOMAINS: { id: Domain; label: string; icon: any; color: string }[] = [
  { id: 'image', label: 'Image', icon: ImageDomainIcon, color: '#96b4ff' },
  { id: 'audio', label: 'Audio', icon: AudioIcon,       color: '#ff99f7' },
  { id: 'video', label: 'Video', icon: VideoIcon,       color: '#54f4cf' },
  { id: '3d',    label: '3D',    icon: BoxIcon,         color: '#ffb984' },
  { id: 'text',  label: 'Text',  icon: TextDomainIcon,  color: '#ff6259' },
]

// -- Fetch partner nodes from object_info ----------------------------------

const allItems = ref<PartnerNode[]>([])
const loading = ref(true)
const fetchError = ref<string | null>(null)

async function loadPartnerNodes() {
  loading.value = true
  fetchError.value = null
  try {
    const res = await fetch('/object_info')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const info = await res.json() as Record<string, any>
    const items: PartnerNode[] = []
    for (const [nodeType, node] of Object.entries(info)) {
      const cat = (node?.category || '') as string
      // Replicate and fal actions only: hidden per-model classes and the
      // retired Comfy-billed partner nodes stay loadable in old workflows.
      if (!offeredInActionsPanel(nodeType, cat)) continue
      const parts = cat.split('/')
      // Shape: api node / <domain> / <provider>
      const domain = parts[1] as Domain | undefined
      const provider = parts[2] || 'Other'
      if (!domain || !['image', 'audio', 'video', '3d', 'text'].includes(domain)) continue
      const p = parsePrice(node?.price_badge)
      items.push({
        nodeType,
        label: node?.display_name || nodeType,
        description: (node?.description || '').split('\n')[0]!.slice(0, 200),
        provider,
        domain,
        price: p.price,
        priceSuffix: p.suffix,
        priceApprox: p.approx,
        priceVaries: p.varies,
      })
    }
    allItems.value = items
  } catch (e: any) {
    fetchError.value = e?.message || 'failed to load actions'
    allItems.value = []
  } finally {
    loading.value = false
  }
}
onMounted(loadPartnerNodes)

// -- Tabs + search + collapse ----------------------------------------------

const activeDomain = ref<Domain>('image')
const searchQuery = ref('')

const props = defineProps<{ focusDomain?: { domain: ActionDomain; ts: number } | null }>()
watch(() => props.focusDomain, (f) => {
  if (!f) return
  activeDomain.value = f.domain
  searchQuery.value = ''
}, { immediate: true })

function domainItemCount(d: Domain): number {
  return allItems.value.filter(it => it.domain === d).length
}

const visibleGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const items = allItems.value
    .filter(it => it.domain === activeDomain.value)
    .filter(it => !q
      || it.label.toLowerCase().includes(q)
      || it.description.toLowerCase().includes(q)
      || it.provider.toLowerCase().includes(q)
      || it.nodeType.toLowerCase().includes(q)
      || (ACTION_CATALOG[it.nodeType]?.useCase.toLowerCase().includes(q) ?? false)
      || (ACTION_CATALOG[it.nodeType]?.model.toLowerCase().includes(q) ?? false))
  return groupByIntent(items, q ? [] : HERO_BY_DOMAIN[activeDomain.value])
})

// Collapsed sections, persisted under a key independent from Toolbox.
const STORAGE_KEY = 'generators.collapsedSections'
const collapsedKeys = ref<Set<string>>(new Set())
function loadCollapsed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw != null) collapsedKeys.value = new Set(JSON.parse(raw))
  } catch {}
}
function saveCollapsed() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsedKeys.value])) } catch {}
}
onMounted(loadCollapsed)

function sectionKey(s: ActionSection<PartnerNode>): string {
  return `${activeDomain.value}:${s.intent}`
}
function isCollapsed(s: ActionSection<PartnerNode>): boolean {
  if (searchQuery.value.trim()) return false
  return collapsedKeys.value.has(sectionKey(s))
}
function toggleSection(s: ActionSection<PartnerNode>) {
  const key = sectionKey(s)
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
  saveCollapsed()
}

const { addNode } = useNodeSearch()

const panelRef = ref<HTMLDivElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const hoveredItem = ref<PartnerNode | null>(null)
const hoverPos = ref({ top: 0, left: 0 })
let enterTimer: ReturnType<typeof setTimeout> | null = null

function clearSearch() {
  searchQuery.value = ''
  searchInputRef.value?.focus()
}

function onCardEnter(event: MouseEvent, item: PartnerNode) {
  const cardRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  if (enterTimer) clearTimeout(enterTimer)
  enterTimer = setTimeout(() => {
    hoveredItem.value = item
    hoverPos.value = {
      top: cardRect.top + cardRect.height / 2,
      left: (panelRect?.right ?? cardRect.right) + 8,
    }
  }, 120)
}
function onCardLeave() {
  if (enterTimer) clearTimeout(enterTimer)
  hoveredItem.value = null
}
function onCardDragStart(event: DragEvent, item: PartnerNode) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('text/plain', item.nodeType)
  event.dataTransfer.effectAllowed = 'copy'
  if (enterTimer) clearTimeout(enterTimer)
  hoveredItem.value = null
}

// -- Provider badges (deterministic color + initials) ----------------------
//
// Comfy doesn't bundle vendor logos, so we synthesize a recognizable visual
// identity from the provider name. Same provider → same color, same initials,
// every render. Two-letter initials use the first letter of two CamelCase
// chunks where possible ("Stability AI" → "SA"), else first two chars.

function providerInitials(name: string): string {
  const cleaned = (name || '').trim()
  if (!cleaned) return '?'
  // Try CamelCase or space-separated word splits first.
  const words = cleaned.split(/[\s_-]+|(?=[A-Z])/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  const letters = cleaned.replace(/[^A-Za-z0-9]/g, '')
  return letters.slice(0, 2).toUpperCase() || '?'
}

function providerColor(name: string): { bg: string; fg: string } {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0
  const hue = h % 360
  return {
    bg: `hsl(${hue}, 50%, 38%)`,
    fg: `hsl(${hue}, 80%, 92%)`,
  }
}

// Comfy ships brand SVGs for partner providers in its Iconify "comfy"
// collection. The CSS rules for these classes are pulled from Comfy's
// frontend bundle (see assets/css/comfy-partner-icons.css). Each provider
// slug = name lowercased with spaces → dashes, matching getProviderIcon()
// in Comfy's categoryUtil.ts.
// Two icon families in the comfy iconify collection:
// - Monochrome (mask-image based) — need an explicit foreground color set
//   on the element (we use white). Single-color logos like BFL, OpenAI…
// - Full-color (background-image based) — the SVG has its own gradients
//   baked in (Kling rainbow, ByteDance teal/blue, etc.). Leave them alone.
const COMFY_BRAND_ICONS_MONO = new Set([
  'bfl', 'bria', 'grok', 'hitpaw', 'ideogram', 'ltxv', 'openai',
  'recraft', 'runway', 'topaz', 'wavespeed',
])
const COMFY_BRAND_ICONS_COLOR = new Set([
  'bytedance', 'gemini', 'kling', 'luma', 'magnific', 'meshy', 'minimax',
  'moonvalley-marey', 'pixverse', 'rodin', 'sora', 'stability-ai',
  'tencent', 'tripo', 'veo', 'vidu', 'wan',
])

function providerSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}
function hasComfyBrandIcon(provider: string): boolean {
  const s = providerSlug(provider)
  return COMFY_BRAND_ICONS_MONO.has(s) || COMFY_BRAND_ICONS_COLOR.has(s)
}
function isComfyMonoIcon(provider: string): boolean {
  return COMFY_BRAND_ICONS_MONO.has(providerSlug(provider))
}
function comfyBrandIconClass(provider: string): string {
  return `icon-[comfy--${providerSlug(provider)}]`
}

// Lucide fallback for any provider Comfy doesn't ship a brand SVG for
// (e.g. ElevenLabs). Falls back to the domain icon if the provider is
// unknown.
const PROVIDER_ICONS: Record<string, any> = {
  // Replicate: the transport chip. The partner-brand entries below stay for
  // getModelBrand chips on Replicate and fal actions (Luma, PixVerse, …).
  Replicate: Cloud,
  // Image generators
  BFL: Wand2,                    // Black Forest Labs / Flux
  Bria: ImageDomainIcon,
  ByteDance: Film,                // also has video models — Film works for both
  Gemini: Sparkles,
  Grok: Bot,
  HitPaw: Maximize2,
  Ideogram: TypeIcon,
  Kling: Film,
  Luma: Sun,
  Magnific: Maximize2,
  OpenAI: Bot,
  Recraft: Palette,
  Reve: Sparkles,
  Runway: Film,
  'Stability AI': Atom,
  Topaz: Maximize2,
  Wan: ImageDomainIcon,
  WaveSpeed: Maximize2,
  // Video specific
  LTXV: Film,
  MiniMax: Film,
  'Moonvalley Marey': Film,
  PixVerse: Film,
  Sora: Film,
  Veo: Film,
  Vidu: Film,
  // Audio
  ElevenLabs: Mic,
  Sonilo: Music,
  // 3D
  Meshy: BoxIcon,
  Rodin: BoxIcon,
  Tencent: BoxIcon,                // Hunyuan
  Tripo: BoxIcon,
  // Text / chat
  Anthropic: Bot,
  // SVG / vector
  Quiver: PenTool,
}

const DOMAIN_FALLBACK_ICON: Record<Domain, any> = {
  image: ImageDomainIcon,
  audio: AudioIcon,
  video: VideoIcon,
  '3d':  BoxIcon,
  text:  TextDomainIcon,
}

function providerIcon(provider: string, domain: Domain): any {
  return PROVIDER_ICONS[provider] ?? DOMAIN_FALLBACK_ICON[domain]
}

function useCaseFor(item: PartnerNode): { useCase: string; model: string } | null {
  return ACTION_CATALOG[item.nodeType] ?? null
}
</script>

<template>
  <div ref="panelRef" class="h-full bg-[#1a1a1a]/95 backdrop-blur-md border-r border-white/10 flex flex-col shadow-2xl">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
      <div class="flex items-center gap-2">
        <WandSparkles class="size-4 text-white/70" />
        <span class="text-sm font-semibold text-white/90">Actions</span>
      </div>
      <button
        class="flex items-center justify-center size-6 rounded hover:bg-white/10 transition-colors cursor-pointer"
        @click="$emit('close')"
      >
        <X class="size-4 text-white/60" />
      </button>
    </div>

    <!-- Search input -->
    <div class="px-3 pt-3 pb-2">
      <div class="relative">
        <SearchIcon class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-white/40 pointer-events-none" />
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          placeholder="Search actions…"
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

    <!-- Domain tabs -->
    <div class="px-2 pb-2 flex gap-1">
      <button
        v-for="d in DOMAINS"
        :key="d.id"
        class="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[11px] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        :class="activeDomain === d.id
          ? 'font-medium'
          : 'text-white/55 hover:bg-white/[0.04] hover:text-white/85'"
        :style="activeDomain === d.id
          ? { backgroundColor: `${d.color}26`, color: d.color }
          : undefined"
        :disabled="domainItemCount(d.id) === 0 && activeDomain !== d.id"
        :title="d.label"
        @click="activeDomain = d.id"
      >
        <component :is="d.icon" class="size-3.5" :stroke-width="1.75" />
        <span>{{ d.label }}</span>
      </button>
    </div>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto pb-3">
      <div v-if="loading" class="px-4 py-12 text-center text-xs text-white/40">
        Loading actions…
      </div>
      <div v-else-if="fetchError" class="px-4 py-12 text-center text-xs text-amber-400">
        Couldn't load actions: {{ fetchError }}
      </div>
      <div
        v-else-if="visibleGroups.hero.length === 0 && visibleGroups.sections.length === 0"
        class="px-4 py-12 text-center text-xs text-white/40"
      >
        <template v-if="searchQuery.trim()">
          No actions match <span class="text-white/70">"{{ searchQuery }}"</span>.
          <button class="block mx-auto mt-2 text-white/70 hover:text-white underline underline-offset-2 cursor-pointer" @click="clearSearch">
            Clear search
          </button>
        </template>
        <template v-else>
          No actions in this category.
        </template>
      </div>

      <!-- Hero tier — highest-frequency actions, pinned above the intent sections.
           Hidden while searching (search shows one flat grouping). -->
      <div v-if="visibleGroups.hero.length" class="px-2 pt-2 grid grid-cols-2 gap-1.5">
        <button
          v-for="item in visibleGroups.hero"
          :key="item.nodeType"
          draggable="true"
          class="relative group flex flex-col items-start gap-2 rounded bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.06] hover:border-white/15 transition-colors cursor-grab active:cursor-grabbing px-2.5 py-2.5 text-left"
          :title="`${item.label} (${item.nodeType}) — click to add, or drag onto canvas`"
          @click="addNode(item.nodeType)"
          @dragstart="(e) => onCardDragStart(e, item)"
          @mouseenter="(e) => onCardEnter(e, item)"
          @mouseleave="onCardLeave"
        >
          <div
            class="relative size-9 rounded-md flex items-center justify-center shrink-0 ring-1 ring-white/10"
            :class="getGeneratorIcon(item.nodeType) || hasComfyBrandIcon(item.provider) ? 'bg-white/[0.04]' : ''"
            :style="getGeneratorIcon(item.nodeType) || hasComfyBrandIcon(item.provider)
              ? {}
              : { backgroundColor: providerColor(item.provider).bg, color: providerColor(item.provider).fg }"
          >
            <component
              v-if="getGeneratorIcon(item.nodeType)"
              :is="getGeneratorIcon(item.nodeType)"
              class="size-5 text-white/85"
              :stroke-width="1.75"
            />
            <span
              v-else-if="hasComfyBrandIcon(item.provider)"
              :class="[comfyBrandIconClass(item.provider), isComfyMonoIcon(item.provider) ? 'bg-white' : '']"
              class="size-5"
            />
            <component
              v-else
              :is="providerIcon(item.provider, item.domain)"
              class="size-4"
              :stroke-width="1.75"
            />
          </div>
          <span class="text-[12px] text-white/90 group-hover:text-white leading-tight line-clamp-2 transition-colors">
            {{ useCaseFor(item)?.useCase ?? item.label }}
          </span>
          <span
            v-if="item.price"
            class="absolute top-1.5 right-1.5 text-[9px] tabular-nums leading-none px-1 py-0.5 rounded bg-amber-500/15 text-amber-200/90 border border-amber-500/15"
          >{{ item.priceApprox ? '~' : '' }}{{ item.price }}</span>
        </button>
      </div>

      <div v-for="section in visibleGroups.sections" :key="sectionKey(section)" class="px-2 pt-2">
        <button
          class="w-full flex items-center justify-between px-1 pb-1.5 group cursor-pointer"
          @click="toggleSection(section)"
        >
          <span class="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40 group-hover:text-white/65 transition-colors">
            {{ section.label }}
            <span class="ml-1 text-white/25 normal-case tracking-normal">{{ section.items.length }}</span>
          </span>
          <ChevronDown
            class="size-3 text-white/30 group-hover:text-white/55 transition-all"
            :class="isCollapsed(section) ? '-rotate-90' : ''"
          />
        </button>
        <div v-if="!isCollapsed(section)" class="flex flex-col gap-1">
          <button
            v-for="item in section.items"
            :key="item.nodeType"
            draggable="true"
            class="relative group flex items-center gap-3 rounded bg-white/[0.025] hover:bg-white/[0.08] border border-white/[0.04] hover:border-white/10 transition-colors cursor-grab active:cursor-grabbing px-2.5 py-2 text-left"
            :title="`${item.label} (${item.nodeType}) — click to add, or drag onto canvas`"
            @click="addNode(item.nodeType)"
            @dragstart="(e) => onCardDragStart(e, item)"
            @mouseenter="(e) => onCardEnter(e, item)"
            @mouseleave="onCardLeave"
          >
            <!-- Main icon = per-node use-case glyph when we have one
                 (Generate → Sparkles, Upscale → Maximize, etc.). Falls back
                 to the provider's own icon when there's no mapping yet —
                 so a freshly-added partner still looks reasonable. -->
            <div
              class="relative size-9 rounded-md flex items-center justify-center shrink-0 ring-1 ring-white/10"
              :class="getGeneratorIcon(item.nodeType) || hasComfyBrandIcon(item.provider) ? 'bg-white/[0.04]' : ''"
              :style="getGeneratorIcon(item.nodeType) || hasComfyBrandIcon(item.provider)
                ? {}
                : { backgroundColor: providerColor(item.provider).bg, color: providerColor(item.provider).fg }"
              :title="item.provider"
            >
              <component
                v-if="getGeneratorIcon(item.nodeType)"
                :is="getGeneratorIcon(item.nodeType)"
                class="size-5 text-white/85"
                :stroke-width="1.75"
              />
              <span
                v-else-if="hasComfyBrandIcon(item.provider)"
                :class="[comfyBrandIconClass(item.provider), isComfyMonoIcon(item.provider) ? 'bg-white' : '']"
                class="size-5"
              />
              <component
                v-else
                :is="providerIcon(item.provider, item.domain)"
                class="size-4"
                :stroke-width="1.75"
              />
            </div>
            <!-- Use-case-first title + model subline when mapped; falls back
                 to the cleaned model name for partner nodes we haven't mapped. -->
            <div class="flex flex-col min-w-0 flex-1">
              <template v-if="useCaseFor(item)">
                <span class="text-[13px] text-white/85 group-hover:text-white/95 leading-tight transition-colors truncate">
                  {{ useCaseFor(item)!.useCase }}
                </span>
                <span class="flex items-center gap-1 max-w-full mt-0.5">
                  <!-- Model/provider brand icon, inline next to the model name. -->
                  <span
                    v-if="hasComfyBrandIcon(chipProvider(item))"
                    :class="[comfyBrandIconClass(chipProvider(item)), isComfyMonoIcon(chipProvider(item)) ? 'bg-white/45 group-hover:bg-white/60' : '']"
                    class="text-[8px] leading-none shrink-0"
                    :title="chipProvider(item)"
                  />
                  <component
                    v-else
                    :is="providerIcon(chipProvider(item), item.domain)"
                    class="size-2 shrink-0 text-white/45 group-hover:text-white/60"
                    :stroke-width="2"
                  />
                  <span class="text-[11px] text-white/40 group-hover:text-white/55 leading-tight transition-colors truncate">
                    {{ useCaseFor(item)!.model }}
                  </span>
                </span>
              </template>
              <span v-else class="text-[13px] text-white/70 group-hover:text-white/95 leading-tight transition-colors truncate">
                {{ item.label.replace(item.provider, '').replace(/^[ :·-]+/, '') || item.label }}
              </span>
            </div>
            <span
              v-if="item.price"
              class="shrink-0 text-[10px] tabular-nums leading-none px-1.5 py-1 rounded bg-amber-500/15 text-amber-200/90 border border-amber-500/15 group-hover:bg-amber-500/25 transition-colors"
              :title="`${item.priceApprox ? '~' : ''}${item.price}${item.priceSuffix ? ' ' + item.priceSuffix : ''}${item.priceVaries ? ' (varies by settings)' : ''}`"
            >{{ item.priceApprox ? '~' : '' }}{{ item.price }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <Transition
      enter-active-class="transition-all duration-150 ease-out"
      enter-from-class="opacity-0 -translate-x-1"
      enter-to-class="opacity-100 translate-x-0"
      leave-active-class="transition-opacity duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="hoveredItem"
        class="fixed z-[60] w-72 bg-[#1f1f1f]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl p-3 pointer-events-none"
        :style="{ top: hoverPos.top + 'px', left: hoverPos.left + 'px', transform: 'translateY(-50%)' }"
      >
        <div class="flex items-center gap-2 mb-1.5">
          <!-- Same icon treatment as the card: per-node main, provider badge. -->
          <div
            class="relative size-7 rounded-md flex items-center justify-center ring-1 ring-white/10"
            :class="getGeneratorIcon(hoveredItem.nodeType) || hasComfyBrandIcon(hoveredItem.provider) ? 'bg-white/[0.04]' : ''"
            :style="getGeneratorIcon(hoveredItem.nodeType) || hasComfyBrandIcon(hoveredItem.provider)
              ? {}
              : { backgroundColor: providerColor(hoveredItem.provider).bg, color: providerColor(hoveredItem.provider).fg }"
          >
            <component
              v-if="getGeneratorIcon(hoveredItem.nodeType)"
              :is="getGeneratorIcon(hoveredItem.nodeType)"
              class="size-4 text-white/85"
              :stroke-width="1.75"
            />
            <span
              v-else-if="hasComfyBrandIcon(hoveredItem.provider)"
              :class="[comfyBrandIconClass(hoveredItem.provider), isComfyMonoIcon(hoveredItem.provider) ? 'bg-white' : '']"
              class="size-4"
            />
            <component v-else :is="providerIcon(hoveredItem.provider, activeDomain)" class="size-3.5" :stroke-width="1.75" />

            <template v-if="getGeneratorIcon(hoveredItem.nodeType)">
              <span
                v-if="hasComfyBrandIcon(chipProvider(hoveredItem))"
                :class="[comfyBrandIconClass(chipProvider(hoveredItem)), isComfyMonoIcon(chipProvider(hoveredItem)) ? 'bg-white/85' : '']"
                class="absolute -bottom-1.5 -right-1.5 size-2.5 rounded-[3px] ring-1 ring-[#1f1f1f] bg-[#1f1f1f]"
                :title="chipProvider(hoveredItem)"
              />
              <span
                v-else
                class="absolute -bottom-1.5 -right-1.5 size-2.5 rounded-[3px] ring-1 ring-[#1f1f1f] bg-[#1f1f1f] flex items-center justify-center text-white/70"
                :title="chipProvider(hoveredItem)"
              >
                <component :is="providerIcon(chipProvider(hoveredItem), activeDomain)" class="size-1.5" :stroke-width="2.75" />
              </span>
            </template>
          </div>
          <div class="flex flex-col min-w-0">
            <span class="text-sm font-semibold text-white/90 truncate">
              {{ useCaseFor(hoveredItem)?.useCase ?? hoveredItem.label }}
            </span>
            <span class="text-[10px] uppercase tracking-[0.08em] text-white/40">
              {{ useCaseFor(hoveredItem) ? `${useCaseFor(hoveredItem)!.model} · ${hoveredItem.provider}` : hoveredItem.provider }}
            </span>
          </div>
        </div>
        <p v-if="hoveredItem.description" class="text-xs text-white/60 leading-relaxed">{{ hoveredItem.description }}</p>
        <p v-else class="text-xs text-white/40 italic">No description provided.</p>
        <div v-if="hoveredItem.price" class="mt-2 pt-2 border-t border-white/5 flex items-center gap-1.5 text-[11px]">
          <span class="text-white/40">Cost per run</span>
          <span class="text-amber-200/90 tabular-nums">
            {{ hoveredItem.priceApprox ? '~' : '' }}{{ hoveredItem.price }}<span v-if="hoveredItem.priceSuffix" class="text-white/50"> {{ hoveredItem.priceSuffix }}</span>
          </span>
          <span v-if="hoveredItem.priceVaries" class="ml-auto text-[10px] text-white/35 italic">varies by settings</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
