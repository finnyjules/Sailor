/**
 * Step 3, Task R2.12: the controller check of stage R2 (picture effects),
 * fixture-level.
 *
 * As R1.7 (runner-cards-e2e.unit.spec.ts): the real routes through h3
 * `toWebHandler` (POST /api/runs, the SSE stream GET /api/runs/events,
 * POST /api/runs/preview); behind them the real engine, file run store, file
 * kept store and metering, hosted, with the kit's fake ledger, fake fal and
 * fake Replicate. The families come from the real `runnerFamilies()`:
 * NUXT_RUNNER_ENABLED=true and NUXT_RUNNER_FAMILIES=frame,cards,
 * effects-tone,effects-blur,effects-cells,effects-warp,effects-mask,
 * effects-noise,shader-bake,live-previews, set in-process (never .env). No
 * provider key is read and nothing reaches the network.
 *
 * Expected pixels are Python's: fixtures/runner-effects-e2e.json
 * (scripts/runner_effects_fixtures.py --group e2e) runs each workflow node by
 * node as ComfyUI does (float hand-off, the real loaders, the same node ids).
 * Exact classes are compared bit for bit; a library class (Blur, Adjust
 * curves, Film grain) within its band (R2 rule 10, ruling (b)).
 *
 * 1. Six workflows, POST /api/runs to the last event: kept pictures, previews,
 *    saved files, charges (equal to priceGraph; ruling (a): effects earn
 *    the render credit only on a graph with an output class, as the ComfyUI
 *    path does). Kept pictures: trunc8 when only Save image / Preview image
 *    read them, round8 when handed on.
 * 2. With every effects family off: the needs-engine list over every saved
 *    project graph against the code before R2.1 (564d47185, extracted with
 *    `git archive`), against a pinned per-graph hash fixture
 *    (fixtures/runner-effects-e2e-needs-engine.json, written with
 *    R212_PIN=1), and no effect class taken with its family off.
 * 3. A restart halfway through Generate an image → Blur → Adjust curves →
 *    Save image, killed during Blur.
 * 4. A live preview through /api/runs/preview.
 * 5. Add noise side by side (no assertion): R212_ADDNOISE_DIR, default
 *    /private/tmp/r212-addnoise, after
 *    `.venv/bin/python scripts/runner_effects_fixtures.py --group e2e --addnoise-dir /private/tmp/r212-addnoise`.
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, inflateSync } from 'node:zlib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import sharp from 'sharp'
import { __setEngineForTests } from '~~/server/runner/index'
import { runnerFamilies } from '~~/server/runner/config'
import { _resetRateLimits } from '~~/server/lib/rateLimit'
import { BASE_RENDER_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { createEngineResultStore, type ResultStore } from '~~/server/runner/results'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { __setPreviewDepsForTests, type PreviewDeps } from '~~/server/runner/preview'
import startRoute from '~~/server/api/runs/index.post'
import eventsRoute from '~~/server/api/runs/events.get'
import previewRoute from '~~/server/api/runs/preview.post'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerMessage } from '#shared/runner/messages'
import { RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import { EFFECT_CLASSES_PORTED, EFFECT_FAMILIES, EFFECT_FAMILY_OF, effectSchemaOf } from '#shared/runner/effects'
import { IMAGE_OUTPUT_CLASSES, PICTURE_OUTPUTS, runnerTakesNode } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { SHADER_CATALOG_VERSION, shaderBakeKeySync, shaderBakedText } from '#shared/runner/shaderBakeKey'
import { isRunnerDeclined } from '~~/app/lib/runner/client'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, until } from './__runner__/kit'
import { expectBand, runEffectCase, withAssets, type FxCase, type FxFile } from './__runner__/effectsParity'
import { withoutUnknownFields } from './helpers/pythonParity'

// ── Fixtures ─────────────────────────────────────────────────────────────

interface E2EItem { w: number; h: number; c: number; f32z: string; round8?: string; trunc8?: string; u16?: string }
interface E2EStep {
  class_type: string
  node_id: string
  widgets: Record<string, unknown>
  outputs: { kind: 'image' | 'mask'; items: E2EItem[] }[]
  preview?: { filename: string; mode: string; w: number; h: number; px: string }
}
interface E2EFlow {
  steps: E2EStep[]
  card?: { source: string; file: string }
  load?: { source: string; file: string }
  download?: { source: string; file: string }
  painter_file?: string
  frame?: { widgets: Record<string, unknown>; w: number; h: number; trunc8: string }
}
interface E2EFixture { flows: Record<string, E2EFlow>; library_eps: Record<string, number>; assets: Record<string, string>; band_eps: number }
interface NodeCase { class_type: string; links: string[]; widgets: Record<string, unknown>; call: { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }; error?: string }

const readFixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))
const FX = readFixture('runner-effects-e2e.json') as E2EFixture
const FAMILIES_FX = readFixture('runner-families.json') as { falEdit: NodeCase[] }
const EDIT = FAMILIES_FX.falEdit.find(c => c.class_type === 'EditImageNode' && !!c.call?.endpoint && !c.error && c.links.length === 1)!

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const asset = (name: string) => b64(FX.assets[name]!)
const flow = (name: string) => FX.flows[name]!
const step = (f: E2EFlow, id: string) => f.steps.find(s => s.node_id === id)!
/** Python's float32 of an item (H × W × C, interleaved). */
const pyF32 = (it: E2EItem) => { const b = inflateSync(b64(it.f32z)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
/** The library ε of a class (0: exact). */
const epsOf = (cls: string) => FX.library_eps[cls] ?? 0

// ── Nodes ────────────────────────────────────────────────────────────────

const imageCard = (file: string) => ({ class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const outImage = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const previewImage = (from: [string, number]) => ({ class_type: 'PreviewImage', inputs: { images: from } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const effect = (s: E2EStep, wires: Record<string, [string, number]>) => ({ class_type: s.class_type, inputs: { ...s.widgets, ...wires } })
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
const ON = 'frame,cards,effects-tone,effects-blur,effects-cells,effects-warp,effects-mask,effects-noise,shader-bake,live-previews'
function handler(route: any, userId: string | null = USER) {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (route: any, body: unknown) => handler(route)(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const startRun = (takes: ApiPrompt[]) => post(startRoute, { takes, workflow: { nodes: [] }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Step 3 R2' })
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

// ── Harness ──────────────────────────────────────────────────────────────

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

type Kit = ReturnType<typeof makeKit> & { keptBytes: (f: OutputFile) => Uint8Array; downloads: string[] }
/** Every provider download is this picture (Python loads it as bytesio_to_image_tensor does). */
const PROVIDER_PNG = () => asset(flow('generate_grain_edit').download!.file)

/** A hosted kit on the server's families, with a watched file kept store beside its run store; the routes use its engine. */
function kit(o: Parameters<typeof makeKit>[0] = {}): Kit {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'runner-effects-e2e-runs-'))
  const w = watchedKept(dir)
  const downloads: string[] = []
  const k = makeKit({
    hosted: true, ...o, dir,
    deps: {
      families: runnerFamilies, kept: w.kept,
      download: async (url: string) => { downloads.push(url); return { bytes: PROVIDER_PNG(), contentType: 'image/png' } },
      ...o.deps,
    },
  })
  __setEngineForTests(k.engine)
  return Object.assign(k, { keptBytes: w.bytes, downloads })
}
function writeInput(k: { root: string }, name: string, bytes: Uint8Array) {
  const path = join(k.root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}
const priceOf = (p: ApiPrompt) => priceGraph(p, { families: runnerFamilies() })

async function rawOf(bytes: Uint8Array): Promise<{ w: number; h: number; c: number; px: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, c: info.channels, px: new Uint8Array(data) }
}
const fileBytes = (root: string, f: OutputFile) => new Uint8Array(readFileSync(join(root, f.type, f.subfolder, f.filename)))

/**
 * A PNG's pixels against one of Python's 8-bit forms: bit for bit for an exact
 * class (eps 0), within the band otherwise (Python's float within eps of this
 * mode's boundary, there ±1).
 */
/**
 * Which 8-bit form a kept picture is (controller ruling on R2.12): trunc8 when only Save image / Preview
 * image read it (save_images' np.clip(255·x).astype(uint8)); round8 when it is handed on (as a float to an
 * effect or a Frame, or to a provider, whose hand-off rounds).
 */
const ONLY_SAVES = 'rule: read only by Save image / Preview image → trunc8'
const HANDED_ON = 'rule: handed on as a float → round8'
const TO_PROVIDER = 'rule: handed to a provider → the hand-off\'s round8'
async function expectPixels(png: Uint8Array, it: E2EItem, mode: 'round' | 'trunc', eps: number, label: string) {
  const got = await rawOf(png)
  expect([got.w, got.h, got.c], `${label}: size and channels`).toEqual([it.w, it.h, it.c])
  const want = b64(mode === 'round' ? it.round8! : it.trunc8!)
  if (eps === 0) {
    let first = -1
    for (let i = 0; i < want.length; i++) if (got.px[i] !== want[i]) { first = i; break }
    expect(first, `${label}: first byte that differs from Python's ${mode}8 (got ${got.px[first]}, want ${want[first]})`).toBe(-1)
    expect(got.px.length, label).toBe(want.length)
  }
  else expectBand(got.px, want, pyF32(it), null, eps, mode, label)
}

/** A kept float32 tensor file ('SFT1', c, h, w, planar floats) as Python's H × W × C floats. */
function tensorInterleaved(bytes: Uint8Array): { c: number; h: number; w: number; f: Float32Array } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(v.getUint32(0, true)).toBe(0x31544653)
  const c = v.getUint32(4, true)
  const h = v.getUint32(8, true)
  const w = v.getUint32(12, true)
  const planar = new Float32Array(bytes.slice(16).buffer)
  const n = w * h
  const f = new Float32Array(n * c)
  for (let k = 0; k < c; k++) for (let i = 0; i < n; i++) f[i * c + k] = planar[k * n + i]!
  return { c, h, w, f }
}
/** The kept float against Python's: bit for bit (exact chain), or the worst |Δ|·255 (library upstream), which is returned. */
function expectFloat(bytes: Uint8Array, it: E2EItem, exact: boolean, label: string): number {
  const t = tensorInterleaved(bytes)
  expect([t.w, t.h, t.c], `${label}: tensor shape`).toEqual([it.w, it.h, it.c])
  const py = pyF32(it)
  let worst = 0
  let firstBits = -1
  const gu = new Uint32Array(t.f.buffer)
  const pu = new Uint32Array(py.slice().buffer)
  for (let i = 0; i < py.length; i++) {
    worst = Math.max(worst, Math.abs(t.f[i]! - py[i]!) * 255)
    if (firstBits < 0 && gu[i] !== pu[i]) firstBits = i
  }
  if (exact) expect(firstBits, `${label}: first float that differs from Python's (got ${t.f[firstBits]}, want ${py[firstBits]})`).toBe(-1)
  return worst
}

/** The node's ui from its `executed` event (its preview), and the preview file's pixels. */
function shownOf(msgs: RunnerMessage[], node: string): OutputFile {
  const m = msgs.find(x => x.type === 'executed' && x.data.node === node)
  expect(m, `an executed event for ${node}`).toBeTruthy()
  return (m!.data.output as { images: OutputFile[] }).images[0]!
}
async function expectPreview(k: Kit, msgs: RunnerMessage[], s: E2EStep, eps: number, label: string) {
  const f = shownOf(msgs, s.node_id)
  const py = s.preview!
  if (!/^ComfyUI_temp_/.test(py.filename)) expect(f.filename, `${label}: preview name`).toBe(py.filename)
  const got = await rawOf(fileBytes(k.root, f))
  const channels = py.mode === 'RGBA' ? 4 : py.mode === 'RGB' ? 3 : 1
  expect([got.w, got.h, got.c], `${label}: preview size`).toEqual([py.w, py.h, channels])
  const want = b64(py.px)
  const it = s.outputs[0]!.items[0]!
  // A library class's preview is save_live_preview's trunc8 of its first output: within the band.
  if (eps > 0 && it.c === channels) expectBand(got.px, want, pyF32(it), null, eps, 'trunc', `${label}: preview`)
  else expect(Buffer.compare(Buffer.from(got.px), Buffer.from(want)), `${label}: preview pixels are Python's preview file`).toBe(0)
}

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

/**
 * The charge (controller ruling on R2.12): the closing event's credits equal
 * priceGraph for the workflow, as on the ComfyUI path. Effects earn the render
 * credit only on a graph with an output class (price.base), as the ComfyUI
 * path does; the paid nodes are charged their priceGraph prices. A stage that
 * charges something takes one hold, keyed runner:<promptId>, settled once at
 * the charge; a stage that charges nothing takes none. Returns the charge.
 */
function expectCharged(k: Kit, r: Flow, paid: string[]): { charged: number; price: ReturnType<typeof priceOf> } {
  expect(r.run.status, JSON.stringify(Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, [n.status, n.error]])))).toBe('done')
  const price = priceOf(r.prompt)
  expect(Object.keys(price.nodes).sort(), 'priceGraph prices exactly the paid nodes').toEqual([...paid].sort())
  for (const id of paid) expect(r.nodes[id]!.credits, `${id}: charged its priceGraph price`).toBe(price.nodes[id])
  const last = r.msgs.at(-1)!
  expect(last.type).toBe('execution_success')
  const charged = (last.data as { credits: number }).credits
  expect(charged, `priceGraph (${JSON.stringify(price.breakdown)})`).toBe(price.credits)
  expect(charged, 'the paid nodes plus the render credit when the graph has an output class').toBe(paid.reduce((s, id) => s + price.nodes[id]!, 0) + price.base)
  const hold = (k.ledger.hold as any).mock.calls as [string, number, string][]
  if (charged > 0) {
    expect(hold.map(c => c[2]), 'one hold').toEqual([`runner:${r.promptId}`])
    expect(hold[0]![1], 'the hold').toBe(charged)
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual]), 'settled once, at the charge').toEqual([['settled', charged]])
  }
  else expect(hold, 'nothing charged, nothing held').toEqual([])
  return { charged, price }
}

const keptOf = (r: Flow, id: string, slot = 0) => r.nodes[id]!.values![slot] as Extract<RunnerValue, { kind: 'files' | 'mask' }>

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
  // Only the SSE route's 25 s ping interval is faked, so it never fires or leaks.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.NUXT_RUNNER_ENABLED
  delete process.env.NUXT_RUNNER_FAMILIES
  __setEngineForTests(null)
  __setPreviewDepsForTests(null)
})

