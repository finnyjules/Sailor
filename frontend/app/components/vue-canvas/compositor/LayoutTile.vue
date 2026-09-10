<!-- frontend/app/components/vue-canvas/compositor/LayoutTile.vue -->
<script setup lang="ts">
// One tile of the Layout sheet: a plan (the layers + draw order an apply would
// commit) painted by the Frame's own renderer at thumbnail size — so the tile
// is the preview, byte-for-byte the same painter as the canvas.
import { ref, watch, onMounted } from 'vue'
import { paintLayerStack, ensureLayerFonts } from '~/composables/useCompositorLayers'
import type { LocalLayer, StackItem } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { PatternPlan } from '~/lib/frame/patterns/applyToFrame'
import { tileSize } from '~/lib/frame/patterns/tileSize'
import { localStackKey } from '~/lib/compositor/frameStack'

const props = withDefaults(defineProps<{
  plan: PatternPlan
  frameW: number
  frameH: number
  background?: Paint
  groups?: LayerGroup[]
  label: string
  selected?: boolean
  maxPx?: number
}>(), { selected: false, maxPx: 116 })
const emit = defineEmits<{ (e: 'pick'): void; (e: 'more'): void }>()

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
  await ensureLayerFonts(layers as LocalLayer[], W)
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
    paintLayerStack(ctx, W, H, items, layers as LocalLayer[], undefined, undefined, undefined, undefined, props.background, props.groups)
  } catch (e) { console.warn('[LayoutTile] paint failed', e) }
}

onMounted(paint)
watch(() => [props.plan, props.frameW, props.frameH, props.background], paint)

function onKey(e: KeyboardEvent) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('pick') } }
</script>

<template>
  <div class="flex flex-col items-center gap-1">
    <div
      role="button" tabindex="0" data-testid="layout-tile"
      :data-pattern="plan.posterState.patternId" :data-seed="plan.posterState.seed"
      :aria-label="`${label} — apply`"
      class="group relative rounded-md ring-1 transition-colors cursor-pointer overflow-hidden bg-[#1a1a1c]"
      :class="selected ? 'ring-white' : 'ring-white/10 hover:ring-white/40'"
      :style="{ width: size.w + 'px', height: size.h + 'px' }"
      @click="emit('pick')" @keydown="onKey"
    >
      <canvas ref="canvas" class="block" :style="{ width: size.w + 'px', height: size.h + 'px' }" />
      <button
        type="button" data-testid="layout-tile-more" title="More like this"
        class="absolute right-1 bottom-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-black/80"
        @click.stop="emit('more')"
      >More</button>
    </div>
    <div class="text-[11px] text-white/55 truncate max-w-[116px]" :title="label">{{ label }}</div>
  </div>
</template>
