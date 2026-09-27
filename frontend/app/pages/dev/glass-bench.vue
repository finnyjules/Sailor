<script setup lang="ts">
/**
 * Glass benchmark: 40 real NodeShell nodes on a real <VueFlow>, wired to
 * createCanvasGlass exactly like the real canvas (VueNodeCanvas.vue), so a
 * frame-time run can compare Always / Smart / Never before the glass
 * decision (task 9, stage 1 plan). Reachable only at /dev/glass-bench.
 *
 * Half the nodes (20, as 10 pairs) sit in overlapping pairs; the other half
 * stand alone in a grid below. 30 wires connect across both groups, several
 * of them long enough to cross behind a node that isn't either endpoint —
 * exactly the case createCanvasGlass's `nodesWithSomethingBehind` exists for.
 *
 * setViewport fires no Vue Flow move events, but createCanvasGlass reads
 * "moving" from the viewport itself, so the animated run turns Smart's blur
 * off and the settle after it turns blur back on — no hand-fired callbacks.
 */
import { ref, computed, nextTick, onMounted, onUnmounted, h, defineComponent, markRaw } from 'vue'
import { VueFlow, useVueFlow, Position } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import NodeShell from '~/components/vue-canvas/surfaces/NodeShell.vue'
import NodeWell from '~/components/vue-canvas/surfaces/NodeWell.vue'
import NodePort from '~/components/vue-canvas/NodePort.vue'
import { createCanvasGlass, provideCanvasGlass } from '~/composables/useCanvasGlass'
import { countVisible, sampleWire, type GlassMode, type NodeBox, type Wire } from '~/lib/canvas/glassPolicy'

definePageMeta({ layout: false })

// ---------- 40 nodes: 10 overlapping pairs (20 nodes) + 20 standalone ----------
const NODE_COUNT = 40
const PAIR_COUNT = 10
const PAIR_COLS = 5
const STANDALONE_COLS = 5
const COL_GAP = 300
const ROW_GAP = 260
const PAIR_ROWS = Math.ceil(PAIR_COUNT / PAIR_COLS)
const STANDALONE_TOP = 40 + PAIR_ROWS * ROW_GAP + 100

interface BenchNodeDef { id: string; x: number; y: number; row: number }
const nodeDefs: BenchNodeDef[] = []

for (let p = 0; p < PAIR_COUNT; p++) {
  const col = p % PAIR_COLS
  const row = Math.floor(p / PAIR_COLS)
  const baseX = 40 + col * COL_GAP
  const baseY = 40 + row * ROW_GAP
  nodeDefs.push({ id: `bench-${p * 2}`, x: baseX, y: baseY, row })
  // Offset just enough to overlap the shell above/left of it.
  nodeDefs.push({ id: `bench-${p * 2 + 1}`, x: baseX + 50, y: baseY + 40, row })
}
for (let s = 0; s < NODE_COUNT - PAIR_COUNT * 2; s++) {
  const col = s % STANDALONE_COLS
  const row = Math.floor(s / STANDALONE_COLS)
  nodeDefs.push({ id: `bench-${PAIR_COUNT * 2 + s}`, x: 40 + col * COL_GAP, y: STANDALONE_TOP + row * ROW_GAP, row })
}

const allNodeIds = nodeDefs.map(n => n.id)

// ---------- wires: 30 edges, several crossing behind a third node ----------
interface BenchEdgeDef { id: string; source: string; target: string }
const edgeDefs: BenchEdgeDef[] = []
// Within each overlapping pair (10 edges).
for (let p = 0; p < PAIR_COUNT; p++) {
  edgeDefs.push({ id: `e-pair-${p}`, source: `bench-${p * 2}`, target: `bench-${p * 2 + 1}` })
}
// Chain the pairs together (9 edges) — each hop crosses the grid gap, passing
// behind whichever standalone/pair node sits on the bezier's path.
for (let p = 0; p < PAIR_COUNT - 1; p++) {
  edgeDefs.push({ id: `e-chain-${p}`, source: `bench-${p * 2 + 1}`, target: `bench-${(p + 1) * 2}` })
}
// Bridge into the standalone section (1 edge).
edgeDefs.push({ id: 'e-bridge', source: `bench-${PAIR_COUNT * 2 - 1}`, target: `bench-${PAIR_COUNT * 2}` })
// Every other standalone node, skipping one each time (10 edges) — long
// enough to cross behind the node in between.
const standaloneCount = NODE_COUNT - PAIR_COUNT * 2
for (let s = 0; s < standaloneCount - 2; s += 2) {
  edgeDefs.push({ id: `e-standalone-${s}`, source: `bench-${PAIR_COUNT * 2 + s}`, target: `bench-${PAIR_COUNT * 2 + s + 2}` })
}

