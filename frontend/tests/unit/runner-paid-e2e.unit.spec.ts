/**
 * Step 3, Task R3.18: the controller check of stage R3 (paid-model nodes),
 * fixture-level.
 *
 * As R1.7 and R2.12 (runner-cards-e2e, runner-effects-e2e): the real routes
 * through h3 `toWebHandler` (POST /api/runs, the SSE stream
 * GET /api/runs/events); behind them the real engine, file run store, file
 * kept store and metering, hosted, with the kit's fake ledger, fake fal and
 * fake Replicate. The families come from the real `runnerFamilies()`:
 * NUXT_RUNNER_ENABLED=true and NUXT_RUNNER_FAMILIES=cards,llm-text,describe,
 * image-repair,layers,audio-gen,gen-3d,film-shot,image-extras,lora,
 * nano-extras,turntable, set in-process (never .env). No provider key is
 * read and nothing reaches the network.
 *
 * The fake providers answer from the committed Python fixtures, in Python's
 * call order: fixtures/runner-paid-e2e.json (scripts/runner_paid_fixtures.py
 * --group e2e: the chained workflows, node by node) and the single-node
 * cases of runner-paid-describe / -audio-gen / -gen-3d / -nano-extras.json.
 *
 * 1. Nine workflows, POST /api/runs to the last event. For each: the
 *    requests are Python's (deep-equal, and the wire text with R3.3 ruling
 *    1's whole-FLOAT rule), every value and file is Python's, the hold is the
 *    ceiling (Σ priceNode of the nodes as sent, the render credit when the
 *    graph has an output class; priceGraph agrees), the charge priceNode's
 *    figure for what ran, never above the hold.
 * 2. A failure injected mid-pipeline (Separate background and foreground,
 *    Restyle) charges the finished calls only; a restart mid-pipeline sends
 *    no call twice.
 * 3. Every R3 family off: the needs-engine list over every saved project
 *    against the code at 38b4a0672 (`git archive`): the lists that differ
 *    differ only by nodes no output reads (R3.8's pruning, a ruled
 *    difference), pinned in fixtures/runner-paid-e2e-needs-engine.json; the
 *    ComfyUI path's prices against the same commit, per class, pinned in
 *    fixtures/runner-paid-e2e-prices.json.
 *
 *    LIVE DATA: both pins are read from the saved projects in
 *    user/sailor/projects, which change as the app is used. When a project
 *    is added, edited or removed, the pins no longer match: look at the
 *    difference, then re-pin with
 *    `R318_PIN=1 npx vitest run tests/unit/runner-paid-e2e.unit.spec.ts -t "every R3 family off"`.
 * 4. The hosted refusals end to end, on the runner's route and the hosted
 *    ComfyUI meter (meterGraphSubmit, the /prompt gate).
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import sharp from 'sharp'
import { __setEngineForTests } from '~~/server/runner/index'
import { runnerFamilies } from '~~/server/runner/config'
import { _resetRateLimits } from '~~/server/lib/rateLimit'
import { BASE_RENDER_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { __setInputUploadsEngineRootForTests } from '~~/server/utils/inputUploads'
import { __setHuggingFaceLookupForTests, __setMultiLoraRotationForTests, multiLoraHfRef, multiLoraRotation } from '~~/server/runner/generators/lora'
import { answerUsage } from '~~/server/runner/generators/llm'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { MODERATION_BLOCKED_MESSAGE } from '~~/server/utils/moderation'
import startRoute from '~~/server/api/runs/index.post'
import eventsRoute from '~~/server/api/runs/events.get'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerMessage } from '#shared/runner/messages'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs } from '#shared/runner/validate'
import { parsePyJson, pyJsonDumps, type PyJson } from '#shared/runner/pyJson'
import { LORA_BY_NAME_HOSTED } from '#shared/runner/lora'
import { SPEECH_VOICE_NOT_OFFERED } from '#shared/runner/audioGen'
import { DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS } from '#shared/runner/describe'
import { GENERATE_3D_RUNNER_ONLY } from '#shared/runner/gen3d'
import { NANO_EXTRAS_CLASSES } from '#shared/runner/nanoExtras'
import { priceNode, type NodeInputs } from '#shared/pricing/nodePrice'
import { PAID_NODE_CLASSES, paidCalls, restyleLoraCalls } from '#shared/pricing/paidSettings'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { callCredits } from '#shared/pricing/pipelinePrice'
import { PRE_R3_FLAT } from '#shared/pricing/estimateFloor'
import { isRunnerDeclined } from '~~/app/lib/runner/client'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, until } from './__runner__/kit'
import type { PaidCase, PyCall } from './__runner__/paidParity'

// ── Fixtures ─────────────────────────────────────────────────────────────

interface Px { shape: number[]; sha256: string; px?: string }
type E2EStep = PaidCase & { made?: Record<string, Px>; loaded?: Record<string, Px> }
interface E2E {
  summarize_generate: { steps: E2EStep[] }
  split_frame: { steps: E2EStep[]; handed_on: { subject: Px; background: Px }; frame: Px & { widgets: Record<string, unknown> } }
  upscale_remove_save: { steps: E2EStep[]; handed_on: { upscaled: Px }; saved: Px }
  restyle_second: E2EStep
  multi_lora_image: E2EStep & { rotate: number; rotate_after: number }
}
const readFixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))
const FX = readFixture('runner-paid-e2e.json') as E2E
const caseOf = (file: string, name: string): PaidCase => {
  const c = (readFixture(file) as { cases: PaidCase[] }).cases.find(x => x.name === name)
  if (!c) throw new Error(`${file} has no case ${name}`)
  return c
}
const DESCRIBE = caseOf('runner-paid-describe.json', 'describe · default')
const MUSIC = caseOf('runner-paid-audio-gen.json', 'music · stereo-large 1 s')
const GEN3D = caseOf('runner-paid-gen-3d.json', 'generate 3d · defaults')
const NANO = readFixture('runner-paid-nano-extras.json') as { cases: PaidCase[]; baked: Record<string, string> }
const POSE = NANO.cases.find(c => c.name === 'pose · mannequin · baked result pose_result.png')!
const [SUMMARIZE, GENERATE] = FX.summarize_generate.steps as [E2EStep, E2EStep]
const [SPLIT] = FX.split_frame.steps as [E2EStep]
const [UPSCALE, REMOVE] = FX.upscale_remove_save.steps as [E2EStep, E2EStep]
const RESTYLE = FX.restyle_second
/**
 * LC1 (B5, the owed live checks): the multi-LoRA node sends a Hugging Face
 * reference bare (multiLoraHfRef), which the model takes and Python's
 * `huggingface.co/` form it refused. This flow's two LoRAs stay two.
 */
const MULTI = ((c: typeof FX.multi_lora_image) => ({
  ...c,
  calls: c.calls.map((call) => {
    const refs = call.payload.hf_loras as string[]
    const bare = refs.map(multiLoraHfRef)
    if (new Set(bare).size !== new Set(refs).size) throw new Error('two LoRAs collapsed: not this flow')
    let json = call.payload_json!
    for (const r of refs) json = json.replace(JSON.stringify(r), JSON.stringify(multiLoraHfRef(r)))
    return { ...call, payload: { ...call.payload, hf_loras: bare }, payload_json: json }
  }),
}))(FX.multi_lora_image)

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const isRaw = (a: unknown): a is { __body__: string } => !!a && typeof a === 'object' && typeof (a as { __body__?: unknown }).__body__ === 'string'

// ── Nodes ────────────────────────────────────────────────────────────────

const imageCard = (file: string) => ({ class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outImage = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const textCard = (from: string) => ({ class_type: 'Text', inputs: { text: '', source: [from, 0] } })
const audioCard = (from: string) => ({ class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: [from, 0] } })
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
function frameWidgets(over: Record<string, unknown> = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  for (let i = 1; i <= 16; i++) {
    Object.assign(w, {
      [`layer${i}_x`]: 0, [`layer${i}_y`]: 0, [`layer${i}_rotation`]: 0, [`layer${i}_scale`]: 1,
      [`layer${i}_opacity`]: 1, [`layer${i}_blend`]: 'normal', [`layer${i}_z`]: i, [`layer${i}_protect`]: false, [`layer${i}_cloner`]: '',
    })
  }
  return { ...w, width: 0, height: 0, motion_params: '', ...over }
}

// ── The routes ───────────────────────────────────────────────────────────

const USER = 'user_1'
/** The brief's families, exactly. */
const ON = 'cards,llm-text,describe,image-repair,layers,audio-gen,gen-3d,film-shot,image-extras,lora,nano-extras,turntable'
const R3_FAMILIES: readonly RunnerFamily[] = ['llm-text', 'describe', 'image-repair', 'layers', 'audio-gen', 'gen-3d', 'film-shot', 'image-extras', 'lora', 'nano-extras', 'turntable']
function handler(route: any, userId: string | null = USER) {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (route: any, body: unknown) => handler(route)(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const startRun = (takes: ApiPrompt[]) => post(startRoute, { takes, workflow: { nodes: [] }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Step 3 R3' })
async function started(takes: ApiPrompt[]): Promise<{ runId: string; legId: string; promptIds: string[] }> {
  const res = await startRun(takes)
  if (res.status !== 200) throw new Error(`POST /api/runs → ${res.status}: ${await res.text()}`)
  return await res.json()
}

/** GET /api/runs/events, read in the background (named ready/ping left out). */
async function openEvents() {
  const res = await handler(eventsRoute)(new Request('http://x/'))
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const msgs: RunnerMessage[] = []
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (/^event:/m.test(block)) continue
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data: ?/, '')).join('\n')
        if (data) msgs.push(JSON.parse(data) as RunnerMessage)
      }
    }
  })().catch(() => {})
  return { msgs, until: (check: (m: RunnerMessage[]) => boolean, ms = 60_000) => until(() => check(msgs), ms) }
}
const ends = (promptId: string) => (m: RunnerMessage) =>
  (m.type === 'execution_success' || m.type === 'execution_error') && m.data.prompt_id === promptId

