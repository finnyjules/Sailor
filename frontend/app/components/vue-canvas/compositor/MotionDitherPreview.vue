<script setup lang="ts">
/** The gallery tile's tiny live preview for Dither in / Dither out. Every other tile is a CSS
 *  animation, but a dither pattern isn't something CSS can fake — this runs the REAL reveal
 *  maths (`revealParams` + `cellTest`) on a tiny 48×30 canvas, drawn with smoothing
 *  off and stretched up to the tile with `image-rendering: pixelated` so a maths cell reads as
 *  a screen pixel block. The gallery popover only exists while open, so the loop's lifetime is
 *  the popover's: started in onMounted, cancelled in onBeforeUnmount. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { revealParams, cellTest } from '~/lib/motionx/reveal'

const props = defineProps<{ out: boolean }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const COLS = 48
const ROWS = 30
const CYCLE = 2.4
// The tile's own rounded "card" — dither cells outside it stay transparent, so the pattern
// reads as a shape resolving rather than as noise filling the whole tile.
const INSET_X = 5
const INSET_Y = 4
const RADIUS = 4

let raf = 0
let imageData: ImageData | null = null

/** Is grid cell (x, y) inside the inset rounded card? Cell-granularity rounded-rect test. */
function insideCard(x: number, y: number): boolean {
  const x0 = INSET_X, y0 = INSET_Y, x1 = COLS - INSET_X, y1 = ROWS - INSET_Y
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
  const cx = x < x0 + RADIUS ? x0 + RADIUS : x >= x1 - RADIUS ? x1 - RADIUS : x
  const cy = y < y0 + RADIUS ? y0 + RADIUS : y >= y1 - RADIUS ? y1 - RADIUS : y
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

function paint(amount: number, elapsed: number) {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  if (!imageData) imageData = ctx.createImageData(COLS, ROWS)
  const data = imageData.data
  const test = cellTest({ ...revealParams({ cell: 40 }), out: props.out, amount, elapsed }, { cols: COLS, rows: ROWS })
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = (y * COLS + x) * 4
      const shown = insideCard(x, y) && test(x, y)
      data[i] = 0x7c; data[i + 1] = 0x9c; data[i + 2] = 0xff
      data[i + 3] = shown ? 255 : 0
    }
  }
  ctx.putImageData(imageData, 0, 0)
}

/** Amount ramps 0 → 1 over the first 60% of the cycle, holds to 85%, then snaps back to 0.
 *  Dither out plays the same shape in reverse (the shown side shrinks instead of grows). */
function amountAt(cycle: number): number {
  const a = cycle < 0.6 ? cycle / 0.6 : cycle < 0.85 ? 1 : 0
  return props.out ? 1 - a : a
}

function drawFrame(now: number) {
  const cycle = (now / 1000 % CYCLE) / CYCLE
  paint(amountAt(cycle), cycle * CYCLE)
}

function loop(now: number) {
  drawFrame(now)
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced) paint(0.5, 0)
  else raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); raf = 0 })
</script>

<template>
  <canvas ref="canvasEl" :width="COLS" :height="ROWS" class="dither-preview-canvas" aria-hidden="true" />
</template>

<style scoped>
.dither-preview-canvas {
  display: block;
  image-rendering: pixelated;
}
</style>