// ---------- the one node type: title, well, a few static rows ----------
// Static markup only (no StudioRow, no per-frame content animation) — the
// bench measures the glass, not the content.
const BenchNode = defineComponent({
  name: 'BenchNode',
  props: { id: { type: String, required: true } },
  setup(props) {
    return () => h('div', { class: 'relative w-fit' }, [
      h(NodePort, { id: 'in', type: 'target', side: 'left', dataType: 'IMAGE', label: 'In', index: 0 }),
      h(NodePort, { id: 'out', type: 'source', side: 'right', dataType: 'IMAGE', label: 'Out', index: 0 }),
      h('div', { style: { width: '240px' } }, [
        h(NodeShell, { title: props.id, nodeId: props.id }, {
          default: () => [
            h(NodeWell, null, {
              default: () => h('div', { class: 'h-[70px]', style: { background: 'linear-gradient(135deg, #2a2a2e, #1a1a1c)' } }),
            }),
            h('div', { class: 'flex items-center justify-between px-1 text-[12px] text-white/60' }, [
              h('span', 'Model'), h('span', { class: 'text-white/80' }, 'Nano Banana 2'),
            ]),
            h('div', { class: 'flex items-center justify-between px-1 text-[12px] text-white/60' }, [
              h('span', 'Size'), h('span', { class: 'text-white/80' }, 'Square 1:1'),
            ]),
            h('div', { class: 'flex items-center justify-between px-1 text-[12px] text-white/60' }, [
              h('span', 'Strength'), h('span', { class: 'text-white/80' }, '70'),
            ]),
          ],
          foot: () => [
            h('span', { class: 'text-[12px] text-white/50' }, 'Not run yet'),
            h('button', { type: 'button', class: 'node-btn node-btn--primary ml-auto' }, [
              h('span', 'Run'),
              h('span', { class: 'node-btn__price' }, '$0.03'),
            ]),
          ],
        }),
      ]),
    ])
  },
})

const nodeTypes = { bench: markRaw(BenchNode) } as any

const flowNodes = nodeDefs.map(n => ({ id: n.id, type: 'bench', position: { x: n.x, y: n.y }, data: { id: n.id } }))
const flowEdges = edgeDefs.map(e => ({
  id: e.id, source: e.source, target: e.target, sourceHandle: 'out', targetHandle: 'in',
}))

// ---------- glass wiring, same shape as VueNodeCanvas.vue ----------
const mode = ref<GlassMode>('smart')
const canvasRootRef = ref<HTMLElement | null>(null)

// Fix round 1, finding 1(c): blurAllowed's smart rule turns blur off once
// more than GLASS_LIMITS.maxVisibleNodes (24) nodes are visible. A FIXED
// (0, 340, zoom 1) viewport was tuned for one window size (1600×1000) and
// silently broke at another (1890×1063 put 25 nodes on screen, over the
// limit, so Smart measured the same as Never). Fix round 2: the rest
// viewport is now computed from the actual canvas size once nodes are
// measured — see computeRestViewport() — searching for an offset that keeps
// visible-node count between 12 and 20 (comfortably under the 24 limit, but
// still a real subset, not just one pair), covers at least 3 overlapping
// pairs, and includes at least one wire crossing behind a third node, so the
// blur test still has both cases to measure. Kept only as the pre-measurement
// mount default and the last-resort fallback if the search finds nothing.
const REST_VIEWPORT = { x: 0, y: 340, zoom: 1 }
// The rest viewport actually in use — recomputed once nodes are measured,
// and again on window resize (fix round 2). Everything below (the pan/zoom
// animation's centre, the mount default) reads this, not the constant.
const restViewport = ref({ ...REST_VIEWPORT })

const {
  onNodesInitialized, getNodes, getEdges, viewport: vfViewport, setViewport,
} = useVueFlow()

