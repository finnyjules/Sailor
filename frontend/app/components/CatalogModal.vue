<script setup lang="ts" generic="T extends { id: string }">
/**
 * CatalogModal — reusable full-screen picker for browsing a collection of
 * "items" (models, blocks, fonts, templates, …) and committing one to a
 * caller. Generic over the item type T; the caller provides slots for the
 * card and detail-pane rendering plus filter wiring.
 *
 * Layout: header (title, search, filter chips) · grid (cards) · footer
 * (cancel + confirm). Detail pane slides in from the right when an item
 * has focus, hosting per-item settings without leaving the modal.
 *
 * Reuse sites at time of writing:
 *   - ModelGalleryModal (text-to-image model picker), and the other *GalleryModal pickers
 *   - ShaderEffectGallery (every shader-effect picker: node, Shader studio, fills, Frame)
 *
 * Optional extras: a `#lead` card shown first in the `leadIn` section (or first in the
 * flat grid), and a `#card-overlay` rendered over each card OUTSIDE its <button> (so the
 * overlay can hold its own buttons). `testid` lands on the panel: the root is a Teleport,
 * so attributes can't fall through.
 */
import { Search, X, Check } from 'lucide-vue-next'
import { groupBySections, type CatalogSection } from '~/lib/catalogSections'

interface FilterTag {
  id: string
  label: string
  count?: number
}

const props = defineProps<{
  open: boolean
  title: string
  subtitle?: string
  items: T[]
  selectedId: string | null
  filters?: FilterTag[]
  activeFilterId?: string         // 'all' = no filter
  searchQuery?: string
  searchPlaceholder?: string
  confirmLabel?: string           // defaults to "Use this"
  emptyMessage?: string
  /** Opt-in sectioned grid: ordered headers + item→section mapping. Absent ⇒
   *  today's flat grid. Callers should pass `items` ordered section-by-section
   *  so arrow-key nav (flat index based) follows the visual order. */
  sections?: CatalogSection[]
  sectionOf?: (item: T) => string
  /** The section whose grid shows the `#lead` slot first (shown even with no items).
   *  With no sections, the lead is first in the flat grid. Show or hide the lead by setting
   *  or clearing `leadIn` together with the `#lead` slot (as ShaderEffectGallery does): slots
   *  aren't reactive, so a slot that comes or goes while `leadIn` stays the same isn't seen. */
  leadIn?: string
  /** data-testid for the panel. */
  testid?: string
}>()

const emit = defineEmits<{
  close: []
  confirm: [item: T]
  'update:selectedId': [id: string]
  'update:activeFilterId': [id: string]
  'update:searchQuery': [query: string]
}>()

// Initial focus = current selection if any, else first item. `immediate: true`
// so this also runs on mount when the parent renders us with open=true from
// the start (typical when the modal is `v-if`'d on a boolean state ref).
const focusedId = ref<string | null>(null)

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    focusedId.value = props.selectedId ?? props.items[0]?.id ?? null
  }
}, { immediate: true })

// Also follow external selection changes while open (e.g. caller programmatically
// chose a different model).
watch(() => props.selectedId, (next) => {
  if (props.open && next) focusedId.value = next
})

// If the currently-focused item drops out of the visible items list (e.g.
// the user picked a filter that excludes it), jump focus to the first
// still-visible item so the detail pane stays populated and the confirm
// button has a target. Emit through `update:selectedId` so the parent
// (and any derived state like the confirm button label) stays in sync.
watch(() => props.items, (items) => {
  if (!props.open || !items.length) return
  if (!items.some(i => i.id === focusedId.value)) {
    focusItem(items[0]!)
  }
})

const focusedItem = computed<T | null>(() =>
  props.items.find(i => i.id === focusedId.value) ?? null,
)

