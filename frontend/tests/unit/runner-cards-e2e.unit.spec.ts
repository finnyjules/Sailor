/**
 * Step 3, Task R1.7: the controller check, fixture-level, `cards` on.
 *
 * Everything goes through the real routes (h3 `toWebHandler`, as
 * runner-routes.unit.spec.ts and runner-phase-b-e2e.unit.spec.ts do):
 * POST /api/runs and the SSE stream GET /api/runs/events. Behind them is the
 * real engine, file run store, file kept store and metering (hosted, with the
 * kit's fake ledger), the kit's fake fal and fake Replicate, and a fake
 * moderation service. The server's families come from the real
 * `runnerFamilies()`: NUXT_RUNNER_ENABLED=true,
 * NUXT_RUNNER_FAMILIES=frame,fal-edit,restyle,cards. No provider key is read
 * and nothing reaches the network (FAL_KEY, NUXT_REPLICATE_TOKEN and
 * REPLICATE_API_TOKEN must be unset).
 *
 * Provider requests are checked against the committed Python fixtures
 * (fixtures/runner-cards.json `wired_text`, fixtures/runner-families.json
 * `falEdit`); card outputs against runner-cards.json (`scene3d`,
 * `image_to_mask`, `smart_layout`). Charges against `priceGraph`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import sharp from 'sharp'
import { __setEngineForTests } from '~~/server/runner/index'
import { runnerFamilies } from '~~/server/runner/config'
import { _resetRateLimits } from '~~/server/lib/rateLimit'
import { BASE_RENDER_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { ReplicateError } from '~~/server/runner/replicateQueue'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { smartLayoutRenderer } from '~~/server/runner/cards/smartLayout'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { MODERATION_BLOCKED_MESSAGE } from '~~/server/utils/moderation'
import startRoute from '~~/server/api/runs/index.post'
import eventsRoute from '~~/server/api/runs/events.get'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerMessage } from '#shared/runner/messages'
import type { RunnerFamily } from '#shared/runner/families'
import { staticValueOf } from '#shared/runner/staticValues'
import { nodesNeedingEngine } from '~~/app/lib/runner/needsEngine'
import { isRunnerDeclined } from '~~/app/lib/runner/client'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import type { RenderRequest } from '~~/server/templates/schema'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, until } from './__runner__/kit'
import { withoutUnknownFields } from './helpers/pythonParity'

// Every R1 card's text is known at the start of a run, even through a Gate
// (staticWiredTexts reads each card's own words wherever they are wired), so
// a blocked word is refused before any hold. A text only known by running
// (R3's text nodes) is not. As runner-values-moderation.unit.spec.ts does,
// the start's reading is switched off in the one test that stands for such a
// text; everywhere else it is the real one.
const modState = vi.hoisted(() => ({ startKnows: true }))
vi.mock('#shared/runner/staticValues', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/runner/staticValues')>()
  return { ...real, staticWiredTexts: (...a: Parameters<typeof real.staticWiredTexts>) => modState.startKnows ? real.staticWiredTexts(...a) : [] }
})

// ── Fixtures ─────────────────────────────────────────────────────────────

interface WiredCase { name: string; class_type: string; inputs: Record<string, unknown>; links: string[]; reading_json?: string; provider: string; endpoint: string; payload: Record<string, unknown> }
interface Image8 { w: number; h: number; rgb8?: string; fill?: [number, number, number] }
interface Scene3DCase { name: string; beauty_image: string; depth_image: string; normal_image: string; files: Record<string, string>; outputs: Image8[] }
interface Mask16 { w: number; h: number; mask16?: string; mask16_sha256?: string }
interface ToMaskCase { name: string; via: string; files: Record<string, string>; names: string[]; channel: string; channels: number; error?: true; masks?: Mask16[] }
interface ExecuteCase { name: string; inputs: Record<string, string>; node_id: string; error?: string; bodies: Record<string, unknown>[]; ui?: { images: OutputFile[] } }
interface NodeCase { class_type: string; links: string[]; widgets: Record<string, unknown>; call: { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> }; error?: string }

const readFixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'))
const CARDS_FX = readFixture('runner-cards.json') as {
  wired_text: WiredCase[]; scene3d: Scene3DCase[]; image_to_mask: ToMaskCase[]; smart_layout: { execute: ExecuteCase[] }
}
const FAMILIES_FX = readFixture('runner-families.json') as { falEdit: NodeCase[] }

function pick<T>(list: T[], label: string, ok: (c: T) => boolean): T {
  const c = list.find(ok)
  if (!c) throw new Error(`fixture has no ${label} case`)
  return c
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const u16 = (s: string) => { const b = Buffer.from(s, 'base64'); return [...new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2)] }
/** Python's pictures (IMG:<input>) as the kit's hand-off names a file: https://fal.storage/<file name>. */
function handedOff(payload: Record<string, unknown>, files: Record<string, string>): Record<string, unknown> {
  const swap = (v: unknown): unknown =>
    typeof v === 'string' && v.startsWith('IMG:') ? `https://fal.storage/${files[v.slice(4)] ?? `${v.slice(4)}.png`}`
      : Array.isArray(v) ? v.map(swap)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v
  return swap(payload) as Record<string, unknown>
}