const getBoxes = () => getNodes.value
  .filter(n => n.dimensions.width > 0)
  .map(n => ({ id: n.id, x: n.computedPosition.x, y: n.computedPosition.y, w: n.dimensions.width, h: n.dimensions.height }))
const getWires = () => getEdges.value
  .filter(e => e.sourceX != null && e.targetX != null)
  .map(e => ({ source: e.source, target: e.target, sx: e.sourceX, sy: e.sourceY, tx: e.targetX, ty: e.targetY }))
const getSize = () => ({ width: canvasRootRef.value?.clientWidth ?? 0, height: canvasRootRef.value?.clientHeight ?? 0 })

// Which node ids are the endpoints of an overlapping pair, keyed by pair
// index — used below to require the chosen viewport actually shows several
// full pairs, not just scattered singles.
const pairIds: Array<[string, string]> = Array.from({ length: PAIR_COUNT }, (_, p) => [`bench-${p * 2}`, `bench-${p * 2 + 1}`])

/**
 * Fix round 2: find a zoom-1 (x, y) offset, from the real measured boxes and
 * the real canvas size, such that:
 *  - 12–20 nodes are visible (under GLASS_LIMITS.maxVisibleNodes=24, but not
 *    trivially small either);
 *  - at least 3 overlapping pairs are fully visible (both members);
 *  - at least one wire passes behind a node that isn't either endpoint, and
 *    that node is itself visible.
 * A simple grid search over candidate offsets — the bench only needs one
 * usable viewport, not an optimal one.
 */
function computeRestViewport(): { x: number; y: number; zoom: number } {
  const boxes = getBoxes()
  const wires = getWires()
  const { width, height } = getSize()
  if (!boxes.length || !width || !height) return { ...REST_VIEWPORT }

  // Nodes with a wire passing behind them (excluding the wire's own
  // endpoints) — a purely geometric property of the layout, independent of
  // the viewport.
  const wireBehindIds = new Set<string>()
  for (const w of wires as Wire[]) {
    const pts = sampleWire(w)
    for (const b of boxes as NodeBox[]) {
      if (b.id === w.source || b.id === w.target || wireBehindIds.has(b.id)) continue
      if (pts.some(p => p.x > b.x + 2 && p.x < b.x + b.w - 2 && p.y > b.y + 2 && p.y < b.y + b.h - 2)) {
        wireBehindIds.add(b.id)
      }
    }
  }

  const minX = Math.min(...boxes.map(b => b.x))
  const maxX = Math.max(...boxes.map(b => b.x + b.w))
  const minY = Math.min(...boxes.map(b => b.y))
  const maxY = Math.max(...boxes.map(b => b.y + b.h))
  // A node at (b.x, b.y, b.w, b.h) is visible under offset (ox, oy) when
  // b.x+ox < width && b.y+oy < height && b.x+ox+b.w > 0 && b.y+oy+b.h > 0.
  // So any offset that puts even one node on screen satisfies
  // -maxX < ox < width-minX and -maxY < oy < height-minY — the full useful
  // search range, not just offsets that align the content's top-left corner
  // to the window's. (An earlier version bounded this too tightly and never
  // found the crop that hides the standalone grid below the pairs.)
  const STEP = 40
  const oxLo = -maxX - STEP
  const oxHi = width - minX + STEP
  const oyLo = -maxY - STEP
  const oyHi = height - minY + STEP

  let best: { x: number; y: number; score: number } | null = null
  for (let ox = oxLo; ox <= oxHi; ox += STEP) {
    for (let oy = oyLo; oy <= oyHi; oy += STEP) {
      const visibleIds = new Set(
        boxes
          .filter(b => {
            const left = b.x + ox, top = b.y + oy, right = left + b.w, bottom = top + b.h
            return right > 0 && bottom > 0 && left < width && top < height
          })
          .map(b => b.id),
      )
      const visible = visibleIds.size
      if (visible < 12 || visible > 20) continue
      const pairsVisible = pairIds.filter(([a, b]) => visibleIds.has(a) && visibleIds.has(b)).length
      if (pairsVisible < 3) continue
      let hasWireBehind = false
      for (const id of wireBehindIds) { if (visibleIds.has(id)) { hasWireBehind = true; break } }
      if (!hasWireBehind) continue
      const score = Math.abs(visible - 16) // prefer the middle of the 12–20 band
      if (!best || score < best.score) best = { x: ox, y: oy, score }
    }
  }
  return best ? { x: best.x, y: best.y, zoom: 1 } : { ...REST_VIEWPORT }
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null
function refreshRestViewport() {
  restViewport.value = computeRestViewport()
  setViewport(restViewport.value)
  if (mode.value === 'smart') canvasGlass.invalidate()
}
function handleResize() {
  // Never fight a run in progress — only recompute at rest.
  if (running.value) return
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(refreshRestViewport, 150)
}
onMounted(() => window.addEventListener('resize', handleResize))
onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (resizeTimer) clearTimeout(resizeTimer)
})

