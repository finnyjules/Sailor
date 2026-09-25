<script setup lang="ts">
// Dev-only evaluation of the shader-generation engine (AI in Sailor spec §7, build
// stage 1). Per request: the hand-written spike takes, then the real engine on
// Sonnet 5 and Haiku 4.5. Nothing calls the paid API until Run is pressed AND
// confirmed. Click a tile to mark it a keeper; "Copy results" exports everything.
definePageMeta({ layout: false })
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import type { GenTake } from '~~/shared/shadergen/contract'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import type { EffectDef } from '~/lib/shaderfx/types'
import { EVAL_REQUESTS, type EvalRequest } from '~/lib/shadergen/__eval__/requests'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { createBrowserTakeRenderer } from '~/lib/shadergen/browserRenderer'
import { makeCallModel, makeReview } from '~/lib/shadergen/client'
import { generateTakes, type EngineInput, type EngineResult, type TakeRenderer } from '~/lib/shadergen/engine'
import type { GenBase, GenRequest } from '~/lib/shadergen/prompt'

type RowId = 'spike' | 'plan' | 'patch'
interface Tile { take: GenTake; thumbnail: string; flags: string[]; compiled: boolean; calls: number | null; keep: boolean; log: string[] }
interface Row { status: 'idle' | 'running' | 'done' | 'error'; tiles: Tile[]; failures: number; dropped: number; ms: number; tokensIn: number; tokensOut: number; error: string }

type VariantId = 'A' | 'B' | 'C' | 'D' | 'E'
const VARIANT_LABELS: Record<VariantId, string> = {
  A: 'A · Sonnet, thinking high',
  B: 'B · Opus 5.5 (the product setting), effort high',
  C: 'C · Sonnet + photo + examples',
  D: 'D · Sonnet + look and revise',
  E: 'E · Opus 5.5 (the product setting), effort high + photo + examples + look and revise',
}
const VARIANT_KEYS = ['A', 'B', 'C', 'D', 'E'] as const
/** A and B were already run; C, D, E are the levers still worth trying. */
const variantSelected = reactive<Record<VariantId, boolean>>({ A: false, B: false, C: true, D: true, E: true })
const selectedVariants = computed(() => VARIANT_KEYS.filter(id => variantSelected[id]))
/** Only the two requests the quality-variants section evaluates. */
const VARIANT_REQUESTS = EVAL_REQUESTS.filter(r => r.key === 'rain' || r.key === 'ink')

const ROWS: { id: RowId; label: string }[] = [
  { id: 'spike', label: 'Spike (hand-written)' },
  { id: 'plan', label: 'Sonnet 5' },
  { id: 'patch', label: 'Haiku 4.5' },
]
const emptyRow = (): Row => ({ status: 'idle', tiles: [], failures: 0, dropped: 0, ms: 0, tokensIn: 0, tokensOut: 0, error: '' })
const rows = reactive<Record<string, Record<RowId, Row>>>(
  Object.fromEntries(EVAL_REQUESTS.map(r => [r.key, { spike: emptyRow(), plan: emptyRow(), patch: emptyRow() }])),
)

const variantRows = reactive<Record<string, Record<VariantId, Row>>>(
  Object.fromEntries(VARIANT_REQUESTS.map(r => [r.key, { A: emptyRow(), B: emptyRow(), C: emptyRow(), D: emptyRow(), E: emptyRow() }])),
)

const { getLocalSetting } = useLocalSettings()
const apiKey = computed(() => getLocalSetting('Sailor.AI.AnthropicApiKey') ?? '')
const ready = ref(false)
const armed = ref(false)
const running = ref(false)
const variantArmed = ref(false)
const variantRunning = ref(false)
const copied = ref(false)
const loadError = ref('')
const catalog = shallowRef<EffectDef[]>([])
/** The test photo at its natural size, for variant C's attached-image call. */
const photo = ref('')
let renderer: TakeRenderer | null = null

/** Variant C's "quality bar" examples: finished spike takes from OTHER
 *  requests than the one being generated, each with its own request text. */
