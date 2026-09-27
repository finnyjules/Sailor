<!-- The layout grid's editor overlay (spec 2026-09-26-frame-layout-grid-design). SVGs that stay
     mounted so the modules can FADE: column edges (always, very faint), modules + baselines
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
  /** Displayed size in CSS px (kept for callers; strokes are non-scaling, so nothing reads it). */
  w: number; h: number
  /** The selected text's capitals and baselines in grid px, with its box's x and width; or null. */
  textMarks?: { capTop: number; baselines: number[]; x: number; w: number } | null
}>(), { textMarks: null })

/** The app's accent — snap lines, the badge and the text marks (Global Constraints). */
const ACCENT = '#5b7cff'
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
      <line v-for="x in colEdges" :key="'c' + x" :x1="x" :x2="x" y1="0" :y2="grid.H" stroke="rgba(255,255,255,.09)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-neutral lg-mods" :class="{ on: moving }" :viewBox="vb" preserveAspectRatio="none" data-testid="compositor-grid-modules">
      <rect v-for="(c, i) in cells" :key="'m' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line v-for="y in baselines" :key="'b' + y" x1="0" :x2="grid.W" :y1="y" :y2="y" stroke="rgba(255,255,255,.12)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <svg class="lg-marks" :viewBox="vb" preserveAspectRatio="none">
      <rect v-for="(c, i) in coveredCells" :key="'k' + i" :x="c.x" :y="c.y" :width="c.w" :height="c.h" fill="rgba(124,156,255,.22)" />
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