const canvasGlass = createCanvasGlass({
  viewport: vfViewport,
  boxes: getBoxes,
  wires: getWires,
  size: getSize,
}, { mode })

// In Always mode the policy allows blur everywhere, but only nodes actually
// listed in blurIds get `data-glass-blur` on their shell (see NodeShell.vue /
// useNodeGlass) — so for Always to mean every shell blurs, every node id
// must be in blurIds, overriding whatever nodesWithSomethingBehind computed.
// In Never mode blur is never allowed at the root either way, but the set
// should still be empty (fix round 1, finding 2) so no shell is left
// carrying a stale `data-glass-blur` attribute from a previous Smart run.
const effectiveBlurIds = computed(() => {
  if (mode.value === 'always') return new Set(allNodeIds)
  if (mode.value === 'never') return new Set<string>()
  return canvasGlass.blurIds.value
})
provideCanvasGlass({ blurIds: effectiveBlurIds })

// True blur only happens where BOTH hold: the root allows it (canvas-glass--blur)
// and the shell is in the blur set. Used by the readout and by the
// blurredAtRest/blurredDuringPan measurements below.
function sampleBlurredShellCount(): number {
  return canvasGlass.rootClass.value.includes('canvas-glass--blur') ? effectiveBlurIds.value.size : 0
}

// ---------- always-visible readout (fix round 1, finding 1a) ----------
const rootHasBlur = computed(() => canvasGlass.rootClass.value.includes('canvas-glass--blur'))
const blurredShellCount = computed(() => effectiveBlurIds.value.size)
const visibleNodeCount = computed(() => countVisible(getBoxes(), { ...vfViewport.value, ...getSize() }))

// Same as the real canvas: decide blur once the nodes have real dimensions.
// Fix round 2: also where the rest viewport is first computed for real —
// boxes only have real widths/heights from this point on.
onNodesInitialized(() => {
  restViewport.value = computeRestViewport()
  setViewport(restViewport.value)
  canvasGlass.invalidate()
})

function setMode(next: GlassMode) {
  mode.value = next
  canvasGlass.recompute()
}

// ---------- the benchmark run ----------
interface BenchResult {
  label: string
  median: number
  p95: number
  dropped: number
  frames: number
  // Fix round 1, finding 1(b): so a Smart run that never actually blurred
  // (e.g. because too many nodes were visible) can be told apart from one
  // that did, instead of just trusting the frame times.
  blurredAtRest: number
  blurredDuringPan: number
}
const results = ref<BenchResult[]>([])
const running = ref(false)

