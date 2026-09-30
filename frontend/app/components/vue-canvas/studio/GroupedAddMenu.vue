<script lang="ts">
import type { Component } from 'vue'

/** One entry. `testid` + `kind` land as data attributes so tests address items as before. */
export interface AddMenuItem {
  id: string
  label: string
  testid: string
  kind?: string
  icon?: Component
  disabled?: boolean
  /** Tooltip — why a greyed entry is greyed. */
  title?: string
}
export interface AddMenuGroup { label: string; items: AddMenuItem[] }

/** Where to open the menu beside the button that opened it: on whichever side has more room,
 *  its height capped to that room (the list scrolls), kept off the right edge. */
export function anchoredMenuPos(r: DOMRect, width: number): { top: number; left: number; maxHeight: number } {
  const MARGIN = 8
  const below = window.innerHeight - (r.bottom + 4) - MARGIN
  const above = (r.top - 4) - MARGIN
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - MARGIN - width))
  return below >= above
    ? { top: r.bottom + 4, left, maxHeight: Math.max(0, below) }
    : { top: Math.max(MARGIN, r.top - 4 - Math.max(0, above)), left, maxHeight: Math.max(0, above) }
}
</script>

<script setup lang="ts">
// The add menu shared by the Frame layer plus and the 3D object plus: a search box, then the
// entries under small group headings. Typing filters by entry or group name; ↑/↓ + Enter pick,
// Esc closes. Positioning is the caller's (it teleports and places this root).
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'

const props = defineProps<{
  groups: AddMenuGroup[]
  /** Entries above the search results with no heading (e.g. "Add outline"). */
  lead?: AddMenuItem[]
  placeholder?: string
}>()
const emit = defineEmits<{ pick: [id: string]; close: [] }>()

const query = ref('')
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  const lead = (props.lead ?? []).filter(i => !q || i.label.toLowerCase().includes(q))
  const groups = props.groups
    .map(g => ({
      label: g.label,
      items: !q || g.label.toLowerCase().includes(q) ? g.items : g.items.filter(i => i.label.toLowerCase().includes(q)),
    }))
    .filter(g => g.items.length)
  return { lead, groups }
})
const pickable = computed(() =>
  [...shown.value.lead, ...shown.value.groups.flatMap(g => g.items)].filter(i => !i.disabled))

const activeId = ref<string | null>(null)
watch(query, () => { activeId.value = query.value.trim() ? (pickable.value[0]?.id ?? null) : null })

function move(step: number) {
  const list = pickable.value
  if (!list.length) return
  const i = list.findIndex(x => x.id === activeId.value)
  const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length
  activeId.value = list[next]!.id
  nextTick(() => listEl.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const hit = pickable.value.find(x => x.id === activeId.value)
    if (hit) emit('pick', hit.id)
  } else if (e.key === 'Escape') { e.preventDefault(); emit('close') }
}
function pick(item: AddMenuItem) { if (!item.disabled) emit('pick', item.id) }

onMounted(() => input.value?.focus({ preventScroll: true }))
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-[#161616] shadow-2xl" @keydown.stop="onKey">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-2.5 py-2">
      <Search class="h-3.5 w-3.5 shrink-0 text-white/35" />
      <input ref="input" v-model="query" type="text" data-testid="add-menu-search" :placeholder="placeholder ?? 'Search'"
        class="min-w-0 flex-1 bg-transparent text-[12px] text-white/90 outline-none placeholder:text-white/30" />
    </div>
    <div ref="listEl" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
      <template v-for="item in shown.lead" :key="item.id">
        <button type="button" :data-testid="item.testid" :data-kind="item.kind" :data-active="item.id === activeId"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer data-[active=true]:bg-white/10 data-[active=true]:text-white"
          @mouseenter="activeId = item.id" @click.stop="pick(item)">
          <component :is="item.icon" v-if="item.icon" class="h-3.5 w-3.5 opacity-70" />{{ item.label }}
        </button>
      </template>
      <div v-if="shown.lead.length && shown.groups.length" class="my-1 h-px bg-white/10" />
      <div v-for="(g, gi) in shown.groups" :key="g.label" data-testid="add-menu-group" :data-group="g.label">
        <div class="px-2 pb-0.5 text-[10.5px] font-medium text-white/35" :class="gi ? 'pt-2.5' : 'pt-1'">{{ g.label }}</div>
        <button v-for="item in g.items" :key="item.id" type="button"
          :data-testid="item.testid" :data-kind="item.kind" :data-active="item.id === activeId"
          :disabled="item.disabled" :title="item.title"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer data-[active=true]:bg-white/10 data-[active=true]:text-white disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-white/80"
          @mouseenter="item.disabled || (activeId = item.id)" @click.stop="pick(item)">
          <component :is="item.icon" v-if="item.icon" class="h-3.5 w-3.5 opacity-70" />
          <span>{{ item.label }}</span>
        </button>
      </div>
      <div v-if="!shown.lead.length && !shown.groups.length" class="px-2 py-3 text-center text-[12px] text-white/35">No matches</div>
    </div>
  </div>
</template>
