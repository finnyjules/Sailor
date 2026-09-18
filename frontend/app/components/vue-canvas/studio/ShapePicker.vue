<script setup lang="ts">
/**
 * The shape library picker — ONE component for every `shape` control (Space
 * Type's separator today; Compositor, Shape Studio and 3D Studio next). A
 * teleported, viewport-clamped floating panel anchored to its row, closed by
 * Escape or a click outside (the SweepPopover / CanvasContextMenu conventions).
 *
 * Thumbnails are inline SVG in `currentColor`: the shape's source colour is a
 * hint in the manifest, never something the picker shows.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { SHAPE_FAMILIES, SHAPE_NONE, familyOf, searchShapes, type ShapeFamily } from '~/lib/shapes/catalog'
import { SHAPE_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'

const props = withDefaults(defineProps<{
  modelValue: string
  allowNone?: boolean
  anchor: { x: number; y: number }
  /** The element that opened this picker. A press on it is NOT an outside
   *  click: the trigger owns the open/closed toggle, and closing here as well
   *  would make the same press close and immediately reopen the panel. */
  ignore?: HTMLElement | null
  /** Multi-select: a tile toggles (emits `toggle`), the picker stays open, and
   *  tiles in `selectedIds` show as on. Single-select (default) is unchanged. */
  multiple?: boolean
  selectedIds?: string[]
}>(), { allowNone: true, multiple: false, selectedIds: () => [] })
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'toggle', v: string): void; (e: 'close'): void }>()

/** Whether a tile shows as selected: the set membership in multi mode, else the single value. */
function isOn(id: string): boolean { return props.multiple ? props.selectedIds.includes(id) : props.modelValue === id }

const query = ref('')
const family = ref<ShapeFamily | 'all'>('all')
const rail = computed(() => [{ id: 'all' as const, label: 'All' }, ...SHAPE_FAMILIES])
const visible = computed(() =>
  searchShapes(query.value).filter(s => family.value === 'all' || familyOf(s.id) === family.value),
)

/** Roving tabindex: the grid is one Tab stop, not one per tile. The selected
 *  tile (or the first tile when nothing currently rendered is selected) gets
 *  tabindex="0"; every other tile gets "-1" so arrow-key navigation (below)
 *  moves focus within the grid without Tab stepping through every shape.
 *  Recomputed off `visible`, so a search/family filter that hides the
 *  selected shape rolls the roving stop onto the first visible tile. */
const tileIds = computed(() => [
  ...(props.allowNone ? [SHAPE_NONE] : []),
  ...visible.value.map(s => s.id),
])
const rovingId = computed(() =>
  tileIds.value.includes(props.modelValue) ? props.modelValue : tileIds.value[0],
)

function pick(id: string) {
  if (props.multiple) { emit('toggle', id); return } // stay open; the parent updates the set
  emit('update:modelValue', id)
  emit('close')
}

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
    x = Math.max(8, x)
    y = Math.max(8, y)
    pos.value = { x, y }
    searchRef.value?.focus()
  })
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); emit('close') }
}

/** Roving focus across the tile grid. The grid is a fixed 5-column CSS grid
 *  (grid-cols-5 below), so Down/Up is ±5 tiles and Right/Left is ±1; the
 *  column count lives here as GRID_COLS because nothing in the DOM reports
 *  it. Movement clamps at both ends rather than wrapping — the None tile and
 *  the last shape are the edges of the list, not a ring. */
const GRID_COLS = 5
const gridRef = ref<HTMLDivElement | null>(null)

function tiles(): HTMLElement[] {
  return Array.from(gridRef.value?.querySelectorAll<HTMLElement>('[data-shape]') ?? [])
}
function focusTile(index: number) {
  const list = tiles()
  if (!list.length) return
  list[Math.min(list.length - 1, Math.max(0, index))]!.focus()
}

