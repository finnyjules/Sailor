<script setup lang="ts">
/**
 * FontPicker — searchable font chooser for the in-node type widgets (Text Mask,
 * Text on Path). Trigger button opens an inline panel (clip-safe inside a node)
 * listing the curated Featured variable fonts plus the full Google catalog
 * (lazy-loaded on first open and filtered as you type). Emits a `pick` the
 * widget turns into its own state.
 */
import { VARIABLE_FONTS, type VariableFont } from '~/data/variable-fonts'
import { loadGoogleCatalog, type GoogleFont } from '~/data/google-fonts'
import { filterLibraryGroups } from '~/data/library-fonts'
import { onClickOutside } from '@vueuse/core'

const props = defineProps<{
  selectedKey: string   // 'var:<id>' or 'goog:<family>' or 'lib:<family>' — highlights the active row
  label: string         // current font name shown on the trigger
  sublabel?: string     // 'Variable' | 'Google'
}>()
const emit = defineEmits<{
  pick: [payload: { source: 'variable'; id: string } | { source: 'google'; font: GoogleFont } | { source: 'library'; family: string }]
}>()

const LIMIT = 60

const root = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const catalog = ref<GoogleFont[]>([])
const loading = ref(false)

const { suggestions, loading: suggestLoading, error: suggestError, hasRun: suggestRan, suggest, clear: clearSuggest } = useFontSuggest()
const { ensure: ensureGoogleFont } = useGoogleFontPreview()
const { ensure: ensureLibFace } = useLibraryFonts()

// Source tabs: Google catalog vs. the licensed Pangram/Off-Type library (mirrors
// the main FontPicker's Google|Pangram split). Opens on Pangram when the current
// selection is already a library family.
type FontPickerTab = 'google' | 'pangram'
const activeTab = ref<FontPickerTab>('google')

function ensureCatalog() {
  if (catalog.value.length || loading.value) return
  loading.value = true
  loadGoogleCatalog().then(list => { catalog.value = list }).finally(() => { loading.value = false })
}

function runSuggest() {
  ensureCatalog()           // suggestions resolve against the catalog
  suggest(query.value)
}

// Load each suggested face so its preview row paints in-face, not in the fallback.
watch(suggestions, (list) => { for (const s of list) ensureGoogleFont(s.family) })

function pickSuggestion(s: { family: string; category: string }) {
  // Prefer the full catalog entry (carries axes); fall back to a minimal font so
  // the pick always lands even if the catalog hasn't loaded or omits this family.
  const font = catalog.value.find(f => f.family === s.family)
    ?? { family: s.family, category: s.category, weights: [400], italic: false, axes: [] }
  pickGoogle(font)   // closes the panel via pickGoogle
}

// Invalidate suggestions when the query changes.
watch(query, () => { if (suggestRan.value) clearSuggest() })

onClickOutside(root, () => { if (open.value) close() })

function toggle() {
  open.value = !open.value
  if (!open.value) return
  query.value = ''
  activeTab.value = props.selectedKey.startsWith('lib:') ? 'pangram' : 'google'
  nextTick(() => searchEl.value?.focus())
  if (!catalog.value.length) {
    loading.value = true
    loadGoogleCatalog().then(list => { catalog.value = list }).finally(() => { loading.value = false })
  }
}
function close() { open.value = false; query.value = '' }

const q = computed(() => query.value.trim().toLowerCase())

const featured = computed(() => {
  if (!q.value) return VARIABLE_FONTS
  return VARIABLE_FONTS.filter(f =>
    f.label.toLowerCase().includes(q.value) || f.family.toLowerCase().includes(q.value))
})

const googleMatches = computed(() => {
  if (!q.value) return catalog.value
  const starts: GoogleFont[] = [], has: GoogleFont[] = []
  for (const f of catalog.value) {
    const fam = f.family.toLowerCase()
    if (fam.startsWith(q.value)) starts.push(f)
    else if (fam.includes(q.value)) has.push(f)
  }
  return [...starts, ...has]
})
const googleShown = computed(() => googleMatches.value.slice(0, LIMIT))

