<!-- frontend/app/components/vue-canvas/compositor/LayoutSetSheet.vue -->
<script setup lang="ts">
// The set sheet (Stage 5 — Make a set): the Frame's layout recomposed at each ticked format, side
// by side at true proportions. Each tile is painted by the Frame's own renderer (`LayoutTile`), so
// it is the real picture; its chip says which layout it got. Pure view: the host plans the set
// (`useLayoutSet`), and answers `send` (one format to the canvas), `download`, `cancel` (the
// download) and `close`. Nothing here writes the Frame. While a download runs the footer shows its
// progress (`Rendering 3 of 7…`) and a Cancel; afterwards each format that failed is named.
// A format not planned yet (`pending`) shows a placeholder until its plan lands. A tile leaves out
// the Frame's post effects and paints shader fills at preview quality; the footer says the download
// adds them (`effectsInDownload`) when the Frame has any.
import { computed, ref } from 'vue'
import { X } from 'lucide-vue-next'
import LayoutTile from '~/components/vue-canvas/compositor/LayoutTile.vue'
import KeepClearOverlay from '~/components/vue-canvas/compositor/KeepClearOverlay.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import { FRAME_FORMATS, keepKind } from '~/lib/frame/formats'
import type { FrameFormat } from '~/lib/frame/formats'
import { tileSize } from '~/lib/frame/patterns/tileSize'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { LayoutPlan } from '~/lib/frame/patterns/kit/plan'
import type { SheetEntry } from '~/composables/useLayoutSet'
import type { WiredContentProvider } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { SetExportFailure } from '~/lib/frame/layoutSetExport'

const props = defineProps<{
  entries: SheetEntry[]
  /** The Frame's own layout's name. */
  layoutName: string
  /** The Frame moves: the set is its stills ("Stills only for now."). */
  hasMotion?: boolean
  background?: Paint
  wiredContent?: WiredContentProvider | null
  /** A download is running: its progress line (`Rendering 3 of 7…`); null/absent otherwise. */
  progress?: string | null
  /** The formats the last download could not render. */
  failures?: SetExportFailure[]
  /** The last download's outcome when nothing was saved (`Download cancelled.`). */
  notice?: string
  /** The Frame has post effects or shader fills, which the tiles leave out and the download adds. */
  effectsInDownload?: boolean
}>()
const emit = defineEmits<{
  (e: 'send', formatId: string): void
  (e: 'download'): void
  (e: 'cancel'): void
  (e: 'close'): void
}>()

/** The longest side of a tile (px): four of them fit a row. A wide banner (3:1 or wider) gets
 *  twice that, so it stays readable; it wraps onto a row of its own. */
const TILE_MAX = 180
const WIDE = 3
const tileMax = (e: SetEntry) => (e.w / e.h >= WIDE ? TILE_MAX * 2 : TILE_MAX)

type Kind = 'kept' | 'swapped' | 'none' | 'pending'
const kindOf = (e: SheetEntry): Kind => (e.pending ? 'pending' : !e.plan || !e.layers ? 'none' : e.swapped ? 'swapped' : 'kept')
function chip(e: SetEntry): string {
  const k = kindOf(e)
  if (k === 'none') return 'Nothing fits this format'
  if (k === 'swapped') return `${e.layoutName ?? ''} — ${props.layoutName} doesn't fit`
  return e.layoutName ?? props.layoutName
}

const counts = computed(() => {
  const c = { kept: 0, swapped: 0, none: 0, pending: 0 }
  for (const e of props.entries) c[kindOf(e)]++
  return c
})
const title = computed(() => {
  const n = props.entries.length
  return `${props.layoutName}, in ${n} ${n === 1 ? 'format' : 'formats'}`
})
/** "N as <layout> · M with another layout · K where nothing fits" — a part with none is left out. */
const summary = computed(() => {
  const c = counts.value
  const parts: string[] = []
  if (c.kept) parts.push(`${c.kept} as ${props.layoutName}`)
  if (c.swapped) parts.push(`${c.swapped} with another layout`)
  if (c.none) parts.push(`${c.none} where nothing fits`)
  return parts.join(' · ')
})
/** Only the formats something fits are exported. */
const exportable = computed(() => counts.value.kept + counts.value.swapped)
/** While formats are still being planned the count is not known yet (the download plans them first). */
const downloadLabel = computed(() => counts.value.pending ? 'Download images'
  : `Download ${exportable.value} ${exportable.value === 1 ? 'image' : 'images'}`)
const downloading = computed(() => props.progress != null)

// ── the covered areas: each format's keep-clear bands, over its tile ──
const showCovered = ref(false)
const formatOf = (id: string): FrameFormat | undefined => FRAME_FORMATS.find(f => f.id === id)
const anyCovered = computed(() => props.entries.some(e => !!formatOf(e.formatId)?.keep))

interface Tile { e: SheetEntry; kind: Kind; size: { w: number; h: number }; max: number; fmt?: FrameFormat }
const tiles = computed<Tile[]>(() => props.entries.map((e) => {
  const max = tileMax(e)
  return { e, kind: kindOf(e), size: tileSize(e.w, e.h, max, max), max, fmt: formatOf(e.formatId) }
}))
/** What `LayoutTile` paints: the plan's draw order over the layers the apply would commit. One
 *  object per entry, kept while the entry is (a tile repaints when its `plan` changes identity —
 *  never on a re-render of the sheet, such as each download progress step). */
const tilePlans = new WeakMap<SetEntry, LayoutPlan>()
function tilePlan(e: SetEntry): LayoutPlan {
  let p = tilePlans.get(e)
  if (!p) { p = { ...e.plan!, layers: e.layers! }; tilePlans.set(e, p) }
  return p
}
</script>

