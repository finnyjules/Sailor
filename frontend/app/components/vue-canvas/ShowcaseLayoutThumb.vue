<script setup lang="ts">
// A Showcase layout's thumbnail: a 2D canvas painted from the layout's own placement maths
// (lib/spacetype/layouts/thumbnail.ts) — no WebGL context, never out of step with the layout.
// Still until `playing`, then it runs the loop; one tile plays at a time in the gallery.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ShowcaseLayout } from '~/lib/spacetype/layouts/index'
import { paintLayoutThumb, THUMB_STILL_T } from '~/lib/spacetype/layouts/thumbnail'

const props = defineProps<{ layout: ShowcaseLayout; playing?: boolean }>()

const el = ref<HTMLCanvasElement | null>(null)
const LOOP_MS = 5000
let raf = 0, startedAt = 0, observer: ResizeObserver | null = null

function paint(t01: number) {
  const c = el.value, ctx = c?.getContext('2d')
  if (!c || !ctx) return
  const w = c.clientWidth, h = c.clientHeight
  if (!w || !h) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  paintLayoutThumb(ctx, w, h, props.layout, t01)
}
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0 }
function sync() {
  stop()
  if (!props.playing) { paint(THUMB_STILL_T); return }
  startedAt = performance.now()
  const tick = (now: number) => {
    paint(THUMB_STILL_T + ((now - startedAt) % LOOP_MS) / LOOP_MS)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

onMounted(() => {
  sync()
  // The card's width is fluid (auto-fill grid), so repaint when it settles or changes.
  observer = new ResizeObserver(() => { if (!raf) paint(THUMB_STILL_T) })
  if (el.value) observer.observe(el.value)
})
watch(() => [props.playing, props.layout], sync)
onBeforeUnmount(() => { stop(); observer?.disconnect() })
</script>

<template>
  <canvas ref="el" class="block h-full w-full" aria-hidden="true" />
</template>