// ── Fake providers answering from the fixtures ───────────────────────────

interface Sent { n: number; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; id: string }
type Fakes = { fal: ReturnType<typeof createFakeFal>; replicate: ReturnType<typeof createFakeReplicate> }
interface Script {
  /** Python's answers, in Python's call order (both services). */
  answers: unknown[]
  /** The files each answer names, base64, by URL. */
  files: Record<string, string>
  /** Before each submission: fail it, hold it, hang it. */
  onSubmit?: (n: number, provider: 'fal' | 'replicate', f: Fakes) => Promise<void> | void
}
/**
 * One fake fal and one fake Replicate answering Python's answers in call
 * order, each request keyed by its payload (a request sent again after a
 * restart would get the same answer, and be seen as sent twice). Every
 * submission is written down in order, with its service.
 */
function scripted(s: Script) {
  const queue = [...s.answers]
  const answerOf = new Map<string, unknown>()
  const sent: Sent[] = []
  const bodyOf = (provider: 'fal' | 'replicate', input: unknown) => {
    const a = answerOf.get(JSON.stringify(input))
    if (a === undefined) throw new Error('an unprogrammed request')
    if (isRaw(a)) return a.__body__
    return JSON.stringify(provider === 'replicate' ? { id: 'pred', status: 'succeeded', ...(a as object) } : a)
  }
  const fal = createFakeFal({ bodyText: ({ input }) => bodyOf('fal', input) })
  const replicate = createFakeReplicate({ bodyText: ({ input }) => bodyOf('replicate', input) })
  const fakes = { fal, replicate }
  for (const [provider, fake] of [['fal', fal], ['replicate', replicate]] as const) {
    const submit = fake.client.submit
    fake.client.submit = (async (endpoint: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      const key = JSON.stringify(payload)
      if (!answerOf.has(key)) {
        if (!queue.length) throw new Error(`the runner made more calls than Python (${endpoint})`)
        answerOf.set(key, queue.shift())
      }
      const n = sent.length + 1
      sent.push({ n, provider, endpoint, payload, id: '' })
      await s.onSubmit?.(n, provider, fakes)
      const r = await (submit as (...a: unknown[]) => Promise<{ requestId: string }>)(endpoint, payload, ...rest)
      sent[n - 1]!.id = r.requestId
      return r
    }) as typeof submit
  }
  return { fal, replicate, sent }
}

/** A file kept store that remembers every kept file's bytes (kept bytes may be let go when the run ends). */
function watchedKept(dir: string): { kept: KeptBytes; bytes: (f: OutputFile) => Uint8Array } {
  const inner = createFileKeptBytes(join(dir, 'runner-kept'))
  const seen = new Map<string, Uint8Array>()
  return {
    kept: { ...inner, put: async (runId, b, ext) => { const f = await inner.put(runId, b, ext); seen.set(f.filename, b.slice()); return f } },
    bytes: (f) => {
      const b = seen.get(f.filename)
      if (!b) throw new Error(`no kept file ${f.filename}`)
      return b
    },
  }
}

type Kit = ReturnType<typeof makeKit> & { keptBytes: (f: OutputFile) => Uint8Array; downloads: string[]; sent: Sent[] }
type Moderate = (text: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>
interface KitOpts { script: Script; dir?: string; root?: string; ledger?: ReturnType<typeof createFakeLedger>; fakes?: ReturnType<typeof scripted>; statusHang?: (n: number) => boolean; moderate?: Moderate }
/**
 * A hosted kit on the server's families, its providers answering from the
 * script, its downloads served from the script's files, a watched file kept
 * store beside its run store; the routes use its engine. `statusHang`: the
 * n-th submission's status is never answered (a server that dies there).
 */
function kit(o: KitOpts): Kit {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'runner-paid-e2e-runs-'))
  const w = watchedKept(dir)
  const downloads: string[] = []
  const fakes = o.fakes ?? scripted(o.script)
  const never = () => new Promise<never>(() => {})
  const hungOf = <T extends { status: unknown }>(client: T): T => {
    if (!o.statusHang) return client
    const status = client.status as (...a: unknown[]) => Promise<unknown>
    return { ...client, status: (async (url: string, ...rest: unknown[]) => {
      const id = /^(?:fal|replicate):\/\/([a-z]+\d+)/.exec(url)?.[1]
      const hung = fakes.sent.find(x => x.id === id && o.statusHang!(x.n))
      return hung ? never() : status(url, ...rest)
    }) as T['status'] }
  }
  const k = makeKit({
    hosted: true, dir, root: o.root, ledger: o.ledger, moderate: o.moderate,
    fal: { ...fakes.fal, client: hungOf(fakes.fal.client) },
    replicate: { ...fakes.replicate, client: hungOf(fakes.replicate.client) },
    deps: {
      families: runnerFamilies,
      kept: w.kept,
      download: async (url: string) => {
        downloads.push(url)
        const f = o.script.files[url]
        if (f === undefined) throw new Error(`GET ${url} is not served by the fixture`)
        return { bytes: b64(f), contentType: /\.png$/.test(url) ? 'image/png' : null }
      },
    },
  })
  mkdirSync(join(k.root, 'models', 'loras'), { recursive: true })
  __setInputUploadsEngineRootForTests(k.root)
  __setEngineForTests(k.engine)
  return Object.assign(k, { keptBytes: w.bytes, downloads, sent: fakes.sent })
}
function writeInput(k: { root: string }, name: string, bytes: Uint8Array) {
  const path = join(k.root, 'input', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}
const readOut = (root: string, f: OutputFile) => new Uint8Array(readFileSync(join(root, f.type, f.subfolder, f.filename)))

/** Runs one workflow from POST /api/runs to its last event. */
async function runFlow(k: Kit, prompt: ApiPrompt) {
  const events = await openEvents()
  const { runId, promptIds } = await started([prompt])
  expect(promptIds).toEqual([`${runId}.0.t0`])
  await events.until(m => m.some(ends(promptIds[0]!)))
  await k.engine.settled(runId)
  const run = (await k.store.get(runId))!
  return { runId, promptId: promptIds[0]!, run, msgs: events.msgs, nodes: run.takes[0]!.nodes, prompt }
}
type Flow = Awaited<ReturnType<typeof runFlow>>
const done = (r: Flow) => expect(r.run.status, JSON.stringify(Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, [n.status, n.error]])))).toBe('done')

// ── Requests: Python's, on the wire ───────────────────────────────────────

/**
 * Python's wire text with the one ruled difference (R3.3 ruling 1, FLOAT
 * widgets only): a whole float Python writes `1.0` is the runner's `1`.
 */
