<script setup lang="ts">
/**
 * Templates gallery — reusable Frame layouts. "Yours" lists what the user
 * has saved (useTemplateLibrary, file-backed via /api/frame-templates);
 * "Sailor" is a curated shelf seeded later (content task, not this one) so
 * it renders empty with a coming-soon note for now. Placing a card dispatches
 * `sailor:placeTemplate`, which CompositorModal listens for and routes to
 * placeTemplateIntoFrame() on the currently open Frame.
 */
import { Search as SearchIcon, X, LayoutTemplate, Trash2 } from 'lucide-vue-next'
import { useTemplateLibrary, type StoredTemplate } from '~/composables/useTemplateLibrary'

defineEmits<{ close: [] }>()

const { templates, remove } = useTemplateLibrary()

const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)

const visibleTemplates = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return templates.value
  return templates.value.filter(t => t.name.toLowerCase().includes(q))
})

function clearSearch() {
  searchQuery.value = ''
  searchInputRef.value?.focus()
}

// Place → the open Compositor. CompositorModal listens for this and calls
// placeTemplateIntoFrame(); if no Frame is open there's nothing listening,
// which is fine for v1 (per the brief: require an open Frame).
function onPlace(t: StoredTemplate) {
  window.dispatchEvent(new CustomEvent('sailor:placeTemplate', { detail: { template: t } }))
}

function onDelete(t: StoredTemplate, e: Event) {
  e.stopPropagation()
  if (window.confirm(`Delete "${t.name}"? This can't be undone.`)) {
    remove(t.id)
  }
}

function layerCount(t: StoredTemplate): number {
  const layers = (t as any).layers
  return Array.isArray(layers) ? layers.length : 0
}
</script>

<template>
  <div class="h-full bg-[#1a1a1a]/95 backdrop-blur-md border-r border-white/10 flex flex-col shadow-2xl">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
      <div class="flex items-center gap-2">
        <LayoutTemplate class="size-4 text-white/70" />
        <span class="text-sm font-semibold text-white/90">Templates</span>
        <span class="text-[11px] text-white/40 ml-1">{{ templates.length }}</span>
      </div>
      <button
        class="flex items-center justify-center size-6 rounded hover:bg-white/10 transition-colors cursor-pointer"
        @click="$emit('close')"
      >
        <X class="size-4 text-white/60" />
      </button>
    </div>

    <!-- Search -->
    <div v-if="templates.length" class="px-3 pt-3 pb-2 shrink-0">
      <div class="relative">
        <SearchIcon class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-white/40 pointer-events-none" />
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="text"
          placeholder="Search templates…"
          class="w-full bg-white/[0.04] border border-white/10 rounded pl-7 pr-7 py-1.5 text-xs text-white/85 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
          @keydown.esc="clearSearch"
        />
        <button
          v-if="searchQuery"
          class="absolute right-1.5 top-1/2 -translate-y-1/2 size-4 rounded hover:bg-white/10 flex items-center justify-center cursor-pointer"
          @click="clearSearch"
        >
          <X class="size-3 text-white/50" />
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-3 pt-1">
      <!-- Yours -->
      <p class="px-2 pt-1 pb-1.5 text-[9px] uppercase tracking-wider text-white/35">
        Yours
      </p>

      <!-- Empty state -->
      <div
        v-if="!templates.length"
        class="flex flex-col items-center justify-center px-4 py-8 text-center"
      >
        <div class="size-12 rounded-full bg-white/[0.04] border border-white/10 flex items-center justify-center mb-3">
          <LayoutTemplate class="size-5 text-white/40" />
        </div>
        <p class="text-sm text-white/70 font-medium mb-1">No templates saved yet</p>
        <p class="text-xs text-white/40 leading-relaxed">
          Open a Frame, then use<br />
          <span class="text-white/60">"Save as Template…"</span> to add one here.
        </p>
      </div>

      <p
        v-else-if="searchQuery && !visibleTemplates.length"
        class="text-xs text-white/40 text-center mt-6"
      >
        No templates match "{{ searchQuery }}".
      </p>

      <div v-else class="flex flex-col gap-1.5 mb-3">
        <div
          v-for="t in visibleTemplates"
          :key="t.id"
          class="template-card group relative flex items-center gap-2 px-2 py-2 rounded-md bg-white/[0.025] hover:bg-white/[0.06] border border-white/[0.04] hover:border-white/10 transition-colors"
        >
          <div class="shrink-0 size-9 rounded bg-white/[0.05] border border-white/10 flex items-center justify-center">
            <LayoutTemplate class="size-4 text-white/40" />
          </div>
          <div class="flex-1 min-w-0 flex flex-col gap-0.5">
            <span class="text-[12px] font-medium text-white/90 truncate">{{ t.name }}</span>
            <div class="text-[10px] text-white/40 flex items-center gap-1.5">
              <span>{{ layerCount(t) }} layer{{ layerCount(t) === 1 ? '' : 's' }}</span>
            </div>
          </div>
          <button
            class="shrink-0 flex items-center justify-center size-5 rounded text-white/40 hover:text-rose-300 hover:bg-rose-500/15 opacity-0 group-hover:opacity-100 transition-opacity"
            :aria-label="`Delete ${t.name}`"
            @click="onDelete(t, $event)"
          >
            <Trash2 class="size-3.5" />
          </button>
          <button
            class="shrink-0 px-2.5 py-1 rounded text-[11px] font-medium bg-white/10 hover:bg-white/20 text-white/85 transition-colors cursor-pointer"
            @click="onPlace(t)"
          >
            Place
          </button>
        </div>
      </div>

      <!-- Sailor: curated shelf, seeded in a later content task -->
      <p class="px-2 pt-2 pb-1.5 text-[9px] uppercase tracking-wider text-white/35 border-t border-white/10 mt-1">
        Sailor
      </p>
      <div class="flex flex-col items-center justify-center px-4 py-6 text-center">
        <p class="text-xs text-white/40 leading-relaxed">
          Curated starting templates are coming soon.
        </p>
      </div>
    </div>
  </div>
</template>
