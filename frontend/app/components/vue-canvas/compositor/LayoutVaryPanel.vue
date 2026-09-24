<!-- frontend/app/components/vue-canvas/compositor/LayoutVaryPanel.vue -->
<script setup lang="ts">
// The Layout tab's Vary panel: the style, its suggested title face, the current layout and its
// variation count, ‹ Vary ›, the choices that actually change something, the best variations,
// and every layout of the style that fits. Every pick is emitted; the host applies it (one undo
// step each, via `useLayoutVary`). Picking a style applies nothing.
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSegmentedRow from '~/components/vue-canvas/studio/StudioSegmentedRow.vue'
import LayoutTile from '~/components/vue-canvas/compositor/LayoutTile.vue'
import type { ChoiceRow, LayoutFormatInfo, LibraryItem, SuggestedFace, VaryCandidate } from '~/composables/useLayoutVary'
import { STYLES } from '~/lib/frame/patterns/kit/styles'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import type { Choice } from '~/lib/frame/patterns/kit/vary'
import type { WiredContentProvider } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LayerGroup } from '~/lib/compositor/layerGroups'

const props = defineProps<{
  /** The current layout's name ('' when none is current yet). */
  name: string
  candidates: VaryCandidate[]
  index: number
  choices: ChoiceRow[]
  library: LibraryItem[]
  layoutId: string
  /** The current layout has been applied (not merely shown first). */
  applied: boolean
  frameW: number
  frameH: number
  background?: Paint
  groups?: LayerGroup[]
  wiredContent?: WiredContentProvider | null
  /** The format the Frame is sized for, its rules and the lines it leaves out (null: none). */
  format?: LayoutFormatInfo | null
  /** The style on show (absent: Swiss). */
  styleId?: StyleId
  /** The style's suggested title face, while the title is in another face (null: none). */
  suggestedFace?: SuggestedFace | null
  /** The style's library is complete: an empty one then means none of its layouts fit. */
  libraryDone?: boolean
}>()
const emit = defineEmits<{
  (e: 'vary', step: 1 | -1): void
  (e: 'jump', i: number): void
  (e: 'select', id: string): void
  (e: 'choice', key: keyof Choice, value: unknown): void
  (e: 'style', style: StyleId): void
  (e: 'use-face'): void
}>()

const STYLE_IDS: StyleId[] = ['swiss', 'performance', 'editorial', 'street']
const STYLE_LABELS = STYLE_IDS.map(id => STYLES[id].label)
const styleNow = computed<StyleId>(() => props.styleId ?? 'swiss')
function pickStyle(v: string) { if (v !== styleNow.value) emit('style', v as StyleId) }

const current = computed(() => props.candidates[props.index])
const count = computed(() => props.candidates.length)
/** Nothing to vary; or already applied with only one variation. Before the first apply, Vary
 *  applies the variation on show, so one is enough. */
const stuck = computed(() => count.value === 0 || (props.applied && count.value < 2))

/** Up to 8 variations, the window following the current one (the prototype's strip). */
const strip = computed(() => {
  const n = Math.min(8, count.value)
  const start = props.index < 8 ? 0 : props.index - 7
  return Array.from({ length: n }, (_, k) => start + k)
})

/** The lines not shown, quoted: the first 24 characters of each, cut with an ellipsis. The
 *  format's hidden levels, then the lines the current layout does not place (a style layout —
 *  Strip places no fine print). Only the format: Stage 2's words ("in this format"). */