function pythonWire(payloadJson: string, floatKeys: readonly string[]): string {
  const keys = new Set(floatKeys)
  const whole = (v: PyJson): PyJson => (v && typeof v === 'object' && 'float' in v && Number.isInteger(v.float) ? { int: String(v.float) } : v)
  const walk = (v: PyJson): PyJson => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && 'obj' in v) return { obj: v.obj.map(([k, x]) => [k, keys.has(k) ? (Array.isArray(x) ? x.map(whole) : whole(x)) : walk(x)] as [string, PyJson]) }
    return v
  }
  return pyJsonDumps(walk(parsePyJson(payloadJson)))
}
/** A payload as a wire text, keys sorted (numbers keep their written form). */
function wireText(payload: unknown): string {
  const sorted = (v: PyJson): PyJson => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v && typeof v === 'object' && 'obj' in v) return { obj: [...v.obj].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)] as [string, PyJson]) }
    return v
  }
  return pyJsonDumps(sorted(parsePyJson(JSON.stringify(payload))))
}
/** A payload with the runner's links written as Python names the same pictures (`links`: runner link → Python's). */
function asPython(payload: Record<string, unknown>, links: ReadonlyMap<string, string>): Record<string, unknown> {
  const walk = (v: unknown): unknown => (typeof v === 'string' ? (links.get(v) ?? v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v)
  return walk(payload) as Record<string, unknown>
}
/** The runner's calls are Python's, in order: service, endpoint, payload (deep-equal) and wire text. */
function expectCalls(sent: readonly Sent[], py: readonly PyCall[], links: ReadonlyMap<string, string>, floatKeys: readonly string[], label: string) {
  expect(sent.map(s => [s.provider, s.endpoint]), `${label}: the calls`).toEqual(py.map(c => [c.provider, c.endpoint]))
  for (const [i, c] of py.entries()) {
    const mine = asPython(sent[i]!.payload, links)
    expect(mine, `${label}: call ${i + 1}`).toEqual(c.payload)
    expect(wireText(mine), `${label}: call ${i + 1} on the wire`).toBe(pythonWire(c.payload_json!, floatKeys))
  }
}

// ── Pixels ────────────────────────────────────────────────────────────────

async function pixelsOf(bytes: Uint8Array): Promise<{ shape: number[]; data: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { shape: [info.height, info.width, info.channels], data: new Uint8Array(data) }
}
/** A PNG's pixels are Python's (shape and sha256 of the 8-bit array), exactly. */
async function expectPixels(bytes: Uint8Array, want: Px, label: string) {
  const got = await pixelsOf(bytes)
  expect(got.shape, `${label}: shape`).toEqual(want.shape)
  expect(sha(got.data), `${label}: pixels`).toBe(want.sha256)
}
/**
 * A provider's picture saved as the runner keeps it (the provider's own
 * bytes) against the tensor Python downloaded from the same file:
 * bytesio_to_image_tensor reads it as RGBA, so an RGB file is Python's
 * tensor with an opaque alpha. The bytes are the served file's exactly.
 */
async function expectProviderPicture(bytes: Uint8Array, served: string, pyTensor: { shape: number[]; sha256: string }, label: string) {
  expect(Buffer.compare(Buffer.from(bytes), Buffer.from(b64(served))), `${label}: the provider's file, byte for byte`).toBe(0)
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const shape = [1, info.height, info.width, info.channels]
  if (pyTensor.shape[3] === 3) {
    const rgb = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    expect([1, rgb.info.height, rgb.info.width, rgb.info.channels], `${label}: shape`).toEqual(pyTensor.shape)
    expect(sha(rgb.data), `${label}: pixels`).toBe(pyTensor.sha256)
    return
  }
  expect(shape, `${label}: shape`).toEqual(pyTensor.shape)
  expect(sha(data), `${label}: pixels`).toBe(pyTensor.sha256)
}
const pyTensor = (output: unknown, slot = 0) => ((output as { tensor: { shape: number[]; sha256: string } }[])[slot]!.tensor)
const uploadsOf = (k: Kit) => new Map((k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([bytes, name]) => [`https://fal.storage/${name}`, bytes]))

// ── Money ─────────────────────────────────────────────────────────────────

const credit = (p: ReturnType<typeof priceNode>, label: string): number => {
  if ('refused' in p) throw new Error(`${label}: ${p.refused}`)
  return p.credits
}
/**
 * The hold (the ceiling) and the charge, each from priceNode on its own:
 * `ceiling` node id → the node's priceNode figure as sent; `charged` node id
 * → its figure for what ran. The render credit rides on both when the graph
 * has an output class and something is charged (ruling (a), R2.12). Asserts
 * one hold keyed runner:<promptId> at the ceiling (none when it is 0),
 * settled once at the charge, never above it, the closing event's credits
 * and each node's record.
 */
function expectMoney(k: Kit, r: Flow, ceiling: Record<string, number>, charged: Record<string, number>, o: { pixels?: Record<string, number>; savedPoses?: Record<string, boolean> } = {}) {
  const graph = priceGraph(r.prompt, { families: runnerFamilies(), ...(o.pixels ? { inputPixels: o.pixels } : {}), ...(o.savedPoses ? { savedPoses: o.savedPoses } : {}) })
  const sum = (m: Record<string, number>) => Object.values(m).reduce((s, v) => s + v, 0)
  const hold = sum(ceiling) + (graph.base! > 0 && sum(ceiling) > 0 ? BASE_RENDER_CREDITS : 0)
  const charge = sum(charged) + (graph.base! > 0 && sum(charged) > 0 ? BASE_RENDER_CREDITS : 0)
  if (sum(ceiling) > 0) expect(graph.credits, `priceGraph agrees on the ceiling (${JSON.stringify(graph.breakdown)})`).toBe(hold)
  for (const [id, c] of Object.entries(ceiling)) expect(graph.nodes![id], `${id}: priceGraph's figure`).toBe(c)
  expect(charge, 'the charge is never above the hold').toBeLessThanOrEqual(hold)
  const holds = (k.ledger.hold as any).mock.calls as [string, number, string][]
  if (hold > 0) {
    expect(holds, 'one hold, at the ceiling').toEqual([[USER, hold, `runner:${r.promptId}`]])
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual]), 'settled once, at the charge').toEqual([[charge > 0 ? 'settled' : 'released', charge > 0 ? charge : null]])
  }
  else expect(holds, 'nothing to charge, nothing held').toEqual([])
  for (const [id, c] of Object.entries(charged)) {
    const rec = r.nodes[id]!
    // A pipeline (R3.1) keeps its hold on its record and is charged the calls that finished, each its own credits.
    if (rec.calls) expect(rec.calls.filter(x => x.status === 'done' && !x.lost).reduce((s, x) => s + callCredits({ usd: x.usd }), 0), `${id}: its finished calls are priceNode's figure for what ran`).toBe(c)
    else expect(rec.credits, `${id}: charged priceNode's figure for what ran`).toBe(c)
  }
  const last = r.msgs.at(-1)!
  expect((last.data as { credits: number }).credits, 'the closing event carries the charge').toBe(charge)
  return { hold, charge }
}
/** One call's credits (pipelinePrice.ts callCredits over its card): the per-call figure priceNode sums. */
const callOf = (call: Parameters<typeof paidCallUsd>[0]) => callCredits({ usd: paidCallUsd(call)! })

// ── Setup ─────────────────────────────────────────────────────────────────

beforeAll(() => {
  // The evidence only counts with no provider key in the environment.
  expect(process.env.FAL_KEY).toBeUndefined()
  expect(process.env.FAL_API_KEY).toBeUndefined()
  expect(process.env.NUXT_REPLICATE_TOKEN).toBeUndefined()
  expect(process.env.REPLICATE_API_TOKEN).toBeUndefined()
})
beforeEach(() => {
  process.env.NUXT_RUNNER_ENABLED = 'true'
  process.env.NUXT_RUNNER_FAMILIES = ON
  _resetRateLimits()
  __setMultiLoraRotationForTests(0)
  // No LoRA link here needs a look-up: one would reach the network.
  __setHuggingFaceLookupForTests(async (repo) => { throw new Error(`no look-up expected (${repo})`) })
  // Only the SSE route's 25 s ping interval is faked, so it never fires or leaks.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.NUXT_RUNNER_ENABLED
  delete process.env.NUXT_RUNNER_FAMILIES
  __setEngineForTests(null)
  __setInputUploadsEngineRootForTests(null)
  __setHuggingFaceLookupForTests(null)
  __setMultiLoraRotationForTests(0)
})

// ── 1. The nine workflows ─────────────────────────────────────────────────