const filteredLibrary = computed(() => filterLibraryGroups(query.value))
// Preview each visible library family in its own face once the Pangram tab is open.
watch([activeTab, filteredLibrary], () => {
  if (activeTab.value === 'pangram') for (const g of filteredLibrary.value) for (const f of g.families) ensureLibFace(f.family)
})

function pickVariable(f: VariableFont) { emit('pick', { source: 'variable', id: f.id }); close() }
function pickGoogle(f: GoogleFont) { emit('pick', { source: 'google', font: f }); close() }
function pickLibrary(family: string) { emit('pick', { source: 'library', family }); close() }
</script>

<template>
  <div ref="root" class="fp nopan nodrag">
    <button type="button" class="fp__trigger" @click="toggle">
      <span class="fp__trigger-label">{{ label }}</span>
      <span v-if="sublabel" class="fp__trigger-tag">{{ sublabel }}</span>
      <span class="fp__caret" :class="{ 'fp__caret--open': open }">›</span>
    </button>

    <div v-if="open" class="fp__panel">
      <div class="fp__searchrow">
        <input
          ref="searchEl"
          v-model="query"
          class="fp__search"
          placeholder="Search or describe fonts…"
          @keydown.enter.prevent="runSuggest"
        />
        <button type="button" class="fp__sparkle" title="Suggest fonts from a description" :disabled="suggestLoading" @click="runSuggest">✨ Ask AI</button>
      </div>
      <div class="fp__tabs">
        <button type="button" class="fp__tab" :class="{ 'fp__tab--active': activeTab === 'google' }" @click="activeTab = 'google'">Google</button>
        <button type="button" class="fp__tab" :class="{ 'fp__tab--active': activeTab === 'pangram' }" @click="activeTab = 'pangram'">Pangram</button>
      </div>
      <div v-if="activeTab === 'google'" class="fp__list">
        <template v-if="suggestLoading || suggestError || suggestions.length || suggestRan">
          <div class="fp__group">✨ Suggested</div>
          <div v-if="suggestLoading" class="fp__more">Finding fonts…</div>
          <div v-else-if="suggestError" class="fp__more">{{ suggestError }}</div>
          <div v-else-if="!suggestions.length" class="fp__more">No matches — try describing the style differently.</div>
          <button
            v-for="s in suggestions"
            :key="'s' + s.family"
            type="button"
            class="fp__row"
            :class="{ 'fp__row--sel': selectedKey === 'goog:' + s.family }"
            @click="pickSuggestion(s)"
          >
            <span class="fp__row-name" :style="{ fontFamily: s.family }">{{ s.family }}</span>
            <span class="fp__row-meta">{{ s.reason }}</span>
          </button>
        </template>

        <template v-if="featured.length">
          <div class="fp__group">Featured</div>
          <button
            v-for="f in featured"
            :key="'v' + f.id"
            type="button"
            class="fp__row"
            :class="{ 'fp__row--sel': selectedKey === 'var:' + f.id }"
            @click="pickVariable(f)"
          >
            <span class="fp__row-name">{{ f.label }}</span>
            <span class="fp__row-meta">{{ f.category }}</span>
          </button>
        </template>

        <div class="fp__group">
          Google Fonts
          <span v-if="loading" class="fp__hint">loading…</span>
          <span v-else-if="catalog.length" class="fp__hint">{{ googleMatches.length }}</span>
        </div>
        <button
          v-for="f in googleShown"
          :key="'g' + f.family"
          type="button"
          class="fp__row"
          :class="{ 'fp__row--sel': selectedKey === 'goog:' + f.family }"
          @click="pickGoogle(f)"
        >
          <span class="fp__row-name">{{ f.family }}</span>
          <span class="fp__row-meta">{{ f.axes.length ? 'variable' : f.category }}</span>
        </button>

        <div v-if="!loading && googleMatches.length > googleShown.length" class="fp__more">
          +{{ googleMatches.length - googleShown.length }} more — keep typing to narrow
        </div>
        <div v-if="!loading && q && !featured.length && !googleMatches.length" class="fp__more">
          No fonts match “{{ query }}”.
        </div>
      </div>
      <div v-else class="fp__list">
        <template v-for="g in filteredLibrary" :key="g.foundry.id">
          <div class="fp__group">{{ g.foundry.label }}</div>
          <button
            v-for="f in g.families"
            :key="f.id"
            type="button"
            class="fp__row"
            :class="{ 'fp__row--sel': selectedKey === 'lib:' + f.family }"
            @click="pickLibrary(f.family)"
          >
            <span class="fp__row-name" :style="{ fontFamily: f.family }">{{ f.family }}</span>
            <span class="fp__row-meta">{{ f.faces.length }}</span>
          </button>
        </template>
        <div v-if="!filteredLibrary.length" class="fp__more">
          No fonts match “{{ query }}”.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fp { position: relative; width: 100%; }
