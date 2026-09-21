<script setup lang="ts">
/** The gallery tile's tiny live preview for the ten Settle effects (Addendum 3, Part 4) — each
 *  its own pair of tiles (In / Out), told apart by the `effect` prop. Runs on the same tiny
 *  48×30 canvas as `MotionDitherPreview`, drawing the SAME synthetic card (`previewCard.ts`) so
 *  every tile agrees on what "the layer" looks like.
 *
 *  These are PREVIEWS OF THE IDEA — cheap 2D approximations hand-rolled for a tile this small —
 *  not the Shader Studio effects themselves. What IS shared with the real thing is the shape of
 *  the curve: strength follows the library's `settleStrength(amount, 1)` (full strength at the
 *  bar's start, easing to nothing by its end) and the fade follows `settleFade`.
 *
 *  The gallery popover only exists while open, so the loop's lifetime is the popover's: started
 *  in onMounted, cancelled in onBeforeUnmount. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { settleEffectOf, settleStrength, settleFade } from '~/lib/motionx/reveal'
import { buildPreviewCard } from './previewCard'

const props = defineProps<{ effect: string; out: boolean }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const COLS = 48
const ROWS = 30
const CYCLE = 2.4

let raf = 0
let source: Uint8ClampedArray | null = null
let imageData: ImageData | null = null
let sourceCanvas: HTMLCanvasElement | null = null
let tintCanvases: { r: HTMLCanvasElement; g: HTMLCanvasElement; b: HTMLCanvasElement } | null = null
let tinyCanvas: HTMLCanvasElement | null = null

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
/** A cheap deterministic hash, NOT `Math.random` — the same input always looks the same, so a
 *  "shifted block" sits still between frames instead of flickering to a new spot every paint. */
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s)
}
/** Nearest-neighbour sample of the source card; outside its bounds reads as transparent. */
function sampleSrc(src: Uint8ClampedArray, x: number, y: number): readonly [number, number, number, number] {
  const xi = Math.round(x), yi = Math.round(y)
  if (xi < 0 || xi >= COLS || yi < 0 || yi >= ROWS) return [0, 0, 0, 0]
  const i = (yi * COLS + xi) * 4
  return [src[i]!, src[i + 1]!, src[i + 2]!, src[i + 3]!]
}
function writePixel(data: Uint8ClampedArray, x: number, y: number, px: readonly [number, number, number, number]) {
  const i = (y * COLS + x) * 4
  data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3]
}
function applyFade(data: Uint8ClampedArray, fade: number) {
  if (fade >= 1) return
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i]! * fade)
}