describe('R3.18 · each paid workflow, POST /api/runs to the last event (hosted, fake ledger)', () => {
  it('the server has exactly the brief\'s families on', () => {
    expect([...runnerFamilies()].sort()).toEqual(ON.split(',').sort())
  })

  it('Text → Summarize text → Generate an image\'s prompt_in → Image card: Python\'s two requests, the summary handed on, the picture; the tokens charged', async () => {
    const script = { answers: [...SUMMARIZE.answers, ...GENERATE.answers], files: { ...GENERATE.files } as Record<string, string> }
    const k = kit({ script })
    const p: ApiPrompt = {
      t: { class_type: 'Text', inputs: { text: SUMMARIZE.widgets.text } },
      s: { class_type: 'SummarizeTextNode', inputs: { length: SUMMARIZE.widgets.length, model: SUMMARIZE.widgets.model, text: ['t', 0] } },
      g: { class_type: 'GenerateImageNode', inputs: { ...GENERATE.widgets, prompt_in: ['s', 0] } },
      o: outImage('g'),
    }
    const r = await runFlow(k, p)
    done(r)
    expectCalls(k.sent, [...SUMMARIZE.calls, ...GENERATE.calls], new Map(), ['temperature'], 'Summarize → Generate')
    // The summary is Python's, handed on as the prompt Python built; the Text card's words Python's text.
    const summary = (SUMMARIZE.output as string[])[0]!
    expect(r.nodes.t!.values).toEqual({ 0: { kind: 'text', text: SUMMARIZE.widgets.text } })
    expect(r.nodes.s!.values).toEqual({ 0: { kind: 'text', text: summary } })
    expect(r.msgs.find(m => m.type === 'executed' && m.data.node === 's')?.data.output, 'Summarize shows Python\'s ui').toEqual(SUMMARIZE.ui)
    // The picture: the provider's file, Python's tensor; the Image card shows it.
    expect(r.nodes.g!.outputs).toHaveLength(1)
    const made = r.nodes.g!.outputs[0]!
    await expectProviderPicture(readOut(k.root, made), GENERATE.files![GENERATE.gets![0]!.url]!, pyTensor(GENERATE.output), 'Generate an image')
    expect(k.downloads).toEqual(GENERATE.gets!.map(g => g.url))
    expect(r.nodes.o!.status).toBe('done')
    // Money: Summarize held at its ceiling (a wired text), charged the tokens Replicate reports; the picture its price.
    const sIn = p.s!.inputs as NodeInputs
    const usage = answerUsage(JSON.parse((SUMMARIZE.answers[0] as { __body__: string }).__body__))
    expect(usage, 'the answer reports its tokens').not.toBeNull()
    const sHold = credit(priceNode('SummarizeTextNode', sIn), 'Summarize')
    const sUsed = credit(priceNode('SummarizeTextNode', sIn, { answerUsage: usage! }), 'Summarize used')
    const gPrice = credit(priceNode('GenerateImageNode', p.g!.inputs as NodeInputs), 'Generate')
    expect(sUsed).toBeLessThanOrEqual(sHold)
    const m = expectMoney(k, r, { s: sHold, g: gPrice }, { s: sUsed, g: gPrice })
    console.info(`R3.18 Summarize → Generate: held ${m.hold} (Summarize ${sHold}, Generate ${gPrice}, render 1), charged ${m.charge} (Summarize ${sUsed})`)
  }, 120_000)

  it('Image card → Describe an image → Text card: Python\'s request, Python\'s text on the card; charged its price', async () => {
    const c = DESCRIBE
    const k = kit({ script: { answers: c.answers, files: {} } })
    writeInput(k, 'image.png', b64(c.picture_files!.image!))
    const p: ApiPrompt = {
      c: imageCard('image.png'),
      n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['c', 0] } },
      t: textCard('n'),
    }
    const r = await runFlow(k, p)
    done(r)
    expectCalls(k.sent, c.calls, new Map([['https://fal.storage/image.png', 'IMG:image']]), [], 'Describe')
    const text = (c.output as string[])[0]!
    expect(r.nodes.n!.values).toEqual({ 0: { kind: 'text', text } })
    expect(r.nodes.t!.values).toEqual({ 0: { kind: 'text', text } })
    // Python's Describe shows nothing itself.
    expect(c.ui).toBeNull()
    expect(r.msgs.find(m => m.type === 'executed' && m.data.node === 'n')).toBeUndefined()
    const price = credit(priceNode(c.class_type, p.n!.inputs as NodeInputs), 'Describe')
    expectMoney(k, r, { n: price }, { n: price })
  }, 120_000)

  it('LoadImage → Separate background and foreground → Frame: with the brief\'s families the Frame (family frame) is off, so the runner declines it', async () => {
    const k = kit({ script: { answers: [], files: {} } })
    writeInput(k, 'image.png', b64(SPLIT.picture_files!.image!))
    const res = await startRun([splitFramePrompt()])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { data?: unknown }
    expect(body.data).toEqual({ reason: 'not-eligible' })
    expect(isRunnerDeclined({ statusCode: res.status, data: body })).toBe(true)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.sent).toEqual([])
  })

  it('LoadImage → Separate background and foreground → Frame (both layers), frame on too: Python\'s two calls and mask, both layers, the Frame\'s render; charged both calls', async () => {
    process.env.NUXT_RUNNER_FAMILIES = `${ON},frame`
    const k = kit({ script: { answers: SPLIT.answers, files: SPLIT.files! } })
    writeInput(k, 'image.png', b64(SPLIT.picture_files!.image!))
    const p = splitFramePrompt()
    const r = await runFlow(k, p)
    done(r)
    await expectSplit(k, r)
    // Money: no output class (LoadImage, Split, a Frame): no render credit, as on the ComfyUI path.
    const calls = splitCredits()
    expect(priceGraph(p).base).toBe(0)
    expectMoney(k, r, { n: calls.cutout + calls.fill }, { n: calls.cutout + calls.fill })
  }, 120_000)

  it('Image card → Upscale (Real-ESRGAN) → Remove background → Save image: Python\'s requests, the pictures handed on and saved; charged both', async () => {
    const k = kit({ script: { answers: [...UPSCALE.answers, ...REMOVE.answers], files: { ...UPSCALE.files, ...REMOVE.files } } })
    writeInput(k, 'image.png', b64(UPSCALE.picture_files!.image!))
    const p: ApiPrompt = {
      c: imageCard('image.png'),
      u: { class_type: 'UpscaleImageNode', inputs: { ...UPSCALE.widgets, image: ['c', 0] } },
      rb: { class_type: 'RemoveBackgroundNode', inputs: { ...REMOVE.widgets, image: ['u', 0] } },
      s: saveImage(['rb', 0]),
    }
    const r = await runFlow(k, p)
    done(r)
    const upscaled = r.nodes.u!.outputs[0]!
    const cutout = r.nodes.rb!.outputs[0]!
    // Upscale: the Image card's file as Python's loader picture; Python's payload and wire text.
    expectCalls(k.sent.slice(0, 1), UPSCALE.calls, new Map([['https://fal.storage/image.png', 'IMG:image']]), ['scale_factor', 'creativity', 'resemblance', 'scale'], 'Upscale')
    await expectProviderPicture(readOut(k.root, upscaled), UPSCALE.files![UPSCALE.gets![0]!.url]!, { shape: [1, ...FX.upscale_remove_save.handed_on.upscaled.shape], sha256: FX.upscale_remove_save.handed_on.upscaled.sha256 }, 'Upscale\'s picture')
    // Remove background: Python sends the PNG of the tensor it downloaded (RGBA); the runner hands off its picture: the same pixels.
    const pyImage = String(REMOVE.calls[0]!.payload.image)
    const handed = uploadsOf(k).get(String(k.sent[1]!.payload.image))
    expect(handed, 'the upscaled picture was handed off').toBeDefined()
    // Evidence for the report: the colour channels alone against Python's (its alpha is opaque).
    const hp = await pixelsOf(handed!)
    const pyUp = b64(FX.upscale_remove_save.handed_on.upscaled.px!)
    const rgbOf = (px: Uint8Array, ch: number) => Uint8Array.from({ length: (px.length / ch) * 3 }, (_, i) => px[Math.floor(i / 3) * ch + (i % 3)]!)
    console.info(`R3.18 Upscale → Remove background hand-off: runner ${JSON.stringify(hp.shape)}, Python ${JSON.stringify(REMOVE.made![pyImage]!.shape)}; colour channels equal: ${sha(rgbOf(hp.data, hp.shape[2]!)) === sha(rgbOf(pyUp, 4))}; Python's alpha all 255: ${pyUp.every((v, i) => i % 4 !== 3 || v === 255)}`)
    // Strict (controller ruling on R3.18): waits on R3.H2 (a runner-made picture handed to a provider as Python's tensor PNG).
    await expectPixels(handed!, REMOVE.made![pyImage]!, 'the picture handed to Remove background (Python: the RGBA tensor it downloaded)')
    expectCalls(k.sent.slice(1), REMOVE.calls, new Map([[String(k.sent[1]!.payload.image), pyImage]]), [], 'Remove background')
    expect(Buffer.compare(Buffer.from(readOut(k.root, cutout)), Buffer.from(b64(REMOVE.files![REMOVE.gets![0]!.url]!))), 'the cut-out is the provider\'s file').toBe(0)
    // Save image: Python's save_images of the cut-out.
    const saved = r.nodes.s!.outputs
    expect(saved).toHaveLength(1)
    await expectPixels(readOut(k.root, saved[0]!), FX.upscale_remove_save.saved, 'Save image')
    expect(k.downloads).toEqual([...UPSCALE.gets!, ...REMOVE.gets!].map(g => g.url))
    // Money: Upscale priced on the Image card's measured size (8 × 6); Remove background its call.
    const pixels = { u: 8 * 6 }
    const up = credit(priceNode('UpscaleImageNode', p.u!.inputs as NodeInputs, { inputPixels: pixels.u }), 'Upscale')
    const rb = credit(priceNode('RemoveBackgroundNode', p.rb!.inputs as NodeInputs), 'Remove background')
    expectMoney(k, r, { u: up, rb }, { u: up, rb }, { pixels })
  }, 120_000)

  it('Generate music → Audio card: Python\'s request, the provider\'s sound on the card; charged its price', async () => {
    const c = MUSIC
    const k = kit({ script: { answers: c.answers, files: c.files! } })
    const p: ApiPrompt = { m: { class_type: c.class_type, inputs: { ...c.widgets } }, a: audioCard('m') }
    const r = await runFlow(k, p)
    done(r)
    expectCalls(k.sent, c.calls, new Map(), ['temperature', 'top_p', 'speed', 'volume'], 'Generate music')
    const made = r.nodes.m!.outputs[0]!
    const url = (c.output as { audio: string }[])[0]!.audio
    expect(Buffer.compare(Buffer.from(readOut(k.root, made)), Buffer.from(b64(c.files![url]!))), 'the sound is the provider\'s file (Python\'s download)').toBe(0)
    expect(r.nodes.a!.outputs).toEqual([made])
    expect(r.msgs.find(m => m.type === 'executed' && m.data.node === 'a')?.data.output).toEqual({ audio: [made] })
    expect(c.ui).toBeNull()
    const price = credit(priceNode(c.class_type, p.m!.inputs as NodeInputs), 'music')
    expectMoney(k, r, { m: price }, { m: price })
  }, 120_000)

  it('Image card → Generate a 3D model → 3D model card: Python\'s request, the provider\'s GLB saved and its address handed on (ruling (k)); charged its price', async () => {
    const c = GEN3D
    const k = kit({ script: { answers: c.answers, files: c.files! } })
    writeInput(k, 'image.png', b64(c.picture_files!.image!))
    const p: ApiPrompt = {
      c: imageCard('image.png'),
      n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['c', 0] } },
      m: { class_type: 'Model3D', inputs: { glb_url: ['n', 0] } },
    }
    const r = await runFlow(k, p)
    done(r)
    expectCalls(k.sent, c.calls, new Map([['https://fal.storage/image.png', 'IMG:image']]), ['guidance_scale'], 'Generate a 3D model')
    // Python hands on the provider's address; the runner saves that file as the user's own and hands on its address (ruling (k)).
    const url = (c.output as string[])[0]!
    const file = r.nodes.n!.outputs[0]!
    expect(file.filename).toMatch(/^model3d_\d+_\.glb$/)
    expect(Buffer.compare(Buffer.from(readOut(k.root, file)), Buffer.from(b64(c.files![url]!))), 'the GLB is Python\'s file, byte for byte').toBe(0)
    // Hosted: saved under the user's own subfolder (u_<hash>), as every hosted output is.
    expect(file.subfolder).toMatch(/^u_[0-9a-f]+$/)
    const address = `/view?filename=${file.filename}&subfolder=${file.subfolder}&type=output`
    expect(r.nodes.n!.values).toEqual({ 0: { kind: 'glb', url: address, file } })
    expect(r.nodes.m!.values).toEqual({ 0: { kind: 'text', text: address } })
    expect(k.downloads).toEqual([url])
    const price = credit(priceNode(c.class_type, p.n!.inputs as NodeInputs), '3D')
    expectMoney(k, r, { n: price }, { n: price })
  }, 120_000)

  it('Image card → Flux Dev + LoRAs → Image card: Python\'s request, Python\'s picture; held two calls (ruling (g)), charged the one made', async () => {
    const c = MULTI
    __setMultiLoraRotationForTests(c.rotate as 0 | 1)
    const k = kit({ script: { answers: c.answers, files: c.files! } })
    writeInput(k, 'image.png', b64(c.picture_files!.image!))
    const p: ApiPrompt = {
      c: imageCard('image.png'),
      n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['c', 0] } },
      o: outImage('n'),
    }
    const r = await runFlow(k, p)
    done(r)
    expectCalls(k.sent, c.calls, new Map([['https://fal.storage/image.png', 'IMG:image']]), ['guidance', 'guidance_scale', 'lora_scale', 'prompt_strength', 'lora_scales'], 'Flux Dev + LoRAs')
    expect(multiLoraRotation(), 'the order toggle moves as Python\'s').toBe(c.rotate_after)
    const out = r.nodes.n!.outputs[0]!
    await expectPixels(readOut(k.root, out), { shape: pyTensor(c.output).shape.slice(1), sha256: pyTensor(c.output).sha256 }, 'Flux Dev + LoRAs\' picture')
    const steps = paidCalls(c.class_type, p.n!.inputs as NodeInputs, {})
    if ('refused' in steps) throw new Error(steps.refused)
    expect(steps.steps.map(s => s.times), 'two slots: held for the reload retry').toEqual([2])
    const one = callOf(steps.steps[0]!.call)
    expect(credit(priceNode(c.class_type, p.n!.inputs as NodeInputs), 'multi')).toBe(2 * one)
    expectMoney(k, r, { n: 2 * one }, { n: one })
  }, 120_000)

  it('Image card → Restyle an Image · Style LoRA, an illustration held on the second pass: Python\'s seven calls, Python\'s picture; charged the seven calls, never the hold', async () => {
    const c = RESTYLE
    const k = kit({ script: { answers: c.answers, files: c.files! } })
    writeInput(k, 'content_image.png', b64(c.picture_files!.content_image!))
    const r = await runFlow(k, restylePrompt())
    done(r)
    await expectRestyle(k, r)
    const { hold, made } = restyleCredits(c.widgets, ['describe', 'stylize', 'classify-ref', 'nb-1', 'classify-1', 'nb-2', 'classify-2'])
    expect(made).toBeLessThan(hold)
    expectMoney(k, r, { n: hold }, { n: made })
  }, 120_000)

  it('Image card → Pose Mannequin with a baked result: no call, the saved pose handed on as Python\'s picture; nothing held or charged', async () => {
    const c = POSE
    const k = kit({ script: { answers: [], files: {} } })
    for (const [name, bytes] of Object.entries(NANO.baked)) writeInput(k, name, b64(bytes))
    writeInput(k, 'character.png', b64(c.picture_files!.character!))
    const p: ApiPrompt = { c: imageCard('character.png'), n: { class_type: c.class_type, inputs: { ...c.widgets, character: ['c', 0] } } }
    const r = await runFlow(k, p)
    done(r)
    expect(c.calls).toEqual([])
    expect(k.sent).toEqual([])
    expect(k.downloads).toEqual([])
    const v = r.nodes.n!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(v.kind).toBe('files')
    const want = pyTensor(c.output)
    const f = v.files[0]!
    await expectPixels(f.type === 'kept' ? k.keptBytes(f) : readOut(k.root, f), { shape: want.shape.slice(1), sha256: want.sha256 }, `the saved pose handed on (${f.type} ${f.filename})`)
    const shown = r.msgs.find(m => m.type === 'executed' && m.data.node === 'n')?.data.output as { images: OutputFile[] } | undefined
    expect(shown?.images, 'shown as Python\'s live preview').toHaveLength(1)
    await expectPixels(readOut(k.root, shown!.images[0]!), { shape: want.shape.slice(1), sha256: want.sha256 }, 'the saved pose shown')
    expectMoney(k, r, { n: 0 }, { n: 0 }, { savedPoses: { n: true } })
    // priceGraph with the pose read: the node free (ruling (p)); the render credit only rides on a charge.
    expect(priceGraph(p, { families: runnerFamilies(), savedPoses: { n: true } }).nodes!.n).toBe(0)
  }, 120_000)
})

