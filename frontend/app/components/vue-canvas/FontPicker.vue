<script setup lang="ts">
/**
 * FontPicker — shared searchable Google Fonts dropdown (extracted from Type
 * Studio). Trigger button opens an inline panel: search + ✨ describe-a-font AI
 * suggest (with in-face previews), an optional "Variable fonts only" toggle, an
 * optional caller-provided pinned list shown above the catalog under a small
 * "Sailor" header, and the filtered Google catalog (capped at 120 rows) with
 * `var` badges for variable faces. Owns all open/search/suggest state
 * internally; closes + clears the search on select.
 */
import { loadGoogleCatalog, type GoogleFont } from '~/data/google-fonts'
import { filterLibraryGroups, featuredFamilies } from '~/data/library-fonts'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import VariableGlyph from '~/components/vue-canvas/studio/VariableGlyph.vue'

withDefaults(defineProps<{
  modelValue: string
  pinned?: { label: string; value: string; variable?: boolean }[]
  showVariableToggle?: boolean
  // When set, the trigger reads as a 28px studio row — label left, font name and caret
  // right — so a Font control sits in the same rhythm as the sliders beside it instead of
  // a caption-above-a-dropdown. Omitted, the trigger keeps its original full-width form
  // for callers that already draw their own label.
  label?: string
  // What the trigger READS, when that is not what the trigger MATCHES. `modelValue` is
  // the identity the rows highlight against — a pinned entry's `value`, or a catalog /
  // library family name — and for most callers that string is also the right thing to
  // show. Vector Type is the exception: its pinned entries are catalog IDS
  // (`big-shoulders`), so highlighting the current pick and reading it back as
  // "Big Shoulders Display" are two different strings. Omitted, the trigger shows
  // `modelValue`, exactly as it always has.
  display?: string
  // A font is a bindable control. In row mode (`label` set), the variable glyph rides next
  // to the label and a bound value shows the pink column name instead of the picker — the
  // same treatment StudioColorField gives a bound colour, so binding survives the move off
  // the old caption-above layout that carried the glyph.
  bound?: string | null
}>(), {
  showVariableToggle: true,
  bound: null,
})

const emit = defineEmits<{
  (e: 'promote'): void
  (e: 'menu', ev: MouseEvent): void
  (e: 'goToCollection'): void
  (e: 'select', payload:
    | { kind: 'google'; family: string }
    | { kind: 'pinned'; value: string }
    | { kind: 'library'; family: string; foundry: string }): void
}>()

// Full Google Fonts catalog (~1900 families), fetched once via the shared proxy and
// used to populate the searchable font picker.
const fontCatalog = ref<GoogleFont[]>([])
loadGoogleCatalog().then((c) => { fontCatalog.value = c })

// Custom searchable font dropdown (a native <select> can't show 1900 options nicely,
// and a datalist has no visible affordance). Open/close + live filter, capped for perf.
const fontPickerOpen = ref(false)
const fontSearch = ref('')
const variableOnly = ref(false)
// A font is variable when it has a registered axis with an actual range (max > min).
const isVar = (f: GoogleFont) => f.axes.some(a => a.max > a.min)
const varAxes = (f: GoogleFont) => f.axes.filter(a => a.max > a.min).map(a => a.tag).join(' ')
const filteredFonts = computed(() => {
  const q = fontSearch.value.trim().toLowerCase()
  let list = fontCatalog.value
  if (variableOnly.value) list = list.filter(isVar)
  const matched = q ? list.filter(f => f.family.toLowerCase().includes(q)) : list
  return matched.slice(0, 120)
})
function closePicker() {
  fontPickerOpen.value = false
  fontSearch.value = ''
}
function selectGoogle(family: string) {
  emit('select', { kind: 'google', family })
  closePicker()
}
function selectPinned(value: string) {
  emit('select', { kind: 'pinned', value })
  closePicker()
}

// Source tabs: Google catalog vs. the licensed Pangram/Off-Type library. The
// library list comes from the static manifest (no network) via filterLibraryGroups.
type FontPickerTab = 'google' | 'pangram' | 'featured'
const activeTab = ref<FontPickerTab>('google')
const { ensure: ensureLibFace } = useLibraryFonts()
const filteredLibrary = computed(() => filterLibraryGroups(fontSearch.value))
function selectLibrary(family: string, foundry: string) {
  emit('select', { kind: 'library', family, foundry })
  closePicker()
}
// Preview each visible library family in its own face once the Pangram tab is open.
watch([activeTab, filteredLibrary], () => {
  if (activeTab.value === 'pangram') for (const g of filteredLibrary.value) for (const f of g.families) ensureLibFace(f.family)
})
const filteredFeatured = computed(() => featuredFamilies(fontSearch.value))
watch([activeTab, filteredFeatured], () => {
  if (activeTab.value !== 'featured') return
  for (const f of filteredFeatured.value) {
    if (f.source === 'google') ensureFontFace(f.googleFamily || f.family)
    else ensureLibFace(f.family)
  }
})
function selectFeatured(f: { family: string; foundry: string; source?: string; googleFamily?: string }) {
  if (f.source === 'google') selectGoogle(f.googleFamily || f.family)
  else selectLibrary(f.family, f.foundry)
}

