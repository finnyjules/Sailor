<script setup lang="ts">
/**
 * The Look library picker — the visual replacement for the Lighting panel's Look
 * dropdown. Same popover conventions as ShapePicker (teleported, viewport-clamped,
 * Escape / click-outside to close, `ignore` for the trigger). Every card is drawn
 * from its LookRecipe by LookPlot, so the library is data, not images.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { LOOK_GROUPS, featuredLooks, looksInGroup, searchLooks, type LookRecipe } from '~/lib/scene3d/lighting'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import LookPlot from './LookPlot.vue'

const props = defineProps<{
  modelValue: string
  anchor: { x: number; y: number }
  ignore?: HTMLElement | null
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'close'): void }>()

type RailId = 'featured' | LookRecipe['group']
const query = ref('')
const rail = ref<RailId>('featured')
const railItems = computed(() => [{ id: 'featured' as RailId, label: 'Featured' }, ...LOOK_GROUPS.map(g => ({ id: g.id as RailId, label: g.label }))])

/** Search wins over the rail: a typed query searches the whole library. */
const visible = computed<LookRecipe[]>(() => {
  if (query.value.trim()) return searchLooks(query.value)
  if (rail.value === 'featured') return featuredLooks()
  return looksInGroup(rail.value)
})

function pick(id: string) { emit('update:modelValue', id); emit('close') }

const rootRef = ref<HTMLDivElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const pos = ref({ x: props.anchor.x, y: props.anchor.y })
onMounted(() => {
  nextTick(() => {
    const el = rootRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = props.anchor.x, y = props.anchor.y
    if (x + r.width + 8 > window.innerWidth) x = Math.max(8, window.innerWidth - r.width - 8)
    if (y + r.height + 8 > window.innerHeight) y = Math.max(8, window.innerHeight - r.height - 8)
    pos.value = { x: Math.max(8, x), y: Math.max(8, y) }
    searchRef.value?.focus()
  })
})
function onKeydown(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); emit('close') } }
function onOutside(e: MouseEvent) {
  const t = e.target as Node
  if (rootRef.value?.contains(t)) return
  if (props.ignore?.contains(t)) return
  emit('close')
}
onMounted(() => { window.addEventListener('keydown', onKeydown, true); window.addEventListener('mousedown', onOutside, true) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown, true); window.removeEventListener('mousedown', onOutside, true) })

const card = 'flex flex-col items-center gap-1 rounded-md p-1.5 text-center transition-colors'
const cardIdle = 'hover:bg-white/[0.07]'
const cardOn = 'bg-white/[0.12] ring-1 ring-white/40'
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootRef"
      class="fixed z-[210] rounded-lg border border-white/10 bg-[#141414] p-2 text-[12px] text-white/90 shadow-2xl"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${LOOK_PICKER_WIDTH}px` }"
      role="dialog"
      aria-label="Choose a lighting look"
    >
      <input
        ref="searchRef"
        v-model="query"
        type="search"
        placeholder="Search looks — softbox, rim, golden hour…"
        spellcheck="false"
        class="mb-2 h-7 w-full rounded-[6px] bg-white/[0.06] px-2 text-[11px] text-white/90 outline-none placeholder:text-white/30 focus:bg-white/[0.10]"
      />
      <div class="flex gap-2">
        <div class="flex w-28 shrink-0 flex-col gap-0.5">
          <button
            v-for="r in railItems" :key="r.id" type="button"
            class="rounded px-2 py-1 text-left text-[11px] transition-colors"
            :class="rail === r.id && !query.trim() ? 'bg-white text-neutral-900' : 'text-white/55 hover:bg-white/10 hover:text-white/90'"
            @click="rail = r.id; query = ''"
          >{{ r.label }}</button>
        </div>
        <div class="grid max-h-[340px] flex-1 grid-cols-4 content-start gap-1 overflow-y-auto pr-1" role="listbox" aria-label="Looks">
          <button
            v-for="l in visible" :key="l.id" type="button" role="option" :data-look="l.id"
            :aria-selected="modelValue === l.id ? 'true' : 'false'"
            :title="l.blurb"
            :class="[card, modelValue === l.id ? cardOn : cardIdle]"
            @click="pick(l.id)"
          >
            <span class="relative rounded-md bg-[#0d1016] p-1">
              <LookPlot :recipe="l" :size="72" />
              <span v-if="l.additive" class="absolute right-1 top-1 rounded bg-white/15 px-1 text-[9px] leading-4 text-white/80" title="Adds to the current look">+</span>
              <span v-if="l.featured" class="absolute left-1 top-1 text-[10px] leading-4 text-amber-300/90" title="Featured">★</span>
            </span>
            <span class="w-full truncate text-[11px] leading-tight text-white/90">{{ l.label }}</span>
            <span class="w-full truncate text-[9.5px] leading-tight text-white/45">{{ l.blurb }}</span>
          </button>
          <p v-if="!visible.length" class="col-span-4 py-6 text-center text-[11px] text-white/40">No looks match.</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
