<!-- The layout grid's editor overlay (spec 2026-09-26-frame-layout-grid-design). A few SVG paths
     that stay mounted so the modules can FADE: column edges (always, very faint), modules + baselines
     (only while a layer is moving), the accent fill on what the moving layer covers, the selected
     text's capital/baseline lines, and a badge naming what a drag covers. Neutral lines blend
     with `difference`, so they read on a light or a dark Frame. Never painted into a render — it
     is DOM over the artboard, outside every paintLayerStack path. -->
<script setup lang="ts">
import { computed } from 'vue'
import { spanOf, type ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

const props = withDefaults(defineProps<{
  grid: ResolvedLayoutGrid
  show: boolean
  moving: boolean
  /** The moving layer's box in grid px (text: capitals to last baseline), or null. */
  covered: { x: number; y: number; w: number; h: number } | null
  /** Displayed size in CSS px (at zoom 1): how dense the baselines are on screen. */
  w: number; h: number
  /** The selected text's capitals and baselines in grid px, with its box's x and width; or null. */
  textMarks?: { capTop: number; baselines: number[]; x: number; w: number } | null
}>(), { textMarks: null })

/** The app's accent — snap lines, the badge and the text marks (Global Constraints). */
const ACCENT = '#5b7cff'
/** Baselines closer than this on screen (CSS px at zoom 1) would read as a grey wash: not drawn. */
const MIN_BASELINE_PX = 3
/** Past this many modules the outlines are skipped (a wash too, and a very long path). */
const MAX_MODULES = 2000
const vb = computed(() => `0 0 ${props.grid.W} ${props.grid.H}`)
// Each layer is ONE path (spec: not one element per line), so a pointermove that changes only the
// covered cells re-renders a handful of elements. Hairlines are `vector-effect: non-scaling-stroke`
// 1 px strokes: they stay one CSS px through the viewBox scaling AND the modal's CSS zoom (SVG
// <pattern> tiles would scale with the viewBox, which is why these are paths).
const n = (v: number) => Math.round(v * 1000) / 1000
type Cell = { x: number; y: number; w: number; h: number }
const rectsPath = (cells: Cell[]) => cells.map(c => `M${n(c.x)} ${n(c.y)}h${n(c.w)}v${n(c.h)}h${n(-c.w)}Z`).join('')
const colPath = computed(() => {
  const H = n(props.grid.H)
  return [...new Set(props.grid.cols.flatMap(c => [n(c.a), n(c.a + c.w)]))].map(x => `M${x} 0V${H}`).join('')
})
const modPath = computed(() => {
  const { cols, rows, H } = props.grid
  if ((rows.length ? cols.length * rows.length : cols.length) > MAX_MODULES) return ''
  return rectsPath(rows.length
    ? cols.flatMap(c => rows.map(r => ({ x: c.a, y: r.a, w: c.w, h: r.w })))
    : cols.map(c => ({ x: c.a, y: 0, w: c.w, h: H })))
})
const basePath = computed(() => {
  const { unit, W, H } = props.grid
  if (!(unit > 0) || !(W > 0) || (unit * props.w) / W < MIN_BASELINE_PX) return ''
  let d = ''
  for (let i = 1; i * unit < H; i++) d += `M0 ${n(i * unit)}H${n(W)}`
  return d
})
// What the moving layer covers, as the Layer section counts it (spanOf) — so the fill, the badge
// and the Column/Row fields always agree, and a one-line text still covers its row.
const coveredSpan = computed(() => (props.covered && props.moving ? spanOf(props.covered, props.grid) : null))
const coveredCells = computed(() => {
  const s = coveredSpan.value
  if (!s) return []
  const cols = props.grid.cols.slice(s.col - 1, s.col - 1 + s.cols)
  if (s.row == null || s.rows == null) return cols.map(c => ({ x: c.a, y: 0, w: c.w, h: props.grid.H }))
  const rows = props.grid.rows.slice(s.row - 1, s.row - 1 + s.rows)
  return cols.flatMap(c => rows.map(r => ({ x: c.a, y: r.a, w: c.w, h: r.w })))
})
const coveredPath = computed(() => rectsPath(coveredCells.value))
const badge = computed(() => {
  const s = coveredSpan.value
  if (!s || !props.covered) return null
  const text = s.row != null && s.rows != null
    ? `${s.cols} × ${s.rows} ${s.cols * s.rows === 1 ? 'module' : 'modules'}`
    : `${s.cols} ${s.cols === 1 ? 'column' : 'columns'}`
  const x = props.grid.cols[s.col - 1]!.a
  return { text, left: `${(x / props.grid.W) * 100}%`, top: `${(props.covered.y / props.grid.H) * 100}%` }
})
</script>

<template>
  <div v-if="show" class="lg-overlay" data-testid="compositor-grid-overlay">
    <svg class="lg-neutral" :viewBox="vb" preserveAspectRatio="none">
      <path data-testid="compositor-grid-columns" :d="colPath" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-neutral lg-mods" :class="{ on: moving }" :viewBox="vb" preserveAspectRatio="none" data-testid="compositor-grid-modules">
      <path v-if="modPath" :d="modPath" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1" vector-effect="non-scaling-stroke" />
      <path v-if="basePath" data-testid="compositor-grid-baselines" :d="basePath" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-marks" :viewBox="vb" preserveAspectRatio="none">
      <path v-if="coveredPath" data-testid="compositor-grid-covered" :d="coveredPath" fill="rgba(124,156,255,.22)" />
    </svg>
    <svg v-if="textMarks" class="lg-marks" :viewBox="vb" preserveAspectRatio="none" data-testid="compositor-grid-text-marks">
      <line :x1="textMarks.x" :x2="textMarks.x + textMarks.w" :y1="textMarks.capTop" :y2="textMarks.capTop"
        :stroke="ACCENT" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
      <line v-for="(b, i) in textMarks.baselines" :key="'tb' + i" :x1="textMarks.x" :x2="textMarks.x + textMarks.w" :y1="b" :y2="b"
        :stroke="ACCENT" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-if="badge" class="lg-badge" data-testid="compositor-grid-badge" :style="{ left: badge.left, top: badge.top }">{{ badge.text }}</div>
  </div>
</template>

<style scoped>
.lg-overlay { position: absolute; inset: 0; pointer-events: none; }
.lg-overlay svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.lg-neutral { mix-blend-mode: difference; }
.lg-mods { opacity: 0; transition: opacity .22s ease; }
.lg-mods.on { opacity: 1; }
.lg-badge {
  position: absolute; transform: translateY(calc(-100% - 4px));
  background: #5b7cff; color: #fff; border-radius: 4px; padding: 1px 6px;
  font: 500 10px/1.4 system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap;
}
</style>
