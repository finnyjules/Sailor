<script setup lang="ts">
// Effect picker for Kinetic Studio — wraps the shared CatalogModal. Two tabs:
//
//   Layouts  the Showcase card layouts (photos, fill cards and words on one arrangement),
//            grouped by family. Thumbnails are drawn live from each layout's own placement
//            maths and play while hovered — no captured image to go stale.
//   Text     the type-first effects, with their captured thumbnails (the capture button).
//
// Which tab an effect sits on is the effect's own `gallery` field. Picking one emits
// `select`; the editor sets effectId and its existing watcher switches (keeping content,
// card look and motion when the switch is from one layout to another).
import { ref, computed, onMounted } from 'vue'
import { SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects'
import { LAYOUT_FAMILIES } from '~/lib/spacetype/layouts/index'
import { loadEffectThumbnails } from '~/composables/useEffectThumbnails'
import ShowcaseLayoutThumb from './ShowcaseLayoutThumb.vue'

const props = defineProps<{ selectedId: string }>()
const emit = defineEmits<{ close: []; select: [id: string] }>()

type Tab = 'layouts' | 'text'
const tabOf = (e: { gallery?: Tab }): Tab => e.gallery ?? 'text'

const thumbs = ref<Record<string, string>>({})
onMounted(async () => { thumbs.value = await loadEffectThumbnails() })

const visibleEffects = SPACE_TYPE_EFFECTS.filter(e => !e.hidden)
// Picker order within a tab is registry order — for layouts that is already family by family,
// which CatalogModal's sectioned grid needs (its arrow-key nav follows the flat item order).
const entries = visibleEffects.map(e => ({ id: e.id, label: e.label, tab: tabOf(e), layout: e.showcaseLayout }))
const count = (t: Tab) => entries.filter(e => e.tab === t).length

// `selectedId` marks the effect in use ("Current"); the modal tracks its own focus, and
// `confirm` hands back whichever entry is focused — so the mark never wanders off to a
// tab's first item when the tab changes.
const searchQuery = ref('')
// Open on the tab holding the current effect.
const tab = ref<Tab>(entries.find(e => e.id === props.selectedId)?.tab ?? 'layouts')
const tabs = [
  { id: 'layouts', label: 'Layouts', count: count('layouts') },
  { id: 'text', label: 'Text', count: count('text') },
]

const items = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return entries.filter(e => e.tab === tab.value && (!q || e.label.toLowerCase().includes(q)))
})
const sections = computed(() => (tab.value === 'layouts' ? LAYOUT_FAMILIES.map(f => ({ id: f, label: f })) : undefined))
const sectionOf = (item: { layout?: { family: string } }) => item.layout?.family ?? ''

const hoveredId = ref<string | null>(null)
</script>

<template>
  <CatalogModal
    :open="true"
    title="Pick an effect"
    :subtitle="tab === 'layouts' ? 'Arrange photos, cards and words' : 'Effects built around a line of text'"
    :items="items"
    :selected-id="selectedId"
    :filters="tabs"
    :active-filter-id="tab"
    :sections="sections"
    :section-of="sectionOf"
    :search-query="searchQuery"
    :search-placeholder="tab === 'layouts' ? 'Search layouts…' : 'Search effects…'"
    :empty-message="tab === 'layouts' ? 'No layouts match.' : 'No effects match.'"
    @close="emit('close')"
    @confirm="(it: any) => emit('select', it.id)"
    @update:active-filter-id="(id: string) => (tab = id as Tab)"
    @update:search-query="(q: string) => (searchQuery = q)"
  >
    <template #card="{ item, focused }">
      <div
        class="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-t-lg bg-neutral-950"
        @mouseenter="hoveredId = (item as any).id" @mouseleave="hoveredId = null"
      >
        <ShowcaseLayoutThumb
          v-if="(item as any).layout"
          :layout="(item as any).layout"
          :playing="hoveredId === (item as any).id || focused"
        />
        <img v-else-if="thumbs[(item as any).id]" :src="thumbs[(item as any).id]" :alt="(item as any).label" class="h-full w-full object-cover" />
        <span v-else class="text-[10px] text-white/30">{{ (item as any).label }}</span>
      </div>
      <div class="px-3 py-2">
        <span class="text-[13px] font-medium text-white/90">{{ (item as any).label }}</span>
      </div>
    </template>
  </CatalogModal>
</template>