// ── The chained workflows' parts, shared with the failure and restart tests ──

function splitFramePrompt(): ApiPrompt {
  const w = FX.split_frame.frame.widgets
  return {
    l: loadImage('image.png'),
    n: { class_type: SPLIT.class_type, inputs: { ...SPLIT.widgets, image: ['l', 0] } },
    frame: { class_type: 'Compositor', inputs: frameWidgets({ ...w, layer1: ['n', 1], layer2: ['n', 0] }) },
  }
}
const splitCredits = () => {
  const s = paidCalls(SPLIT.class_type, SPLIT.widgets as NodeInputs, {})
  if ('refused' in s) throw new Error(s.refused)
  expect(s.steps.map(x => x.times)).toEqual([1, 1])
  return { cutout: callOf(s.steps[0]!.call), fill: callOf(s.steps[1]!.call) }
}
/** Split's two calls (the mask by its pixels), its two layers and the Frame's render, all Python's. */
async function expectSplit(k: Kit, r: Flow, o: { downloads?: boolean } = {}) {
  const IMG = 'https://fal.storage/image.png'
  const [cut, fill] = SPLIT.calls as [PyCall, PyCall]
  expect(k.sent.map(s => [s.provider, s.endpoint])).toEqual([[cut.provider, cut.endpoint], [fill.provider, fill.endpoint]])
  expectCalls(k.sent.slice(0, 1), [cut], new Map([[IMG, 'IMG:image']]), [], 'the cut-out')
  // The fill: Python's picture (the loader's, as it is) and Python's mask, by its pixels (PIL and sharp write other PNG bytes).
  const mine = k.sent[1]!.payload
  expect(Object.keys(mine).sort()).toEqual(Object.keys(fill.payload).sort())
  expect(mine.image).toBe(IMG)
  expect(fill.payload.image).toBe('IMG:image')
  const mask = uploadsOf(k).get(String(mine.mask))
  expect(mask, 'the mask was handed off').toBeDefined()
  const pyMask = String(fill.payload.mask)
  expect(pyMask.startsWith('data:image/png;base64,')).toBe(true)
  const [a, b] = await Promise.all([sharp(mask!).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true }), sharp(b64(pyMask.slice(22))).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true })])
  expect([a.info.width, a.info.height, a.info.channels]).toEqual([b.info.width, b.info.height, 1])
  expect(sha(a.data), 'the mask\'s pixels are Python\'s').toBe(sha(b.data))
  // The layers: the cut-out as downloaded, the background Python's tensor; both Python's handed-on pixels.
  const [subject, background] = [r.nodes.n!.values![0], r.nodes.n!.values![1]] as Extract<RunnerValue, { kind: 'files' }>[]
  const sb = readOut(k.root, subject!.files[0]!)
  expect(Buffer.compare(Buffer.from(sb), Buffer.from(b64(SPLIT.files![(SPLIT.output as [{ image: string }])[0].image]!))), 'the subject is the provider\'s cut-out').toBe(0)
  await expectPixels(sb, FX.split_frame.handed_on.subject, 'the subject handed to the Frame')
  await expectPixels(readOut(k.root, background!.files[0]!), FX.split_frame.handed_on.background, 'the background handed to the Frame')
  expect(sha((await pixelsOf(readOut(k.root, background!.files[0]!))).data)).toBe(pyTensor(SPLIT.output, 1).sha256)
  expect(r.msgs.find(m => m.type === 'executed' && m.data.node === 'n')?.data.output).toEqual({ images: [subject!.files[0], background!.files[0]], animated: [false] })
  // The Frame: Python's render as save_live_preview writes it.
  const ff = r.nodes.frame!.outputs[0]!
  await expectPixels(readOut(k.root, ff), FX.split_frame.frame, 'the Frame\'s render')
  if (o.downloads !== false) expect(k.downloads).toEqual(SPLIT.gets!.map(g => g.url))
}

function restylePrompt(): ApiPrompt {
  return { c: imageCard('content_image.png'), n: { class_type: RESTYLE.class_type, inputs: { ...RESTYLE.widgets, content_image: ['c', 0] } } }
}
/** Python's links for the pictures the runner hands on from its own kept copies (the hand-off rule, R3.14). */
function restyleLinks(c: PaidCase): Map<string, string> {
  const m = new Map<string, string>([['https://fal.storage/content_image.png', 'IMG:content_image']])
  const flux = (c.answers[1] as { output?: string[] }).output?.[0]
  if (flux) m.set('https://fal.storage/restyle_style.png', flux)
  let pass = 0
  for (const a of c.answers) {
    const url = (a as { images?: { url: string }[] }).images?.[0]?.url
    if (url) m.set(`https://fal.storage/restyle_pass_${++pass}.png`, url)
  }
  return m
}
async function expectRestyle(k: Kit, r: Flow) {
  const c = RESTYLE
  expectCalls(k.sent, c.calls, restyleLinks(c), ['guidance', 'guidance_scale', 'lora_scale', 'prompt_strength'], 'Restyle')
  expect(r.nodes.n!.calls!.map(x => [x.key, x.status])).toEqual(['describe', 'stylize', 'classify-ref', 'nb-1', 'classify-1', 'nb-2', 'classify-2'].map(key => [key, 'done']))
  const out = r.nodes.n!.outputs[0]!
  expect(out.filename).toMatch(/^restyle_lora/)
  const want = pyTensor(c.output)
  await expectPixels(readOut(k.root, out), { shape: want.shape.slice(1), sha256: want.sha256 }, 'Restyle\'s picture')
}
/** Restyle's hold (every call its settings may make, priceNode) and the credits of the calls given, each at the route that served it. */
function restyleCredits(widgets: Record<string, unknown>, keys: string[]): { hold: number; made: number } {
  const calls = restyleLoraCalls(widgets as NodeInputs)
  const one = (key: string) => (key.startsWith('nb-') ? callOf({ ...calls.nanoBanana.call, fallbacks: [] }) : key === 'stylize' ? callOf(calls.stylize.call) : callOf(calls.moondream.call))
  return { hold: credit(priceNode(RESTYLE.class_type, restylePrompt().n!.inputs as NodeInputs), 'Restyle'), made: keys.reduce((s, key) => s + one(key), 0) }
}