// ── 1. The six workflows ─────────────────────────────────────────────────

describe('R2.12 · each effects workflow, POST /api/runs to the last event (hosted, fake ledger)', () => {
  it('the server has exactly the brief\'s families on', () => {
    expect([...runnerFamilies()].sort()).toEqual(ON.split(',').sort())
  })

  it('Image card → Adjust color → Blur → Save image: Python\'s pixels at every node; charged the render credit', async () => {
    const f = flow('card_color_blur_save')
    const [color, blur] = [step(f, 'color'), step(f, 'blur')]
    const k = kit()
    writeInput(k, f.card!.file, asset(f.card!.file))
    const p: ApiPrompt = { c: imageCard(f.card!.file), color: effect(color, { image: ['c', 0] }), blur: effect(blur, { image: ['color', 0] }), s: saveImage(['blur', 0]) }
    const r = await runFlow(k, p)
    // A graph with an output class (the Image card, Save image): the effects earn the render credit (ruling (a)).
    const { charged, price } = expectCharged(k, r, [])
    expect(price.base).toBe(BASE_RENDER_CREDITS)
    expect(charged).toBe(BASE_RENDER_CREDITS)
    // Adjust color (exact): read by Blur, so kept as the hand-off's round8 and its float32 (bit for bit).
    const cv = keptOf(r, 'color')
    await expectPixels(k.keptBytes(cv.files[0]!), color.outputs[0]!.items[0]!, 'round', 0, `Adjust color kept (${HANDED_ON})`)
    expect(cv.tensors, 'Adjust color keeps its float for Blur').toHaveLength(1)
    expectFloat(k.keptBytes(cv.tensors![0]!), color.outputs[0]!.items[0]!, true, 'Adjust color float')
    await expectPreview(k, r.msgs, color, 0, 'Adjust color')
    // Blur (library): read only by Save image, so kept as save_images' trunc8 (effects/plan.ts `trunc`, R1.5).
    const bv = keptOf(r, 'blur')
    await expectPixels(k.keptBytes(bv.files[0]!), blur.outputs[0]!.items[0]!, 'trunc', epsOf('Blur'), `Blur kept (${ONLY_SAVES})`)
    await expectPreview(k, r.msgs, blur, epsOf('Blur'), 'Blur')
    // Save image: Python's save_images of Blur's float.
    const saved = r.nodes.s!.outputs
    expect(saved.map(x => x.filename)).toEqual(['ComfyUI_00001_.png'])
    await expectPixels(fileBytes(k.root, saved[0]!), blur.outputs[0]!.items[0]!, 'trunc', epsOf('Blur'), 'saved (Save image truncates)')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  }, 120_000)

  it('LoadImage → Threshold mask → Apply mask → Frame: Python\'s mask, picture and Frame render; charge', async () => {
    const f = flow('load_threshold_apply_frame')
    const [thresh, apply] = [step(f, 'thresh'), step(f, 'apply')]
    const k = kit()
    writeInput(k, f.load!.file, asset(f.load!.file))
    const p: ApiPrompt = {
      l: loadImage(f.load!.file),
      thresh: effect(thresh, { image: ['l', 0] }),
      apply: effect(apply, { image: ['l', 0], mask: ['thresh', 0] }),
      frame: { class_type: 'Compositor', inputs: frameWidgets({ ...f.frame!.widgets, layer1: ['apply', 0] }) },
    }
    const r = await runFlow(k, p)
    // No output class (LoadImage, effects, a Frame): no render credit, as on the ComfyUI path (ruling (a)).
    const { charged, price } = expectCharged(k, r, [])
    expect(price.base).toBe(0)
    expect(charged).toBe(0)
    // Threshold mask (exact): its 16 bits and its float32, bit for bit.
    const mv = keptOf(r, 'thresh')
    expect(mv.kind).toBe('mask')
    const m = await decodeMask(k.keptBytes(mv.files[0]!))
    const want = thresh.outputs[0]!.items[0]!
    expect([m.w, m.h]).toEqual([want.w, want.h])
    const u16 = b64(want.u16!)
    expect([...m.data].map(v => Math.round(v * 65535)), 'Threshold mask 16 bits').toEqual([...new Uint16Array(u16.buffer, u16.byteOffset, u16.byteLength / 2)])
    expect(mv.tensors, 'Threshold mask keeps its float for Apply mask').toHaveLength(1)
    expectFloat(k.keptBytes(mv.tensors![0]!), want, true, 'Threshold mask float')
    await expectPreview(k, r.msgs, thresh, 0, 'Threshold mask')
    // Apply mask (exact): read by the Frame, so round8 and its float.
    const av = keptOf(r, 'apply')
    await expectPixels(k.keptBytes(av.files[0]!), apply.outputs[0]!.items[0]!, 'round', 0, `Apply mask kept (${HANDED_ON})`)
    expect(av.tensors).toHaveLength(1)
    expectFloat(k.keptBytes(av.tensors![0]!), apply.outputs[0]!.items[0]!, true, 'Apply mask float')
    await expectPreview(k, r.msgs, apply, 0, 'Apply mask')
    // The Frame: Python's render as save_live_preview writes it.
    const ff = r.nodes.frame!.outputs[0]!
    const got = await rawOf(fileBytes(k.root, ff))
    expect([got.w, got.h, got.c]).toEqual([f.frame!.w, f.frame!.h, 3])
    expect(Buffer.compare(Buffer.from(got.px), Buffer.from(b64(f.frame!.trunc8))), 'Frame render').toBe(0)
  }, 120_000)

  it('Generate an image → Film grain → Edit image: with the brief\'s families Edit image\'s model has no family on (fal-edit), so the runner declines it', async () => {
    const k = kit()
    const res = await startRun([grainFlowPrompt()])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string; data?: unknown }
    expect(body.data).toEqual({ reason: 'not-eligible' })
    expect(isRunnerDeclined({ statusCode: res.status, data: body })).toBe(true)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('Generate an image (fake fal) → Film grain → Edit image (fake fal), fal-edit on too: the edit is handed Python\'s round8; charged the two calls and the render credit', async () => {
    process.env.NUXT_RUNNER_FAMILIES = `${ON},fal-edit`
    const f = flow('generate_grain_edit')
    const grain = step(f, 'grain')
    const k = kit()
    const p = grainFlowPrompt()
    const r = await runFlow(k, p)
    expectCharged(k, r, ['gen', 'edit'])
    // Two downloads (the generate's picture, then the edit's); Film grain read the first as Python's bytesio_to_image_tensor (RGBA).
    expect(k.downloads).toEqual(['https://fal.media/req1.png', 'https://fal.media/req2.png'])
    const gv = keptOf(r, 'grain')
    expect(gv.files).toHaveLength(1)
    const kept = k.keptBytes(gv.files[0]!)
    await expectPixels(kept, grain.outputs[0]!.items[0]!, 'round', epsOf('FilmGrain'), `Film grain kept (${TO_PROVIDER})`)
    await expectPreview(k, r.msgs, grain, epsOf('FilmGrain'), 'Film grain')
    // The bytes handed to the edit are the kept round8 picture.
    const up = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === gv.files[0]!.filename)
    expect(up).toHaveLength(1)
    expect(Buffer.compare(Buffer.from(up[0]![0]), Buffer.from(kept))).toBe(0)
    // fal: the generate, then the edit with Python's request and the kept picture's URL.
    const sent = k.fal.submitted()
    expect(sent).toHaveLength(2)
    const want = withoutUnknownFields('fal', EDIT.call.endpoint, EDIT.call.payload)
    const swap = (v: unknown): unknown => typeof v === 'string' && v.startsWith('IMG:') ? `https://fal.storage/${gv.files[0]!.filename}`
      : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([a, x]) => [a, swap(x)])) : v
    expect([sent[1]!.endpoint, sent[1]!.payload]).toEqual([EDIT.call.endpoint, swap(want)])
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  }, 120_000)

  it('Painter → Merge alpha → Save image: Python\'s canvas, mask, merged picture and save', async () => {
    const f = flow('painter_merge_save')
    const [paint, merge] = [step(f, 'paint'), step(f, 'merge')]
    const k = kit()
    writeInput(k, f.painter_file!, asset(f.painter_file!))
    const p: ApiPrompt = {
      paint: { class_type: 'Painter', inputs: { ...paint.widgets } },
      merge: effect(merge, { image: ['paint', 0], mask: ['paint', 1] }),
      s: saveImage(['merge', 0]),
    }
    const r = await runFlow(k, p)
    expectCharged(k, r, [])
    const iv = keptOf(r, 'paint', 0)
    await expectPixels(k.keptBytes(iv.files[0]!), paint.outputs[0]!.items[0]!, 'round', 0, `Painter picture kept (${HANDED_ON})`)
    expect(iv.tensors).toHaveLength(1)
    expectFloat(k.keptBytes(iv.tensors![0]!), paint.outputs[0]!.items[0]!, true, 'Painter picture float')
    const mv = keptOf(r, 'paint', 1)
    expect(mv.kind).toBe('mask')
    const m = await decodeMask(k.keptBytes(mv.files[0]!))
    const mw = paint.outputs[1]!.items[0]!
    const u16 = b64(mw.u16!)
    expect([...m.data].map(v => Math.round(v * 65535)), 'Painter mask 16 bits').toEqual([...new Uint16Array(u16.buffer, u16.byteOffset, u16.byteLength / 2)])
    expect(mv.tensors).toHaveLength(1)
    expectFloat(k.keptBytes(mv.tensors![0]!), mw, true, 'Painter mask float')
    // UI.PreviewImage's file (five random letters: pixels only).
    const shown = shownOf(r.msgs, 'paint')
    expect(shown.filename).toMatch(/^ComfyUI_temp_[a-z]{5}_00001_\.png$/)
    await expectPreview(k, r.msgs, paint, 0, 'Painter')
    // Merge alpha (exact): read only by Save image → trunc8; the save itself.
    await expectPixels(k.keptBytes(keptOf(r, 'merge').files[0]!), merge.outputs[0]!.items[0]!, 'trunc', 0, `Merge alpha kept (${ONLY_SAVES})`)
    await expectPreview(k, r.msgs, merge, 0, 'Merge alpha')
    await expectPixels(fileBytes(k.root, r.nodes.s!.outputs[0]!), merge.outputs[0]!.items[0]!, 'trunc', 0, 'saved (Save image truncates)')
  }, 120_000)

  it('Perlin noise → Gradient map → Preview image: Python\'s noise, map and preview file', async () => {
    const f = flow('perlin_gradient_preview')
    const [perlin, gmap] = [step(f, 'perlin'), step(f, 'gmap')]
    const k = kit()
    const p: ApiPrompt = { perlin: effect(perlin, {}), gmap: effect(gmap, { image: ['perlin', 0] }), p: previewImage(['gmap', 0]) }
    const r = await runFlow(k, p)
    expectCharged(k, r, [])
    const pv = keptOf(r, 'perlin')
    await expectPixels(k.keptBytes(pv.files[0]!), perlin.outputs[0]!.items[0]!, 'round', 0, `Perlin kept (${HANDED_ON})`)
    expect(pv.tensors).toHaveLength(1)
    expectFloat(k.keptBytes(pv.tensors![0]!), perlin.outputs[0]!.items[0]!, true, 'Perlin float')
    await expectPreview(k, r.msgs, perlin, 0, 'Perlin')
    await expectPixels(k.keptBytes(keptOf(r, 'gmap').files[0]!), gmap.outputs[0]!.items[0]!, 'trunc', 0, `Gradient map kept (${ONLY_SAVES})`)
    await expectPreview(k, r.msgs, gmap, 0, 'Gradient map')
    const shown = shownOf(r.msgs, 'p')
    expect(shown.filename).toMatch(/^ComfyUI_temp_[a-z]{5}_00001_\.png$/)
    await expectPixels(fileBytes(k.root, shown), gmap.outputs[0]!.items[0]!, 'trunc', 0, 'Preview image file')
  }, 120_000)

  it('Image card → Shader effect (a fixture bake, uploaded, with a correct sailor_baked key): the bake\'s pixels kept and shown; charged the render credit', async () => {
    const card = flow('card_color_blur_save').card!.file
    const src = await rawOf(asset(card))
    const bakeRgba = new Uint8Array(src.w * src.h * 4).map((_, i) => (i * 37 + (i >> 2) * 11) & 255)
    const bake = new Uint8Array(await sharp(bakeRgba, { raw: { width: src.w, height: src.h, channels: 4 } }).png().toBuffer())
    const bakeName = `shader_bake_${createHash('sha256').update(bake).digest('hex').slice(0, 32)}.png`
    const k = kit()
    writeInput(k, card, asset(card))
    writeInput(k, bakeName, bake)
    const inputs: Record<string, unknown> = { image: ['c', 0], effect: 'halftone', params: '{}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 768, aspect: '1:1' }
    inputs.sailor_baked = shaderBakedText([bakeName], shaderBakeKeySync(inputs, [card], SHADER_CATALOG_VERSION, [bakeName]))
    const p: ApiPrompt = { c: imageCard(card), fx: { class_type: 'ShaderEffect', inputs } }
    const r = await runFlow(k, p)
    expectCharged(k, r, [])
    const rgb = bakeRgba.filter((_, i) => i % 4 !== 3)
    const v = keptOf(r, 'fx')
    const kept = await rawOf(k.keptBytes(v.files[0]!))
    expect([kept.w, kept.h, kept.c]).toEqual([src.w, src.h, 3])
    expect(Buffer.compare(Buffer.from(kept.px), Buffer.from(rgb)), 'Shader effect kept = the bake').toBe(0)
    const shown = shownOf(r.msgs, 'fx')
    expect(shown.filename).toMatch(/^live_preview_fx_\d{5}\.png$/)
    const pv = await rawOf(fileBytes(k.root, shown))
    expect(Buffer.compare(Buffer.from(pv.px), Buffer.from(rgb)), 'Shader effect preview = the bake').toBe(0)
  }, 120_000)
})

