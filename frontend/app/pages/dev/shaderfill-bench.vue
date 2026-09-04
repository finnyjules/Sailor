<template>
  <div class="bench">
    <h1>Shader fill readback bench (Task 3: field renderer)</h1>
    <p class="note">
      Drives <code>withFieldFrame</code> + <code>resolveField</code> (<code>~/lib/shaderfill/field</code>)
      instead of calling shaderFx directly — the same descriptor-batched cache every real
      surface will go through. shaderFx renders a field into its own WebGL2 context; field.ts
      blits it ONCE into its own persistent, cached 2D canvas (by <code>fieldKey</code>) and
      returns that canvas. This bench binds the returned canvas DIRECTLY as the
      <code>THREE.CanvasTexture</code> image source on a quad in a SEPARATE three.js renderer —
      no second copy. (An earlier revision copied it again into a bench-owned canvas first;
      that measured as the dominant cost of a ~4x regression and was removed — see
      <code>resolveField</code>'s ownership-contract doc in field.ts.) Answers both "how many
      live 512² fields can we afford per frame?" and "does the cache actually collapse
      identical descriptors to one render?"
    </p>

    <div class="controls">
      <div class="group">
        <span class="label">fields/frame</span>
        <button
          v-for="n in FIELD_OPTIONS" :key="n"
          :class="{ active: fieldsCount === n }"
          @click="fieldsCount = n"
        >{{ n }}</button>
        <span class="hint">(0 = vsync baseline, no shader work)</span>
      </div>
      <label class="group"><input v-model="distinct" type="checkbox"> distinct descriptors (vary the effect's first param per field)</label>
      <span class="status">{{ status }}</span>
    </div>

    <div class="stats">
      <div class="stat"><span class="k">effect</span><span class="v">{{ effectId || '—' }}</span></div>
      <div class="stat"><span class="k">frame (wall, 120f avg)</span><span class="v">{{ stats.wallMs.toFixed(2) }} ms</span></div>
      <div class="stat"><span class="k">cpu submit (120f avg)</span><span class="v">{{ stats.cpuMs.toFixed(2) }} ms</span></div>
      <div class="stat"><span class="k">bind (120f avg)</span><span class="v">{{ stats.bindMs.toFixed(2) }} ms</span></div>
      <div class="stat"><span class="k">fps (wall)</span><span class="v" :class="{ bad: stats.fps > 0 && stats.fps < 30 }">{{ stats.fps.toFixed(1) }}</span></div>
    </div>

    <p class="verdict">{{ verdictText }}</p>

    <p class="pass-note">
      Pass condition (Task 0 spec): 2 distinct 512² fields sustain ≥30fps with total wall frame
      time under 33ms. Load starts at fields=0 to capture the vsync baseline automatically; then
      switch to fields=2 with "distinct descriptors" checked and read the wall fps / verdict above.
      Wait ~1s after any control change — the first 60 frames are discarded while shaders
      compile and FBOs allocate.
    </p>

    <div class="controls">
      <button class="run-sweep" :disabled="sweepRunning" @click="onRunSweepClick">{{ sweepRunning ? 'sweeping…' : 'Run sweep' }}</button>
      <span class="hint">
        rAF/vsync-independent path — 60 forced-sync iterations per field count (10 discarded as
        warmup), works even when this pane is hidden/backgrounded. `t` advances one host frame
        per iteration, so every iteration lands on a fresh cache bucket and must re-render (a
        static `t` would cache-hit after iteration 1 and measure lookups, not GPU cost). Each
        field's <code>resolveField</code> result is bound DIRECTLY as its texture's image source
        (no intermediate copy — see the note above), then a single-pixel <code>getImageData</code>
        readback on THAT SAME canvas forces it to materialise — necessary because shaderFx
        renders on its own separate WebGL2 context, so this sweep's own
        <code>gl.finish()</code> (which only syncs the THREE renderer's context) doesn't wait for
        it by itself; skipping this was tried and measured a ~20x-too-fast, broken reading. Every
        row is tagged
        <code>mode: 'distinct' | 'shared'</code> so a number is never read without its regime,
        and carries the actual <code>renders</code> count for its timed iterations (from
        field.ts's <code>fieldStats()</code>) plus <code>msPerRender</code> — total timed time ÷
        actual renders, which means the same thing in both regimes, unlike <code>msPerField</code>.
        This button reads the checkbox above; headless callers pass the regime explicitly —
        <code>window.__benchSweep({ distinct: true })</code> reproduces Task 0's per-field GPU
        cost, <code>{ distinct: false }</code> measures the batched/shared cost (fields
        legitimately collapse toward 1 render/iteration), and a bare
        <code>window.__benchSweep()</code> defaults to whatever this checkbox currently shows.
      </span>
    </div>

    <p class="pass-note">
      Batching proof — the load-bearing claim of the whole design — is exposed as
      <code>window.__benchBatch()</code>: renders 8 fields with identical descriptors (must
      collapse to 1 render), 8 with distinct ones (must issue 8), and 8 with an identical
      SPEED:0 descriptor at 8 DIFFERENT times (must also collapse to 1 — proves the frozen-field
      cache path specifically, not by riding along on the identical-`t` case). Counts come from
      field.ts's <code>fieldStats()</code>. Not wired to a button — console/controller only.
      Raw cumulative counts are also exposed directly as <code>window.__benchFieldStats()</code>
      → <code>{ renders, hits, misses, tileHits, tileMisses }</code>, for inspecting cache
      behaviour mid-session without running a full sweep or batch. <code>tileHits</code>/
      <code>tileMisses</code> are the SEPARATE input-tile cache (keyed on the input fill + size,
      not time) — the evidence that an animated field's time-invariant input is rasterised once
      per (input, size) and reused across every frame and every consumer sharing it, instead of
      being re-rasterised on the CPU every single frame.
    </p>

    <p v-if="sweepError" class="sweep-error">sweep error: {{ sweepError }}</p>

    <table v-if="sweepRows && sweepRows.length" class="sweep-table">
      <thead>
        <tr>
          <th>fields</th><th>mode</th><th>ms / iteration</th><th>ms / field</th><th>ms / render</th>
          <th>bind ms</th><th>renders</th><th>tile hits</th><th>tile misses</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in sweepRows" :key="r.fields">
          <td>{{ r.fields }}</td>
          <td>{{ r.mode }}</td>
          <td>{{ r.msPerIteration.toFixed(2) }}</td>
          <td>{{ r.msPerField.toFixed(2) }}</td>
          <td>{{ r.msPerRender.toFixed(2) }}</td>
          <td>{{ r.bindMs.toFixed(2) }}</td>
          <td>{{ r.renders }}</td>
          <td>{{ r.tileHits }}</td>
          <td>{{ r.tileMisses }}</td>
        </tr>
      </tbody>
    </table>

    <canvas ref="canvasEl" :width="CANVAS_W" :height="CANVAS_H" class="stage" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { DEFAULT_FILL, fillTileBox, type Fill, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { withFieldFrame, resolveField, clearFieldCache, fieldStats, type FieldRequest } from '~/lib/shaderfill/field'
import { LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
import type { EffectDef } from '~/lib/shaderfx/types'

definePageMeta({ layout: false })

// Preferred generative-ish effect for the bench (needs no uploaded image — its
// input is the synthetic gradient fill built below). Falls back to the first
// catalog effect flagged `generative` if this id isn't present.
const PREFERRED_EFFECT_ID = 'fbm_warp'

const FIELD_SIZE = 512
const FIELD_OPTIONS = [0, 1, 2, 4, 8] as const
const MAX_FIELDS = 8
const FRAME_WINDOW = 120
// Frames to discard after any control change (fields/distinct) before averaging —
// shader compile + FBO allocation on the first frames otherwise swamp the signal
// (a switch to N=1 could read as costlier than N=2 purely from warm-up jitter).
const WARMUP_FRAMES = 60
const CANVAS_W = 960
const CANVAS_H = 480

// Bench starts at fields=0 on load specifically so the vsync-ceiling baseline for
// THIS display gets captured automatically before any shader work runs — without
// it, "60fps at 8 fields" is ambiguous between "plenty of headroom" and "exactly
// saturated" (see verdictText below).
const fieldsCount = ref<number>(0)
const distinct = ref(false)
const status = ref('loading catalog…')
const effectId = ref('')
const stats = ref({ cpuMs: 0, bindMs: 0, wallMs: 0, fps: 0 })
/** Wall fps at fields=0, captured once (the first time the rolling window fills at
 *  fields=0 post-warmup). Never recaptured — later 0-field visits don't overwrite it. */
const baselineFps = ref<number | null>(null)

const verdictText = computed(() => {
  if (baselineFps.value == null) return 'measuring fields=0 baseline…'
  const fps = stats.value.fps
  if (fps <= 0) return 'measuring…'
  const ratio = fps / baselineFps.value
  return ratio >= 0.9
    ? `vsync-capped (headroom) — ${fps.toFixed(1)} fps vs ${baselineFps.value.toFixed(1)} fps baseline`
    : `GPU-bound: ${fps.toFixed(1)} fps — baseline ${baselineFps.value.toFixed(1)} fps`
})

const canvasEl = ref<HTMLCanvasElement | null>(null)

let effectDef: EffectDef | null = null
// The shader's input is now a Fill DESCRIPTOR, not a pre-built canvas — resolveField
// rasterises it itself (via fillTileBox/effectiveTileFill) per field, same as any
// real shader-fill consumer. Same convention as before: a static gradient tile.
const baseFillSpec: Fill = { ...DEFAULT_FILL, type: 'gradient' }
const BENCH_FPS = 60

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.OrthographicCamera | null = null
let raf = 0
let startedAt = 0

interface FieldState {
  texture: THREE.CanvasTexture
  mesh: THREE.Mesh
}
const fieldStates: FieldState[] = []

// CPU-submit timing (command-submission cost — how long shaderFx.render/the texture
// assignment take to RETURN, not how long the GPU takes to finish). Useful for
// telling "we're submitting too much work" apart from "the GPU can't keep up", but
// render() is async on the GPU side, so this must NOT drive fps.
const frameTimes: number[] = []
// `bindTimes` used to time a drawImage+getImageData COPY into a bench-owned canvas
// (measurement overhead, not architecture — see the top-of-page note). Now times
// the trivial `texture.image = out; texture.needsUpdate = true` assignment, which
// should be ~0 — kept as a metric specifically so that near-zero number is visible
// and comparable against what copying used to cost.
const bindTimes: number[] = []
// Wall-clock rAF-to-rAF deltas — the only honest frame-cost signal, since the
// browser can't start the next frame until the current one's GPU work is done.
const wallTimes: number[] = []
let lastNow: number | null = null
let warmupRemaining = WARMUP_FRAMES

function pushRolling(arr: number[], v: number): void {
  arr.push(v)
  if (arr.length > FRAME_WINDOW) arr.shift()
}

function avg(arr: number[]): number {
  if (!arr.length) return 0
  let sum = 0
  for (const v of arr) sum += v
  return sum / arr.length
}

/** Discard the rolling windows and restart the warm-up count — called on load and
 *  after any fields/distinct change, so shader-compile/FBO-alloc jitter from the
 *  first frames never pollutes the averages. */
function resetWarmup(): void {
  warmupRemaining = WARMUP_FRAMES
  frameTimes.length = 0
  bindTimes.length = 0
  wallTimes.length = 0
}

// Defensive: a throw here would surface as an opaque "scheduler flush" warning and
// silently break the fields/distinct controls (this watcher fires on every change).
watch([fieldsCount, distinct], () => {
  try { resetWarmup() } catch (e) { console.error('[shaderfill-bench] resetWarmup failed', e) }
})

/** Arrange up to 8 quads in a 4-wide grid, hide the rest. */
function layoutFields(): void {
  const n = fieldsCount.value
  const cols = Math.min(4, n)
  const rows = Math.ceil(n / 4)
  const spacing = 1.3
  for (let i = 0; i < MAX_FIELDS; i++) {
    const st = fieldStates[i]
    if (!st) continue
    const visible = i < n
    st.mesh.visible = visible
    if (!visible) continue
    const col = i % 4
    const row = Math.floor(i / 4)
    st.mesh.position.set((col - (cols - 1) / 2) * spacing, -(row - (rows - 1) / 2) * spacing, 0)
  }
}

watch(fieldsCount, () => {
  try { layoutFields() } catch (e) { console.error('[shaderfill-bench] layoutFields failed', e) }
})

function buildFieldStates(): void {
  for (let i = 0; i < MAX_FIELDS; i++) {
    // Tiny placeholder just to satisfy THREE.CanvasTexture's constructor — it never
    // gets drawn into or displayed. Every real frame reassigns `.image` to whatever
    // `resolveField` returns (see loop()/runSweep()) and sets `needsUpdate`, which is
    // the production consumption pattern: bind field.ts's canvas directly, no copy.
    const placeholder = document.createElement('canvas')
    placeholder.width = 1; placeholder.height = 1
    const texture = new THREE.CanvasTexture(placeholder)
    const mat = new THREE.MeshBasicMaterial({ map: texture })
    const geo = new THREE.PlaneGeometry(1, 1)
    const mesh = new THREE.Mesh(geo, mat)
    scene!.add(mesh)
    fieldStates.push({ texture, mesh })
  }
}

/** Which param to vary for "distinct descriptors", and how: the effect's FIRST
 *  declared param, spread across its declared range (or cycled through its enum
 *  options). Generic over whichever effect the catalog resolves to — not hardcoded
 *  to fbm_warp's `amount` — so this still produces genuinely different descriptors
 *  if PREFERRED_EFFECT_ID falls back to a different generative effect. Returns {}
 *  (every field keys identically) when `distinct` is off, or the effect has no
 *  params to vary. */
function paramOverridesForIndex(i: number, count: number): Record<string, number> {
  if (!effectDef || !effectDef.params.length) return {}
  const p = effectDef.params[0]!
  const key = p.uniform.startsWith('u_') ? p.uniform.slice(2) : p.uniform
  if (p.type === 'enum' && p.options?.length) return { [key]: p.options[i % p.options.length]!.value }
  // Sweeps a NUMERIC param only; colour/gradient params have no scalar range to walk.
  if (p.type === 'color' || p.type === 'gradient') return {}
  const lo = p.min ?? 0, hi = p.max ?? ((p.default as number) + 1)
  return { [key]: lo + (hi - lo) * (i / Math.max(1, count - 1)) }
}

/** `useDistinct` is an explicit parameter, not read from the reactive `distinct` ref
 *  directly — `runSweep` needs to be callable with a regime that overrides whatever
 *  the on-screen checkbox currently shows (see its `SweepOptions`), so every caller
 *  states which regime it wants rather than this function guessing from UI state. */
function specForField(i: number, useDistinct: boolean): ShaderSpec {
  const params = useDistinct ? paramOverridesForIndex(i, MAX_FIELDS) : {}
  return { effectId: effectDef!.id, params, anchor: 'object', speed: 1, seed: 42, input: baseFillSpec }
}

function loop(now: number): void {
  raf = requestAnimationFrame(loop)
  if (!effectDef || !renderer || !scene || !camera) return

  // Wall-clock rAF-to-rAF delta — the ONLY honest frame-cost signal. shaderFx.render()
  // submits GPU work asynchronously, so timing around it (below) measures command
  // submission, not frame cost. The browser can't schedule the next rAF until the
  // current frame's GPU work is actually done, so if GPU work exceeds budget, this
  // delta is what stretches.
  if (lastNow != null) {
    const wallDelta = now - lastNow
    if (warmupRemaining <= 0) pushRolling(wallTimes, wallDelta)
  }
  lastNow = now

  const t0 = performance.now()
  const timeSec = (now - startedAt) / 1000
  const n = fieldsCount.value
  let bindAccum = 0

  // One withFieldFrame call per rendered frame, covering every field this frame
  // wants — this is what lets the live/frozen ceiling apply per-frame rather than
  // per-field. Identical descriptors collapse to one key regardless of `n`.
  // withFieldFrame owns the begin/end pairing in a try/finally (see its doc in
  // ~/lib/shaderfill/field.ts) — this bench used to call beginFieldFrame with no
  // matching endFieldFrame anywhere (the Item 1 regression the final review caught:
  // every OTHER host's next beginFieldFrame call threw once this one ran).
  const requests: FieldRequest[] = Array.from({ length: n }, (_, i) => ({
    spec: specForField(i, distinct.value), w: FIELD_SIZE, h: FIELD_SIZE, t: timeSec, fps: BENCH_FPS,
  }))
  withFieldFrame(requests, (_frozenCount, token) => {
    for (let i = 0; i < n; i++) {
      const out = resolveField(requests[i]!, token)
      const st = fieldStates[i]
      if (!st || !out) continue
      const tb0 = performance.now()
      // No copy: bind resolveField's canvas DIRECTLY as the texture's image source —
      // see field.ts's resolveField ownership-contract doc. This IS the production
      // consumption pattern — deliberately NO forced-sync readback here (unlike
      // runSweep's benchmark-only equivalent below): forcing a synchronous GPU wait
      // every live frame would slow down real interactive rendering for no reason a
      // real consumer needs, since the browser's own pipeline/vsync handles
      // presentation timing. So this stat (`bindMs` in the live panel) measures only
      // the trivial property assignment and should read near-zero — it is NOT
      // comparable to the sweep table's `bindMs` column, which deliberately includes
      // a forced sync for honest measurement.
      st.texture.image = out
      st.texture.needsUpdate = true
      bindAccum += performance.now() - tb0
      st.mesh.rotation.y += 0.012
    }
  })

  renderer.render(scene, camera)

  // CPU submit time only — how long it took shaderFx.render/the bind loop to RETURN,
  // not how long the GPU took to finish. Still useful for isolating "we're
  // submitting too much work" from "the GPU can't keep up", but must not drive fps.
  const cpuMs = performance.now() - t0

  if (warmupRemaining > 0) {
    warmupRemaining--
  } else {
    pushRolling(frameTimes, cpuMs)
    pushRolling(bindTimes, bindAccum)
  }

  const wallAvg = avg(wallTimes)
  const wallFps = wallAvg > 0 ? 1000 / wallAvg : 0
  stats.value = {
    cpuMs: avg(frameTimes),
    bindMs: avg(bindTimes),
    wallMs: wallAvg,
    fps: wallFps,
  }

  // Capture the fields=0 vsync-ceiling baseline exactly once — the first time the
  // wall-clock window fills post-warmup while fields=0. Never recaptured after
  // that, even if the user revisits fields=0 later.
  if (baselineFps.value == null && fieldsCount.value === 0 && warmupRemaining <= 0 && wallTimes.length >= FRAME_WINDOW) {
    baselineFps.value = wallFps
  }
}

// --- rAF-independent sweep -------------------------------------------------
// The on-screen loop() above depends on requestAnimationFrame, which browsers
// pause in hidden/backgrounded tabs — a Browser pane driven headlessly may never
// tick it at all, leaving every on-screen readout stuck at 0.00. This path takes
// the alternative measurement directly: run the pipeline SWEEP_ITERATIONS times
// per field count with an explicit GPU sync each iteration (so it measures
// completed work, not submission — the same trap the CPU-submit timer fell into),
// and return the numbers as a value instead of rendering them to the DOM.

/** 'distinct' = every field genuinely different (Task 0's own methodology — the
 *  regime `LIVE_FIELD_CEILING` is calibrated against); 'shared' = every field the
 *  same descriptor, so per-frame batching legitimately collapses them to far fewer
 *  renders. Carried on every row so a number can never be read without its regime —
 *  see the SweepOptions/mode fix in the Task 3 report addendum for why this exists:
 *  `window.__benchSweep()` used to have no way to select or report which regime
 *  produced a given row, so a caller who didn't also check the on-page checkbox
 *  (which the headless hook doesn't read unless told to) could silently read the
 *  batched 'shared' numbers while believing they were the animated worst case. */
interface SweepRow {
  fields: number; mode: 'distinct' | 'shared'
  msPerIteration: number; msPerField: number; msPerRender: number
  /** Time spent binding + forcing this field's result to materialise: the (trivial)
   *  `texture.image = out; texture.needsUpdate = true` assignment, PLUS a
   *  single-pixel `getImageData` readback on `out` itself (not a copy into a second
   *  canvas — see the forced-sync comment where this is measured, in `runSweep`).
   *  That readback is NOT optional: shaderFx renders on its own separate WebGL2
   *  context, so this sweep's `gl.finish()` (which only syncs the THREE renderer's
   *  own context) doesn't wait for it on its own — omitting the readback was tried
   *  and measured a ~20x-too-fast, methodologically broken number. This is smaller
   *  than what the OLD copy-into-a-second-canvas step cost (15-23ms at 4 fields,
   *  ~68% of iteration time — see the Task 3 report's earlier addenda) but is NOT
   *  ~0 either, unlike the live on-screen loop()'s equivalent stat (which skips this
   *  forced sync entirely, matching what production actually does — see loop()'s
   *  own comment). */
  bindMs: number
  renders: number
  /** field.ts's SEPARATE input-tile cache (keyed on input+size, not time) — the
   *  evidence that an animated field's time-invariant `spec.input` is being
   *  rasterised once and reused, not re-rasterised every frame. Every field in this
   *  bench shares one `baseFillSpec`, so `tileHits` should approach
   *  `fields * timedIterations - 1` (every request after the very first hits) even
   *  in 'distinct' mode, where `renders` itself scales with `fields`. */
  tileHits: number; tileMisses: number
}

interface SweepOptions {
  /** Defaults to the on-page "distinct descriptors" checkbox when omitted, so the
   *  existing "Run sweep" button's behaviour is unchanged. Pass explicitly for a
   *  headless/programmatic call, where there is no checkbox to read. */
  distinct?: boolean
}

const SWEEP_ITERATIONS = 60
const SWEEP_WARMUP = 10

const sweepRows = ref<SweepRow[] | null>(null)
const sweepRunning = ref(false)
const sweepError = ref('')

/**
 * Guarded, synchronous-per-iteration sweep. Returns rows in FIELD_OPTIONS order
 * (0 first, so its msPerIteration is available as the baseline for the rest).
 *
 * `t` MUST advance one host frame (1/BENCH_FPS) per iteration, not sit still. An
 * earlier version used `t0 / 1000` (wall time at measurement start) as `t`, which on
 * a synchronous, no-await loop barely moves between iterations — after iteration 1
 * every `resolveField` call landed on the SAME quantized time bucket as the one
 * before it, so every iteration from #2 onward was a cache HIT, not a render. That
 * reported ~0.1ms/field (a cache lookup) instead of the ~1.2-3.6ms/field a genuinely
 * animated field costs (Task 0's number, which this sweep exists to reproduce and
 * which LIVE_FIELD_CEILING in descriptor.ts is calibrated against). Advancing `t`
 * deterministically by the frame interval reproduces the real animated case: every
 * iteration is a fresh `quantizeTime` bucket, so every iteration must re-render.
 *
 * The field cache is cleared once at the START of each field-count block (not inside
 * the timed loop — that would reintroduce shader-compile jitter the warmup exists to
 * absorb; clearing only drops cache entries + counters, not compiled GL programs).
 * Without this, every block replays the exact same `t` sequence (0, 1/60, 2/60, ...)
 * as every other block, so block N's iteration K would cache-HIT on block (N-1)'s
 * identical (spec, t) pair left in the cache — silently making later rows look
 * cheaper than they are.
 *
 * Even with the above fixed, `renders` (and therefore `msPerField`) still depends on
 * whether fields share one descriptor or are each distinct — that's a REAL
 * difference, not a bug, but a caller who doesn't also know which regime produced a
 * number can draw the wrong conclusion from it (this is exactly the failure the
 * coordinator caught: the default 'shared' regime reads as "fills are ~4x cheaper
 * than they are" if read as the animated worst case). So the regime is now an
 * explicit parameter with every row tagged by `mode`, and `msPerRender` — total timed
 * wall-ms divided by the ACTUAL render count — is reported alongside `msPerField`
 * specifically because it means the same thing in both regimes, where `msPerField`
 * does not (it silently changes meaning as `renders` diverges from `fields`).
 */
async function runSweep(opts: SweepOptions = {}): Promise<SweepRow[] | { error: string }> {
  if (!effectDef || !renderer || !scene || !camera || fieldStates.length < MAX_FIELDS) {
    return { error: 'not ready' }
  }
  const useDistinct = opts.distinct ?? distinct.value
  const mode: SweepRow['mode'] = useDistinct ? 'distinct' : 'shared'
  const rendererInst = renderer
  const sceneInst = scene
  const cameraInst = camera
  const gl = rendererInst.getContext()

  const rows: SweepRow[] = []
  let baselineMs = 0

  for (const n of FIELD_OPTIONS) {
    clearFieldCache()
    const iterMs: number[] = []
    const bindMsArr: number[] = []
    // Snapshot fieldStats() at the warmup/timed boundary so every reported count
    // covers exactly the same population as msPerIteration/bindMs (the post-warmup
    // iterations only) — a row's counts and its timings can never silently refer to
    // different work.
    let rendersAtTimedStart = 0
    let tileHitsAtTimedStart = 0
    let tileMissesAtTimedStart = 0

    for (let iter = 0; iter < SWEEP_ITERATIONS; iter++) {
      if (iter === SWEEP_WARMUP) {
        const s = fieldStats()
        rendersAtTimedStart = s.renders
        tileHitsAtTimedStart = s.tileHits
        tileMissesAtTimedStart = s.tileMisses
      }

      // Everything inside this loop body is synchronous — no await — so the
      // timer below reflects real work, not event-loop scheduling.
      const t0 = performance.now()
      let bindAccum = 0
      const timeSec = iter / BENCH_FPS

      const requests: FieldRequest[] = Array.from({ length: n }, (_, i) => ({
        spec: specForField(i, useDistinct), w: FIELD_SIZE, h: FIELD_SIZE, t: timeSec, fps: BENCH_FPS,
      }))
      // withFieldFrame owns the begin/end pairing in a try/finally — see its doc in
      // ~/lib/shaderfill/field.ts. This sweep used to call beginFieldFrame with no
      // matching endFieldFrame per iteration (the Item 1 regression: iteration 2
      // threw on re-entry).
      withFieldFrame(requests, (_frozenCount, token) => {
        for (let i = 0; i < n; i++) {
          const out = resolveField(requests[i]!, token)
          const st = fieldStates[i]
          if (!st || !out) continue
          const tb0 = performance.now()
          // No copy: bind resolveField's canvas DIRECTLY as the texture's image
          // source (the production consumption pattern — see resolveField's ownership
          // doc). The read below is NOT a copy — no second canvas, no drawImage into a
          // separate destination — it is a forced-materialise readback on `out` itself,
          // and it is NOT optional measurement overhead:
          //
          // shaderFx renders on its OWN WebGL2 context, separate from this bench's
          // THREE.WebGLRenderer context. `gl.finish()` below only blocks until commands
          // submitted to the context it's called ON have completed — it has no
          // visibility into shaderFx's separate context's queue. An earlier version of
          // this fix dropped the forced sync entirely (reasoning that the texture
          // upload inside renderer.render() would force resolution as a side effect),
          // and measured ~0.25ms/render — a ~20x drop that turned out to be a false
          // reading: the sweep was measuring command SUBMISSION, not completed work,
          // the exact trap the file's own long-standing comments already warn about.
          // Re-adding this single-pixel readback (on the canvas we already have, not a
          // new one) forces shaderFx's context to actually finish before we time it,
          // and the number came back up to something plausible. Confirmed via a live
          // A/B on the running bench before keeping this — see the Task 3 report.
          st.texture.image = out
          st.texture.needsUpdate = true
          out.getContext('2d')!.getImageData(0, 0, 1, 1)
          bindAccum += performance.now() - tb0
        }
      })

      rendererInst.render(sceneInst, cameraInst)
      // Force a GPU sync so the timer reflects completed work, not submission.
      gl.finish()

      const ms = performance.now() - t0
      if (iter >= SWEEP_WARMUP) {
        iterMs.push(ms)
        bindMsArr.push(bindAccum)
      }
    }

    const msPerIteration = avg(iterMs)
    const bindMs = avg(bindMsArr)
    if (n === 0) baselineMs = msPerIteration
    const msPerField = n === 0 ? 0 : (msPerIteration - baselineMs) / n
    const finalStats = fieldStats()
    const renders = finalStats.renders - rendersAtTimedStart
    const tileHits = finalStats.tileHits - tileHitsAtTimedStart
    const tileMisses = finalStats.tileMisses - tileMissesAtTimedStart
    // Total timed wall-ms (not the baseline-subtracted delta msPerField uses) divided
    // by the actual render count — checkbox/regime-independent, unlike msPerField.
    const totalTimedMs = iterMs.reduce((a, b) => a + b, 0)
    const msPerRender = renders > 0 ? totalTimedMs / renders : 0
    rows.push({ fields: n, mode, msPerIteration, msPerField, msPerRender, bindMs, renders, tileHits, tileMisses })

    // Yield ONLY between field counts (never inside the timed region above) so a
    // ~5-20s sweep doesn't block the page/tab for one long uninterrupted stretch.
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  return rows
}

/**
 * Content probe (controller verification, not part of the benchmark).
 *
 * A blank canvas costs roughly as much to render/bind as a real one, so the timings
 * alone cannot tell a working pipeline from one where resolveField silently produced
 * nothing. This runs a single field through resolveField and reports pixel
 * statistics for both the input fill it rasterised and the canvas it returned —
 * inspected DIRECTLY, no copy (see the ownership-contract doc on resolveField) —
 * non-zero `spread` on both means real work.
 */
function runProbe(): unknown {
  const def = effectDef, st = fieldStates[0]
  if (!def || !st) return { error: 'not ready' }

  clearFieldCache()
  const req: FieldRequest = { spec: specForField(0, distinct.value), w: FIELD_SIZE, h: FIELD_SIZE, t: 1.234, fps: BENCH_FPS }
  // withFieldFrame owns the begin/end pairing in a try/finally — see its doc in
  // ~/lib/shaderfill/field.ts.
  return withFieldFrame([req], (_frozenCount, token) => {
    const out = resolveField(req, token)
    if (!out) return { error: 'resolveField returned null' }

    // Independently rebuild the same input tile resolveField rasterised internally,
    // purely for this probe's own reporting (resolveField doesn't expose it).
    const inputTile = fillTileBox(baseFillSpec, FIELD_SIZE, FIELD_SIZE)

    const stats = (c: HTMLCanvasElement, label: string) => {
      const x = c.getContext('2d')
      if (!x) return { label, err: 'no 2d context' }
      const d = x.getImageData(0, 0, c.width, c.height).data
      let mn = 255, mx = 0, sum = 0, n = 0, opaque = 0
      for (let i = 0; i < d.length; i += 4 * 401) {
        const v = d[i]!
        mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; n++
        if (d[i + 3]! > 0) opaque++
      }
      return { label, w: c.width, h: c.height, min: mn, max: mx, mean: +(sum / n).toFixed(1), spread: mx - mn, opaquePct: +(100 * opaque / n).toFixed(1) }
    }

    return {
      effect: def.id,
      inputFill: stats(inputTile, 'input fill (shader source)'),
      field: stats(out, 'field canvas (resolveField result, direct — no copy)'),
    }
  })
}

/**
 * Batching proof (controller verification — the load-bearing claim of the whole
 * design). Three cases, each isolated by a `clearFieldCache()` so their render
 * counts (via field.ts's `fieldStats()`) can't cross-contaminate:
 *
 *  1. IDENTICAL descriptors, same `t` — N consumers sharing one shader fill at one
 *     moment in time. Must collapse to exactly 1 render no matter how large N is.
 *  2. DISTINCT descriptors, same `t` — N genuinely different fields. Must issue N
 *     renders — proves the cache isn't over-collapsing unrelated requests too.
 *  3. IDENTICAL (frozen, speed:0) descriptor, N DIFFERENT `t` values — a single
 *     shader fill with `speed: 0`, requested at N different moments (e.g. N frames
 *     of an animation, or N shapes each polling at a slightly different time). Must
 *     ALSO collapse to 1 render, because fieldKey drops time entirely when
 *     speed === 0 (descriptor.ts) — this is the "genuinely cached, not by accident"
 *     case: unlike case 1, the requests here are NOT identical (their `t` differs),
 *     so this demonstrates the frozen-field cache path specifically rather than
 *     riding along on case 1's same-t coincidence.
 */
function runBatch(): unknown {
  if (!effectDef) return { error: 'not ready' }
  const n = MAX_FIELDS
  const t = 0.5
  const mk = (params: Record<string, number>, speed = 1, tOverride = t): FieldRequest => ({
    spec: { effectId: effectDef!.id, params, anchor: 'object', speed, seed: 42, input: baseFillSpec },
    w: FIELD_SIZE, h: FIELD_SIZE, t: tOverride, fps: BENCH_FPS,
  })

  // withFieldFrame owns the begin/end pairing in a try/finally for each of the three
  // isolated cases below — see its doc in ~/lib/shaderfill/field.ts.
  clearFieldCache()
  const identicalReqs = Array.from({ length: n }, () => mk({}))
  withFieldFrame(identicalReqs, (_frozenCount, token) => {
    for (const r of identicalReqs) resolveField(r, token)
  })
  const identicalRenders = fieldStats().renders

  clearFieldCache()
  const distinctReqs = Array.from({ length: n }, (_, i) => mk(paramOverridesForIndex(i, n)))
  withFieldFrame(distinctReqs, (_frozenCount, token) => {
    for (const r of distinctReqs) resolveField(r, token)
  })
  const distinctRenders = fieldStats().renders

  clearFieldCache()
  // Same descriptor every time EXCEPT `t`, which is different for every request —
  // if this collapses to 1 render it can only be because speed:0 made fieldKey
  // ignore `t`, not because the requests happened to be identical.
  const frozenReqs = Array.from({ length: n }, (_, i) => mk({}, 0, i * 0.37))
  withFieldFrame(frozenReqs, (_frozenCount, token) => {
    for (const r of frozenReqs) resolveField(r, token)
  })
  const frozenRenders = fieldStats().renders

  clearFieldCache()
  return {
    n,
    identicalRenders,   // must be 1 regardless of n (same descriptor, same t)
    distinctRenders,    // must equal n (n genuinely distinct descriptors)
    frozenRenders,      // must be 1 (same descriptor, speed:0, n DIFFERENT t values)
    pass: identicalRenders === 1 && distinctRenders === n && frozenRenders === 1,
  }
}

/**
 * Bake-ceiling proof (Task 10 — a real correctness bug found in review). Before the
 * fix, `beginFieldFrame` ran bake requests through the SAME `planFields`/
 * LIVE_FIELD_CEILING as live ones, so any export of a scene with more than
 * LIVE_FIELD_CEILING distinct shader-fill descriptors silently froze the 5th-and-
 * beyond field at t=0 — independent of tab visibility, not a harness artefact.
 *
 * Builds `n` (> LIVE_FIELD_CEILING) genuinely distinct descriptors (different
 * effect params per field, via `specForField(i, true)`, the same helper the
 * distinct-mode sweep/batch use), resolves them at two different times under
 * `bake: true`, and reduces each result canvas to a coarse pixel-mean sample. The
 * ASSERTION that actually distinguishes "fixed" from "still broken" is per-field:
 * every one of the `n` fields must produce a DIFFERENT mean at t=2.5 than at t=0 —
 * not just the first LIVE_FIELD_CEILING. A same-descriptors control run with
 * `bake: false` is included specifically so "everything changed" isn't vacuously
 * true (e.g. because nothing in this build ever freezes): under live mode only the
 * first LIVE_FIELD_CEILING fields should change; the rest must read IDENTICAL
 * between the two times, proving the ceiling itself is real and it is bake
 * specifically that is exempt from it, not that freezing never happens at all.
 */
function runBakeCeilingProof(): unknown {
  if (!effectDef) return { error: 'not ready' }
  const n = 6
  const meanOf = (c: HTMLCanvasElement | null): number | null => {
    if (!c) return null
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let sum = 0, count = 0
    for (let i = 0; i < d.length; i += 4 * 97) { sum += d[i]!; count++ }
    return count > 0 ? +(sum / count).toFixed(3) : null
  }
  // i+1, not i: paramOverridesForIndex(0, ...) lands the effect's first param at its
  // literal MIN (e.g. fbm_warp's `amount: 0`), which for a warp-amount-style param
  // can legitimately make the field time-INVARIANT regardless of the ceiling fix —
  // a confound, not a freeze. Starting at 1 keeps every field's param away from that
  // edge so "did the pixels change" actually tests liveness, not a coincidence of
  // which param value index 0 happens to draw.
  const resolveAll = (bake: boolean, t: number): (number | null)[] => {
    const reqs: FieldRequest[] = Array.from({ length: n }, (_, i) => ({
      spec: specForField(i + 1, true), w: FIELD_SIZE, h: FIELD_SIZE, t, fps: BENCH_FPS, bake,
    }))
    // withFieldFrame owns the begin/end pairing in a try/finally — see its doc in
    // ~/lib/shaderfill/field.ts.
    return withFieldFrame(reqs, (_frozenCount, token) => reqs.map(r => meanOf(resolveField(r, token))))
  }

  clearFieldCache()
  const bakeAt0 = resolveAll(true, 0)
  const bakeAt2 = resolveAll(true, 2.5)
  const bakeChanged = bakeAt0.map((m, i) => m != null && bakeAt2[i] != null && m !== bakeAt2[i])

  clearFieldCache()
  const liveAt0 = resolveAll(false, 0)
  const liveAt2 = resolveAll(false, 2.5)
  const liveChanged = liveAt0.map((m, i) => m != null && liveAt2[i] != null && m !== liveAt2[i])

  clearFieldCache()
  return {
    n, ceiling: LIVE_FIELD_CEILING,
    bakeAt0, bakeAt2, bakeChanged,
    liveAt0, liveAt2, liveChanged,
    pass: bakeChanged.every(Boolean) &&
      liveChanged.slice(0, LIVE_FIELD_CEILING).every(Boolean) &&
      liveChanged.slice(LIVE_FIELD_CEILING).every(v => v === false),
  }
}

// `samplePixels`/`runPoolCheck` (and `window.__benchPoolCheck`) were removed along
// with field.ts's output-canvas pool: the pool measured no benefit and made direct
// texture binding unsafe (a consumer holding a reference across an LRU eviction
// could have its texture silently start showing a different descriptor's pixels the
// moment the recycled canvas got reused) — see field.ts's `resolveField` doc and the
// Task 3 report's later addenda for the full history. Nothing pools evicted canvases
// anymore, so there is nothing left for that check to exercise.

async function onRunSweepClick(): Promise<void> {
  sweepRunning.value = true
  sweepError.value = ''
  try {
    const res = await runSweep()
    if ('error' in res) sweepError.value = res.error
    else sweepRows.value = res
  } catch (e) {
    sweepError.value = String(e)
    console.error('[shaderfill-bench] sweep failed', e)
  } finally {
    sweepRunning.value = false
  }
}

onMounted(async () => {
  try {
    const catalog = await fetchShaderFxCatalog()
    const preferred = catalog.effects.find(e => e.id === PREFERRED_EFFECT_ID)
    const fallback = catalog.effects.find(e => e.generative)
    effectDef = preferred ?? fallback ?? catalog.effects[0] ?? null
    if (!effectDef) {
      status.value = 'no effects in catalog — cannot run bench'
      return
    }
    effectId.value = effectDef.id
    status.value = ''

    if (!canvasEl.value) {
      status.value = 'canvas ref missing — cannot init renderer'
      return
    }
    renderer = new THREE.WebGLRenderer({ canvas: canvasEl.value, antialias: true })
    renderer.setSize(CANVAS_W, CANVAS_H, false)
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x111111)
    camera = new THREE.OrthographicCamera(-3, 3, 1.5, -1.5, 0.1, 100)
    camera.position.z = 5
    camera.lookAt(0, 0, 0)

    buildFieldStates()
    layoutFields()

    // Register the rAF-independent sweep once the renderer + fields it depends on
    // exist. Callable straight from a hidden/backgrounded Browser pane, where the
    // rAF loop below never ticks.
    ;(window as any).__benchSweep = runSweep
    ;(window as any).__benchProbe = runProbe
    ;(window as any).__benchBatch = runBatch
    ;(window as any).__benchBakeCeilingProof = runBakeCeilingProof
    // Raw cumulative { renders, hits, misses } since the last clearFieldCache() —
    // exposed directly (not just baked into __benchSweep/__benchBatch's return
    // values) so cache behaviour can be inspected from the console mid-session,
    // e.g. between manual control changes, without needing a whole sweep/batch run.
    ;(window as any).__benchFieldStats = fieldStats

    startedAt = performance.now()
    raf = requestAnimationFrame(loop)
  } catch (e) {
    // Any init failure (catalog fetch, WebGL context creation, etc.) lands here
    // instead of becoming an unhandled rejection out of an async onMounted —
    // which Vue would otherwise only surface as an opaque scheduler-flush warning.
    status.value = `init failed: ${e}`
    console.error('[shaderfill-bench] init failed', e)
  }
})

onBeforeUnmount(() => {
  delete (window as any).__benchSweep
  delete (window as any).__benchProbe
  delete (window as any).__benchBatch
  delete (window as any).__benchBakeCeilingProof
  delete (window as any).__benchFieldStats
  clearFieldCache()
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  for (const st of fieldStates) {
    st.texture.dispose()
    ;(st.mesh.material as THREE.Material).dispose()
    st.mesh.geometry.dispose()
  }
  renderer?.dispose()
  renderer = null
})
</script>

<style scoped>
.bench { padding: 16px; font: 13px ui-monospace, monospace; color: #ddd; background: #111; min-height: 100vh }
h1 { font-size: 15px; margin: 0 0 4px }
.note { color: #888; margin: 0 0 12px; max-width: 80ch; line-height: 1.5 }
.controls { display: flex; gap: 20px; align-items: center; margin-bottom: 12px; flex-wrap: wrap }
.group { display: flex; gap: 6px; align-items: center }
.label { color: #999 }
.hint { color: #666; font-size: 11px }
button { background: #222; color: #ddd; border: 1px solid #444; padding: 4px 10px; cursor: pointer; font: inherit }
button.active { background: #2a5; color: #000; border-color: #2a5; font-weight: 700 }
.status { color: #fa0 }
.stats { display: flex; gap: 18px; margin-bottom: 8px; flex-wrap: wrap }
.stat { display: flex; flex-direction: column; background: #161616; border: 1px solid #333; padding: 6px 12px; min-width: 110px }
.stat .k { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: .04em }
.stat .v { color: #fff; font-size: 16px; font-weight: 700 }
.stat .v.bad { color: #f66 }
.verdict { color: #fd0; font-weight: 700; margin: 0 0 10px }
.pass-note { color: #9c9; max-width: 80ch; line-height: 1.5; margin: 0 0 14px }
button.run-sweep { background: #57a; color: #fff; border-color: #57a }
button.run-sweep:disabled { background: #444; color: #888; border-color: #444 }
.sweep-error { color: #f66; margin: 0 0 10px }
.sweep-table { border-collapse: collapse; margin: 0 0 14px }
.sweep-table th, .sweep-table td { border: 1px solid #333; padding: 3px 9px; text-align: right }
.sweep-table th { background: #1c1c1c; color: #999; font-weight: 600 }
.stage { display: block; background: #000; border: 1px solid #333 }
code { color: #9cf }
</style>