// The fixture cases each workflow is built from.
const IDEA = pick(CARDS_FX.wired_text, 'flux-schnell prompt_in', c => c.name === 'flux-schnell, prompt \'a red fox\': prompt_in')
const TASTE = pick(CARDS_FX.wired_text, 'restyle from a Moodboard', c => c.class_type === 'RestyleFromImageNode' && c.inputs.prompt === 'watercolor' && !!c.reading_json)
const EDIT = pick(FAMILIES_FX.falEdit, 'fal-edit Edit', c => c.class_type === 'EditImageNode' && !!c.call?.endpoint && !c.error && c.links.length === 1)
const SCENE = pick(CARDS_FX.scene3d, 'three good bakes', c => c.name.startsWith('three good bakes'))
const TO_MASK = pick(CARDS_FX.image_to_mask, 'LoadImage red', c => c.via === 'load' && c.channel === 'red' && !c.error)
const LAYOUT = pick(CARDS_FX.smart_layout.execute, 'aspects repeated', c => c.name === 'aspects repeated')

// ── Nodes ────────────────────────────────────────────────────────────────

const imageCard = (file: string) => ({ class_type: 'Image', inputs: { image: file } })
const outImage = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const loadImage = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
const scene3d = () => ({ class_type: 'Scene3DStudio', inputs: { scene_state: '{}', beauty_image: SCENE.beauty_image, depth_image: '', normal_image: '', glb_url: '' } })
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })

interface CardFlow {
  label: string
  prompt: ApiPrompt
  /** Input files to write: name → bytes. */
  files: Record<string, Uint8Array>
  /** The card node ids, in prompt order (what nodesNeedingEngine names with `cards` off). */
  cards: string[]
}

/** 1. Primitive → Gate (bypass) → Generate an image `prompt_in` → Image card. */
const ideaFlow = (): CardFlow => ({
  label: 'Primitive → Gate (bypass) → Generate an image prompt_in',
  prompt: {
    p: { class_type: 'PrimitiveString', inputs: { value: String(IDEA.inputs.prompt_in) } },
    g: { class_type: 'ComfyGateNode', inputs: { data_in: ['p', 0], bypass: true } },
    1: { class_type: 'GenerateImageNode', inputs: { ...IDEA.inputs, prompt_in: ['g', 0] } },
    2: outImage('1'),
  },
  files: {},
  cards: ['p'],
})
/** 2. Moodboard → Restyle `style_in` (content from an Image card) → Image card. */
const tasteFlow = (): CardFlow => ({
  label: 'Moodboard → Restyle style_in',
  prompt: {
    m: { class_type: 'Moodboard', inputs: { reading_json: TASTE.reading_json!, moodboard_id: 'mb_1' } },
    11: imageCard('content_image.png'),
    1: { class_type: 'RestyleFromImageNode', inputs: { ...TASTE.inputs, content_image: ['11', 0], style_in: ['m', 0] } },
    2: outImage('1'),
  },
  files: { 'content_image.png': new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 7, 7]) },
  cards: ['m'],
})
/** 3. Text → Smart Layout `text_layer_2` → Save image (Python's node id 17, for its preview names). */
const layoutFlow = (): CardFlow => {
  const inputs: Record<string, unknown> = { ...LAYOUT.inputs, text_layer_2: ['t', 0] }
  return {
    label: 'Text → Smart Layout → Save image',
    prompt: {
      t: { class_type: 'Text', inputs: { text: LAYOUT.inputs.text_layer_2! } },
      [LAYOUT.node_id]: { class_type: 'SmartLayout', inputs },
      s: saveImage([LAYOUT.node_id, 0]),
    },
    files: {},
    cards: ['t', LAYOUT.node_id, 's'],
  }
}
/** 4. 3D Studio (its RGBA beauty bake) → Edit image → Image card. */
const sceneFlow = (): CardFlow => ({
  label: '3D Studio → Edit image',
  prompt: {
    s: scene3d(),
    1: { class_type: 'EditImageNode', inputs: { ...EDIT.widgets, input_image: ['s', 0] } },
    2: outImage('1'),
  },
  files: { [SCENE.beauty_image]: b64(SCENE.files[SCENE.beauty_image]!) },
  cards: ['s'],
})
/** 5. LoadImage → Image to mask; the same LoadImage → Save image (the workflow's output). */
const maskFlow = (): CardFlow => ({
  label: 'LoadImage → Image to mask',
  prompt: {
    l: loadImage(TO_MASK.names[0]!),
    u: { class_type: 'ImageToMask', inputs: { image: ['l', 0], channel: TO_MASK.channel } },
    s: saveImage(['l', 0]),
  },
  files: { [TO_MASK.names[0]!]: b64(TO_MASK.files[TO_MASK.names[0]!]!) },
  cards: ['l', 'u', 's'],
})