<template>
  <div
    data-testid="layout-set-sheet"
    role="dialog" :aria-label="title"
    class="absolute top-16 left-4 bottom-4 right-[19.5rem] z-[60] flex flex-col bg-[#161616] border border-white/10 rounded-lg shadow-2xl text-white/85"
    @pointerdown.stop>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2 border-b border-white/10">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-[13px] font-medium text-white truncate" data-testid="layout-set-title">{{ title }}</span>
        <span class="text-[11px] text-white/55" data-testid="layout-set-summary">{{ summary }}</span>
      </div>
      <span class="flex-1" />
      <label v-if="anyCovered" class="flex items-center gap-2 text-[12px] text-white/70" data-testid="layout-set-covered">
        <StudioSwitch v-model="showCovered" />
        Show covered areas
      </label>
      <button type="button" class="p-1 rounded text-white/55 hover:text-white/85 cursor-pointer" aria-label="Close" data-testid="layout-set-close" @click="emit('close')">
        <X class="size-4" />
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-4">
      <div class="flex flex-wrap items-end gap-5">
        <div
          v-for="t in tiles" :key="t.e.formatId"
          class="flex flex-col items-center gap-1.5" data-testid="layout-set-tile" :data-format="t.e.formatId" :data-kind="t.kind">
          <div class="relative" :style="{ width: `${t.size.w}px` }">
            <template v-if="t.kind === 'pending'">
              <div
                class="flex items-center justify-center rounded-md ring-1 ring-white/10 bg-white/[0.03] text-[11px] text-white/45"
                :style="{ width: `${t.size.w}px`, height: `${t.size.h}px` }" data-testid="layout-set-pending">Planning…</div>
              <div class="mt-1 text-center text-[11px] text-white/55 truncate" :title="t.e.label">{{ t.e.label }}</div>
            </template>
            <LayoutTile
              v-else-if="t.kind !== 'none'"
              :plan="tilePlan(t.e)" :frame-w="t.e.w" :frame-h="t.e.h" :max-px="t.max"
              :background="background" :groups="t.e.groups ?? undefined" :wired-content="wiredContent"
              :label="t.e.label" :pickable="false"
            />
            <template v-else>
              <div class="rounded-md ring-1 ring-white/10 bg-white/[0.03]" :style="{ width: `${t.size.w}px`, height: `${t.size.h}px` }" />
              <div class="mt-1 text-center text-[11px] text-white/55 truncate" :title="t.e.label">{{ t.e.label }}</div>
            </template>
            <div
              v-if="showCovered && t.fmt?.keep"
              class="absolute left-0 top-0 pointer-events-none" data-testid="layout-set-covered-area"
              :style="{ width: `${t.size.w}px`, height: `${t.size.h}px` }">
              <KeepClearOverlay :keep="t.fmt.keep" :w="t.size.w" :h="t.size.h" :kind="keepKind(t.fmt) ?? 'app'" />
            </div>
          </div>
          <span
            v-if="t.kind !== 'pending'"
            class="max-w-[220px] truncate rounded px-1.5 py-0.5 text-[11px]"
            :class="t.kind === 'swapped' ? 'bg-amber-400/15 text-amber-300' : t.kind === 'none' ? 'bg-white/[0.04] text-white/45' : 'bg-white/[0.06] text-white/70'"
            :title="chip(t.e)" data-testid="layout-set-chip">{{ chip(t.e) }}</span>
          <button
            v-if="t.kind === 'kept' || t.kind === 'swapped'" type="button"
            class="h-7 px-2.5 rounded text-[11px] font-medium cursor-pointer bg-white/[0.06] hover:bg-white/12 text-white/80"
            data-testid="layout-set-send" @click="emit('send', t.e.formatId)">Send to canvas</button>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-white/10">
      <span v-if="hasMotion" class="text-[11px] text-white/45" data-testid="layout-set-stills">Stills only for now.</span>
      <span v-if="effectsInDownload" class="text-[11px] text-white/45" data-testid="layout-set-effects">Effects and shader fills are added in the download.</span>
      <span v-if="notice && !downloading" class="text-[11px] text-white/55" data-testid="layout-set-notice">{{ notice }}</span>
      <span
        v-for="f in (downloading ? [] : failures ?? [])" :key="f.formatId"
        class="text-[11px] text-red-300/90" :title="f.message" data-testid="layout-set-failure">Couldn't render {{ f.label }}.</span>
      <span class="flex-1" />
      <template v-if="downloading">
        <span class="text-[12px] text-white/70 tabular-nums" aria-live="polite" data-testid="layout-set-progress">{{ progress }}</span>
        <button
          type="button"
          class="h-8 px-3 rounded text-[12px] font-medium cursor-pointer bg-white/[0.06] hover:bg-white/12 text-white/85"
          data-testid="layout-set-cancel" @click="emit('cancel')">Cancel</button>
      </template>
      <button
        type="button"
        class="h-8 px-3 rounded text-[12px] font-medium cursor-pointer bg-white/[0.06] hover:bg-white/12 text-white/85"
        @click="emit('close')">Close</button>
      <button
        v-if="!downloading"
        type="button"
        class="h-8 px-3 rounded text-[12px] font-medium cursor-pointer disabled:opacity-50 bg-white hover:bg-white/90 text-neutral-900"
        data-testid="layout-set-download" :disabled="!exportable && !counts.pending"
        @click="emit('download')">{{ downloadLabel }}</button>
    </div>
  </div>
</template>