// Opt-in sectioned grid. Falls back to one anonymous unlabeled group so the
// template only has a single per-group loop to maintain (no duplicated card
// markup between "flat" and "sectioned" rendering paths).
const slots = useSlots()
// Re-read when `leadIn` changes (slots themselves aren't reactive — see the prop's note).
const hasLead = computed(() => !!props.leadIn && !!slots.lead)
const grouped = computed(() => {
  if (props.sections?.length && props.sectionOf) {
    const groups = groupBySections(props.items, props.sections, props.sectionOf)
    const lead = props.leadIn
    if (hasLead.value && lead && !groups.some(g => g.id === lead)) {
      // The lead's section shows even when it has no items, at its declared position.
      const order = (id: string) => { const i = props.sections!.findIndex(s => s.id === id); return i < 0 ? Infinity : i }
      const at = groups.findIndex(g => order(g.id) > order(lead))
      const label = props.sections.find(s => s.id === lead)?.label ?? ''
      groups.splice(at < 0 ? groups.length : at, 0, { id: lead, label, items: [] })
    }
    return groups
  }
  return [{ id: '__all', label: '', items: props.items }]
})
/** The group whose grid starts with the lead card. */
const leadGroupId = computed(() => (!hasLead.value ? null : props.sections?.length && props.sectionOf ? props.leadIn! : '__all'))

function focusItem(item: T) {
  focusedId.value = item.id
  emit('update:selectedId', item.id)
}

function confirmFocused() {
  if (focusedItem.value) emit('confirm', focusedItem.value)
}