// Measurement code as specified in the task 9 brief: rAF deltas over a
// 6-second figure-eight pan followed by a 6-second pinch zoom (1 → 0.6 → 1),
// both centred on restViewport (fix round 2: computed from the real canvas
// size, not the REST_VIEWPORT constant) so the pan stays over the
// overlapping-pairs section the rest viewport frames.
async function runBench(label: string, blurredAtRest: number) {
  const deltas: number[] = []
  let last = performance.now(), live = true
  const tick = (t: number) => { deltas.push(t - last); last = t; if (live) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  let blurredDuringPan = blurredAtRest
  let sampledMidPan = false
  const start = performance.now()
  const rest = restViewport.value
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = (performance.now() - start) / 1000
      if (t > 12) { resolve(); return }
      if (t <= 6) setViewport({ x: rest.x + Math.sin(t * 2) * 400, y: rest.y + Math.sin(t * 4) * 150, zoom: rest.zoom })
      else setViewport({ x: rest.x, y: rest.y, zoom: rest.zoom - 0.4 * Math.sin(((t - 6) / 6) * Math.PI) })
      // Sampled once, at t≈3s (mid pan, per fix round 1 finding 1b).
      if (!sampledMidPan && t >= 3) { sampledMidPan = true; blurredDuringPan = sampleBlurredShellCount() }
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  live = false
  const s = deltas.slice(5).sort((a, b) => a - b)
  const result: BenchResult = {
    label,
    median: s[Math.floor(s.length / 2)] ?? 0,
    p95: s[Math.floor(s.length * 0.95)] ?? 0,
    dropped: s.filter(d => d > 20).length,
    frames: s.length,
    blurredAtRest,
    blurredDuringPan,
  }
  ;(window as any).__glassBench = [...((window as any).__glassBench ?? []), result]
  console.table([result])
  results.value = [...results.value, result]
  return result
}

async function runPan() {
  if (running.value) return
  running.value = true
  try {
    // Sample the rest state BEFORE the first setViewport turns blur off.
    if (mode.value === 'smart') canvasGlass.recompute()
    await nextTick()
    const blurredAtRest = sampleBlurredShellCount()
    const label = mode.value === 'always' ? 'Always' : mode.value === 'never' ? 'Never' : 'Smart'
    await runBench(label, blurredAtRest)
  } finally {
    running.value = false
  }
}

function fmt(n: number) { return Number.isFinite(n) ? n.toFixed(1) : '—' }
</script>

<template>
  <div ref="canvasRootRef" :class="[canvasGlass.rootClass.value, 'relative h-screen w-full overflow-hidden bg-[#0a0a0a]']" :style="canvasGlass.rootStyle.value" data-slot="comfy-canvas">
    <VueFlow
      class="absolute inset-0"
      :nodes="flowNodes"
      :edges="flowEdges"
      :node-types="nodeTypes"
      :default-viewport="REST_VIEWPORT"
      :min-zoom="0.2"
      :max-zoom="2"
      :nodes-draggable="false"
      :pan-on-scroll="true"
    />

    <div class="absolute left-4 top-4 z-10 flex flex-col gap-3 rounded-xl border border-white/10 bg-[#161616]/95 p-3">
      <div class="flex items-center gap-2">
        <button
          v-for="m in (['always', 'smart', 'never'] as GlassMode[])"
          :key="m"
          type="button"
          class="node-btn"
          :class="{ 'node-btn--primary': mode === m }"
          :disabled="running"
          @click="setMode(m)"
        >{{ m === 'always' ? 'Always' : m === 'smart' ? 'Smart' : 'Never' }}</button>
        <button type="button" class="node-btn" :disabled="running" @click="runPan">Pan</button>
      </div>

      <!-- Always-visible readout (fix round 1, finding 1a) — makes it obvious
           on screen, without waiting for a run, when Smart's 24-visible-node
           limit has silently turned blur off. -->
      <div data-testid="glass-readout" class="text-[12px] text-white/60">
        <span data-testid="glass-readout-root">root blur: {{ rootHasBlur ? 'on' : 'off' }}</span>
        ·
        <span data-testid="glass-readout-shells">shells blurring: {{ blurredShellCount }}</span>
        ·
        <span data-testid="glass-readout-visible">visible: {{ visibleNodeCount }}</span>
      </div>

      <table v-if="results.length" class="text-left text-[12px] text-white/70">
        <thead>
          <tr class="text-white/40">
            <th class="pr-4 font-medium">Mode</th>
            <th class="pr-4 font-medium">Median</th>
            <th class="pr-4 font-medium">p95</th>
            <th class="pr-4 font-medium">Dropped</th>
            <th class="pr-4 font-medium">Frames</th>
            <th class="pr-4 font-medium">Blur (rest)</th>
            <th class="font-medium" title="Shells blurring mid pan. Smart should read 0 while moving">Blur (pan)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in results" :key="i">
            <td class="pr-4">{{ r.label }}</td>
            <td class="pr-4">{{ fmt(r.median) }} ms</td>
            <td class="pr-4">{{ fmt(r.p95) }} ms</td>
            <td class="pr-4">{{ r.dropped }}</td>
            <td class="pr-4">{{ r.frames }}</td>
            <td class="pr-4">{{ r.blurredAtRest }}</td>
            <td>{{ r.blurredDuringPan }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