// ── The routes ───────────────────────────────────────────────────────────

const USER = 'user_1'
const ON = 'frame,fal-edit,restyle,cards'
const OFF = 'frame,fal-edit,restyle'
function handler(route: any, userId: string | null = USER) {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (route: any, body: unknown) => handler(route)(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const startRun = (takes: ApiPrompt[]) => post(startRoute, { takes, workflow: { nodes: [] }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Step 3' })
async function started(takes: ApiPrompt[]): Promise<{ runId: string; legId: string; promptIds: string[] }> {
  const res = await startRun(takes)
  if (res.status !== 200) throw new Error(`POST /api/runs → ${res.status}: ${await res.text()}`)
  return await res.json()
}

/** GET /api/runs/events, read in the background: every runner message, in order (named ready/ping left out). */
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
  // Left open, not cancelled (see runner-phase-b-e2e.unit.spec.ts): its ping interval is faked.
  return { msgs, until: (check: (m: RunnerMessage[]) => boolean, ms = 30_000) => until(() => check(msgs), ms) }
}
const ends = (promptId: string) => (m: RunnerMessage) =>
  (m.type === 'execution_success' || m.type === 'execution_error') && m.data.prompt_id === promptId

// ── Harness ──────────────────────────────────────────────────────────────

type Kit = ReturnType<typeof makeKit>
/** A hosted kit on the server's families, with a file kept store beside its run store; the routes use its engine. */
function kit(o: Parameters<typeof makeKit>[0] = {}): Kit {
  // The kept store sits beside the run store, so a second kit on the same folder (a restart) shares it.
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'runner-cards-e2e-runs-'))
  const k = makeKit({ hosted: true, ...o, dir, deps: { families: runnerFamilies, kept: createFileKeptBytes(join(dir, 'runner-kept')), ...o.deps } })
  __setEngineForTests(k.engine)
  return k
}
function writeFiles(k: Kit, files: Record<string, Uint8Array>) {
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(k.root, 'input', name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
  }
}
const holds = (k: Kit) => [...k.ledger.holds.values()].map(h => [h.state, h.actual])
const blockWord = (word: string) => vi.fn(async (text: string) => text.includes(word) ? { ok: false as const, categories: ['test'] } : { ok: true as const })
const priceOf = (p: ApiPrompt) => priceGraph(p, { families: runnerFamilies() })

async function expectRgb(bytes: Uint8Array, want: Image8, label: string) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height, info.channels], label).toEqual([want.w, want.h, 3])
  expect(Buffer.compare(data, Buffer.from(want.rgb8!, 'base64')), label).toBe(0)
}

