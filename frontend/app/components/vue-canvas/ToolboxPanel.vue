<script setup lang="ts">
import {
  X, Toolbox,
  // Chrome & UI
  Search as SearchIcon, ChevronDown,
} from 'lucide-vue-next'
import { useNodeSearch } from '~/composables/useNodeSearch'
import {
  TOOLBOX_SECTIONS, TOOLBOX_DOMAINS, DEFAULT_COLLAPSED,
  type Domain, type ToolboxItem, type ToolboxSection,
} from '~/data/toolbox-items'

defineEmits<{ close: [] }>()

// Domain list aliased to its original local name so the rest of this file
// (rendering logic, filter loops) keeps reading naturally.
const DOMAINS = TOOLBOX_DOMAINS


// Apply default domain to any section that didn't set one explicitly.
const sections = computed<Required<ToolboxSection>[]>(() =>
  TOOLBOX_SECTIONS.map(s => ({ ...s, domain: s.domain ?? 'image' })),
)

const activeDomain = ref<Domain>('image')
const searchQuery = ref('')

function domainItemCount(d: Domain): number {
  return sections.value
    .filter(s => s.domain === d)
    .reduce((sum, s) => sum + s.items.length, 0)
}

// Visible sections = current domain + (if searching) filtered items per section.
const visibleSections = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return sections.value
    .filter(s => s.domain === activeDomain.value)
    .map(s => {
      if (!q) return s
      const items = s.items.filter(it =>
        it.label.toLowerCase().includes(q)
        || it.description.toLowerCase().includes(q)
        || it.nodeType.toLowerCase().includes(q),
      )
      return { ...s, items }
    })
    .filter(s => s.items.length > 0)
})

// Collapsed sections, persisted to localStorage.
const STORAGE_KEY = 'toolbox.collapsedSections'
const collapsedKeys = ref<Set<string>>(new Set())

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw != null) {
      collapsedKeys.value = new Set(JSON.parse(raw))
    } else {
      // First load: apply our default-collapsed set.
      collapsedKeys.value = new Set(DEFAULT_COLLAPSED)
    }
  } catch {
    collapsedKeys.value = new Set(DEFAULT_COLLAPSED)
  }
}
function saveCollapsed() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsedKeys.value]))
  } catch {}
}
onMounted(loadCollapsed)

function sectionKey(s: { domain: Domain; title: string }): string {
  return `${s.domain}:${s.title}`
}
function isCollapsed(s: { domain: Domain; title: string }): boolean {
  // While searching, force-expand every section so matches are visible.
  if (searchQuery.value.trim()) return false
  return collapsedKeys.value.has(sectionKey(s))
}
function toggleSection(s: { domain: Domain; title: string }) {
  const key = sectionKey(s)
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
  saveCollapsed()
}

const { addNode } = useNodeSearch()

// Adding a node never downloads anything (step 3, R10.5): the Toolbox's
// model nodes run as hosted calls, and the depth model fills itself.
function handleAdd(item: ToolboxItem) {
  addNode(item.nodeType)
}

const panelRef = ref<HTMLDivElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const hoveredItem = ref<ToolboxItem | null>(null)
const hoverPos = ref({ top: 0, left: 0 })
let enterTimer: ReturnType<typeof setTimeout> | null = null

function clearSearch() {
  searchQuery.value = ''
  searchInputRef.value?.focus()
}

// Native HTML5 drag → drop onto the VueFlow canvas. VueNodeCanvas already
// listens for `dragover`/`drop` and creates the node at the cursor position.
function onCardDragStart(event: DragEvent, item: ToolboxItem) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('text/plain', item.nodeType)
  event.dataTransfer.effectAllowed = 'copy'
  // Hide the hover-preview tooltip while a drag is in flight.
  if (enterTimer) clearTimeout(enterTimer)
  hoveredItem.value = null
}

function onCardEnter(event: MouseEvent, item: ToolboxItem) {
  const cardRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  if (enterTimer) clearTimeout(enterTimer)
  // Tiny delay so quick mouse-overs don't flash a preview.
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
</script>

<template>
  <div ref="panelRef" class="h-full bg-[#1a1a1a]/95 backdrop-blur-md border-r border-white/10 flex flex-col shadow-2xl">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/10">
      <div class="flex items-center gap-2">
        <Toolbox class="size-4 text-white/70" />
        <span class="text-sm font-semibold text-white/90">Toolbox</span>
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
          placeholder="Search the toolbox…"
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

    <!-- Sections / empty state -->
    <div class="flex-1 overflow-y-auto pb-3">
      <div
        v-if="visibleSections.length === 0"
        class="px-4 py-12 text-center text-xs text-white/40"
      >
        <template v-if="searchQuery.trim()">
          No nodes match <span class="text-white/70">"{{ searchQuery }}"</span>.
          <button class="block mx-auto mt-2 text-white/70 hover:text-white underline underline-offset-2 cursor-pointer" @click="clearSearch">
            Clear search
          </button>
        </template>
        <template v-else>
          No tools in this category yet.
        </template>
      </div>

      <div v-for="section in visibleSections" :key="sectionKey(section)" class="px-2 pt-2">
        <button
          class="w-full flex items-center justify-between px-1 pb-1.5 group cursor-pointer"
          @click="toggleSection(section)"
        >
          <span class="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40 group-hover:text-white/65 transition-colors">
            {{ section.title }}
            <span class="ml-1 text-white/25 normal-case tracking-normal">{{ section.items.length }}</span>
          </span>
          <ChevronDown
            class="size-3 text-white/30 group-hover:text-white/55 transition-all"
            :class="isCollapsed(section) ? '-rotate-90' : ''"
          />
        </button>
        <div v-if="!isCollapsed(section)" class="grid grid-cols-3 gap-1">
          <button
            v-for="item in section.items"
            :key="item.nodeType"
            draggable="true"
            class="relative group flex flex-col items-center justify-center gap-2.5 aspect-square rounded bg-white/[0.025] hover:bg-white/[0.08] border border-white/[0.04] hover:border-white/10 transition-colors cursor-grab active:cursor-grabbing p-2"
            title="Click to add, or drag onto the canvas"
            @click="handleAdd(item)"
            @dragstart="(e) => onCardDragStart(e, item)"
            @mouseenter="(e) => onCardEnter(e, item)"
            @mouseleave="onCardLeave"
          >
            <div class="relative size-6 flex items-center justify-center">
              <component
                :is="item.icon"
                class="size-6 text-white/65 group-hover:text-white/95 transition-colors"
                :stroke-width="1.5"
              />
            </div>
            <span class="text-[11px] text-white/65 group-hover:text-white/90 text-center leading-tight transition-colors line-clamp-2">{{ item.label }}</span>
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
        class="fixed z-[60] w-64 bg-[#1f1f1f]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl p-3 pointer-events-none"
        :style="{ top: hoverPos.top + 'px', left: hoverPos.left + 'px', transform: 'translateY(-50%)' }"
      >
        <div class="flex items-center gap-2 mb-1.5">
          <div class="flex items-center justify-center size-7 rounded-md bg-white/5">
            <component :is="hoveredItem.icon" class="size-3.5 text-white/80" />
          </div>
          <span class="text-sm font-semibold text-white/90">{{ hoveredItem.label }}</span>
        </div>
        <p class="text-xs text-white/60 leading-relaxed">{{ hoveredItem.description }}</p>
      </div>
    </Transition>
  </Teleport>
</template>