// Keyboard nav: arrows move focus across the grid, Enter confirms, Esc closes.
// Hooked at the modal level so the user doesn't have to click a tile first.
function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') { emit('close'); return }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { confirmFocused(); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
  const idx = props.items.findIndex(i => i.id === focusedId.value)
  if (idx < 0) return
  // Grid column count tracked via the CSS var below — we don't know the
  // exact value from JS, so up/down jump by the closest reasonable estimate
  // (3 columns on most viewports). This is "good enough" for keyboard nav.
  const COLS_ESTIMATE = 3
  let next = idx
  if (e.key === 'ArrowRight') next = Math.min(idx + 1, props.items.length - 1)
  else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0)
  else if (e.key === 'ArrowDown') next = Math.min(idx + COLS_ESTIMATE, props.items.length - 1)
  else if (e.key === 'ArrowUp') next = Math.max(idx - COLS_ESTIMATE, 0)
  if (next !== idx) {
    e.preventDefault()
    focusItem(props.items[next]!)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- pointer-events-none on enter-from + leave-active prevents the
         transitioning overlay from intercepting wheel / pinch / click while
         it's animating in or out. Without this, a leaving modal that Vue 3
         occasionally fails to fully unmount (a known Transition-inside-
         Teleport edge case) silently absorbs pinch-zoom on the canvas
         behind it — until a full page reload re-creates the DOM. -->
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      enter-from-class="opacity-0 pointer-events-none"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-100 ease-in pointer-events-none"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0 pointer-events-none"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[100] flex items-center justify-center p-6"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" @click="emit('close')" />

        <!-- Panel -->
        <div
          :data-testid="testid"
          class="relative z-10 w-full max-w-[1280px] h-[85vh] max-h-[860px] flex flex-col bg-[#161616] rounded-xl border border-white/10 shadow-[0_24px_64px_rgba(0,0,0,0.55)] overflow-hidden"
        >
          <!-- Header -->
          <div class="flex items-start gap-4 px-5 pt-4 pb-3">
            <div class="flex-1 min-w-0">
              <h2 class="text-sm font-semibold text-white/95 truncate">{{ title }}</h2>
              <p v-if="subtitle" class="text-[11px] text-white/45 mt-0.5 truncate">{{ subtitle }}</p>
            </div>
            <button
              class="shrink-0 size-7 rounded-md hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white/90 cursor-pointer transition-colors"
              title="Close (Esc)"
              @click="emit('close')"
            >
              <X class="size-4" />
            </button>
          </div>

          <!-- Search row — sits on its own line so the filter row below has
               the whole width to lay chips out without orphans. -->
          <div class="px-5 pt-3 pb-2.5">
            <div class="relative max-w-md">
              <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-white/35 pointer-events-none" />
              <input
                :value="searchQuery ?? ''"
                type="text"
                :placeholder="searchPlaceholder ?? 'Search…'"
                class="w-full bg-white/[0.04] border border-white/10 rounded-md pl-8 pr-3 py-1.5 text-xs text-white/85 placeholder-white/30 outline-none focus:bg-white/[0.06] focus:border-white/20 transition-colors"
                @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>
          <!-- Filter chip strip — horizontally scrollable so a long tag list
               never wraps into orphan rows. The track has no visible
               scrollbar; we scroll it with the wheel/trackpad. -->
          <div v-if="filters?.length" class="px-5 py-2 overflow-x-auto scrollbar-thin">
            <div class="flex items-center gap-1 w-max">
              <button
                v-for="f in filters"
                :key="f.id"
                class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] transition-colors cursor-pointer whitespace-nowrap"
                :class="(activeFilterId ?? 'all') === f.id
                  ? 'bg-white/[0.12] text-white font-medium'
                  : 'text-white/55 hover:text-white/85 hover:bg-white/[0.05]'"
                @click="emit('update:activeFilterId', f.id)"
              >
                <span>{{ f.label }}</span>
                <span v-if="f.count != null" class="text-white/35 tabular-nums">{{ f.count }}</span>
              </button>
            </div>
          </div>

          <!-- Body: grid + detail pane -->
          <div class="flex-1 flex min-h-0">
            <!-- Grid -->
            <div class="flex-1 min-w-0 overflow-y-auto px-5 py-4">
              <div
                v-if="items.length === 0 && !hasLead"
                class="h-full flex items-center justify-center text-xs text-white/40"
              >
                {{ emptyMessage ?? 'Nothing matches your filters.' }}
              </div>
              <div v-else class="flex flex-col gap-5">
                <section v-for="g in grouped" :key="g.id">
                  <div
                    v-if="g.label"
                    class="flex items-center gap-2.5 mb-2.5"
                  >
                    <span class="text-[10px] uppercase tracking-[0.14em] font-semibold text-white/45">{{ g.label }}</span>
                    <span class="text-[10px] text-white/25 tabular-nums">{{ g.items.length }}</span>
                    <div class="flex-1 h-px bg-white/[0.06]" />
                  </div>
                  <div
                    class="grid gap-3"
                    style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));"
                  >
                    <slot v-if="g.id === leadGroupId" name="lead" />
                    <!-- `group` sits on the wrapper so a card-overlay (a sibling of the
                         button) can show on the card's hover. -->
                    <div v-for="item in g.items" :key="item.id" class="group relative flex">
                      <button
                        class="relative flex flex-1 min-w-0 flex-col items-stretch text-left rounded-lg overflow-hidden border transition-all cursor-pointer"
                        :class="focusedId === item.id
                          ? 'border-white/30 ring-1 ring-white/20 bg-white/[0.04]'
                          : 'border-white/[0.06] hover:border-white/15 bg-white/[0.015] hover:bg-white/[0.035]'"
                        @click="focusItem(item)"
                        @dblclick="confirmFocused"
                      >
                        <slot name="card" :item="item" :focused="focusedId === item.id" />
                        <!-- Selected mark when item.id matches the OUT-OF-MODAL selection -->
                        <span
                          v-if="selectedId === item.id"
                          class="absolute top-2 left-2 inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] font-semibold text-white/80 bg-white/15 border border-white/30 rounded px-1.5 py-0.5 backdrop-blur-sm"
                        >
                          <Check class="size-2.5" /> Current
                        </span>
                      </button>
                      <slot name="card-overlay" :item="item" />
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <!-- Detail pane -->
            <aside
              v-if="$slots.detail && focusedItem"
              class="w-[360px] shrink-0 bg-[#1b1b1b]/70 overflow-y-auto"
            >
              <slot name="detail" :item="focusedItem" />
            </aside>
          </div>

          <!-- Footer -->
          <div class="flex items-center justify-between gap-3 px-5 py-3 border-t border-white/[0.06] bg-black/20">
            <div class="text-[10.5px] text-white/35">
              <slot name="footer-hint">
                <kbd class="font-mono px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55">↑↓←→</kbd>
                navigate
                <span class="mx-1.5 text-white/15">·</span>
                <kbd class="font-mono px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55">⌘↵</kbd>
                use
                <span class="mx-1.5 text-white/15">·</span>
                <kbd class="font-mono px-1 py-0.5 rounded bg-white/[0.06] border border-white/10 text-white/55">Esc</kbd>
                close
              </slot>
            </div>
            <div class="flex items-center gap-2">
              <slot name="actions" :focused-item="focusedItem">
                <button
                  class="h-8 px-3 rounded-md text-xs text-white/75 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                  @click="emit('close')"
                >
                  Cancel
                </button>
                <button
                  class="h-8 px-4 rounded-md text-xs font-medium bg-white text-black hover:bg-white/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  :disabled="!focusedItem"
                  @click="confirmFocused"
                >
                  {{ confirmLabel ?? 'Use this' }}
                </button>
              </slot>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