/** Runs one workflow from POST /api/runs to its last event; the stage's run, events and price. */
async function runFlow(k: Kit, f: CardFlow) {
  writeFiles(k, f.files)
  const events = await openEvents()
  const { runId, promptIds } = await started([f.prompt])
  expect(promptIds).toEqual([`${runId}.0.t0`])
  await events.until(m => m.some(ends(promptIds[0]!)))
  await k.engine.settled(runId)
  const run = (await k.store.get(runId))!
  const price = priceOf(f.prompt)
  return { runId, promptId: promptIds[0]!, run, events, price, nodes: run.takes[0]!.nodes }
}
/** The stage's closing event carries the charge; the hold was taken once and settled at it. */
function expectCharged(k: Kit, r: Awaited<ReturnType<typeof runFlow>>) {
  expect(r.run.status).toBe('done')
  expect(k.ledger.hold).toHaveBeenCalledTimes(1)
  expect(k.ledger.hold).toHaveBeenCalledWith(USER, r.price.credits, `runner:${r.promptId}`)
  expect(holds(k)).toEqual([['settled', r.price.credits]])
  const last = r.events.msgs.at(-1)!
  expect(last.type).toBe('execution_success')
  expect(last.data).toMatchObject({ prompt_id: r.promptId, run_id: r.runId, credits: r.price.credits, stopped: false, canvas_id: 'c1' })
  expect(r.events.msgs[0]).toMatchObject({ type: 'execution_start', data: { prompt_id: r.promptId } })
}

beforeAll(() => {
  // The evidence only counts with no provider key in the environment.
  expect(process.env.FAL_KEY).toBeUndefined()
  expect(process.env.NUXT_REPLICATE_TOKEN).toBeUndefined()
  expect(process.env.REPLICATE_API_TOKEN).toBeUndefined()
})
beforeEach(() => {
  process.env.NUXT_RUNNER_ENABLED = 'true'
  process.env.NUXT_RUNNER_FAMILIES = ON
  _resetRateLimits()
  modState.startKnows = true
  // Only the SSE route's 25 s ping interval is faked, so it never fires or leaks.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.NUXT_RUNNER_ENABLED
  delete process.env.NUXT_RUNNER_FAMILIES
  __setEngineForTests(null)
})

// ── 1. Each workflow, POST /api/runs to the last event ───────────────────