// ── Pixel-array effects (sample the source buffer into a fresh ImageData) ───────────────────
function paintSlice(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  const MAX = 11
  const band = 3
  const drift = Math.floor(elapsed * 3)
  for (let y = 0; y < ROWS; y++) {
    const off = Math.round((hash01(Math.floor(y / band) + drift) - 0.5) * 2 * MAX * k)
    for (let x = 0; x < COLS; x++) writePixel(data, x, y, sampleSrc(src, x - off, y))
  }
}
function paintGlitch(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  data.set(src)
  const tick = Math.floor(elapsed * 6)
  const chroma = Math.round(3 * k)
  for (let b = 0; b < 3; b++) {
    const seed = tick * 5 + b * 13
    const y0 = Math.floor(hash01(seed) * ROWS)
    const h = 2 + Math.floor(hash01(seed + 1) * 4)
    const shift = Math.round((hash01(seed + 2) - 0.5) * 2 * 14 * k)
    for (let y = y0; y < Math.min(ROWS, y0 + h); y++) {
      for (let x = 0; x < COLS; x++) {
        const [r] = sampleSrc(src, x - shift - chroma, y)
        const [, g] = sampleSrc(src, x - shift, y)
        const [, , bch, a] = sampleSrc(src, x - shift + chroma, y)
        writePixel(data, x, y, [r, g, bch, a])
      }
    }
  }
}
function paintWave(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  const AMP = 6
  for (let y = 0; y < ROWS; y++) {
    const off = Math.round(Math.sin((y / ROWS) * Math.PI * 2 * 1.5 + elapsed * 2) * AMP * k)
    for (let x = 0; x < COLS; x++) writePixel(data, x, y, sampleSrc(src, x - off, y))
  }
}
function paintLiquify(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  const AMP = 4
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const dx = Math.sin((y / ROWS) * Math.PI * 2 + elapsed * 1.3) * AMP * k
      const dy = Math.sin((x / COLS) * Math.PI * 2 + elapsed * 1.7) * AMP * k
      writePixel(data, x, y, sampleSrc(src, x - dx, y - dy))
    }
  }
}
function paintSwirl(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  const cx = COLS / 2, cy = ROWS / 2
  const maxR = Math.hypot(cx, cy)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const dx = x - cx, dy = y - cy
      const r = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx) + (1 - r / maxR) * 2.6 * k + elapsed * 0.4
      writePixel(data, x, y, sampleSrc(src, cx + Math.cos(angle) * r, cy + Math.sin(angle) * r))
    }
  }
}
function paintRipple(data: Uint8ClampedArray, src: Uint8ClampedArray, k: number, elapsed: number) {
  const cx = COLS / 2, cy = ROWS / 2
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const dx = x - cx, dy = y - cy
      const r = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)
      const nr = r + Math.sin(r * 0.9 - elapsed * 4) * 3 * k
      writePixel(data, x, y, sampleSrc(src, cx + Math.cos(angle) * nr, cy + Math.sin(angle) * nr))
    }
  }
}