function onGridKeydown(e: KeyboardEvent) {
  const list = tiles()
  const i = list.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  const steps: Record<string, number | undefined> = {
    ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLS, ArrowUp: -GRID_COLS,
  }
  const step = steps[e.key]
  if (step !== undefined) { e.preventDefault(); focusTile(i + step); return }
  if (e.key === 'Home') { e.preventDefault(); focusTile(0); return }
  if (e.key === 'End') { e.preventDefault(); focusTile(list.length - 1); return }
  if (e.key === 'Enter' || e.key === ' ') {
    // A focused <button> already activates on Enter/Space; preventDefault
    // stops the browser ALSO synthesising a click, which would pick the same
    // tile twice. Picking here keeps the behaviour identical either way.
    e.preventDefault()
    const id = list[i]!.dataset.shape
    if (id) pick(id)
  }
}

/** Focus stays in the search box on open (typing is the common first move);
 *  ArrowDown is the documented way into the grid, landing on the current
 *  shape when it is visible so the selection is where the eye already is. */
function onSearchKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowDown') return
  e.preventDefault()
  const current = tiles().findIndex(el => el.dataset.shape === props.modelValue)
  focusTile(current >= 0 ? current : 0)
}
function onOutside(e: MouseEvent) {
  const target = e.target as Node
  if (rootRef.value?.contains(target)) return
  if (props.ignore?.contains(target)) return
  emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('mousedown', onOutside, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onOutside, true)
})

const tile = 'flex h-9 w-9 items-center justify-center rounded-md transition-colors'
const tileIdle = 'text-white/70 hover:bg-white/10 hover:text-white'
const tileOn = 'bg-white text-neutral-900'
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootRef"
      class="fixed z-[210] rounded-lg border border-white/10 bg-[#141414] p-2 text-[12px] text-white/90 shadow-2xl"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${SHAPE_PICKER_WIDTH}px` }"
      role="dialog"
      aria-label="Choose a shape"
    >
      <input
        ref="searchRef"
        v-model="query"
        type="search"
        placeholder="Search shapes"
        spellcheck="false"
        class="mb-2 h-7 w-full rounded-[6px] bg-white/[0.06] px-2 text-[11px] text-white/90 outline-none placeholder:text-white/30 focus:bg-white/[0.10]"
        @keydown="onSearchKeydown"
      />
      <div class="flex gap-2">
        <div class="flex w-24 shrink-0 flex-col gap-0.5">
          <button
            v-for="f in rail" :key="f.id" type="button"
            :data-family="f.id"
            class="rounded px-2 py-1 text-left text-[11px] transition-colors"
            :class="family === f.id ? 'bg-white text-neutral-900' : 'text-white/55 hover:bg-white/10 hover:text-white/90'"
            @click="family = f.id"
          >{{ f.label }}</button>
        </div>
        <div
          ref="gridRef"
          class="grid max-h-64 flex-1 grid-cols-5 content-start gap-1 overflow-y-auto pr-1"
          role="listbox"
          aria-label="Shapes"
          @keydown="onGridKeydown"
        >
          <button
            v-if="allowNone && !multiple" type="button" data-shape="none" title="None" role="option"
            :aria-selected="modelValue === SHAPE_NONE ? 'true' : 'false'"
            :tabindex="rovingId === SHAPE_NONE ? 0 : -1"
            :class="[tile, modelValue === SHAPE_NONE ? tileOn : tileIdle]"
            @click="pick(SHAPE_NONE)"
          ><span class="text-[11px]">None</span></button>
          <button
            v-for="s in visible" :key="s.id" type="button" :data-shape="s.id" :title="s.name" role="option"
            :aria-selected="isOn(s.id) ? 'true' : 'false'"
            :tabindex="rovingId === s.id ? 0 : -1"
            :class="[tile, isOn(s.id) ? tileOn : tileIdle]"
            @click="pick(s.id)"
          >
            <svg viewBox="0 0 96 96" width="26" height="26" fill="currentColor" aria-hidden="true">
              <path :d="s.d" :fill-rule="s.fillRule" />
            </svg>
          </button>
          <p v-if="!visible.length" class="col-span-5 py-4 text-center text-[11px] text-white/40">No shapes match.</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
