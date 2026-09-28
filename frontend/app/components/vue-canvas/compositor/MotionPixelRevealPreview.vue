<script setup lang="ts">
/** The gallery tile's tiny live preview for the nine Pixel reveal looks (task 4 of the 2026-09-28
 *  addendum) — each its own pair of tiles (In / Out), told apart by the `out` prop, same as
 *  `MotionSettlePreview`. Runs on the same 48×30 canvas as `MotionDitherPreview`/
 *  `MotionSettlePreview`, drawing the SAME synthetic card (`previewCard.ts`) so every tile
 *  agrees on what "the layer" looks like.
 *
 *  This is a PREVIEW OF THE IDEA — `pixelRevealPreviewBlocks.ts`'s cheap CPU box-average stands
 *  in for the real painter's WebGL2 mipmapped atlas (`paintPixelReveal.ts`) — not the shader
 *  itself. What IS shared with the real thing is the maths: `pickGrid`, `revealWhen`,
 *  `levelAt` and `pieceStates`, the CPU mirrors `pixelReveal.ts` keeps for exactly this.
 *
 *  The gallery popover only exists while open, so the loop's lifetime is the popover's: started
 *  in onMounted, cancelled in onBeforeUnmount. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { pixelRevealLookOf } from '~/lib/motionx/reveal'
import { buildPreviewCard } from './previewCard'
import { paintPixelRevealFrame } from './pixelRevealPreviewBlocks'

const props = defineProps<{ look: string; out: boolean }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const COLS = 48
const ROWS = 30
const CYCLE = 2.4
// `pickGrid`'s block ladder is chosen against this reference width, NOT the real painter's
// 1080px-wide frame basis: a look's `pixel` (4–64) scaled by 48/1080 would be sub-pixel on a
// tile this small and every look would read as instantly sharp. 240 keeps the whole 4–64 range
// landing on visibly coarse-to-sharp rungs for a 48-wide canvas.
const BLOCK_REF_PX = 240

let raf = 0
let source: Uint8ClampedArray | null = null
let imageData: ImageData | null = null

function draw(amount: number) {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  if (!source) source = buildPreviewCard(COLS, ROWS)
  if (!imageData) imageData = ctx.createImageData(COLS, ROWS)
  const look = pixelRevealLookOf(props.look)
  const targetBlockPx = look.settings.pixel * (COLS / BLOCK_REF_PX)
  paintPixelRevealFrame(imageData.data, source, COLS, ROWS, look.settings, amount, targetBlockPx)
  ctx.putImageData(imageData, 0, 0)
}

/** Amount ramps 0 → 1 over the first 60% of the cycle, holds to 85%, then snaps back to 0 —
 *  same shape as `MotionSettlePreview`'s. Out plays the mirror: revealed, then unrevealed. */
function amountAt(cycle: number): number {
  const a = cycle < 0.6 ? cycle / 0.6 : cycle < 0.85 ? 1 : 0
  return props.out ? 1 - a : a
}

function drawFrame(now: number) {
  const cycle = (now / 1000 % CYCLE) / CYCLE
  draw(amountAt(cycle))
}

function loop(now: number) {
  drawFrame(now)
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced) draw(0.4)
  else raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); raf = 0 })
</script>

<template>
  <canvas ref="canvasEl" :width="COLS" :height="ROWS" class="pixelreveal-preview-canvas" aria-hidden="true" />
</template>

<style scoped>
.pixelreveal-preview-canvas {
  display: block;
  image-rendering: pixelated;
}
</style>