// ── 2. Failures and restarts mid-pipeline ─────────────────────────────────

describe('R3.18 · a failure mid-pipeline charges the finished calls only (ruling (f))', () => {
  it('Separate background and foreground → Frame: the fill fails at the provider; the cut-out alone is charged, the Frame never runs', async () => {
    process.env.NUXT_RUNNER_FAMILIES = `${ON},frame`
    const k = kit({ script: { answers: SPLIT.answers, files: SPLIT.files!, onSubmit: (n, _p, f) => { if (n === 2) f.replicate.failNext(1) } } })
    writeInput(k, 'image.png', b64(SPLIT.picture_files!.image!))
    const r = await runFlow(k, splitFramePrompt())
    expect(r.run.status).toBe('error')
    expect(r.nodes.n!.calls!.map(x => [x.key, x.status])).toEqual([['cutout', 'done'], ['fill', 'error']])
    expect(r.nodes.frame!.status).toBe('skipped')
    const calls = splitCredits()
    expect(k.ledger.hold).toHaveBeenCalledWith(USER, calls.cutout + calls.fill, `runner:${r.promptId}`)
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', calls.cutout]])
    const last = r.msgs.at(-1)!
    expect(last.type).toBe('execution_error')
    expect((last.data as { credits: number }).credits).toBe(calls.cutout)
  }, 120_000)

  it('Image card → Restyle: the second Nano Banana pass fails; the five calls before it are charged, and no render credit (nothing was made and shown)', async () => {
    const c = RESTYLE
    const k = kit({ script: { answers: c.answers, files: c.files!, onSubmit: (n, provider, f) => { if (n === 6 && provider === 'fal') f.fal.failNext(1) } } })
    writeInput(k, 'content_image.png', b64(c.picture_files!.content_image!))
    const r = await runFlow(k, restylePrompt())
    expect(r.run.status).toBe('error')
    const keys = ['describe', 'stylize', 'classify-ref', 'nb-1', 'classify-1']
    expect(r.nodes.n!.calls!.map(x => [x.key, x.status])).toEqual([...keys.map(key => [key, 'done']), ['nb-2', 'error']])
    expect(k.sent.map(s => s.endpoint)).toEqual(c.calls.slice(0, 6).map(x => x.endpoint))
    const { hold, made } = restyleCredits(c.widgets, keys)
    expect(k.ledger.hold).toHaveBeenCalledWith(USER, hold + BASE_RENDER_CREDITS, `runner:${r.promptId}`)
    // Controller ruling on R3.18: a node that failed and delivered nothing to an output carries no render
    // credit; the render credit rides only on something made and shown. The charge is the five finished calls.
    expect(r.nodes.n!.outputs).toEqual([])
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual]), 'charged the finished calls only, no render credit').toEqual([['settled', made]])
    expect((r.msgs.at(-1)!.data as { credits: number }).credits).toBe(made)
  }, 120_000)
})

describe('R3.18 · a restart mid-pipeline sends no call twice', () => {
  /** The old server stops following the n-th call (its polls never answer); a new one on the same stores reattaches. */
  async function restarted(script: Script, prompt: ApiPrompt, files: Record<string, string>, hangAt: number, reached: (k: Kit, runId: string) => Promise<boolean>) {
    const fakes = scripted(script)
    const ledger = createFakeLedger()
    const hang = { on: true }
    const k1 = kit({ script, fakes, ledger, statusHang: n => hang.on && n === hangAt })
    for (const [name, b] of Object.entries(files)) writeInput(k1, name, b64(b))
    const { runId, promptIds } = await started([prompt])
    for (let i = 0; i < 4000 && !(await reached(k1, runId)); i++) await new Promise(r => setTimeout(r, 5))
    expect(await reached(k1, runId), 'the old server reached the point').toBe(true)
    await new Promise(r => setTimeout(r, 30))
    hang.on = false
    const k2 = kit({ script, fakes, ledger, dir: k1.dir, root: k1.root })
    const events = await openEvents()
    expect(await k2.engine.reattach()).toBe(1)
    await events.until(m => m.some(ends(promptIds[0]!)))
    await k2.engine.settled(runId)
    const run = (await k2.store.get(runId))!
    return { k1, k2, fakes, ledger, run, nodes: run.takes[0]!.nodes, msgs: events.msgs, promptId: promptIds[0]!, prompt, downloads: [...k1.downloads, ...k2.downloads] }
  }
  const callRecord = async (k: Kit, runId: string, key: string) => ((await k.store.get(runId))!.takes[0]!.nodes.n!.calls ?? []).find(x => x.key === key)

  it('Separate background and foreground → Frame, restarted with the fill in flight: each call sent once, the cut-out downloaded once, Python\'s layers and render, charged both calls once', async () => {
    process.env.NUXT_RUNNER_FAMILIES = `${ON},frame`
    const script = { answers: SPLIT.answers, files: SPLIT.files! }
    const r = await restarted(script, splitFramePrompt(), { 'image.png': SPLIT.picture_files!.image! }, 2, async (k, id) => !!(await callRecord(k, id, 'fill'))?.request)
    expect(r.run.status).toBe('done')
    expect(r.fakes.sent.map(s => s.endpoint), 'each of Python\'s calls sent once').toEqual(SPLIT.calls.map(c => c.endpoint))
    expect(new Set(r.fakes.sent.map(s => JSON.stringify(s.payload))).size).toBe(2)
    const cutUrl = SPLIT.gets![0]!.url
    expect(r.downloads.filter(u => u === cutUrl), 'the cut-out downloaded once').toEqual([cutUrl])
    await expectSplit(Object.assign(r.k2, { sent: r.fakes.sent }), { ...r, runId: r.run.id } as unknown as Flow, { downloads: false })
    expect(r.downloads, 'every download once').toEqual(SPLIT.gets!.map(g => g.url))
    const calls = splitCredits()
    expect([...r.ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[calls.cutout + calls.fill, 'settled', calls.cutout + calls.fill]])
    expect(r.ledger.hold).toHaveBeenCalledTimes(1)
    expect(r.ledger.settle).toHaveBeenCalledTimes(1)
  }, 120_000)

  it('Image card → Restyle, restarted with the second pass in flight: each of the seven calls sent once, the LoRA\'s picture downloaded once, Python\'s picture, charged the seven calls once', async () => {
    const c = RESTYLE
    const script = { answers: c.answers, files: c.files! }
    const r = await restarted(script, restylePrompt(), { 'content_image.png': c.picture_files!.content_image! }, 6, async (k, id) => !!(await callRecord(k, id, 'nb-2'))?.request)
    expect(r.run.status).toBe('done')
    expect(r.fakes.sent.map(s => s.endpoint), 'each of Python\'s calls sent once').toEqual(c.calls.map(x => x.endpoint))
    expect(new Set(r.fakes.sent.map(s => JSON.stringify(s.payload))).size).toBe(7)
    const flux = (c.answers[1] as { output: string[] }).output[0]!
    expect(r.downloads.filter(u => u === flux), 'the LoRA\'s picture downloaded once').toEqual([flux])
    await expectRestyle(Object.assign(r.k2, { sent: r.fakes.sent }), { ...r, runId: r.run.id } as unknown as Flow)
    const { hold, made } = restyleCredits(c.widgets, ['describe', 'stylize', 'classify-ref', 'nb-1', 'classify-1', 'nb-2', 'classify-2'])
    expect([...r.ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[hold + BASE_RENDER_CREDITS, 'settled', made + BASE_RENDER_CREDITS]])
    expect(r.ledger.hold).toHaveBeenCalledTimes(1)
    expect(r.ledger.settle).toHaveBeenCalledTimes(1)
  }, 120_000)
})

// ── 3. Every R3 family off: needs-engine and the ComfyUI path's prices ───

const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
const REPO = resolve(__dirname, '../../..')
/** The code before stage R3 moved any class (the controller's baseline: R3.3's base; R3.1 and R3.2 moved none). */
const BEFORE_R3 = '38b4a0672'
const PRICE_PIN = fileURLToPath(new URL('./fixtures/runner-paid-e2e-prices.json', import.meta.url))
const NEEDS_PIN = fileURLToPath(new URL('./fixtures/runner-paid-e2e-needs-engine.json', import.meta.url))

interface SavedGraph { key: string; prompt: ApiPrompt }
let graphsCache: SavedGraph[] | null = null
async function savedGraphs(): Promise<SavedGraph[]> {
  if (graphsCache) return graphsCache
  const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
  const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
  const out: SavedGraph[] = []
  for (const uuid of readdirSync(PROJECTS).sort()) {
    let wf: { canvases?: { workflow: unknown }[] } | undefined
    try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
    catch { continue }
    ;(wf?.canvases ?? []).forEach((c, i) => {
      try { out.push({ key: `${uuid}#${i}`, prompt: graphToPrompt(c.workflow as never, catalog) }) }
      catch { /* a canvas the prompt builder can't read is left out, as R2.12 did */ }
    })
  }
  graphsCache = out
  return out
}

