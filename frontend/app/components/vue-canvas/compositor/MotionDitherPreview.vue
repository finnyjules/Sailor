<script setup lang="ts">
/** The gallery tile's tiny live preview for Dither in / Dither out. Every other tile is a CSS
 *  animation, but a dither pattern isn't something CSS can fake — this runs on a tiny 48×30
 *  canvas, drawn with smoothing off and stretched up to the tile with `image-rendering:
 *  pixelated` so a block reads as a screen pixel block.
 *
 *  It shows the DEFAULT look — Pixels, the style a freshly-added bar gets — approximated with
 *  the same shape as the real maths (`bayer8` ordered-dither threshold, `pixelSharp` cross-fade)
 *  but hand-rolled rather than calling the shader: this is a PREVIEW of the idea, coloured
 *  blocks standing in for characters, not the ASCII effect itself.
 *
 *  The gallery popover only exists while open, so the loop's lifetime is the popover's:
 *  started in onMounted, cancelled in onBeforeUnmount. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { bayer8, pixelBrightness, pixelSharp } from '~/lib/motionx/reveal'

const props = defineProps<{ out: boolean }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const COLS = 48
const ROWS = 30
const CYCLE = 2.4
// The tile's own rounded "card" — the source image is transparent outside it, so the pattern
// reads as a shape resolving rather than as noise filling the whole tile.
const INSET_X = 5
const INSET_Y = 4
const RADIUS = 4
// Block sizes the transition steps through as `amount` climbs — coarse to sharp, one halving
// per quarter of the bar (the real maths halves every stage instead; four fixed steps is
// plenty for a tile this small).
const BLOCK_SIZES = [8, 4, 2, 1]

let raf = 0
let imageData: ImageData | null = null
let source: Uint8ClampedArray | null = null

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Is grid cell (x, y) inside the inset rounded card? Cell-granularity rounded-rect test. */
function insideCard(x: number, y: number): boolean {
  const x0 = INSET_X, y0 = INSET_Y, x1 = COLS - INSET_X, y1 = ROWS - INSET_Y
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false
  const cx = x < x0 + RADIUS ? x0 + RADIUS : x >= x1 - RADIUS ? x1 - RADIUS : x
  const cy = y < y0 + RADIUS ? y0 + RADIUS : y >= y1 - RADIUS ? y1 - RADIUS : y
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

/** Built once: a rounded card, a diagonal gradient `#7c9cff → #ff7ac3`, and a white bar
 *  standing in for a caption — transparent everywhere outside the card. The Pixels loop
 *  samples and re-samples this same buffer every frame; it never changes. */
function buildSource(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(COLS * ROWS * 4)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!insideCard(x, y)) continue
      const i = (y * COLS + x) * 4
      const t = (x / (COLS - 1) + y / (ROWS - 1)) / 2
      px[i] = 0x7c + (0xff - 0x7c) * t
      px[i + 1] = 0x9c + (0x7a - 0x9c) * t
      px[i + 2] = 0xff + (0xc3 - 0xff) * t
      px[i + 3] = 255
    }
  }
  const barY0 = Math.round(ROWS * 0.6), barY1 = Math.round(ROWS * 0.72)
  const barX0 = INSET_X + 3, barX1 = COLS - INSET_X - 3
  for (let y = barY0; y < barY1; y++) {
    for (let x = barX0; x < barX1; x++) {
      if (!insideCard(x, y)) continue
      const i = (y * COLS + x) * 4
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255
    }
  }
  return px
}

function paint(amount: number, elapsed: number) {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  if (!imageData) imageData = ctx.createImageData(COLS, ROWS)
  if (!source) source = buildSource()
  const data = imageData.data
  const src = source
  const n = BLOCK_SIZES[Math.min(3, Math.floor(clamp01(amount) * 4))]!
  const drift = Math.floor(elapsed * 5)
  const sharp = pixelSharp(amount)
  const brightness = pixelBrightness(amount)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const bx = Math.floor(x / n), by = Math.floor(y / n)
      // The block's colour: the source sampled at the block's own centre, not this pixel's.
      const sx = Math.min(COLS - 1, bx * n + Math.floor(n / 2))
      const sy = Math.min(ROWS - 1, by * n + Math.floor(n / 2))
      const si = (sy * COLS + sx) * 4
      const r = src[si]!, g = src[si + 1]!, b = src[si + 2]!, a = src[si + 3]!
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      // The shader's matte mode compresses tone to 0.25–0.75 before the Brightness ramp
      // (see `ascii_dither.frag`), so the tile has to as well: on raw luma the white caption
      // bar still lit about a tenth of its cells at amount 0, where the real transition
      // draws nothing at all — the tile started every cycle with a speckle it never shows.
      const on = (a / 255) * clamp01(0.25 + 0.5 * luma + brightness) > bayer8(bx - drift, by)
      const i = (y * COLS + x) * 4
      let pr = on ? r : 0, pg = on ? g : 0, pb = on ? b : 0, pa = on ? 255 : 0
      if (sharp > 0) {
        // The last fifth of the bar cross-fades to the REAL pixel at this exact spot —
        // full resolution, not the block's centre — so the picture resolves into focus.
        pr += (src[i]! - pr) * sharp
        pg += (src[i + 1]! - pg) * sharp
        pb += (src[i + 2]! - pb) * sharp
        pa += (src[i + 3]! - pa) * sharp
      }
      data[i] = pr; data[i + 1] = pg; data[i + 2] = pb; data[i + 3] = pa
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
  if (reduced) paint(0.45, 0)
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