describe('R1.7 · each card workflow, `cards` on, POST /api/runs to the last event', () => {
  it('the server has exactly frame, fal-edit, restyle and cards on', () => {
    expect([...runnerFamilies()].sort()).toEqual(['cards', 'fal-edit', 'frame', 'restyle'])
  })

  it('Primitive → Gate (bypass) → Generate an image prompt_in: Python\'s request, the Gate hands the value on, charged priceGraph', async () => {
    const k = kit()
    const f = ideaFlow()
    const r = await runFlow(k, f)
    expect(k.fal.submitted().map(x => [x.endpoint, x.payload])).toEqual([[IDEA.endpoint, IDEA.payload]])
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(r.nodes.p!.values).toEqual({ 0: { kind: 'text', text: IDEA.inputs.prompt_in } })
    expect(r.nodes.g!.status).toBe('done')
    expect(r.nodes.p!.credits ?? 0).toBe(0)
    // The paid node is the only priced node; the Image card brings the render credit.
    expect(r.price.nodes).toMatchObject({ 1: r.price.credits - BASE_RENDER_CREDITS })
    expect(r.price.credits - BASE_RENDER_CREDITS).toBeGreaterThan(0)
    expectCharged(k, r)
  })

  it('Moodboard → Restyle style_in: Python\'s request (on its fal service, Replicate down), the taste moderated, charged priceGraph once', async () => {
    const moderate = vi.fn(async (_t: string) => ({ ok: true as const }))
    // Nano Banana 2's Restyle goes to Replicate first since Task S3, Python's
    // fal call its backup: Replicate refuses the send (a 503), so the fal
    // request is made, and it is Python's exactly.
    const k = kit({ moderate, deps: { backup: () => ({ enabled: true, stallMs: 0 }) } })
    ;(k.replicate.client.submit as any).mockRejectedValueOnce(new ReplicateError('Replicate predictions API HTTP 503: down', 503))
    const f = tasteFlow()
    const r = await runFlow(k, f)
    expect((k.replicate.client.submit as any).mock.calls).toHaveLength(1)
    expect(k.replicate.submitted()).toHaveLength(0)
    expect(k.fal.submitted().map(x => [x.endpoint, x.payload])).toEqual([[TASTE.endpoint, handedOff(TASTE.payload, { content_image: 'content_image.png' })]])
    // The Moodboard's value is the reading's style block, which the fixture's node read as typed.
    const style = (staticValueOf(f.prompt, ['m', 0]) as { kind: 'text'; text: string }).text
    expect(style).toBe(TASTE.inputs.style_in)
    expect(r.nodes.m!.values).toEqual({ 0: { kind: 'text', text: style } })
    expect(moderate.mock.calls.map(c => c[0])).toContain(style)
    expect(r.run.takes[0]!.nodes['1']!.credits).toBe(r.price.nodes!['1'])
    expect(r.price.nodes!['1']).toBeGreaterThan(0)
    expectCharged(k, r)
  })

  it('Text → Smart Layout → Save image: Python\'s render requests, two files saved as the run\'s output, charged priceGraph (the render credit)', async () => {
    const orig = smartLayoutRenderer.render.bind(smartLayoutRenderer)
    const sent: RenderRequest[] = []
    vi.spyOn(smartLayoutRenderer, 'render').mockImplementation(async (req, opts) => {
      sent.push(JSON.parse(JSON.stringify(req)) as RenderRequest)
      return orig(req, opts)
    })
    const k = kit()
    const f = layoutFlow()
    const r = await runFlow(k, f)
    // The render bodies are the ones Python POSTs for the same inputs (no image layers here).
    expect(sent).toEqual(LAYOUT.bodies)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(r.nodes.t!.values).toEqual({ 0: { kind: 'text', text: LAYOUT.inputs.text_layer_2 } })
    // Python's preview names, in output order.
    const shown = r.events.msgs.find(m => m.type === 'executed' && m.data.node === LAYOUT.node_id)!
    expect((shown.data.output as { images: OutputFile[] }).images.map(x => x.filename)).toEqual(LAYOUT.ui!.images.map(x => x.filename))
    // Save image: two files in the user's folder, each counted as the run's output.
    const saved = r.nodes.s!.outputs
    expect(saved.map(x => x.filename)).toEqual(['ComfyUI_00001_.png', 'ComfyUI_00002_.png'])
    for (const x of saved) {
      const meta = await sharp(readFileSync(join(k.root, 'output', x.subfolder, x.filename))).metadata()
      expect([meta.width, meta.height, meta.channels]).toEqual([300, 250, 3])
    }
    expect(k.graphRuns.appendOutput).toHaveBeenCalledTimes(2)
    expect(r.price.credits).toBe(BASE_RENDER_CREDITS)
    expectCharged(k, r)
  }, 60_000)

  it('3D Studio → Edit image: the edit is handed the kept RGB picture (Python\'s pixels), Python\'s request, charged priceGraph', async () => {
    const k = kit()
    const f = sceneFlow()
    const r = await runFlow(k, f)
    const beauty = r.nodes.s!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect(beauty.files[0]!.type).toBe('kept')
    expect(r.nodes.s!.credits ?? 0).toBe(0)
    const want = handedOff(withoutUnknownFields('fal', EDIT.call.endpoint, EDIT.call.payload), { input_image: beauty.files[0]!.filename })
    expect(k.fal.submitted().map(x => [x.endpoint, x.payload])).toEqual([[EDIT.call.endpoint, want]])
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    // The bytes handed off are Python's RGB picture of the RGBA bake, and they are in the kept store.
    const up = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, name]) => name === beauty.files[0]!.filename)
    expect(up).toHaveLength(1)
    await expectRgb(up[0]![0], SCENE.outputs[0]!, 'handed off')
    expect(existsSync(join(k.dir, 'runner-kept', beauty.files[0]!.subfolder, beauty.files[0]!.filename))).toBe(true)
    expectCharged(k, r)
  })

  it('LoadImage → Image to mask: Python\'s mask; the LoadImage\'s Save image written; charged priceGraph (the render credit)', async () => {
    const k = kit()
    const f = maskFlow()
    const r = await runFlow(k, f)
    const mask = r.nodes.u!.values![0] as Extract<RunnerValue, { kind: 'mask' }>
    expect(mask.kind).toBe('mask')
    expect(mask.files).toHaveLength(1)
    const m = await decodeMask(readFileSync(join(k.dir, 'runner-kept', mask.files[0]!.subfolder, mask.files[0]!.filename)))
    const want = TO_MASK.masks![0]!
    expect([m.w, m.h]).toEqual([want.w, want.h])
    expect([...m.data].map(v => Math.round(v * 65535))).toEqual(u16(want.mask16!))
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(r.nodes.s!.outputs.map(x => x.filename)).toEqual(['ComfyUI_00001_.png'])
    expect(r.price.credits).toBe(BASE_RENDER_CREDITS)
    expectCharged(k, r)
  })
})