/** The code at BEFORE_R3, extracted once; every file reachable from `entries` imports relatively (an alias would load today's code). */
let oldTree: string | null = null
function extractOld(): string {
  if (oldTree) return oldTree
  const dir = mkdtempSync(join(tmpdir(), 'r318-before-r3-'))
  execSync(`git -C ${JSON.stringify(REPO)} archive ${BEFORE_R3} frontend/shared frontend/app/data frontend/server/utils/priceBook.ts | tar -x -C ${JSON.stringify(dir)}`)
  oldTree = dir
  return dir
}
function reachable(entry: string): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]!
      if (!spec.startsWith('.')) {
        expect(/^[#~]/.test(spec), `${file} imports ${spec} by an alias: it would load today's code`).toBe(false)
        continue
      }
      const base = resolve(dirname(file), spec)
      const hit = [base, `${base}.ts`, join(base, 'index.ts')].find(p => existsSync(p) && statSync(p).isFile())
      expect(hit, `${file} imports ${spec}, which isn't in the extracted tree`).toBeDefined()
      walk(hit!)
    }
  }
  walk(entry)
  return [...seen]
}

describe('R3.18 · every R3 family off', () => {
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt(`the needs-engine list over every saved project differs from the code at ${BEFORE_R3} (git archive) only by nodes no output reads (R3.8), the set pinned`, async () => {
    const dir = extractOld()
    const entry = join(dir, 'frontend/shared/runner/needsEngine.ts')
    const files = reachable(entry)
    const oldNeeds = await import(pathToFileURL(entry).href) as typeof import('#shared/runner/needsEngine')
    const oldFam = await import(pathToFileURL(join(dir, 'frontend/shared/runner/families.ts')).href) as { RUNNER_FAMILIES: readonly string[] }
    expect(R3_FAMILIES.some(f => oldFam.RUNNER_FAMILIES.includes(f)), 'no R3 family existed then').toBe(false)
    const allOld: ReadonlySet<RunnerFamily> = new Set(oldFam.RUNNER_FAMILIES.filter(x => (RUNNER_FAMILIES as readonly string[]).includes(x)) as RunnerFamily[])
    const sets: [string, ReadonlySet<RunnerFamily>][] = [['frame + cards', new Set<RunnerFamily>(['frame', 'cards'])], ['every family but R3\'s', allOld]]
    for (const [, f] of sets) for (const r3 of R3_FAMILIES) expect(f.has(r3)).toBe(false)
    const graphs = await savedGraphs()
    const raw: string[] = []
    const byPruning: string[] = []
    /** Each differing list: the nodes that moved, and whether every one of them is a node no output reads. */
    const differing: { key: string; families: string; moved: string[] }[] = []
    const notUnread: string[] = []
    for (const g of graphs) {
      const titleOf = (id: string) => id
      for (const [label, families] of sets) {
        const now = nodesNeedingEngine(g.prompt, { runnerOn: true, families, titleOf })
        const before = oldNeeds.nodesNeedingEngine(g.prompt as never, { runnerOn: true, families: families as never, titleOf })
        if (JSON.stringify(now) === JSON.stringify(before)) continue
        const moved = [...now.filter(x => !before.includes(x)), ...before.filter(x => !now.includes(x))]
        const line = `${g.key} (${label}): now ${JSON.stringify(now)} before ${JSON.stringify(before)}; classes ${[...new Set(moved.map(id => g.prompt[id]?.class_type ?? '?'))].join(', ')}`
        raw.push(line)
        // Every node that moved is one no output reads (with no output node at all, no node is read).
        const readers = pruneInvalidOutputs(g.prompt, families)
        const unreadIds = new Set(readers.noOutputs ? Object.keys(g.prompt) : readers.unread)
        differing.push({ key: g.key, families: label, moved: [...moved].sort() })
        // Controller ruling on R3.18 (b): also accepted, an output card that stays (a cards-only remainder runs
        // free) whose only non-output neighbours were pruned as unread.
        const neighbours = (id: string) => new Set([
          ...Object.values(g.prompt[id]?.inputs ?? {}).filter(v => Array.isArray(v) && v.length === 2).map(v => String((v as unknown[])[0])),
          ...Object.entries(g.prompt).filter(([, n]) => Object.values(n.inputs ?? {}).some(v => Array.isArray(v) && v.length === 2 && String(v[0]) === id)).map(([x]) => x),
        ])
        const leftCard = (id: string) => RUNNER_OUTPUT_CLASSES.has(g.prompt[id]?.class_type ?? '') && !unreadIds.has(id)
          && [...neighbours(id)].filter(x => !RUNNER_OUTPUT_CLASSES.has(g.prompt[x]?.class_type ?? '')).every(x => unreadIds.has(x))
        for (const id of moved) if (!unreadIds.has(id) && !leftCard(id)) notUnread.push(`${line}: ${id} is neither unread nor an output card left after its unread neighbours were pruned`)
        // R3.8 fix rounds 1 and 2 (runner-wide, family-independent, accepted): a node no output reads is left
        // out as ComfyUI leaves it out; a prompt with no output node is refused in plain words.
        const pruned = pruneInvalidOutputs(g.prompt, families)
        const kept = pruned.unread.length ? Object.fromEntries(Object.entries(g.prompt).filter(([id]) => !pruned.unread.includes(id))) : g.prompt
        const beforePruned = oldNeeds.nodesNeedingEngine(kept as never, { runnerOn: true, families: families as never, titleOf })
        if (JSON.stringify(now) === JSON.stringify(beforePruned)) byPruning.push(`${line} (R3.8: unread nodes left out)`)
        else if (now.length === 0 && pruned.noOutputs) byPruning.push(`${line} (R3.8: no output node)`)
        else if (now.length === 0 && pruned.unread.length && JSON.stringify(beforePruned) === JSON.stringify(Object.keys(kept))) byPruning.push(`${line} (R3.8: cards left after unread nodes)`)
      }
    }
    const unexplained = raw.filter(l => !byPruning.some(b => b.startsWith(l)))
    console.info(`R3.18 needs-engine vs ${BEFORE_R3}: ${graphs.length} saved graphs × ${sets.length} family sets (old code: ${files.length} files, relative imports only); ${raw.length} lists differ, ${byPruning.length} only by R3.8's pruning, ${unexplained.length} otherwise:\n${[...byPruning, ...unexplained].join('\n')}`)
    expect(graphs.length).toBeGreaterThanOrEqual(800)
    // Not explained by R3.8's accepted, family-independent pruning: none.
    expect(unexplained.slice(0, 20), `${unexplained.length} graphs differ from ${BEFORE_R3} beyond R3.8's pruning`).toEqual([])
    // Controller ruling on R3.18 (as R2.12's baseline ruling): R3.8's pruning is an accepted difference. Every
    // differing list differs only by nodes no output reads, and the set of them is the pinned one.
    differing.sort((a, b) => a.key.localeCompare(b.key) || a.families.localeCompare(b.families))
    if (process.env.R318_PIN === '1') {
      writeFileSync(NEEDS_PIN, `${JSON.stringify({
        note: `Written by tests/unit/runner-paid-e2e.unit.spec.ts with R318_PIN=1: each saved project canvas whose needs-engine list (every R3 family off) differs from ${BEFORE_R3}, with the nodes that moved: all of them nodes no output reads (R3.8's pruning, a ruled difference).`,
        baseline: BEFORE_R3,
        differing,
      }, null, 1)}\n`)
    }
    const pinnedNeeds = JSON.parse(readFileSync(NEEDS_PIN, 'utf8')) as { baseline: string; differing: typeof differing }
    expect(pinnedNeeds.baseline).toBe(BEFORE_R3)
    expect(differing, 'the differing lists are the pinned ones').toEqual(pinnedNeeds.differing)
    expect(notUnread.slice(0, 20), `${notUnread.length} moved nodes are neither unread nor an output card left after its unread neighbours were pruned`).toEqual([])
    // The ruled example of the second kind stays in the pin.
    expect(pinnedNeeds.differing.some(d => d.key === '80466069-beac-4684-a2c0-fb7b86d0c0e2#0')).toBe(true)
  }, 600_000)

  projectsIt(`the ComfyUI path's prices differ from ${BEFORE_R3} only for classes an R3 task moved (the table pinned in fixtures/runner-paid-e2e-prices.json)`, async () => {
    const dir = extractOld()
    const entry = join(dir, 'frontend/server/utils/priceBook.ts')
    reachable(entry)
    const old = await import(pathToFileURL(entry).href) as { priceGraph: typeof priceGraph; PRICE_BOOK_VERSION: string }
    // The classes stage R3's tasks moved: every paid class (R3.3–R3.16), the pre-R3 flat rows they replaced, the
    // engine pickers R3.5 re-priced (a wired engine) and R3.15's two nano classes (priced on the edit cards:
    // Pose 10 → 14 a call, 0 with no call; Lens 14).
    // LC1 (2026-10-01): Face swap moved from Easel ($0.05) to fal's face swap ($0.001), the user's ruling (b).
    const MOVED = new Set<string>([...PAID_NODE_CLASSES, ...Object.keys(PRE_R3_FLAT), 'UpscaleImageNode', 'EnhanceDetailNode', ...NANO_EXTRAS_CLASSES, 'FaceSwap'])
    const rows = new Map<string, { class: string; old: number | null; new: number | null; source: string; nodes: number }>()
    const add = (ct: string, a: number | null, b: number | null, source: string) => {
      if (a === b) return
      const key = `${ct}|${a}|${b}|${source}`
      const row = rows.get(key) ?? { class: ct, old: a, new: b, source, nodes: 0 }
      row.nodes++
      rows.set(key, row)
    }
    const priceOr = (f: () => { nodes?: Record<string, number> }) => { try { return f().nodes ?? {} } catch (e) { return e instanceof Error ? e.message : 'refused' } }
    // Every saved graph, node by node, as the ComfyUI path prices it (no families).
    let graphs = 0
    const refusals: string[] = []
    for (const g of await savedGraphs()) {
      graphs++
      const a = priceOr(() => old.priceGraph(g.prompt))
      const b = priceOr(() => priceGraph(g.prompt))
      if (typeof a === 'string' || typeof b === 'string') {
        if (a !== b) refusals.push(`${g.key}: before ${typeof a === 'string' ? a : 'priced'}, now ${typeof b === 'string' ? b : 'priced'}`)
        continue
      }
      for (const [id, n] of Object.entries(g.prompt)) add(n.class_type, a[id] ?? null, b[id] ?? null, 'saved projects')
    }
    // Every class of the node catalogue, alone, at its default settings (its pictures unwired).
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, { input?: Record<string, Record<string, [unknown, Record<string, unknown>?]>> }>
    for (const [ct, def] of Object.entries(catalog)) {
      const inputs: Record<string, unknown> = {}
      for (const part of ['required', 'optional'] as const) {
        for (const [name, spec] of Object.entries(def.input?.[part] ?? {})) {
          const [type, opts] = spec as [unknown, Record<string, unknown> | undefined]
          if (opts && 'default' in opts) inputs[name] = opts.default
          else if (Array.isArray(type)) inputs[name] = type[0]
          else if (type === 'COMBO' && Array.isArray(opts?.options)) inputs[name] = (opts!.options as unknown[])[0]
        }
      }
      const p: ApiPrompt = { n: { class_type: ct, inputs } }
      const a = priceOr(() => old.priceGraph(p))
      const b = priceOr(() => priceGraph(p))
      if (typeof a === 'string' || typeof b === 'string') {
        if (a !== b) refusals.push(`${ct} (defaults): before ${typeof a === 'string' ? a : 'priced'}, now ${typeof b === 'string' ? b : 'priced'}`)
        continue
      }
      add(ct, a.n ?? null, b.n ?? null, 'defaults')
    }
    const table = [...rows.values()].sort((x, y) => x.class.localeCompare(y.class) || x.source.localeCompare(y.source) || (x.old ?? -1) - (y.old ?? -1) || (x.new ?? -1) - (y.new ?? -1))
    const outside = table.filter(r => !MOVED.has(r.class))
    const refusedOutside = refusals.filter(l => !MOVED.has(l.split(/[ :]/)[0]!))
    console.info(`R3.18 ComfyUI-path prices vs ${BEFORE_R3} (price book ${old.PRICE_BOOK_VERSION} → now): ${graphs} saved graphs and ${Object.keys(catalog).length} catalogue classes; ${table.length} class/price rows changed, ${outside.length} outside the moved classes; refusals changed: ${refusals.length}\n`
      + `class | old | new | source | nodes\n${table.map(r => `${r.class} | ${r.old ?? '—'} | ${r.new ?? '—'} | ${r.source} | ${r.nodes}`).join('\n')}\n${refusals.join('\n')}`)
    if (process.env.R318_PIN === '1') {
      writeFileSync(PRICE_PIN, `${JSON.stringify({
        note: `Written by tests/unit/runner-paid-e2e.unit.spec.ts with R318_PIN=1: every class whose ComfyUI-path price (priceGraph, no families) differs between ${BEFORE_R3} (before stage R3) and now, per node in the saved projects and per class alone at its catalogue defaults. null: not priced.`,
        baseline: BEFORE_R3,
        table,
        refusals,
      }, null, 1)}\n`)
    }
    expect(outside, 'price changes outside the classes R3 moved').toEqual([])
    expect(refusedOutside, 'refusals changed outside the classes R3 moved').toEqual([])
    const pinned = JSON.parse(readFileSync(PRICE_PIN, 'utf8')) as { baseline: string; table: typeof table; refusals: string[] }
    expect(pinned.baseline).toBe(BEFORE_R3)
    expect(table, 'the table is the pinned one').toEqual(pinned.table)
    expect(refusals).toEqual(pinned.refusals)
  }, 600_000)
})

