<script setup lang="ts">
/**
 * TexturePicker — the 3D Studio's ambientCG surface picker. A 28px row (thumbnail + name,
 * or "None") that opens an inline panel: search box, category chips, thumbnail grid capped
 * at 120. Picking FETCHES first (server unpacks the 1K set) and only then writes the
 * resolved id, so a failed download leaves the material untouched. Shaped like FontPicker.
 */
import { loadTextureCatalog, ensureTextureFetched, bareTextureId, TEXTURE_ID_PREFIX, type TextureSet } from '~/lib/scene3d/textures'

const props = defineProps<{ modelValue: string | undefined }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'error', msg: string): void }>()

const open = ref(false)
const search = ref('')
const category = ref<string | null>(null)
const sets = ref<TextureSet[]>([])
const loadError = ref('')
const busyId = ref<string | null>(null)
const rowError = ref('')

loadTextureCatalog()
  .then((s) => { sets.value = s })
  .catch(() => { loadError.value = 'Texture library unavailable' })

const current = computed(() => {
  const v = props.modelValue
  if (!v || !v.startsWith(TEXTURE_ID_PREFIX)) return null
  const id = bareTextureId(v)
  return sets.value.find(s => s.id === id) ?? { id, name: id, category: '', tags: [], thumb: '', popularity: 0 }
})

const categories = computed(() => {
  const score = new Map<string, number>()
  for (const s of sets.value) score.set(s.category, (score.get(s.category) ?? 0) + s.popularity)
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
})

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const words = q ? q.split(/\s+/) : []
  return sets.value
    .filter(s => !category.value || s.category === category.value)
    .filter(s => !words.length || words.every(w => s.name.toLowerCase().includes(w) || s.category.toLowerCase().includes(w) || s.tags.some(t => t.includes(w))))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 120)
})

async function pick(s: TextureSet) {
  rowError.value = ''
  busyId.value = s.id
  try {
    await ensureTextureFetched(TEXTURE_ID_PREFIX + s.id)
    emit('update:modelValue', TEXTURE_ID_PREFIX + s.id)
    open.value = false
    search.value = ''
  } catch {
    rowError.value = "Couldn't download this texture"
    emit('error', rowError.value)
  } finally {
    busyId.value = null
  }
}

function clear() {
  rowError.value = ''
  emit('update:modelValue', '')
}
</script>

<template>
  <div data-testid="texture-picker">
    <button
      type="button"
      class="group flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-white/[0.05] px-2.5 text-left hover:bg-white/[0.08]"
      data-testid="texture-picker-row"
      @click="open = !open"
    >
      <span class="flex shrink-0 items-center gap-1.5 text-[11px] text-white/72">Texture</span>
      <span class="ml-auto flex min-w-0 items-center gap-1.5 text-[11px] text-white/90">
        <img v-if="current?.thumb" :src="current.thumb" class="size-5 rounded-sm object-cover" alt="" data-testid="texture-picker-thumb" />
        <span class="truncate">{{ current ? current.name : 'None' }}</span>
      </span>
      <!-- The app's one caret: `›` turned, never ▾/▴/⌄. Down when closed, up when open. -->
      <span class="inline-block shrink-0 text-white/40 transition-transform" :class="open ? '-rotate-90' : 'rotate-90'">›</span>
    </button>
    <p v-if="rowError" class="mt-1 px-2 text-[11px] text-white/55">{{ rowError }}</p>

    <div v-if="open" class="mt-1 rounded bg-black/40 p-1">
      <div class="mb-1 flex items-center gap-1">
        <input
          v-model="search" placeholder="Search textures…" autofocus
          class="w-full flex-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px]"
          data-testid="texture-picker-search"
        />
        <button v-if="current" type="button" class="shrink-0 rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] hover:border-white/25" @click="clear">Clear</button>
      </div>
      <p v-if="loadError" class="px-2 py-1 text-[11px] text-white/40">{{ loadError }}</p>
      <template v-else>
        <!-- Categories ride ABOVE the grid, not beside it: the inspector column is ~170px
             wide, and a sidebar would leave the thumbnails too small to tell apart. -->
        <div class="mb-1 flex gap-1 overflow-x-auto pb-0.5">
          <button type="button" class="shrink-0 rounded px-2 py-0.5 text-[11px]" :class="category === null ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'" @click="category = null">All</button>
          <button v-for="c in categories" :key="c" type="button" class="shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-[11px]"
                  :class="category === c ? 'bg-white/15 text-white/90' : 'text-white/50 hover:text-white/80'" @click="category = c">{{ c }}</button>
        </div>
        <!-- Fixed-size tiles wrapped by flex, NOT an aspect-square grid: an auto grid row
             sizes a `aspect-ratio` item from a base of zero, so the rows collapse to a
             fraction of the tile and neighbouring tiles overlap — the top one then eats
             clicks meant for the one below it. A fixed size has no such cycle. -->
        <div class="flex flex-wrap gap-1 overflow-y-auto" style="max-height: 260px" data-testid="texture-picker-grid">
          <button v-for="s in filtered" :key="s.id" type="button" :title="s.name"
                  class="relative size-9 shrink-0 overflow-hidden rounded border transition-colors"
                  :class="current?.id === s.id ? 'border-white/80' : 'border-white/10 hover:border-white/40'"
                  :disabled="busyId !== null"
                  @click="pick(s)">
            <img :src="s.thumb" class="size-full object-cover" :alt="s.name" loading="lazy" />
            <span v-if="busyId === s.id" class="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-white/80">…</span>
          </button>
          <p v-if="!filtered.length" class="px-2 py-2 text-[11px] text-white/40">No textures match</p>
        </div>
      </template>
    </div>
  </div>
</template>