const quote = (t: string) => {
  const s = t.length > 24 ? `${t.slice(0, 24).trimEnd()}…` : t
  // A line that opens with its own quotation mark (a review's quote) is not wrapped in a second pair.
  return /^[“"«‘']/.test(t) ? s : `“${s}”`
}
const fold = (t: string) => t.trim().split(/\s+/).join(' ')
const notPlaced = computed(() => (current.value?.plan.notPlaced ?? []).map(n => fold(n.text)).filter(Boolean))
const notShown = computed(() => {
  const lines = [...new Set([...(props.format?.hidden ?? []), ...notPlaced.value])]
  if (!lines.length) return ''
  const label = notPlaced.value.length ? 'Not shown' : 'Not shown in this format'
  return `${label}: ${lines.map(quote).join(', ')}.`
})

const offered = computed(() => props.library.filter(it => it.plan))
const noneFit = computed(() => !!props.libraryDone && offered.value.length === 0)
const dropped = computed(() => props.library.filter(it => !it.plan).map(it => it.name))

// The segmented controls carry strings; map each row's values through their index.
const optionKeys = (row: ChoiceRow) => row.options.map((_, i) => String(i))
const optionLabels = (row: ChoiceRow) => row.options.map(o => o.label)
const onKey = (row: ChoiceRow) => String(Math.max(0, row.options.findIndex(o => o.on)))
function pick(row: ChoiceRow, k: string) {
  const o = row.options[Number(k)]
  if (o && !o.on) emit('choice', row.key, o.value)
}
</script>

<template>
  <div class="flex flex-col gap-3" data-testid="layout-vary">
    <!-- 0. The style: which set of layouts is offered. Picking one applies nothing. -->
    <div class="flex flex-col gap-1" data-testid="layout-style">
      <span class="text-[11px] text-white/55">Style</span>
      <StudioSegmented :model-value="styleNow" :options="STYLE_IDS" :option-labels="STYLE_LABELS"
        class="[&>button]:flex-auto [&>button]:px-1.5" @update:model-value="pickStyle" />
    </div>

    <!-- 0b. The style's suggested title face, until the title uses it. Its own undo step. -->
    <div v-if="suggestedFace" class="flex flex-col gap-1.5" data-testid="layout-suggested-face">
      <p class="text-[11px] leading-snug text-white/55">Suggested: {{ suggestedFace.family }} — {{ suggestedFace.note }}</p>
      <StudioButton variant="secondary" class="w-full" data-testid="layout-use-face" @click="emit('use-face')">
        <span class="block truncate">Use {{ suggestedFace.family }} for “{{ suggestedFace.title }}”</span>
      </StudioButton>
    </div>

    <!-- 1. The current layout, what it did, and where this variation sits. -->
    <div v-if="name" class="flex flex-col gap-1">
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-medium text-white/90 truncate" data-testid="layout-vary-name">{{ name }}</span>
        <span v-if="count" class="ml-auto shrink-0 text-[11px] text-white/45 tabular-nums" data-testid="layout-vary-count">{{ index + 1 }} of {{ count }}</span>
      </div>
      <p v-if="current" class="text-[11px] leading-snug text-white/55" data-testid="layout-vary-did">{{ current.out.did }}</p>
    </div>

    <!-- 1b. The format the Frame is sized for, its rules, and the lines it leaves out. -->
    <div v-if="format" class="flex flex-col gap-1" data-testid="layout-format">
      <span class="text-[11px] text-white/70" data-testid="layout-format-label">Format: {{ format.label }}</span>
      <p v-for="n in format.notes" :key="n" class="text-[11px] leading-snug text-white/45">{{ n }}</p>
      <p v-if="notShown" class="text-[11px] leading-snug text-white/45" data-testid="layout-format-hidden">{{ notShown }}</p>
    </div>
    <p v-else-if="notShown" class="text-[11px] leading-snug text-white/45" data-testid="layout-not-shown">{{ notShown }}</p>

    <!-- 2. ‹ Vary › -->
    <div class="flex items-center gap-2">
      <StudioButton variant="secondary" :disabled="stuck" aria-label="Previous variation" title="Previous variation (←)" data-testid="layout-vary-prev" @click="emit('vary', -1)">
        <ChevronLeft class="size-3.5" />
      </StudioButton>
      <StudioButton variant="primary" class="flex-1" :disabled="stuck" title="Next variation (V)" data-testid="layout-vary-next" @click="emit('vary', 1)">
        <span class="inline-flex items-center justify-center gap-2">
          Vary
          <kbd class="font-mono px-1 py-px rounded bg-white/[0.12] border border-white/20 text-[10px] leading-none text-white/80">V</kbd>
        </span>
      </StudioButton>
      <StudioButton variant="secondary" :disabled="stuck" aria-label="Next variation" title="Next variation (→)" data-testid="layout-vary-fwd" @click="emit('vary', 1)">
        <ChevronRight class="size-3.5" />
      </StudioButton>
    </div>

    <!-- 3. Only the choices that change something on this Frame. -->
    <div v-if="choices.length" class="flex flex-col gap-1.5" data-testid="layout-vary-choices">
      <template v-for="row in choices" :key="row.key">
        <div v-if="row.key === 'lines'" class="flex flex-col gap-1">
          <span class="text-[11px] text-white/55">{{ row.label }}</span>
          <StudioSegmented :model-value="onKey(row)" :options="optionKeys(row)" :option-labels="optionLabels(row)"
            :data-choice="row.key" @update:model-value="pick(row, $event)" />
        </div>
        <StudioSegmentedRow v-else :label="row.label" :model-value="onKey(row)" :options="optionKeys(row)" :option-labels="optionLabels(row)"
          :data-choice="row.key" @update:model-value="pick(row, $event)" />
      </template>
    </div>

    <!-- 4. The best variations of this layout. -->
    <div v-if="count > 1" class="flex flex-col gap-1.5">
      <span class="text-[11px] text-white/55">Best variations</span>
      <div class="grid grid-cols-4 gap-2 justify-items-center" data-testid="layout-variations">
        <LayoutTile
          v-for="k in strip" :key="candidates[k]!.sig"
          :plan="candidates[k]!.plan" :frame-w="frameW" :frame-h="frameH"
          :background="background" :groups="groups" :wired-content="wiredContent"
          :label="`Variation ${k + 1}`" :selected="applied && k === index" selected-label="" :max-px="60"
          @pick="emit('jump', k)"
        />
      </div>
    </div>

    <!-- 5. Every layout that fits, then the ones that fit but have no variation that passes. -->
    <p v-if="noneFit" class="text-[11px] leading-snug text-white/45" data-testid="layout-none-fit">None of the {{ STYLES[styleNow].label }} layouts fit this Frame yet.</p>
    <div v-if="library.length" class="flex flex-col gap-1.5">
      <span v-if="offered.length" class="text-[11px] text-white/55">All layouts</span>
      <div v-if="offered.length" class="grid grid-cols-2 gap-3 justify-items-center">
        <LayoutTile
          v-for="it in offered" :key="it.id"
          :plan="it.plan!" :frame-w="frameW" :frame-h="frameH"
          :background="background" :groups="groups" :wired-content="wiredContent"
          :label="it.name" :selected="applied && it.id === layoutId"
          @pick="emit('select', it.id)"
        />
      </div>
      <p v-if="dropped.length" class="text-[11px] text-white/40" data-testid="layout-not-offered">Not offered for this Frame: {{ dropped.join(', ') }}.</p>
    </div>
  </div>
</template>