// ── 4. The hosted refusals, end to end ────────────────────────────────────

describe('R3.18 · the hosted refusals, on the runner\'s route and the hosted ComfyUI meter', () => {
  const blockWord = (word: string) => vi.fn(async (text: string) => (text.includes(word) ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
  /** The hosted /prompt meter's own path (meterGraphSubmit) with the real price book behind it and nothing forwarded. */
  const meterDeps = (moderatePrompt = vi.fn(async (_t: string) => ({ ok: true as const }))) => ({
    priceGraph: vi.fn((p: ApiPrompt) => priceGraph(p)),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt,
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 1000),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
  })
  async function meterRefuses(prompt: ApiPrompt, message: string, classType: string, moderate?: ReturnType<typeof blockWord>) {
    const d = meterDeps(moderate)
    let status = 0
    let msg = ''
    let body: any = null
    try {
      const r = await meterGraphSubmit(USER, { prompt }, d as never)
      status = r.status
      body = r.body
      msg = r.body?.error?.message ?? ''
    }
    catch (e) {
      status = (e as { statusCode?: number }).statusCode ?? 500
      msg = (e as Error).message
    }
    expect([status, msg], 'the hosted ComfyUI meter refuses it').toEqual([400, message])
    if (body) expect(Object.values(body.node_errors).map((x: any) => x.class_type)).toEqual([classType])
    expect(d.priceGraph, 'before pricing').not.toHaveBeenCalled()
    expect(d.hold, 'before any hold').not.toHaveBeenCalled()
    expect(d.forward, 'never forwarded to ComfyUI').not.toHaveBeenCalled()
  }
  async function runnerRefuses(prompt: ApiPrompt, message: string, moderate?: ReturnType<typeof blockWord>) {
    const k = kit({ script: { answers: [], files: {} }, moderate })
    const res = await startRun([prompt])
    const body = (await res.json()) as { statusMessage?: string; message?: string }
    expect([res.status, body.statusMessage ?? body.message], 'the runner\'s route refuses it').toEqual([400, message])
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.sent).toEqual([])
    return k
  }

  it('a picked LoRA (ruling (i)): refused on both paths before any hold', async () => {
    const p: ApiPrompt = {
      n: { class_type: 'FluxLoRARemoteNode', inputs: { prompt: 'a portrait of TOK', lora_name: 'trained.safetensors', lora_url: '', lora_scale: 1, aspect_ratio: '1:1', megapixels: '1', num_inference_steps: 28, guidance: 3.5, seed: 0, prompt_strength: 0.8 } },
      o: outImage('n'),
    }
    await runnerRefuses(p, LORA_BY_NAME_HOSTED)
    await meterRefuses(p, LORA_BY_NAME_HOSTED, 'FluxLoRARemoteNode')
  })

  it('a cloned voice (ruling (j)): refused on both paths before any hold', async () => {
    const speech = caseOf('runner-paid-audio-gen.json', 'speech · cloned voice')
    const p: ApiPrompt = { n: { class_type: speech.class_type, inputs: { ...speech.widgets } }, a: audioCard('n') }
    expect(String(speech.widgets.voice_id)).toMatch(/clone/)
    await runnerRefuses(p, SPEECH_VOICE_NOT_OFFERED)
    await meterRefuses(p, SPEECH_VOICE_NOT_OFFERED, speech.class_type)
  })

  it('a /view video on Describe a video\'s ComfyUI path: refused before pricing (the runner takes an upload)', async () => {
    const p: ApiPrompt = { n: { class_type: 'DescribeVideoNode', inputs: { model: 'Gemini 2.5 Flash', video_url: '/view?filename=clip.mp4&type=input', prompt: 'What happens?' } }, t: textCard('n') }
    await meterRefuses(p, DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS, 'DescribeVideoNode')
  })

  it('Generate a 3D model on the ComfyUI path: refused before pricing (runner only)', async () => {
    const p: ApiPrompt = {
      l: loadImage('image.png'),
      n: { class_type: GEN3D.class_type, inputs: { ...GEN3D.widgets, image: ['l', 0] } },
      m: { class_type: 'Model3D', inputs: { glb_url: ['n', 0] } },
    }
    await meterRefuses(p, GENERATE_3D_RUNNER_ONLY, GEN3D.class_type)
  })

  it('a blocked negative prompt (inside a preset Film a shot\'s model options): refused on both paths before any hold', async () => {
    const p: ApiPrompt = {
      n: { class_type: 'FilmShotNode', inputs: { model: 'hailuo-h3', prompt: 'the fox runs', aspect_ratio: '16:9', duration: '6', seed: 3, preset: 'orbit', model_options: JSON.stringify({ negative_prompt: 'NEGWORDS' }) } },
      v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } },
    }
    expect(isRunnerEligible(p, runnerFamilies()), 'the runner takes the shot with the brief\'s families').toBe(true)
    const runner = blockWord('NEGWORDS')
    await runnerRefuses(p, MODERATION_BLOCKED_MESSAGE, runner)
    expect(runner.mock.calls.map(c => c[0])).toContain('NEGWORDS')
    const comfy = blockWord('NEGWORDS')
    const d = meterDeps(comfy)
    await expect(meterGraphSubmit(USER, { prompt: p }, d as never)).rejects.toThrow(MODERATION_BLOCKED_MESSAGE)
    expect(comfy.mock.calls.map(c => c[0])).toContain('NEGWORDS')
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
  })
})