// ── 2. A restart halfway through a paid node that reads a wired value ────

describe('R1.7 · a restart halfway through a paid node that reads a wired value', () => {
  it('after reattach the value is still read, the kept bytes are still there, the node is charged once', async () => {
    const fal = createFakeFal()
    const replicate = createFakeReplicate()
    const ledger = createFakeLedger()
    const state = { crashed: false }
    // Text → Edit image's prompt; 3D Studio → its picture (a kept RGB PNG).
    const words = 'make the sky pink'
    const p: ApiPrompt = {
      t: { class_type: 'Text', inputs: { text: words } },
      s: scene3d(),
      1: { class_type: 'EditImageNode', inputs: { ...EDIT.widgets, input_image: ['s', 0], prompt: ['t', 0] } },
      2: outImage('1'),
    }
    const k1 = kit({ fal, replicate, ledger, deps: { sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) } })
    writeFiles(k1, sceneFlow().files)
    fal.holdNext(1)
    const { runId, promptIds } = await started([p])
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2, 10_000)
    state.crashed = true // the old server stops mid-request
    await new Promise(r => setTimeout(r, 20))
    const before = (await k1.store.get(runId))!
    expect(before.takes[0]!.nodes['1']!.request).toMatchObject({ provider: 'fal', requestId: 'req1' })
    const beauty = (before.takes[0]!.nodes.s!.values![0] as Extract<RunnerValue, { kind: 'files' }>).files[0]!
    const keptPath = join(k1.dir, 'runner-kept', beauty.subfolder, beauty.filename)
    expect(existsSync(keptPath)).toBe(true)
    const keptBytes = readFileSync(keptPath)

    // A new server on the same run store and kept store. Picking up saved runs
    // happens at server start (reattach), which no route exposes; the
    // browser's side still goes through the event route.
    const k2 = kit({ dir: k1.dir, root: k1.root, fal, replicate, ledger })
    const events = await openEvents()
    const pollsBefore = fal.submitted()[0]!.polls
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await events.until(m => m.some(ends(promptIds[0]!)))
    await k2.engine.settled(runId)

    // Polled again, not sent again; the one request carries the wired words and the kept picture.
    expect(fal.submitted()).toHaveLength(1)
    expect(fal.submitted()[0]!.polls).toBeGreaterThan(pollsBefore)
    const want = handedOff(withoutUnknownFields('fal', EDIT.call.endpoint, { ...EDIT.call.payload, prompt: words }), { input_image: beauty.filename })
    expect(fal.submitted()[0]!.payload).toEqual(want)
    expect(replicate.client.submit).not.toHaveBeenCalled()
    const run = (await k2.store.get(runId))!
    expect(run.status).toBe('done')
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    expect(run.takes[0]!.nodes.t!.values).toEqual({ 0: { kind: 'text', text: words } })
    // The kept bytes are still there, unchanged, after the restart (the sweep keeps runs in progress).
    expect(existsSync(keptPath)).toBe(true)
    expect(Buffer.compare(readFileSync(keptPath), keptBytes)).toBe(0)
    // Charged once, at priceGraph.
    const price = priceOf(p).credits
    expect(ledger.hold).toHaveBeenCalledTimes(1)
    expect(ledger.settle).toHaveBeenCalledTimes(1)
    expect([...ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', price]])
    expect(events.msgs.at(-1)).toMatchObject({ type: 'execution_success', data: { prompt_id: promptIds[0], credits: price } })
  })
})

// ── 3. A blocked word in a card ──────────────────────────────────────────

