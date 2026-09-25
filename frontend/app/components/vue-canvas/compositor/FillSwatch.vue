<script setup lang="ts">
// Tiny canvas that previews any compositor Paint (solid / gradient / ombre / grid /
// noise / checkerboard / stripes / qr / image-tint colour / image fill) — used in the
// layer list so a layer's fill is identifiable at a glance. Mirrors FillControl's drawPreview.
import { ref, watch, onMounted } from 'vue'
import { fillTileCanvas } from '~/lib/spacetype/fillTile'
import { type Paint, isFill, isGradient, isImageFill } from '~/composables/useCompositorLayers'
import { getFillBitmap, ensureFillBitmaps } from '~/lib/paint/imageFillCache'
import { imageFillRect, isFoilFill } from '~/lib/compositor/paint'
import { METALS } from '~/lib/compositor/finishPass'

const props = withDefaults(defineProps<{ paint: Paint | undefined; size?: number }>(), { size: 14 })
const cv = ref<HTMLCanvasElement | null>(null)

function drawGradient(ctx: CanvasRenderingContext2D, g: { type: string; angle?: number; stops?: { offset: number; color: string }[] }, w: number, h: number) {
  const stops = [...(g.stops ?? [])].sort((a, b) => a.offset - b.offset)
  let cg: CanvasGradient
  if (g.type === 'radial') cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) / 2)
  else {
    const rad = ((g.angle ?? 0) * Math.PI) / 180, hx = (Math.cos(rad) * w) / 2, hy = (Math.sin(rad) * h) / 2
    cg = ctx.createLinearGradient(w / 2 - hx, h / 2 - hy, w / 2 + hx, h / 2 + hy)
  }
  for (const s of stops) cg.addColorStop(Math.max(0, Math.min(1, s.offset)), s.color)
  ctx.fillStyle = cg; ctx.fillRect(0, 0, w, h)
}

function draw() {
  const c = cv.value; if (!c) return
  const ctx = c.getContext('2d'); if (!ctx) return
  const w = c.width, h = c.height
  ctx.clearRect(0, 0, w, h)
  const p = props.paint
  if (isImageFill(p)) {
    const img = getFillBitmap(p.src)
    if (img) {
      const { dx, dy, dw, dh } = imageFillRect('cover', img.naturalWidth || img.width, img.naturalHeight || img.height, w, h)
      ctx.drawImage(img, dx, dy, dw, dh)
    } else {
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, w, h)
      // onReady fires once, only on a real decode — safe for an empty src (the
      // fill-type-just-picked state) and a failed/in-flight one. A
      // `.then(draw)` re-arm here infinite-loops on those and freezes the tab.
      ensureFillBitmaps([p.src], draw)
    }
    return
  }
  // Foil: the metal's mid colour — the same flat stand-in the painter uses without WebGL 2.
  if (isFoilFill(p)) { ctx.fillStyle = (METALS[p.metal] ?? METALS.gold)[2]; ctx.fillRect(0, 0, w, h); return }
  if (isGradient(p)) { drawGradient(ctx, p, w, h); return }
  if (isFill(p)) { try { ctx.drawImage(fillTileCanvas(p, Math.max(w, h)), 0, 0, w, h) } catch { /* no canvas */ } return }
  const solid = typeof p === 'string' && p && p !== 'none' && p !== 'transparent' ? p : null
  if (solid) { ctx.fillStyle = solid; ctx.fillRect(0, 0, w, h) }
  else {
    // No fill: a faint diagonal, matching FillControl's "none" affordance.
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(1, h - 1); ctx.lineTo(w - 1, 1); ctx.stroke()
  }
}

onMounted(draw)
watch(() => [props.paint, props.size], draw, { deep: true })
</script>

<template>
  <canvas
    ref="cv" :width="size" :height="size"
    class="rounded-[3px] border border-white/15 shrink-0"
    :style="{ width: size + 'px', height: size + 'px' }"
  />
</template>
