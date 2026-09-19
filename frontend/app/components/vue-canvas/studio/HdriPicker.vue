<script setup lang="ts">
/**
 * The browsable Poly Haven HDRI library — the visual replacement for the Lighting panel's HDRI
 * dropdown, mirroring LookPicker's popover conventions (teleported, viewport-clamped, Escape /
 * click-outside to close, `ignore` for the trigger). Cards show Poly Haven's own thumbnails; the
 * catalog is loaded once from our same-origin cache route.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { HDRI_RAILS, loadHdriCatalog, filterHdris, hdriThumbUrl, type HdriCatalogEntry } from '~/lib/scene3d/hdriCatalog'
import { LOOK_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'

const props = defineProps<{
  modelValue: string
  anchor: { x: number; y: number }
  ignore?: HTMLElement | null
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'close'): void }>()

const query = ref('')
const rail = ref<string>('featured')
const entries = ref<HdriCatalogEntry[]>([])
const state = ref<'loading' | 'ready' | 'error'>('loading')

onMounted(() => {
  loadHdriCatalog()
    .then((e) => { entries.value = e; state.value = 'ready' })
    .catch(() => { state.value = 'error' })
})

const visible = computed<HdriCatalogEntry[]>(() => filterHdris(entries.value, rail.value, query.value))

function pick(slug: string) { emit('update:modelValue', slug); emit('close') }

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

const card = 'group flex flex-col gap-1 rounded-md p-1 text-left transition-colors'
const cardIdle = 'hover:bg-white/[0.07]'
const cardOn = 'bg-white/[0.12] ring-1 ring-white/40'
</script>

<template>
  <Teleport to="body">
    <!-- `data-hdri-picker` is the marker the 3D Studio surface's Escape handler queries so it yields
         the key to us while we're open (same mechanism as data-look-picker). -->
    <div
      ref="rootRef"
      data-hdri-picker
      class="fixed z-[210] rounded-lg border border-white/10 bg-[#141414] p-2 text-[12px] text-white/90 shadow-2xl"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${LOOK_PICKER_WIDTH}px` }"
      role="dialog"
      aria-label="Choose a studio HDRI"
    >
      <input
        ref="searchRef"
        v-model="query"
        type="text"
        placeholder="Search HDRIs — studio, sunset, night…"
        class="mb-2 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] text-white/90 placeholder:text-white/30 focus:border-white/25 focus:outline-none"
      />
      <div class="flex gap-2" style="height: 320px">
        <!-- Category rail -->
        <div class="flex w-[112px] shrink-0 flex-col gap-0.5 overflow-y-auto pr-1">
          <button
            v-for="r in HDRI_RAILS"
            :key="r.id"
            type="button"
            class="rounded px-2 py-1.5 text-left text-[11px] transition-colors"
            :class="rail === r.id && !query.trim() ? 'bg-white text-black' : 'text-white/70 hover:bg-white/[0.06]'"
            @click="rail = r.id; query = ''"
          >{{ r.label }}</button>
        </div>
        <!-- Card grid -->
        <div class="min-w-0 flex-1 overflow-y-auto">
          <div v-if="state === 'loading'" class="grid h-full place-items-center text-white/40">Loading the library…</div>
          <div v-else-if="state === 'error'" class="grid h-full place-items-center px-4 text-center text-white/40">
            Couldn't reach the HDRI library. Check your connection and reopen.
          </div>
          <div v-else-if="!visible.length" class="grid h-full place-items-center text-white/40">No matches</div>
          <div v-else class="grid grid-cols-3 gap-1.5">
            <button
              v-for="e in visible"
              :key="e.slug"
              type="button"
              :class="[card, e.slug === modelValue ? cardOn : cardIdle]"
              :title="e.name"
              @click="pick(e.slug)"
            >
              <span class="aspect-[2/1] w-full overflow-hidden rounded bg-[#0d1016]">
                <img :src="hdriThumbUrl(e.slug)" :alt="e.name" loading="lazy" class="size-full object-cover" />
              </span>
              <span class="truncate text-[10.5px] leading-tight text-white/80">{{ e.name }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
