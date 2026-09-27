<!-- The layout grid's editor overlay (spec 2026-09-26-frame-layout-grid-design). Three SVGs that
     stay mounted so the modules can FADE: column edges (always, very faint), modules + baselines
     (only while a layer is moving), and the accent fill on what the moving layer covers. Neutral
     lines blend with `difference`, so they read on a light or a dark Frame. Never painted into a
     render — it is DOM over the artboard, outside every paintLayerStack path. -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

const props = defineProps<{
  grid: ResolvedLayoutGrid
  show: boolean
  moving: boolean
  /** The moving layer's box in grid px, or null. */
  covered: { x: number; y: number; w: number; h: number } | null
  /** Displayed size in CSS px (kept for callers; strokes are non-scaling, so nothing reads it). */
  w: number; h: number
}>()

const vb = computed(() => `0 0 ${props.grid.W} ${props.grid.H}`)
// Hairlines are `vector-effect: non-scaling-stroke` 1 px strokes: they stay one CSS px through
// the viewBox scaling AND the modal's CSS `transform: scale()` zoom.
const colEdges = computed(() => [...new Set(props.grid.cols.flatMap(c => [c.a, c.a + c.w]))])
const cells = computed(() => props.grid.rows.length
  ? props.grid.cols.flatMap(c => props.grid.rows.map(r => ({ x: c.a, y: r.a, w: c.w, h: r.w })))
  : props.grid.cols.map(c => ({ x: c.a, y: 0, w: c.w, h: props.grid.H })))
const baselines = computed(() => {
  const out: number[] = []
  if (!(props.grid.unit > 0)) return out
  for (let y = props.grid.unit; y < props.grid.H; y += props.grid.unit) out.push(y)
  return out
})
const coveredCells = computed(() => {
  const b = props.covered
  if (!b || !props.moving) return []
  const over = (a0: number, a1: number, t0: number, t1: number) => Math.min(a1, t1) - Math.max(a0, t0) > (t1 - t0) / 2
  return cells.value.filter(c => over(b.x, b.x + b.w, c.x, c.x + c.w) && (props.grid.rows.length ? over(b.y, b.y + b.h, c.y, c.y + c.h) : true))
})
</script>

<template>
  <div v-if="show" class="lg-overlay" data-testid="compositor-grid-overlay">
    <svg class="lg-neutral" :viewBox="vb" preserveAspectRatio="none">
      <line v-for="x in colEdges" :key="'c' + x" :x1="x" :x2="x" y1="0" :y2="grid.H" stroke="rgba(255,255,255,.09)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-neutral lg-mods" :class="{ on: moving }" :viewBox="vb" preserveAspectRatio="none" data-testid="compositor-grid-modules">
      <rect v-for="(c, i) in cells" :key="'m' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line v-for="y in baselines" :key="'b' + y" x1="0" :x2="grid.W" :y1="y" :y2="y" stroke="rgba(255,255,255,.12)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-marks" :viewBox="vb" preserveAspectRatio="none">
      <rect v-for="(c, i) in coveredCells" :key="'k' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="rgba(124,156,255,.22)" />
    </svg>
  </div>
</template>

<style scoped>
.lg-overlay { position: absolute; inset: 0; pointer-events: none; }
.lg-overlay svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.lg-neutral { mix-blend-mode: difference; }
.lg-mods { opacity: 0; transition: opacity .22s ease; }
.lg-mods.on { opacity: 1; }
</style>