function grainFlowPrompt(): ApiPrompt {
  const grain = step(flow('generate_grain_edit'), 'grain')
  return {
    gen: generate(),
    grain: effect(grain, { image: ['gen', 0] }),
    edit: { class_type: 'EditImageNode', inputs: { ...EDIT.widgets, input_image: ['grain', 0] } },
    o: outImage('edit'),
  }
}

// ── 2. Every effects family off: needs-engine over the saved projects ────

const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
const REPO = resolve(__dirname, '../../..')
/** Stage R2's base (progress.md: "R2.1 BASE=564d47185"): the code before R2.1. */
const BEFORE_R2 = '564d47185'
const PIN_FILE = fileURLToPath(new URL('./fixtures/runner-effects-e2e-needs-engine.json', import.meta.url))
/** Classes whose runner rules changed after 564d47185 outside stage R2 (git log -S FilmShotNode: 729060504, Shot Director). */
const OUTSIDE_R2: ReadonlySet<string> = new Set(['FilmShotNode'])
const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

interface SavedGraph { key: string; prompt: ApiPrompt }
async function savedGraphs(): Promise<SavedGraph[]> {
  const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
  const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
  const out: SavedGraph[] = []
  for (const uuid of readdirSync(PROJECTS).sort()) {
    let wf: { canvases?: { workflow: unknown }[] } | undefined
    try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
    catch { continue }
    ;(wf?.canvases ?? []).forEach((c, i) => {
      try { out.push({ key: `${uuid}#${i}`, prompt: graphToPrompt(c.workflow as never, catalog) }) }
      catch { /* a canvas the prompt builder can't read is left out, as R2.1 / R2.10 did */ }
    })
  }
  return out
}