function examplesFor(key: string): GenRequest['examples'] {
  const promptFor = (k: string) => EVAL_REQUESTS.find(r => r.key === k)!.prompt
  if (key === 'rain') {
    return [
      { name: 'ink', request: promptFor('ink'), take: SPIKE_TAKES.ink![3]! },
      { name: 'lava', request: promptFor('lava'), take: SPIKE_TAKES.lava![2]! },
    ]
  }
  if (key === 'ink') {
    return [
      { name: 'rain', request: promptFor('rain'), take: SPIKE_TAKES.rain![2]! },
      { name: 'lava', request: promptFor('lava'), take: SPIKE_TAKES.lava![2]! },
    ]
  }
  return []
}

function baseFor(id: string | null): GenBase | null {
  if (!id) return null
  const e = catalog.value.find(x => x.id === id)
  return e ? { name: e.name, source: e.source, params: e.params as GenBase['params'] } : null
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/** Flags as display text: the first letter capitalised (data-flags keeps them raw). */
function flagText(flags: string[]): string {
  const s = flags.join(' · ')
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Checks pass'
}

onMounted(async () => {
  try {
    const [img, cat] = await Promise.all([loadImage('/house-styles/azure-bloom/thumb-2.webp'), fetchShaderFxCatalog()])
    catalog.value = cat.effects
    renderer = createBrowserTakeRenderer(img)
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d')!.drawImage(img, 0, 0)
    photo.value = c.toDataURL('image/jpeg', 0.85)
  } catch (e) {
    loadError.value = `Couldn't load the test image or the effect catalog: ${String((e as Error)?.message ?? (e instanceof Event ? `${e.type} event` : e))}`
    return
  }
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]!.spike
    row.tiles = (SPIKE_TAKES[r.key] ?? []).map((take): Tile => {
      const err = renderer!.compile(take)
      if (err) return { take, thumbnail: '', flags: ['compile error'], compiled: false, calls: null, keep: false, log: [] }
      const j = renderer!.judge(take)
      return { take, thumbnail: j.thumbnail, flags: j.flags, compiled: true, calls: null, keep: false, log: [] }
    })
    row.status = 'done'
  }
  ready.value = true
})

function fill(row: Row, res: EngineResult) {
  row.tiles = res.takes.map(t => ({ take: t.take, thumbnail: t.thumbnail, flags: t.flags, compiled: true, calls: t.modelCalls, keep: false, log: t.log }))
  row.failures = res.failures.length
  row.dropped = res.dropped
  row.ms = res.ms
  row.tokensIn = res.usage.input_tokens
  row.tokensOut = res.usage.output_tokens
  row.status = 'done'
}

async function runTier(tier: 'plan' | 'patch') {
  const deps = { callModel: makeCallModel(apiKey.value, tier), review: makeReview(apiKey.value), renderer: renderer! }
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]![tier]
    row.status = 'running'
    row.error = ''
    try {
      const references = (r.references ?? []).map(baseFor).filter((b): b is GenBase => !!b)
      fill(row, await generateTakes({ request: r.prompt, base: baseFor(r.base), references }, deps))
    } catch (e) {
      row.status = 'error'
      row.error = String((e as Error)?.message ?? e)
    }
  }
}

async function run() {
  // Either run can call the paid API; never let both fire at once, and arming
  // one disarms the other so a stray click can't confirm the wrong run.
  if (running.value || variantRunning.value) return
  if (!armed.value) { armed.value = true; variantArmed.value = false; return }
  armed.value = false
  running.value = true
  try { await Promise.all([runTier('plan'), runTier('patch')]) } finally { running.value = false }
}