.fp__trigger {
  width: 100%;
  display: flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  color: rgba(255,255,255,0.92);
  cursor: pointer;
}
.fp__trigger:hover { border-color: rgba(255,255,255,0.25); }
.fp__trigger-label { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp__trigger-tag {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
  color: rgba(255,255,255,0.65); background: rgba(255,255,255,0.1);
  padding: 1px 5px; border-radius: 4px;
}
/* The app's one caret: `›` turned, never ▾/▴/⌄ — those draw smaller than their type size
   implies and sit off the optical centre. Down when closed, up when open. */
.fp__caret { display: inline-block; color: rgba(255,255,255,0.45); transform: rotate(90deg); transition: transform 0.15s; }
.fp__caret--open { transform: rotate(-90deg); }

.fp__panel {
  margin-top: 5px;
  background: #161616;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  padding: 6px;
  display: flex; flex-direction: column; gap: 6px;
}
.fp__search {
  width: 100%;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  color: rgba(255,255,255,0.92);
  outline: none;
}
.fp__search:focus { border-color: rgba(255,255,255,0.3); }
.fp__searchrow { display: flex; align-items: center; gap: 6px; }
.fp__searchrow .fp__search { flex: 1; }
.fp__sparkle {
  flex-shrink: 0;
  white-space: nowrap;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  padding: 4px 7px;
  font-size: 12px;
  cursor: pointer;
}
.fp__sparkle:hover { border-color: rgba(255,255,255,0.25); }
.fp__sparkle:disabled { opacity: 0.4; cursor: default; }
.fp__tabs { display: flex; align-items: center; gap: 4px; padding: 0 1px; }
.fp__tab {
  background: none; border: none; cursor: pointer;
  border-radius: 5px; padding: 3px 8px;
  font-size: 11px; color: rgba(255,255,255,0.5);
}
.fp__tab:hover { color: rgba(255,255,255,0.8); }
.fp__tab--active { background: rgba(255,255,255,0.15); color: rgba(255,255,255,0.9); }
.fp__list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; }
.fp__group {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em;
  color: rgba(255,255,255,0.4);
  padding: 6px 4px 3px;
  position: sticky; top: 0; background: #161616;
}
.fp__hint { text-transform: none; letter-spacing: 0; color: rgba(255,255,255,0.3); }
.fp__row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  padding: 5px 7px; border-radius: 5px;
  background: none; border: none; cursor: pointer; text-align: left;
}
.fp__row:hover { background: rgba(255,255,255,0.07); }
.fp__row--sel { background: rgba(255,255,255,0.12); }
.fp__row-name { font-size: 12px; color: rgba(255,255,255,0.9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp__row-meta { font-size: 9.5px; color: rgba(255,255,255,0.4); flex-shrink: 0; }
.fp__more { font-size: 10px; color: rgba(255,255,255,0.35); padding: 6px 7px; }
</style>