// ✨ Describe-a-font search: type a description ("fonts like the Knicks logo"),
// an LLM suggests real Google families (grounded against fontCatalog), shown atop
// the literal list. Faces are loaded so each suggestion row previews in-face.
const { suggestions: fontSuggestions, loading: fontSuggestLoading, error: fontSuggestError, hasRun: fontSuggestRan, suggest: runFontSuggestApi, clear: clearFontSuggest } = useFontSuggest()
const { ensure: ensureFontFace } = useGoogleFontPreview()
function runFontSuggest() { runFontSuggestApi(fontSearch.value) }
watch(fontSuggestions, (list) => { for (const s of list) ensureFontFace(s.family) })
watch(fontSearch, () => { if (fontSuggestRan.value) clearFontSuggest() })
// Reset suggestions whenever the picker closes so a stale list doesn't reappear.
watch(fontPickerOpen, (open) => { if (!open && fontSuggestRan.value) clearFontSuggest() })
</script>

<template>
  <!-- Bound (row mode only): the pink column name, click = edit in table, exactly like a
       bound colour/slider row. No picker while bound — the value comes from the column. -->
  <button
    v-if="label && bound"
    type="button"
    class="group flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-white/[0.05] px-2.5 text-left"
    :title="`${bound} — edit in table`"
    @click="emit('goToCollection')"
  >
    <span class="flex items-center gap-1.5 text-[11px] text-white/72">
      {{ label }}
      <VariableGlyph :bound="bound" @promote="emit('promote')" @menu="emit('menu', $event)" />
    </span>
    <span class="ml-auto truncate font-mono text-[11px]" style="color: var(--var-accent-text)">{{ bound }}</span>
  </button>
  <button
    v-else
    type="button"
    @click="fontPickerOpen = !fontPickerOpen"
    class="group flex w-full items-center gap-2 text-left transition-colors"
    :class="label
      ? 'h-7 justify-between rounded-[6px] bg-white/[0.05] px-2.5 hover:bg-white/[0.08]'
      : 'justify-between rounded bg-white/10 px-2 py-1'">
    <span v-if="label" class="flex shrink-0 items-center gap-1.5 text-[11px] text-white/72">
      {{ label }}
      <VariableGlyph :bound="null" @promote="emit('promote')" @menu="emit('menu', $event)" />
    </span>
    <span class="truncate" :class="label ? 'ml-auto text-[11px] text-white/90' : ''">{{ display || modelValue || 'Select font…' }}</span>
    <!-- The app's one caret: `›` turned, never ▾/▴/⌄. Those draw smaller than their type
         size implies and sit off the optical centre. Down when closed, up when open. -->
    <span class="inline-block shrink-0 text-white/40 transition-transform"
          :class="[label ? '' : 'ml-2', fontPickerOpen ? '-rotate-90' : 'rotate-90']">›</span>
  </button>
  <div v-if="fontPickerOpen" class="mt-1 rounded bg-black/40 p-1">
    <div class="mb-1 flex items-center gap-1">
      <input v-model="fontSearch" placeholder="Search or describe fonts…" autofocus
             @keydown.enter.prevent="runFontSuggest"
             class="w-full flex-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1" />
      <button type="button" title="Suggest fonts from a description"
              :disabled="fontSuggestLoading" @click="runFontSuggest"
              class="shrink-0 whitespace-nowrap rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 hover:border-white/25 disabled:opacity-40">✨ Ask AI</button>
    </div>
    <!-- Source tabs -->
    <div class="mb-1 flex items-center gap-1 px-1">
      <button type="button" @click="activeTab = 'google'"
              class="rounded px-2 py-0.5 text-[11px]"
              :class="activeTab === 'google' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'">Google</button>
      <button type="button" @click="activeTab = 'pangram'"
              class="rounded px-2 py-0.5 text-[11px]"
              :class="activeTab === 'pangram' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'">Pangram</button>
      <button type="button" @click="activeTab = 'featured'"
              class="rounded px-2 py-0.5 text-[11px]"
              :class="activeTab === 'featured' ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'">Featured</button>
    </div>
    <div v-if="activeTab === 'google'">
      <label v-if="showVariableToggle" class="mb-1 flex items-center justify-between px-1 py-0.5 text-[11px] text-white/55">
        <span>Variable fonts only</span>
        <StudioSwitch v-model="variableOnly" />
      </label>
      <!-- ✨ Suggested (from a description) -->
      <div v-if="fontSuggestLoading || fontSuggestError || fontSuggestions.length || fontSuggestRan" class="mb-1">
        <p class="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-white/40">✨ Suggested</p>
        <p v-if="fontSuggestLoading" class="px-2 py-1 text-white/40">Finding fonts…</p>
        <p v-else-if="fontSuggestError" class="px-2 py-1 text-white/40">{{ fontSuggestError }}</p>
        <p v-else-if="!fontSuggestions.length" class="px-2 py-1 text-white/40">No matches — try describing the style differently.</p>
        <button v-for="s in fontSuggestions" :key="'s' + s.family" type="button"
                @click="selectGoogle(s.family)"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
                :class="{ 'bg-white/15': modelValue === s.family }">
          <span class="min-w-0 flex-1">
            <span class="block truncate" :style="{ fontFamily: s.family }">{{ s.family }}</span>
            <span class="block truncate text-[10px] text-white/40">{{ s.reason }}</span>
          </span>
          <span class="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-white/40">{{ s.category }}</span>
        </button>
        <div class="mx-2 my-1 border-t border-white/10" />
      </div>
      <!-- Pinned (caller-provided, e.g. Sailor house fonts) — above the catalog. -->
      <div v-if="pinned?.length" class="mb-1">
        <p class="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-white/40">Sailor</p>
        <button v-for="p in pinned" :key="'p' + p.value" type="button"
                @click="selectPinned(p.value)"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
                :class="{ 'bg-white/15': modelValue === p.value }">
          <span class="truncate">{{ p.label }}</span>
          <!-- Same `var` badge as a Google catalog row (spec: "the ten curated
               variable families are pinned at the top and badged `var`"). Only
               a `pinned` caller who marks an entry `variable: true` sees it —
               every other caller never passes it, so their rows are unchanged. -->
          <span v-if="p.variable" class="ml-auto shrink-0 rounded bg-white/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-white/70">var</span>
        </button>
      </div>
      <div class="max-h-48 overflow-y-auto">
        <button v-for="f in filteredFonts" :key="f.family" type="button"
                @click="selectGoogle(f.family)"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
                :class="{ 'bg-white/15': modelValue === f.family }">
          <span class="truncate">{{ f.family }}</span>
          <span v-if="isVar(f)" :title="`Variable axes: ${varAxes(f)}`"
                class="ml-auto shrink-0 rounded bg-white/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-white/70">var</span>
        </button>
        <p v-if="!fontCatalog.length" class="px-2 py-1 text-white/40">Loading fonts…</p>
        <p v-else-if="!filteredFonts.length" class="px-2 py-1 text-white/40">No matches</p>
      </div>
    </div>
    <!-- Pangram / Off-Type -->
    <div v-if="activeTab === 'pangram'" class="max-h-48 overflow-y-auto">
      <template v-for="g in filteredLibrary" :key="g.foundry.id">
        <p class="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-white/40">{{ g.foundry.label }}</p>
        <button v-for="f in g.families" :key="f.id" type="button"
                @click="selectLibrary(f.family, f.foundry)"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
                :class="{ 'bg-white/15': modelValue === f.family }">
          <span class="truncate" :style="{ fontFamily: f.family }">{{ f.family }}</span>
          <span class="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-white/40">{{ f.faces.length }}</span>
        </button>
      </template>
      <p v-if="!filteredLibrary.length" class="px-2 py-1 text-white/40">No matches</p>
    </div>
    <!-- Featured (curated free) -->
    <div v-if="activeTab === 'featured'" class="max-h-48 overflow-y-auto">
      <button
        v-for="f in filteredFeatured"
        :key="f.id"
        type="button"
        class="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
        :class="{ 'bg-white/15': (f.source === 'google' ? (f.googleFamily || f.family) : f.family) === modelValue }"
        @click="selectFeatured(f)"
      >
        <span class="truncate text-[13px] text-white/90" :style="{ fontFamily: f.source === 'google' ? (f.googleFamily || f.family) : f.family }">{{ f.family }}</span>
        <span class="shrink-0 text-[10px] text-white/40">{{ f.category }}</span>
      </button>
      <p v-if="!filteredFeatured.length" class="px-2 py-1 text-white/40">No matches</p>
    </div>
  </div>
</template>