/** deps/input for one quality-variant lever (spec follow-on: A–E). */
function depsAndInputFor(id: VariantId, r: EvalRequest): { deps: { callModel: ReturnType<typeof makeCallModel>; review: ReturnType<typeof makeReview>; renderer: TakeRenderer }; input: EngineInput } {
  const references = (r.references ?? []).map(baseFor).filter((b): b is GenBase => !!b)
  const base: EngineInput = { request: r.prompt, base: baseFor(r.base), references }
  const review = makeReview(apiKey.value)
  if (id === 'A') return { deps: { callModel: makeCallModel(apiKey.value, 'plan', { effort: 'high' }), review, renderer: renderer! }, input: base }
  if (id === 'B') return { deps: { callModel: makeCallModel(apiKey.value, 'shader', { effort: 'high' }), review, renderer: renderer! }, input: base }
  if (id === 'C') return { deps: { callModel: makeCallModel(apiKey.value, 'plan'), review, renderer: renderer! }, input: { ...base, images: [photo.value], examples: examplesFor(r.key) } }
  if (id === 'D') return { deps: { callModel: makeCallModel(apiKey.value, 'plan'), review, renderer: renderer! }, input: { ...base, revise: true } }
  return { deps: { callModel: makeCallModel(apiKey.value, 'shader', { effort: 'high' }), review, renderer: renderer! }, input: { ...base, images: [photo.value], examples: examplesFor(r.key), revise: true } }
}

async function runVariant(id: VariantId) {
  for (const r of VARIANT_REQUESTS) {
    const row = variantRows[r.key]![id]
    row.status = 'running'
    row.error = ''
    try {
      const { deps, input } = depsAndInputFor(id, r)
      fill(row, await generateTakes(input, deps))
    } catch (e) {
      row.status = 'error'
      row.error = String((e as Error)?.message ?? e)
    }
  }
}

async function runVariants() {
  if (running.value || variantRunning.value || selectedVariants.value.length === 0) return
  if (!variantArmed.value) { variantArmed.value = true; armed.value = false; return }
  variantArmed.value = false
  variantRunning.value = true
  try {
    // One at a time (not Promise.all), to stay well inside rate limits, in order A→E.
    for (const id of selectedVariants.value) await runVariant(id)
  } finally {
    variantRunning.value = false
  }
}

const variantTally = computed(() => Object.fromEntries(VARIANT_KEYS.map((id) => {
  let keep = 0, total = 0, failures = 0
  for (const r of VARIANT_REQUESTS) {
    const row = variantRows[r.key]![id]
    total += row.tiles.length
    keep += row.tiles.filter(t => t.keep).length
    failures += row.failures
  }
  return [id, { keep, total, failures }]
})) as Record<VariantId, { keep: number; total: number; failures: number }>)

const tally = computed(() => Object.fromEntries(ROWS.map(({ id }) => {
  let keep = 0, total = 0, failures = 0
  for (const r of EVAL_REQUESTS) {
    const row = rows[r.key]![id]
    total += row.tiles.length
    keep += row.tiles.filter(t => t.keep).length
    failures += row.failures
  }
  return [id, { keep, total, failures }]
})) as Record<RowId, { keep: number; total: number; failures: number }>)

async function copyResults() {
  const requests = EVAL_REQUESTS.map(r => ({
    key: r.key, prompt: r.prompt, base: r.base, references: r.references ?? [],
    rows: Object.fromEntries(ROWS.map(({ id }) => {
      const row = rows[r.key]![id]
      return [id, {
        status: row.status, error: row.error, failures: row.failures, dropped: row.dropped,
        ms: row.ms, tokensIn: row.tokensIn, tokensOut: row.tokensOut,
        tiles: row.tiles.map(t => ({ name: t.take.name, keep: t.keep, flags: t.flags, calls: t.calls, params: t.take.params, body: t.take.body, log: t.log })),
      }]
    })),
  }))
  const variants = VARIANT_REQUESTS.map(r => ({
    key: r.key, prompt: r.prompt,
    rows: Object.fromEntries(VARIANT_KEYS.map((id) => {
      const row = variantRows[r.key]![id]
      return [id, {
        status: row.status, error: row.error, failures: row.failures, dropped: row.dropped,
        ms: row.ms, tokensIn: row.tokensIn, tokensOut: row.tokensOut,
        tiles: row.tiles.map(t => ({ name: t.take.name, keep: t.keep, flags: t.flags, calls: t.calls, params: t.take.params, body: t.take.body, log: t.log })),
      }]
    })),
  }))
  await navigator.clipboard.writeText(JSON.stringify({ requests, variants }, null, 2))
  copied.value = true
}
</script>