// ── Canvas-draw effects (composite the offscreen source canvas with 2D ops) ─────────────────
function ensureSourceCanvas(src: Uint8ClampedArray): HTMLCanvasElement {
  if (sourceCanvas) return sourceCanvas
  const c = document.createElement('canvas')
  c.width = COLS; c.height = ROWS
  const cctx = c.getContext('2d')!
  const id = cctx.createImageData(COLS, ROWS)
  id.data.set(src)
  cctx.putImageData(id, 0, 0)
  sourceCanvas = c
  return c
}
function ensureTints(): { r: HTMLCanvasElement; g: HTMLCanvasElement; b: HTMLCanvasElement } {
  if (tintCanvases) return tintCanvases
  const base = sourceCanvas!
  const make = (tint: string) => {
    const c = document.createElement('canvas')
    c.width = COLS; c.height = ROWS
    const tctx = c.getContext('2d')!
    tctx.drawImage(base, 0, 0)
    tctx.globalCompositeOperation = 'multiply'
    tctx.fillStyle = tint
    tctx.fillRect(0, 0, COLS, ROWS)
    tctx.globalCompositeOperation = 'destination-in'
    tctx.drawImage(base, 0, 0)
    return c
  }
  tintCanvases = { r: make('#ff5a5a'), g: make('#5aff8c'), b: make('#5a8cff') }
  return tintCanvases
}
function paintSplit(ctx: CanvasRenderingContext2D, k: number, fade: number) {
  ctx.clearRect(0, 0, COLS, ROWS)
  const { r, g, b } = ensureTints()
  const off = 4 * k
  ctx.globalAlpha = fade
  ctx.globalCompositeOperation = 'lighter'
  ctx.drawImage(r, -off, 0)
  ctx.drawImage(g, 0, 0)
  ctx.drawImage(b, off, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
}
function paintBlur(ctx: CanvasRenderingContext2D, k: number, fade: number) {
  ctx.clearRect(0, 0, COLS, ROWS)
  ctx.globalAlpha = fade
  ctx.filter = `blur(${(k * 3).toFixed(2)}px)`
  ctx.drawImage(sourceCanvas!, 0, 0)
  ctx.filter = 'none'
  ctx.globalAlpha = 1
}
function paintZoomBlur(ctx: CanvasRenderingContext2D, k: number, fade: number) {
  ctx.clearRect(0, 0, COLS, ROWS)
  const steps = 6
  const cx = COLS / 2, cy = ROWS / 2
  ctx.globalAlpha = fade / steps
  for (let i = 0; i < steps; i++) {
    const scale = 1 + k * 0.5 * (i / (steps - 1))
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(scale, scale)
    ctx.translate(-cx, -cy)
    ctx.drawImage(sourceCanvas!, 0, 0)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}
function paintPixelate(ctx: CanvasRenderingContext2D, k: number, fade: number) {
  ctx.clearRect(0, 0, COLS, ROWS)
  ctx.globalAlpha = fade
  const block = 1 + Math.round(k * 7)
  if (block <= 1) { ctx.drawImage(sourceCanvas!, 0, 0); ctx.globalAlpha = 1; return }
  const sw = Math.max(1, Math.round(COLS / block)), sh = Math.max(1, Math.round(ROWS / block))
  if (!tinyCanvas) tinyCanvas = document.createElement('canvas')
  tinyCanvas.width = sw; tinyCanvas.height = sh
  const tctx = tinyCanvas.getContext('2d')!
  tctx.imageSmoothingEnabled = false
  tctx.clearRect(0, 0, sw, sh)
  tctx.drawImage(sourceCanvas!, 0, 0, COLS, ROWS, 0, 0, sw, sh)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tinyCanvas, 0, 0, sw, sh, 0, 0, COLS, ROWS)
  ctx.imageSmoothingEnabled = true
  ctx.globalAlpha = 1
}

const CANVAS_DRAW_EFFECTS = new Set(['split', 'blur', 'zoomblur', 'pixelate'])

function draw(amount: number, elapsed: number) {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  if (!source) source = buildPreviewCard(COLS, ROWS)
  const id = settleEffectOf(props.effect).id
  const k = clamp01(settleStrength(amount, 1))
  const fade = clamp01(settleFade(amount, true))
  if (CANVAS_DRAW_EFFECTS.has(id)) {
    ensureSourceCanvas(source)
    if (id === 'split') paintSplit(ctx, k, fade)
    else if (id === 'blur') paintBlur(ctx, k, fade)
    else if (id === 'zoomblur') paintZoomBlur(ctx, k, fade)
    else paintPixelate(ctx, k, fade)
    return
  }
  if (!imageData) imageData = ctx.createImageData(COLS, ROWS)
  const data = imageData.data
  if (id === 'slice') paintSlice(data, source, k, elapsed)
  else if (id === 'glitch') paintGlitch(data, source, k, elapsed)
  else if (id === 'wave') paintWave(data, source, k, elapsed)
  else if (id === 'liquify') paintLiquify(data, source, k, elapsed)
  else if (id === 'swirl') paintSwirl(data, source, k, elapsed)
  else paintRipple(data, source, k, elapsed)   // 'ripple', and the unknown-id fallback
  applyFade(data, fade)
  ctx.putImageData(imageData, 0, 0)
}

/** Amount ramps 0 → 1 over the first 60% of the cycle, holds to 85%, then snaps back to 0 —
 *  same shape as `MotionDitherPreview`'s. `settleStrength` turns that into the effect's own
 *  strength curve: full at amount 0, nothing by amount 1. Settle out plays the mirror (already
 *  settled, then breaks apart), same as a dither bar's reveal track running 1 → 0. */
function amountAt(cycle: number): number {
  const a = cycle < 0.6 ? cycle / 0.6 : cycle < 0.85 ? 1 : 0
  return props.out ? 1 - a : a
}

function drawFrame(now: number) {
  const cycle = (now / 1000 % CYCLE) / CYCLE
  draw(amountAt(cycle), cycle * CYCLE)
}

function loop(now: number) {
  drawFrame(now)
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduced) draw(0.4, 0)
  else raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); raf = 0 })
</script>

<template>
  <canvas ref="canvasEl" :width="COLS" :height="ROWS" class="settle-preview-canvas" aria-hidden="true" />
</template>

<style scoped>
.settle-preview-canvas {
  display: block;
}
</style>
