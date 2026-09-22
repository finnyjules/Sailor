<script setup lang="ts">
/** The gallery tile's tiny live preview for the five Copies moves (cloner motion, Task 8) —
 *  Build, Spread/Gather, Ring spins, Fan and Fade along, told apart by the `mode` prop and
 *  played forwards or backwards by `dir` (the tile's own `params.dir`).
 *
 *  Runs on the same tiny 48×30 canvas as `MotionDitherPreview` / `MotionSettlePreview`, but it
 *  does NOT draw `previewCard.ts`: those previews show one layer being revealed, and this one
 *  shows a RING OF COPIES of a layer. The copies are little bars rather than dots so Fan's
 *  per-copy rotation is visible at this size (a rotated circle shows nothing), coloured along
 *  the same `#7c9cff → #ff7ac3` ramp the shared card uses so the tiles still read as one set.
 *
 *  These are PREVIEWS OF THE IDEA — each mode moves exactly the cloner dial its behaviour
 *  compiles to (`copies.build` → count, `copies.spread` → radius, `copies.spin` → startAngle,
 *  `copies.fan` → stepRotation, `copies.fade` → stepOpacity), on a hand-rolled ring rather than
 *  through `expandClones`.
 *
 *  The gallery popover only exists while open, so the loop's lifetime is the popover's: started
 *  in onMounted, cancelled in onBeforeUnmount. */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ mode: string; dir?: string }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const COLS = 48
const ROWS = 30
const CYCLE = 2.4

/** Copies on the ring, and the ring itself. `R` is the resting radius every mode but Spread
 *  sits at; the bars are wide-ish so a rotation reads. */
const COPIES = 8
const CX = COLS / 2
const CY = ROWS / 2
const R = 10.5
const BAR_W = 5
const BAR_H = 3

let raf = 0

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Copy k's colour, along the same ramp as the shared preview card. */
function copyColor(k: number, alpha: number): string {
  const t = COPIES > 1 ? k / (COPIES - 1) : 0
  const r = Math.round(0x7c + (0xff - 0x7c) * t)
  const g = Math.round(0x9c + (0x7a - 0x9c) * t)
  const b = Math.round(0xff + (0xc3 - 0xff) * t)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

/** One copy: a small bar centred on the ring, spun about its OWN centre by `tilt` degrees. */
function drawCopy(ctx: CanvasRenderingContext2D, x: number, y: number, tilt: number, color: string) {
  ctx.save()
  ctx.translate(x, y)
  if (tilt) ctx.rotate((tilt * Math.PI) / 180)
  ctx.fillStyle = color
  ctx.fillRect(-BAR_W / 2, -BAR_H / 2, BAR_W, BAR_H)
  ctx.restore()
}

/**
 * `amount` is the bar's own progress (0 → 1), `elapsed` the wall clock the loop rides.
 * Each mode reads the dial its behaviour animates and leaves every other dial at rest, so a
 * tile shows one dial moving — the same "one behaviour, one property" rule the compilers keep.
 */
function draw(amount: number, elapsed: number) {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  ctx.clearRect(0, 0, COLS, ROWS)

  const mode = props.mode
  const backwards = props.dir === 'out'
  // Spread is the one mode whose 'out' is the GROWING direction (Spread out vs Gather in),
  // matching `copies.spread`: dir 'out' drives radius 0 → r, dir 'in' drives r → 0.
  const a = clamp01(mode === 'spread' ? (props.dir === 'in' ? 1 - amount : amount)
    : backwards ? 1 - amount : amount)

  const spin = mode === 'spin' ? (elapsed / CYCLE) * 360 : 0
  const radius = mode === 'spread' ? a * R : R
  const shown = mode === 'build' ? Math.max(1, Math.floor(1 + a * (COPIES - 1))) : COPIES
  // A radial cloner's even fan is one full turn shared out between the copies; the preview
  // shows a gentler slice of that so the bars stay legible side by side.
  const fanStep = mode === 'fan' ? a * 40 : 0
  const stepOpacity = mode === 'fade' ? a : 1

  for (let k = 0; k < shown; k++) {
    const angle = ((spin + (k * 360) / COPIES) * Math.PI) / 180
    const x = CX + Math.cos(angle) * radius
    const y = CY + Math.sin(angle) * radius
    const alpha = clamp01(Math.pow(stepOpacity, k))
    if (alpha <= 0.004) continue
    drawCopy(ctx, x, y, k * fanStep, copyColor(k, alpha))
  }
}

/** Amount ramps 0 → 1 over the first 60% of the cycle, holds to 85%, then snaps back to 0 —
 *  the same shape `MotionDitherPreview` and `MotionSettlePreview` play. Spin ignores it: a
 *  spin is a LOOP bar, so it turns continuously off `elapsed` instead. */
function amountAt(cycle: number): number {
  return cycle < 0.6 ? cycle / 0.6 : cycle < 0.85 ? 1 : 0
}

function drawFrame(now: number) {
  const cycle = ((now / 1000) % CYCLE) / CYCLE
  draw(amountAt(cycle), cycle * CYCLE)
}

function loop(now: number) {
  drawFrame(now)
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced) draw(0.65, 0)
  else raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); raf = 0 })
</script>

<template>
  <canvas ref="canvasEl" :width="COLS" :height="ROWS" class="copies-preview-canvas" aria-hidden="true" />
</template>

<style scoped>
.copies-preview-canvas {
  display: block;
}
</style>