describe('R1.7 · a blocked word in a Text card', () => {
  const image = (idea: [string, number]) => ({ class_type: 'GenerateImageNode', inputs: { ...IDEA.inputs, prompt_in: idea } })

  it('known at the start: POST /api/runs refuses it before any hold', async () => {
    const moderate = blockWord('forbidden')
    const k = kit({ moderate })
    const p: ApiPrompt = { t: { class_type: 'Text', inputs: { text: 'forbidden words' } }, 1: image(['t', 0]), 2: outImage('1') }
    const res = await startRun([p])
    expect(res.status).toBe(400)
    const body = await res.json() as { statusMessage?: string; message?: string }
    expect(body.statusMessage ?? body.message).toBe(MODERATION_BLOCKED_MESSAGE)
    expect(moderate.mock.calls.map(c => c[0])).toContain('forbidden words')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  /** The blocked word from a Primitive, through a bypassed Gate, into a Text card's source, into the idea socket. */
  const gated = (): ApiPrompt => ({
    s: { class_type: 'PrimitiveString', inputs: { value: 'forbidden words' } },
    g: { class_type: 'ComfyGateNode', inputs: { data_in: ['s', 0], bypass: true } },
    t: { class_type: 'Text', inputs: { text: '', source: ['g', 0] } },
    1: image(['t', 0]),
    2: outImage('1'),
  })

  it('through a Gate, as the cards are today: the start still reads the card\'s own words and refuses before any hold', async () => {
    const moderate = blockWord('forbidden')
    const k = kit({ moderate })
    // The Text card's value can't be worked out before the run (its source is a Gate)…
    expect(staticValueOf(gated(), ['t', 0])).toBeUndefined()
    // …but the Primitive's own words are wired into the Gate, and those are read.
    const res = await startRun([gated()])
    expect(res.status).toBe(400)
    expect(((await res.json()) as { statusMessage?: string }).statusMessage).toBe(MODERATION_BLOCKED_MESSAGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('through a Gate, not known at the start: only that node fails, its hold is released', async () => {
    modState.startKnows = false
    const moderate = blockWord('forbidden')
    const k = kit({ moderate })
    const p = gated()
    const events = await openEvents()
    const { runId, promptIds } = await started([p])
    await events.until(m => m.some(ends(promptIds[0]!)))
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    const nodes = run.takes[0]!.nodes
    expect(nodes['1']!.status).toBe('error')
    expect(nodes['1']!.error).toBe(MODERATION_BLOCKED_MESSAGE)
    // Only that node: the cards before it ran and handed the words on.
    for (const id of ['s', 'g', 't']) expect(nodes[id]!.status, id).toBe('done')
    expect(nodes.t!.values).toEqual({ 0: { kind: 'text', text: 'forbidden words' } })
    expect(moderate.mock.calls.map(c => c[0])).toContain('forbidden words')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).toHaveBeenCalledTimes(1)
    expect(holds(k)).toEqual([['released', null]])
    expect(events.msgs.some(m => m.type === 'execution_error' && m.data.prompt_id === promptIds[0])).toBe(true)
  })
})

// ── 4. `cards` off ───────────────────────────────────────────────────────

describe('R1.7 · with `cards` off, every workflow above is refused as before step 3', () => {
  const flows = [ideaFlow, tasteFlow, layoutFlow, sceneFlow, maskFlow].map(f => f())
  it.each(flows.map(f => [f.label, f] as const))('%s: /api/runs refuses it (not-eligible) and nodesNeedingEngine names the cards', async (_l, f) => {
    process.env.NUXT_RUNNER_FAMILIES = OFF
    expect(runnerFamilies().has('cards')).toBe(false)
    const k = kit()
    writeFiles(k, f.files)
    const res = await startRun([f.prompt])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { statusMessage?: string; data?: unknown }
    expect(body.statusMessage).toBe('This workflow can’t run on the Sailor runner')
    expect(body.data).toEqual({ reason: 'not-eligible' })
    expect(isRunnerDeclined({ statusCode: res.status, data: body })).toBe(true)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()

    const titleOf = (id: string) => `${f.prompt[id]!.class_type} #${id}`
    expect(nodesNeedingEngine(f.prompt, { runnerOn: true, families: runnerFamilies(), titleOf })).toEqual(Object.keys(f.prompt).filter(id => f.cards.includes(id)).map(titleOf))
    // With cards back on, nothing needs the engine.
    const on: ReadonlySet<RunnerFamily> = new Set([...runnerFamilies(), 'cards'])
    expect(nodesNeedingEngine(f.prompt, { runnerOn: true, families: on, titleOf })).toEqual([])
  })
})