describe('R2.12 · every effects family off: the needs-engine list over every saved project', () => {
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  /** Frame and cards only; and every family that existed before R2.1 (set in the test from the old code). */
  const FRAME_CARDS: ReadonlySet<RunnerFamily> = new Set(['frame', 'cards'])

  projectsIt('equals the code before R2.1 (git archive 564d47185), graph by graph, and no effect class is taken with its family off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r212-before-r2-'))
    execSync(`git -C ${JSON.stringify(REPO)} archive ${BEFORE_R2} frontend/shared frontend/app/data | tar -x -C ${JSON.stringify(dir)}`)
    const oldNeeds = await import(pathToFileURL(join(dir, 'frontend/shared/runner/needsEngine.ts')).href) as typeof import('#shared/runner/needsEngine')
    const oldFam = await import(pathToFileURL(join(dir, 'frontend/shared/runner/families.ts')).href) as { RUNNER_FAMILIES: readonly string[] }
    expect(oldFam.RUNNER_FAMILIES.some(x => x.startsWith('effects-'))).toBe(false)
    const allOld: ReadonlySet<RunnerFamily> = new Set(oldFam.RUNNER_FAMILIES.filter(x => (RUNNER_FAMILIES as readonly string[]).includes(x)) as RunnerFamily[])
    const sets: [string, ReadonlySet<RunnerFamily>][] = [['frame + cards', FRAME_CARDS], ['every family before R2.1', allOld]]
    const graphs = await savedGraphs()
    const diffs: string[] = []
    const outside: string[] = []
    let effectNodes = 0
    for (const g of graphs) {
      const titleOf = (id: string) => id
      for (const [label, families] of sets) {
        const now = nodesNeedingEngine(g.prompt, { runnerOn: true, families, titleOf })
        const before = oldNeeds.nodesNeedingEngine(g.prompt as never, { runnerOn: true, families: families as never, titleOf })
        if (JSON.stringify(now) !== JSON.stringify(before)) {
          const moved = [...now.filter(x => !before.includes(x)), ...before.filter(x => !now.includes(x))]
          const classes = [...new Set(moved.map(id => g.prompt[id]?.class_type ?? '?'))]
          const line = `${g.key} (${label}): now ${JSON.stringify(now)} before ${JSON.stringify(before)}; classes ${classes.join(', ')}`
          // Shot Director's Film a shot became the runner's in 729060504 (another stream, after 564d47185, not R2).
          if (classes.every(c => OUTSIDE_R2.has(c))) outside.push(line)
          else diffs.push(line)
        }
        for (const [id, n] of Object.entries(g.prompt)) {
          const fam = EFFECT_FAMILY_OF[n.class_type]
          if (!fam) continue
          effectNodes++
          expect(families.has(fam)).toBe(false)
          expect(runnerTakesNode(g.prompt, id, families), `${g.key} ${id} ${n.class_type} (${label})`).toBe(false)
        }
      }
    }
    console.info(`R2.12 needs-engine vs ${BEFORE_R2}: ${graphs.length} saved graphs × ${sets.length} family sets, ${effectNodes / sets.length} effect nodes; ${diffs.length} differ, ${outside.length} differ only in classes changed outside R2:\n${outside.join('\n')}`)
    expect(graphs.length).toBeGreaterThanOrEqual(800)
    expect(diffs.slice(0, 20), `${diffs.length} graphs differ from the code before R2.1`).toEqual([])
  }, 600_000)

  projectsIt('with every ported effect class spliced in after the pictures of the saved graphs: not taken with its family off, and the list is the list with that class unknown (as before R2.1)', async () => {
    const graphs = await savedGraphs()
    const effectsOff: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(x => !(EFFECT_FAMILIES as readonly string[]).includes(x)))
    const sets: [string, ReadonlySet<RunnerFamily>][] = [['frame + cards', FRAME_CARDS], ['every family but the effects', effectsOff]]
    const unknown = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, n.class_type) ? { ...n, class_type: `${n.class_type}__unknown` } : n]))
    const widgetsOf = (cls: string) => Object.fromEntries(Object.entries(effectSchemaOf(cls)!.widgets).map(([name, w]) => {
      const x = w as { type: string; min?: number; options?: string[] }
      return [name, x.type === 'FLOAT' || x.type === 'INT' ? (x.min ?? 0) : x.type === 'COMBO' ? x.options![0] : x.type === 'BOOLEAN' ? false : '']
    }))
    const perClass = new Map<string, number>()
    const bad: string[] = []
    let spliced = 0
    let changedWhenOn = 0
    graphs.forEach((g, gi) => {
      EFFECT_CLASSES_PORTED.forEach((cls, ci) => {
        if ((gi + ci) % 8 !== 0) return
        const schema = effectSchemaOf(cls)!
        const out: ApiPrompt = JSON.parse(JSON.stringify(g.prompt))
        const added: string[] = []
        const mask = schema.masks.length ? (out.r212_mask_src = { class_type: 'LoadImage', inputs: { image: 'mask.png', upload: 'image' } }, ['r212_mask_src', 1] as [string, number]) : null
        const wiresFor = (from: [string, number] | null) => Object.fromEntries([
          ...schema.images.map(i => [i.name, from]).filter(([, v]) => v),
          ...schema.masks.map(m => [m.name, mask]),
        ])
        if (!schema.images.length) {
          out.r212_fx = { class_type: cls, inputs: { ...widgetsOf(cls), ...wiresFor(null) } }
          out.r212_save = saveImage(['r212_fx', 0])
          added.push('r212_fx')
        }
        else {
          for (const [id, n] of Object.entries(g.prompt)) {
            const slots = Object.prototype.hasOwnProperty.call(PICTURE_OUTPUTS, n.class_type) ? PICTURE_OUTPUTS[n.class_type]! : IMAGE_OUTPUT_CLASSES.has(n.class_type) ? [0] : []
            for (const slot of slots) {
              const fx = `r212_${id}_${slot}`
              for (const r of Object.values(out)) {
                for (const [name, v] of Object.entries(r.inputs ?? {})) if (Array.isArray(v) && v.length === 2 && v[0] === id && v[1] === slot) r.inputs[name] = [fx, 0]
              }
              out[fx] = { class_type: cls, inputs: { ...widgetsOf(cls), ...wiresFor([id, slot]) } }
              added.push(fx)
            }
          }
        }
        if (!added.length) return
        spliced++
        perClass.set(cls, (perClass.get(cls) ?? 0) + 1)
        for (const [label, families] of sets) {
          const titleOf = (id: string) => id
          const now = nodesNeedingEngine(out, { runnerOn: true, families, titleOf })
          const before = nodesNeedingEngine(unknown(out), { runnerOn: true, families, titleOf })
          if (JSON.stringify(now) !== JSON.stringify(before)) bad.push(`${g.key} + ${cls} (${label}): now ${JSON.stringify(now)} as unknown ${JSON.stringify(before)}`)
          for (const id of added) if (runnerTakesNode(out, id, families)) bad.push(`${g.key} + ${cls} (${label}): ${id} taken with its family off`)
        }
        const on = new Set<RunnerFamily>(RUNNER_FAMILIES)
        if (JSON.stringify(nodesNeedingEngine(out, { runnerOn: true, families: on, titleOf: id => id })) !== JSON.stringify(nodesNeedingEngine(unknown(out), { runnerOn: true, families: on, titleOf: id => id }))) changedWhenOn++
      })
    })
    console.info(`R2.12 spliced: ${spliced} graphs with an effect spliced in, ${perClass.size}/${EFFECT_CLASSES_PORTED.length} classes (fewest ${Math.min(...perClass.values())} graphs), ${changedWhenOn} read differently with every family on`)
    expect(perClass.size).toBe(EFFECT_CLASSES_PORTED.length)
    expect(changedWhenOn, 'the check has teeth: with the families on, spliced effects are taken').toBeGreaterThan(0)
    expect(bad.slice(0, 20), `${bad.length} spliced graphs differ`).toEqual([])
  }, 600_000)

  projectsIt('equals the pinned per-graph hashes (fixtures/runner-effects-e2e-needs-engine.json; R212_PIN=1 writes it)', async () => {
    const effectsOff: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(x => !(EFFECT_FAMILIES as readonly string[]).includes(x)))
    const sets: Record<string, ReadonlySet<RunnerFamily>> = { frameCards: FRAME_CARDS, allButEffects: effectsOff }
    const now: Record<string, { prompt: string } & Record<string, string>> = {}
    for (const g of await savedGraphs()) {
      const row: { prompt: string } & Record<string, string> = { prompt: short(JSON.stringify(g.prompt)) }
      for (const [name, families] of Object.entries(sets)) row[name] = short(JSON.stringify(nodesNeedingEngine(g.prompt, { runnerOn: true, families, titleOf: id => id })))
      now[g.key] = row
    }
    if (process.env.R212_PIN === '1') {
      writeFileSync(PIN_FILE, `${JSON.stringify({
        note: 'Written by tests/unit/runner-effects-e2e.unit.spec.ts with R212_PIN=1: per saved project canvas, the sha256 (16 hex) of its prompt and of nodesNeedingEngine with every effects family off (frame + cards; every family but the effects).',
        families: Object.fromEntries(Object.entries(sets).map(([n, s]) => [n, [...s].sort()])),
        graphs: now,
      }, null, 1)}\n`)
    }
    const pinned = JSON.parse(readFileSync(PIN_FILE, 'utf8')) as { families: Record<string, string[]>; graphs: typeof now }
    expect(pinned.families.frameCards).toEqual([...FRAME_CARDS].sort())
    let same = 0
    let changed = 0
    let unpinned = 0
    const differ: string[] = []
    for (const [key, row] of Object.entries(now)) {
      const p = pinned.graphs[key]
      if (!p) { unpinned++; continue }
      if (p.prompt !== row.prompt) { changed++; continue }
      same++
      if (p.frameCards !== row.frameCards || p.allButEffects !== row.allButEffects) differ.push(key)
    }
    console.info(`R2.12 pinned needs-engine: ${same} graphs as pinned, ${changed} edited since, ${unpinned} new, ${Object.keys(pinned.graphs).length - same - changed} gone`)
    expect(same).toBeGreaterThan(0)
    expect(differ).toEqual([])
  }, 600_000)
})

