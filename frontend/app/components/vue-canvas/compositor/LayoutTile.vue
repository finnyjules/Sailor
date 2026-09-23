<!-- frontend/app/components/vue-canvas/compositor/LayoutTile.vue -->
<script setup lang="ts">
// One tile of the Layout sheet: a plan (the layers + draw order an apply would
// commit) painted by the Frame's own renderer at thumbnail size — so the tile
// is the preview, byte-for-byte the same painter as the canvas.
import { ref, watch, onMounted } from 'vue'
import { paintLayerStack, ensureLayerFonts, ensureLayerImages, withWiredContent } from '~/composables/useCompositorLayers'
import type { LocalLayer, StackItem, WiredContentProvider } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import { tileSize } from '~/lib/frame/patterns/tileSize'
import { localStackKey } from '~/lib/compositor/frameStack'

/** What a tile paints: the layers + draw order an apply would commit (a kit `LayoutPlan`, or
 *  anything of that shape). */
interface TilePlan { layers: LocalLayer[]; order: string[]; posterState: { patternId: string; seed: number } }

const props = withDefaults(defineProps<{
  plan: TilePlan
  frameW: number
  frameH: number
  background?: Paint
  groups?: LayerGroup[]
  label: string
  selected?: boolean
  maxPx?: number
  /** The host's slot → live content resolver, so wired layers paint their real
   *  pixels instead of a bare background — see `withWiredContent` below. */
  wiredContent?: WiredContentProvider | null
  /** The word shown before the label when `selected` ("Last applied" by default). Empty: the
   *  ring alone marks it (small tiles), and the tooltip says "Current". */
  selectedLabel?: string
}>(), { selected: false, maxPx: 116, selectedLabel: 'Last applied' })
const emit = defineEmits<{ (e: 'pick'): void }>()

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref(tileSize(props.frameW, props.frameH, props.maxPx, props.maxPx))
let paintSeq = 0

async function paint() {
  const cv = canvas.value
  if (!cv) return
  const my = ++paintSeq
  size.value = tileSize(props.frameW, props.frameH, props.maxPx, props.maxPx)
  const { w, h } = size.value
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  // Paint at the FRAME's size and scale down: every layer is normalised to the
  // frame, so the renderer must see the real W×H or text and strokes would be
  // measured against the thumbnail.
  const W = props.frameW, H = props.frameH
  const layers = props.plan.layers
  // Both waits happen BEFORE the wired-content span: the span must stay
  // synchronous (see withWiredContent's doc) or another host's span could
  // interleave while this one's provider is still installed.
  await Promise.all([ensureLayerFonts(layers as LocalLayer[], W), ensureLayerImages(layers as LocalLayer[])])
  if (my !== paintSeq || !canvas.value) return
  const byId = new Map(layers.map(l => [localStackKey(l.id), l]))
  const items: StackItem[] = []
  for (const key of props.plan.order) { const l = byId.get(key); if (l) items.push({ type: 'local', key, layer: l }) }
  for (const l of layers) { const key = localStackKey(l.id); if (!props.plan.order.includes(key)) items.push({ type: 'local', key, layer: l }) }
  cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr))
  const ctx = cv.getContext('2d')!
  const s = (w * dpr) / Math.max(1, W)
  ctx.setTransform(s, 0, 0, s, 0, 0)
  ctx.clearRect(0, 0, W, H)
  try {
    withWiredContent(props.wiredContent ?? null, () => {
      paintLayerStack(ctx, W, H, items, layers as LocalLayer[], undefined, undefined, undefined, undefined, props.background, props.groups)
    })
  } catch (e) { console.warn('[LayoutTile] paint failed', e) }
}

onMounted(paint)
watch(() => [props.plan, props.frameW, props.frameH, props.background], paint)

// The ring only means "the tile last applied" — it stays lit after an undo of
// that apply (`remember()` is UI memory outside the undo step, on purpose), so
// the label says exactly that instead of implying "currently applied".
const tileTitle = () => (props.selected ? `${props.selectedLabel || 'Current'} — ${props.label}` : `${props.label} — apply`)
</script>

<template>
  <div class="group flex flex-col items-center gap-1">
    <button
      type="button" data-testid="layout-tile"
      :data-pattern="plan.posterState.patternId" :data-seed="plan.posterState.seed"
      :aria-label="tileTitle()" :title="tileTitle()"
      class="relative rounded-md ring-1 transition-colors cursor-pointer overflow-hidden bg-[#1a1a1c]"
      :class="selected ? 'ring-white' : 'ring-white/10 hover:ring-white/40'"
      :style="{ width: size.w + 'px', height: size.h + 'px' }"
      @click="emit('pick')"
    >
      <canvas ref="canvas" class="block" :style="{ width: size.w + 'px', height: size.h + 'px' }" />
    </button>
    <div class="text-[11px] text-white/55 truncate" :style="{ maxWidth: maxPx + 'px' }" :title="label">
      <span v-if="selected && selectedLabel" class="text-white/40">{{ selectedLabel }} </span>{{ label }}
    </div>
  </div>
</template>