<template>
  <main class="eval">
    <header>
      <h1>Shader generation: engine run</h1>
      <p>The six requests from the spike. The first row of each is the hand-written spike; the others are the real engine. Click a tile to mark it a keeper.</p>
      <div class="bar">
        <button type="button" :disabled="!ready || running || variantRunning" @click="run">
          {{ running ? 'Running…' : armed ? 'Confirm: this calls the paid API' : 'Run Sonnet 5 and Haiku 4.5' }}
        </button>
        <span v-if="!apiKey" class="note">No key in Settings → AI, so the server's key is used if it has one.</span>
        <button type="button" @click="copyResults">{{ copied ? 'Copied' : 'Copy results' }}</button>
        <span v-for="r in ROWS" :key="r.id" class="tally">
          {{ r.label }}: {{ tally[r.id].keep }} of {{ tally[r.id].total }} kept<template v-if="r.id !== 'spike'"> · {{ tally[r.id].failures }} failed</template>
        </span>
      </div>
      <p v-if="loadError" class="err" data-load-error>{{ loadError }}</p>
    </header>

    <section v-for="req in EVAL_REQUESTS" :key="req.key">
      <h2>“{{ req.prompt }}” <small>{{ req.base ? `from ${baseFor(req.base)?.name ?? req.base}` : 'from nothing' }}</small></h2>
      <div v-for="r in ROWS" :key="r.id" class="row" :data-row="r.id">
        <div class="rowhead">
          <strong>{{ r.label }}</strong>
          <span v-if="rows[req.key]![r.id].status === 'running'">Working…</span>
          <span v-else-if="rows[req.key]![r.id].status === 'error'" class="err">{{ rows[req.key]![r.id].error }}</span>
          <span v-else-if="r.id !== 'spike' && rows[req.key]![r.id].status === 'done'">
            {{ (rows[req.key]![r.id].ms / 1000).toFixed(1) }} s · {{ rows[req.key]![r.id].tokensIn }} in / {{ rows[req.key]![r.id].tokensOut }} out ·
            {{ rows[req.key]![r.id].failures }} failed · {{ rows[req.key]![r.id].dropped }} dropped by review
          </span>
        </div>
        <div class="tiles">
          <button
            v-for="(t, i) in rows[req.key]![r.id].tiles" :key="i" type="button" class="tile" :class="{ keep: t.keep }"
            data-tile :data-compiled="String(t.compiled)" :data-flags="t.flags.join(',')" @click="t.keep = !t.keep"
          >
            <img v-if="t.thumbnail" :src="t.thumbnail" :alt="t.take.name">
            <span v-else class="broken">Didn't compile</span>
            <span class="name">{{ t.take.name }}</span>
            <span class="meta">{{ flagText(t.flags) }}<template v-if="t.calls"> · {{ t.calls }} call{{ t.calls > 1 ? 's' : '' }}</template></span>
          </button>
        </div>
      </div>
    </section>

    <section data-section="variants">
      <h2>Quality variants</h2>
      <p>Five ways to close the gap with the spike, on two requests. Same rules as above: click keepers, then copy results.</p>
      <div class="bar picks">
        <label v-for="id in VARIANT_KEYS" :key="id" class="pick">
          <input :id="`variant-pick-${id}`" v-model="variantSelected[id]" type="checkbox">
          {{ VARIANT_LABELS[id] }}
        </label>
      </div>
      <div class="bar">
        <button type="button" :disabled="!ready || running || variantRunning || selectedVariants.length === 0" @click="runVariants">
          {{ variantRunning ? 'Running…' : variantArmed ? 'Confirm: this calls the paid API' : `Run variants ${selectedVariants.join(', ')} on rain and ink` }}
        </button>
        <span v-for="id in VARIANT_KEYS" :key="id" class="tally">
          {{ VARIANT_LABELS[id] }}: {{ variantTally[id].keep }} of {{ variantTally[id].total }} kept · {{ variantTally[id].failures }} failed
        </span>
      </div>

      <div v-for="req in VARIANT_REQUESTS" :key="req.key">
        <h3>“{{ req.prompt }}” <small>{{ req.base ? `from ${baseFor(req.base)?.name ?? req.base}` : 'from nothing' }}</small></h3>
        <div class="row" data-row="variant-spike">
          <div class="rowhead"><strong>Spike (hand-written)</strong></div>
          <div class="tiles">
            <button
              v-for="(t, i) in rows[req.key]!.spike.tiles" :key="i" type="button" class="tile" :class="{ keep: t.keep }"
              data-tile :data-compiled="String(t.compiled)" :data-flags="t.flags.join(',')" @click="t.keep = !t.keep"
            >
              <img v-if="t.thumbnail" :src="t.thumbnail" :alt="t.take.name">
              <span v-else class="broken">Didn't compile</span>
              <span class="name">{{ t.take.name }}</span>
              <span class="meta">{{ flagText(t.flags) }}</span>
            </button>
          </div>
        </div>
        <div v-for="id in VARIANT_KEYS" :key="id" class="row" :data-row="`variant-${id}`">
          <div class="rowhead">
            <strong>{{ VARIANT_LABELS[id] }}</strong>
            <span v-if="variantRows[req.key]![id].status === 'running'">Working…</span>
            <span v-else-if="variantRows[req.key]![id].status === 'error'" class="err">{{ variantRows[req.key]![id].error }}</span>
            <span v-else-if="variantRows[req.key]![id].status === 'done'">
              {{ (variantRows[req.key]![id].ms / 1000).toFixed(1) }} s · {{ variantRows[req.key]![id].tokensIn }} in / {{ variantRows[req.key]![id].tokensOut }} out ·
              {{ variantRows[req.key]![id].failures }} failed · {{ variantRows[req.key]![id].dropped }} dropped by review
            </span>
          </div>
          <div class="tiles">
            <button
              v-for="(t, i) in variantRows[req.key]![id].tiles" :key="i" type="button" class="tile" :class="{ keep: t.keep }"
              data-tile :data-compiled="String(t.compiled)" :data-flags="t.flags.join(',')" @click="t.keep = !t.keep"
            >
              <img v-if="t.thumbnail" :src="t.thumbnail" :alt="t.take.name">
              <span v-else class="broken">Didn't compile</span>
              <span class="name">{{ t.take.name }}</span>
              <span class="meta">{{ flagText(t.flags) }}<template v-if="t.calls"> · {{ t.calls }} call{{ t.calls > 1 ? 's' : '' }}</template></span>
            </button>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.eval { min-height: 100vh; background: #0e0f11; color: #ebe8e1; font: 14px/1.5 system-ui, sans-serif; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; }
header p { color: #8e8a83; margin: 0 0 12px; }
.bar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-bottom: 8px; }
.bar button { background: #1e1f23; color: inherit; border: 1px solid #34363c; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
.bar button:disabled { opacity: .5; cursor: default; }
.note, .tally { color: #8e8a83; font-size: 12.5px; }
.picks { margin-bottom: 4px; }
.pick { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #ebe8e1; }
section { border-top: 1px solid #2a2c31; margin-top: 24px; padding-top: 16px; }
h2 { font-size: 17px; font-weight: 500; margin: 0 0 10px; }
h2 small { color: #8e8a83; font-weight: 400; font-size: 12.5px; }
.row { margin-bottom: 12px; }
.rowhead { display: flex; gap: 12px; font-size: 12.5px; color: #8e8a83; margin-bottom: 6px; }
.rowhead strong { color: #ebe8e1; font-weight: 500; min-width: 150px; }
.err { color: #e2645a; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.tile { display: grid; gap: 4px; text-align: left; background: #17181b; border: 1px solid #2a2c31; border-radius: 8px; padding: 6px; color: inherit; cursor: pointer; }
.tile.keep { border-color: #7fbf8a; box-shadow: 0 0 0 1px #7fbf8a; }
.tile img, .broken { width: 100%; aspect-ratio: 1; border-radius: 5px; display: grid; place-items: center; background: #000; color: #e2645a; font-size: 12px; }
.name { font-size: 13px; }
.meta { font-size: 11.5px; color: #8e8a83; }
</style>