// ── 3. A restart halfway through a chain of effects after a paid node ────

describe('R2.12 · a restart during Blur, after the paid node finished', () => {
  it('Generate an image → Blur → Adjust curves → Save image: the paid node charged once, the effects run again from its file, Python\'s pixels', async () => {
    const f = flow('generate_blur_curves_save')
    const [blur, curves] = [step(f, 'blur'), step(f, 'curves')]
    const fal = createFakeFal()
    const replicate = createFakeReplicate()
    const ledger = createFakeLedger()
    const root = mkdtempSync(join(tmpdir(), 'runner-effects-e2e-root-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    const base: ResultStore = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    // The old server dies while Blur reads the provider's picture: that read never answers.
    const state = { blurRead: false }
    const dying: ResultStore = { ...base, read: async (file) => {
      if (file.type === 'output') { state.blurRead = true; return new Promise<Uint8Array>(() => {}) }
      return base.read(file)
    } }
    const p: ApiPrompt = { gen: generate(), blur: effect(blur, { image: ['gen', 0] }), curves: effect(curves, { image: ['blur', 0] }), s: saveImage(['curves', 0]) }
    const k1 = kit({ root, fal, replicate, ledger, deps: { results: dying } })
    const { runId, promptIds } = await started([p])
    await until(() => state.blurRead, 30_000)
    await new Promise(r => setTimeout(r, 20))
    const before = (await k1.store.get(runId))!
    const bn = before.takes[0]!.nodes
    expect(bn.gen!.status, 'the paid node finished before the crash').toBe('done')
    expect(bn.blur!.status, 'Blur was running').toBe('running')
    expect(bn.curves!.status).not.toBe('done')
    expect(fal.submitted()).toHaveLength(1)
    expect(k1.downloads).toHaveLength(1)
    const genFile = bn.gen!.outputs[0]!
    const genBytes = readFileSync(join(root, genFile.type, genFile.subfolder, genFile.filename))
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect(ledger.settle).not.toHaveBeenCalled()

    // A new server on the same run store, kept store and files; reattach, as server start does.
    const k2 = kit({ dir: k1.dir, root, fal, replicate, ledger })
    const events = await openEvents()
    expect(await k2.engine.reattach()).toBe(1)
    await events.until(m => m.some(ends(promptIds[0]!)))
    await k2.engine.settled(runId)
    const run = (await k2.store.get(runId))!
    expect(run.status).toBe('done')
    const nodes = run.takes[0]!.nodes
    // The paid node: sent once, not downloaded again, its file unchanged; charged once.
    expect(fal.submitted()).toHaveLength(1)
    expect(k2.downloads).toEqual([])
    expect(nodes.gen!.outputs[0]).toEqual(genFile)
    expect(Buffer.compare(readFileSync(join(root, genFile.type, genFile.subfolder, genFile.filename)), genBytes)).toBe(0)
    const price = priceOf(p)
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect(ledger.settle).toHaveBeenCalledTimes(1)
    expect([...ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', price.credits]])
    expect(price.credits).toBe(price.nodes.gen! + BASE_RENDER_CREDITS)
    expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: price.credits } })
    // The effects ran again from that file, to Python's pixels.
    for (const id of ['blur', 'curves', 's']) expect(nodes[id]!.status, id).toBe('done')
    const bv = nodes.blur!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    await expectPixels(k2.keptBytes(bv.files[0]!), blur.outputs[0]!.items[0]!, 'round', epsOf('Blur'), `Blur kept after the restart (${HANDED_ON})`)
    const worst = expectFloat(k2.keptBytes(bv.tensors![0]!), blur.outputs[0]!.items[0]!, false, 'Blur float')
    // Curves reads Blur's float: its band is rule 10's cap (ruling (b)), the error Blur hands on included.
    const saved = nodes.s!.outputs[0]!
    await expectPixels(fileBytes(root, saved), curves.outputs[0]!.items[0]!, 'trunc', FX.band_eps, 'saved after the restart')
    console.info(`R2.12 restart: Blur's float worst |Δ|·255 = ${worst.toExponential(2)}`)
  }, 120_000)
})

// ── 4. A live preview through /api/runs/preview ──────────────────────────

describe('R2.12 · a live preview through /api/runs/preview', () => {
  it('Image card → Blur → Adjust curves: no hold, no ledger entry, no event; the full run\'s pixels (and Python\'s)', async () => {
    const f = flow('card_blur_curves_preview')
    const [blur, curves] = [step(f, 'blur'), step(f, 'curves')]
    const file = f.card!.file
    const p: ApiPrompt = { c: imageCard(file), blur: effect(blur, { image: ['c', 0] }), curves: effect(curves, { image: ['blur', 0] }) }

    const k = kit()
    writeInput(k, file, asset(file))
    const deps: PreviewDeps = {
      runnerOn: () => true, families: runnerFamilies, hosted: () => true, results: k.deps.results,
      ownership: { ownsInput: async (_u, x) => x.filename === file, ownsOutput: async () => false },
    }
    __setPreviewDepsForTests(deps)
    const events = await openEvents()
    const res = await post(previewRoute, { canvasId: 'c1', nodeId: 'curves', prompt: p, pinned: { c: [{ filename: file, subfolder: '', type: 'input' }] } })
    expect(res.status, await res.clone().text()).toBe(200)
    const { ui } = await res.json() as { ui: { images: OutputFile[]; animated: boolean[] } }
    expect(ui.images).toHaveLength(1)
    expect(ui.images[0]!.filename).toBe('live_preview_curves.png')
    expect(ui.animated).toEqual([false])
    await new Promise(r => setTimeout(r, 50))
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.ledger.settle).not.toHaveBeenCalled()
    expect(k.ledger.holds.size).toBe(0)
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.records.write).not.toHaveBeenCalled()
    expect(events.msgs, 'no run event').toEqual([])
    expect(k.seen).toEqual([])
    const fromPreview = fileBytes(k.root, ui.images[0]!)

    // The full run of the same workflow, through /api/runs.
    const k2 = kit()
    writeInput(k2, file, asset(file))
    const r = await runFlow(k2, p)
    expect(r.run.status).toBe('done')
    const fromRun = fileBytes(k2.root, shownOf(r.msgs, 'curves'))
    expect(Buffer.compare(Buffer.from(fromPreview), Buffer.from(fromRun)), 'the preview file is the full run\'s, byte for byte').toBe(0)
    await expectPreview(k, [{ type: 'executed', data: { node: 'curves', output: ui } } as unknown as RunnerMessage], curves, FX.band_eps, 'preview vs Python')
  }, 120_000)
})

// ── 5. Add noise side by side (for the controller's eyes; no assertion) ──

const ADDNOISE_DIR = process.env.R212_ADDNOISE_DIR ?? '/private/tmp/r212-addnoise'
describe('R2.12 · Add noise side by side', () => {
  it.skipIf(!existsSync(join(ADDNOISE_DIR, 'manifest.json')))('writes the runner\'s Add noise beside Python\'s, and a python | runner sheet for each', async () => {
    const man = JSON.parse(readFileSync(join(ADDNOISE_DIR, 'manifest.json'), 'utf8')) as { ramp: string; side: number; rows: { type: string; monochromatic: boolean; seed: number; amount: number; python: string }[] }
    const ramp = new Uint8Array(readFileSync(join(ADDNOISE_DIR, man.ramp)))
    const families = parseFamilies('cards,effects-noise')
    const fx = withAssets({ torch: '', threads: 0, platform: '', band_eps: 0, assets: { 'ramp.png': Buffer.from(ramp).toString('base64') }, cases: [] } as FxFile)
    const stats = (px: Uint8Array, base: Uint8Array) => {
      let s = 0; let s2 = 0
      for (let i = 0; i < px.length; i++) { const d = px[i]! - base[i]!; s += d; s2 += d * d }
      const m = s / px.length
      return { mean: m, std: Math.sqrt(s2 / px.length - m * m) }
    }
    const rampPx = (await rawOf(ramp)).px
    const lines: string[] = []
    for (const row of man.rows) {
      const c: FxCase = { name: row.python, class_type: 'AddNoise', node_id: `an${row.seed}`, widgets: { amount: row.amount, type: row.type, monochromatic: row.monochromatic }, inputs: { image: { source: 'rgb', files: ['ramp.png'] } } }
      fx.cases.push(c)
      withAssets(fx)
      const run = await runEffectCase(c, { families })
      const runnerPng = run.previews[0]!.bytes
      const tag = `${row.type}_${row.monochromatic ? 'mono' : 'colour'}_s${row.seed}`
      writeFileSync(join(ADDNOISE_DIR, `runner_${tag}.png`), runnerPng)
      const py = new Uint8Array(readFileSync(join(ADDNOISE_DIR, row.python)))
      const gap = 8
      const sheet = await sharp({ create: { width: man.side * 2 + gap, height: man.side, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .composite([{ input: Buffer.from(py), left: 0, top: 0 }, { input: Buffer.from(runnerPng), left: man.side + gap, top: 0 }]).png().toBuffer()
      writeFileSync(join(ADDNOISE_DIR, `sheet_${tag}.png`), sheet)
      const a = stats((await rawOf(py)).px, rampPx)
      const b = stats((await rawOf(runnerPng)).px, rampPx)
      lines.push(`${tag}: python Δ mean ${a.mean.toFixed(3)} std ${a.std.toFixed(3)} | runner Δ mean ${b.mean.toFixed(3)} std ${b.std.toFixed(3)}`)
    }
    writeFileSync(join(ADDNOISE_DIR, 'stats.txt'), `${lines.join('\n')}\n`)
    console.info(`R2.12 Add noise sheets in ${ADDNOISE_DIR}:\n${lines.join('\n')}`)
  }, 120_000)
})
