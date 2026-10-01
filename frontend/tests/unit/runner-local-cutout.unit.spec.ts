/**
 * R7.1: Background remove on Replicate's 851-labs remover (family `bg-remove`)
 * and the pieces every R7 task shares (shared/runner/localModels.ts,
 * server/runner/generators/localModels.ts, server/runner/localModelStart.ts).
 *
 * The provider runs another model than Python's local ISNet, so its answer
 * can't match; everything Sailor does around the call is exact given the same
 * answer (R7 rule 2), against the real execute with its model swapped for a
 * stand-in that answers recorded pictures (fixtures/runner-paid-local-cutout.json,
 * scripts/runner_paid_fixtures.py --group local-cutout). The alpha's blur is
 * torchvision's gaussian, not Pillow's box passes: judged by eye, with loose
 * numbers here, and exact once the blurred alpha is the same.
 *
 * Ruling (f) (USER): a clip runs in Sailor, one call per frame, with a frame
 * cap and the hold at frames × price.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid (a spy on spawn): Stop must leave none running. */
const PROCS = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      return c
    }) as typeof real.spawn,
  }
})
import sharp from 'sharp'
import { createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import {
  ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, LOCAL_MODEL_REQUIRES, LOCAL_MODEL_TOOL_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily,
} from '#shared/runner/families'
import {
  PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { FRAMES_LINK_SOURCES } from '#shared/runner/mediaEffects'
import {
  BG_REMOVE_CLASS, BG_REMOVE_SLUG, LOCAL_MODEL_FAMILY_OF, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, SERVICE_OF, localModelCalls, serviceTooltip,
} from '#shared/runner/localModels'
import { PAID_RATES } from '#shared/pricing/paidRates'
import { FAMILY_PRICED_CLASSES, perFrameCredits, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { estimateUsdForNodes, upstreamInputSeconds, upstreamPictureCount, vueNodesToEstimateInput } from '~/lib/costEstimate'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { spentKeptMedia } from '~~/server/runner/keptRelease'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { PER_NODE_IN_FLIGHT, bgRemoveInput } from '~~/server/runner/generators/localModels'
import { localModelStartProblems, maskBytesBound, pictureBound } from '~~/server/runner/localModelStart'
import { keptBatchBound } from '~~/server/runner/video/start'
import { MEDIA_CAPS } from '#shared/runner/media'
import { cutoutCore, type CutoutMode } from '~~/server/runner/pixels/cutout'
import { effectCores } from '~~/server/runner/effects/cores'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { pilRgba } from '~~/server/runner/pictures/pythonView'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { KEPT_MEDIA_MAKERS } from '~~/server/runner/keptRelease'
import { nodePriceTooltip } from '~/lib/nodeCreditEstimate'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

interface TensorRec { shape: number[]; f32_sha256: string; round8_sha256: string; trunc8_sha256: string; f32?: string }
interface CutoutCase {
  name: string
  class_type: string
  node_id: string
  widgets: { output: CutoutMode; edge_softness: number }
  pictures: string[]
  answers: string[]
  sent: [number, number, string][]
  image: TensorRec
  mask: TensorRec
  alpha8: string
  preview: { filename: string; subfolder: string; type: string; mode: string; w: number; h: number; sha256: string }
  animated: boolean[]
}
interface BlurRef { alpha: string; radius: number; w: number; h: number; in: string; out: string }
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-local-cutout.json'), 'utf8')) as { cases: CutoutCase[]; size: [number, number]; blur: BlurRef[] }
const CASES = FIXTURE.cases
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'bg-remove'])
const ON_CLIP: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'bg-remove'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const ANSWER_URL = (i: number) => `https://replicate.delivery/cut/${i}.png`
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const SCHEMA = loadProviderSchema('replicate', BG_REMOVE_SLUG)

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const shaF32 = (f: Float32Array) => sha(new Uint8Array(f.buffer, f.byteOffset, f.byteLength))
const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no case ${name}`)
  return c
}
const blurred = (c: CutoutCase) => c.widgets.edge_softness > 0
const frames = (c: CutoutCase) => c.answers.length
const f = Math.fround

const scratch = mkdtempSync(join(tmpdir(), 'local-cutout-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The answer as PIL's convert("RGBA") reads it. */
async function answerRgba(c: CutoutCase, i: number) {
  const { data, info } = await pilRgba(b64(c.answers[i]!))
  return { rgba: data.slice(), w: info.width, h: info.height }
}

/** Python's alpha (after its own blur) for frame i, from the recorded mask. */
function pyAlpha(c: CutoutCase, i: number, n: number): Uint8Array {
  return b64(c.alpha8).subarray(i * n, (i + 1) * n)
}

/** The node's float32 outputs as Python builds them from an answer and an alpha (rule 2: exact given the same answer). */
function pythonFloats(rgba: Uint8Array, alpha: Uint8Array, mode: CutoutMode): { image: Float32Array; mask: Float32Array } {
  const n = alpha.length
  const ch = mode === 'transparent' ? 4 : 3
  const image = new Float32Array(n * ch)
  const mask = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = f(alpha[i]! / 255)
    mask[i] = a
    for (let k = 0; k < 3; k++) {
      const v = f(rgba[i * 4 + k]! / 255)
      image[i * ch + k] = mode === 'matte_only' ? a : mode === 'premultiplied' ? f(v * a) : v
    }
    if (ch === 4) image[i * 4 + 3] = a
  }
  return { image, mask }
}

const core = cutoutCore(effectCores.kn)

/** Every frame of a case through the core, with Python's alpha put in its answer (the blur set aside) or with the runner's blur. */
async function throughCore(c: CutoutCase, o: { quant: 'round' | 'trunc'; pythonAlpha: boolean }) {
  const pics: Uint8Array[] = []
  const alphas: Uint8Array[] = []
  const floats: { image: Float32Array[]; mask: Float32Array[] } = { image: [], mask: [] }
  let preview: Uint8Array | undefined
  for (let i = 0; i < frames(c); i++) {
    const { rgba, w, h } = await answerRgba(c, i)
    const n = w * h
    if (o.pythonAlpha) for (let p = 0; p < n; p++) rgba[p * 4 + 3] = pyAlpha(c, i, n)[p]!
    const r = core.cutout({ rgba, w, h, mode: c.widgets.output, sigma: o.pythonAlpha ? 0 : c.widgets.edge_softness, quant: o.quant, channels: c.widgets.output === 'transparent' ? 4 : 3, preview: i === 0 })
    pics.push(r.picture)
    alphas.push(r.alpha)
    const fl = pythonFloats(rgba, r.alpha, c.widgets.output)
    floats.image.push(fl.image)
    floats.mask.push(fl.mask)
    if (r.preview) preview = r.preview
  }
  const cat = (xs: Uint8Array[]) => Uint8Array.from(Buffer.concat(xs.map(x => Buffer.from(x))))
  const catF = (xs: Float32Array[]) => { const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let o2 = 0; for (const x of xs) { out.set(x, o2); o2 += x.length } return out }
  return { picture: cat(pics), alpha: cat(alphas), image: catF(floats.image), mask: catF(floats.mask), preview: preview! }
}

describe('the fixture', () => {
  it('covers soft, hard and empty alpha × every output × edge_softness 0, 2 and 10; a clip of three frames; a picture smaller than the blur; a grey + alpha answer', () => {
    const names = new Set(CASES.map(c => c.name))
    for (const a of ['soft', 'hard', 'empty']) {
      for (const o of ['transparent', 'premultiplied', 'matte_only']) {
        for (const s of [0, 2, 10]) expect(names.has(`cutout · ${a} alpha · ${o} · edge ${s}`), `${a} ${o} ${s}`).toBe(true)
        expect(names.has(`cutout · a clip of three frames · ${o}`)).toBe(true)
      }
    }
    for (const n of ['a clip of three frames · transparent · edge 2', 'a 7 × 5 picture · edge 2', 'an answer in grey and alpha · premultiplied']) expect(names.has(`cutout · ${n}`), n).toBe(true)
    // Python called its model once per frame, each with an RGB picture.
    for (const c of CASES) expect(c.sent.length, c.name).toBe(c.answers.length)
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set([BG_REMOVE_CLASS]))
  })
})

describe('Python\'s work on the answer (../pixels/cutout.ts): exact given the same answer', () => {
  const exact = CASES.filter(c => !blurred(c))

  it.each(exact.map(c => [c.name, c] as const))('%s: outputs, mask and preview bit for bit', async (_n, c) => {
    const r = await throughCore(c, { quant: 'round', pythonAlpha: false })
    expect(shaF32(r.image), 'the float32 picture').toBe(c.image.f32_sha256)
    expect(shaF32(r.mask), 'the float32 mask').toBe(c.mask.f32_sha256)
    expect(sha(r.picture), 'round-8 (the hand-off)').toBe(c.image.round8_sha256)
    expect(sha((await throughCore(c, { quant: 'trunc', pythonAlpha: false })).picture), 'trunc-8 (Save image)').toBe(c.image.trunc8_sha256)
    expect(sha(r.preview), 'the preview\'s pixels').toBe(c.preview.sha256)
    expect([c.preview.mode, c.preview.w, c.preview.h]).toEqual(['RGBA', c.image.shape[2], c.image.shape[1]])
  })

  const soft = CASES.filter(blurred)
  it.each(soft.map(c => [c.name, c] as const))('%s: exact once the alpha is blurred the same', async (_n, c) => {
    const same = await throughCore(c, { quant: 'round', pythonAlpha: true })
    expect(shaF32(same.image)).toBe(c.image.f32_sha256)
    expect(shaF32(same.mask)).toBe(c.mask.f32_sha256)
    expect(sha(same.picture)).toBe(c.image.round8_sha256)
    expect(sha(same.preview)).toBe(c.preview.sha256)
    // The runner blurs too (its own blur is weighed against Pillow's below, at a picture's size); an empty alpha stays empty.
    const own = await throughCore(c, { quant: 'round', pythonAlpha: false })
    const unblurred = core.cutout({ ...(await answerRgba(c, 0)), mode: 'matte_only', sigma: 0, quant: 'round', channels: 3, preview: false }).alpha
    if (/empty alpha/.test(c.name)) expect(own.alpha.every(v => v === 0)).toBe(true)
    else expect(sha(own.alpha.subarray(0, unblurred.length))).not.toBe(sha(unblurred))
  })

  // The one step not ported (the user's matching rule: judged by eye): torchvision's gaussian at σ = radius
  // against Pillow's box-pass GaussianBlur, at a picture's size. Loose numbers, in 8-bit alpha levels.
  it.each(FIXTURE.blur.map(r => [`${r.alpha} alpha at radius ${r.radius}`, r] as const))('the blur, %s: close to Pillow\'s', (_n, r) => {
    const a = new Uint8Array(inflateSync(Buffer.from(r.in, 'base64')))
    const py = new Uint8Array(inflateSync(Buffer.from(r.out, 'base64')))
    const own = core.blurAlpha(a, r.w, r.h, r.radius)
    let sum = 0
    let most = 0
    for (let i = 0; i < py.length; i++) {
      const d = Math.abs(own[i]! - py[i]!)
      sum += d
      most = Math.max(most, d)
    }
    expect(sum / py.length, 'mean difference').toBeLessThan(1)
    expect(most, 'largest difference').toBeLessThanOrEqual(16)
  })

  it('the 8-bit forms: round and trunc both give k for every k / 255; Stop stops the core', () => {
    for (let k = 0; k < 256; k++) {
      expect(core.round8(f(k / 255))).toBe(k)
      expect(core.trunc8(f(k / 255))).toBe(k)
    }
    const rgba = new Uint8Array(4 * 4)
    expect(() => core.cutout({ rgba, w: 2, h: 2, mode: 'transparent', sigma: 0, quant: 'round', channels: 4, preview: false }, () => true)).toThrow('Stopped')
    expect(() => core.cutout({ rgba, w: 3, h: 2, mode: 'transparent', sigma: 0, quant: 'round', channels: 4, preview: false })).toThrow('not the size')
  })

  it('on the Frame\'s worker, the same pixels', async () => {
    const c = caseNamed('cutout · soft alpha · premultiplied · edge 2')
    const inThread = await throughCore(c, { quant: 'trunc', pythonAlpha: false })
    const { rgba, w, h } = await answerRgba(c, 0)
    const r = await pixelsInWorker(undefined, worker => worker.cutout({ rgba, w, h, mode: 'premultiplied', sigma: 2, quant: 'trunc', channels: 3, preview: true }))
    expect(sha(r.picture)).toBe(sha(inThread.picture))
    expect(sha(r.alpha)).toBe(sha(inThread.alpha))
    expect(sha(r.preview!)).toBe(sha(inThread.preview))
  })
})

// ── The plan, run by hand ───────────────────────────────────────────────────

const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const bgNode = (c: CutoutCase, from: [string, number] = ['l', 0]) => ({ class_type: BG_REMOVE_CLASS, inputs: { frames: from, ...c.widgets } })
const PIC = (i: number): OutputFile => ({ filename: `p${i}.png`, subfolder: '', type: 'input' })

async function planOf(c: CutoutCase, o: { held?: number; prompt?: ApiPrompt } = {}): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: o.prompt ?? { l: LOAD, n: bgNode(c) }, nodeId: 'n', gateOpen: false, families: ON,
    filesFrom: link => (link[0] === 'l' ? c.pictures.map((_x, i) => PIC(i)) : []),
    toUrl: async f2 => `https://fal.storage/${f2.filename}`,
    ...(o.held !== undefined ? { measured: { frames: o.held } } : {}),
  })
  if (p.kind !== 'pipeline') throw new Error('Background remove is a pipeline')
  return p
}

/** The pipeline with its calls answered by key (several are in flight at once), its downloads served, its saves kept. */
async function runByHand(c: CutoutCase, o: { held?: number } = {}) {
  const plan = await planOf(c, { held: o.held ?? frames(c) })
  const calls: PipelineCall[] = []
  const kept = new Map<string, Uint8Array>()
  const previews: Uint8Array[] = []
  let inFlight = 0
  let most = 0
  const io = {
    signal: new AbortController().signal,
    call: async (x: PipelineCall) => {
      calls.push(x)
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      const i = Number(/^cut-(\d+)$/.exec(x.key)![1])
      return { result: { output: ANSWER_URL(i) }, raw: null, urls: [] }
    },
    download: async (url: string) => ({ bytes: b64(c.answers[Number(/\/(\d+)\.png$/.exec(url)![1])]!), contentType: 'image/png' }),
    keep: async (bytes: Uint8Array, ext: string) => {
      const file: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      kept.set(file.filename, bytes)
      return file
    },
    read: async (file: OutputFile) => kept.get(file.filename)!,
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
    savePreview: async (bytes: Uint8Array, s: { nodeId?: string }) => {
      previews.push(bytes)
      return { filename: `live_preview_${s.nodeId}_00001.png`, subfolder: 'sailor_runner', type: 'temp' } as OutputFile
    },
    handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, kept, previews, most: () => most }
}

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height, channels: info.channels }
}

describe('every picture case (the plan, run by hand)', () => {
  const pictureCases = CASES.filter(c => !blurred(c))

  it.each(pictureCases.map(c => [c.name, c] as const))('%s: one call per picture to the saved schema; Python\'s picture, mask and preview', async (_n, c) => {
    const r = await runByHand(c)
    const made = await r.run()
    expect(r.calls.map(x => x.key).sort()).toEqual(c.answers.map((_a, i) => `cut-${i}`).sort())
    for (const [i, x] of r.calls.entries()) {
      expect([x.provider, x.endpoint, x.media]).toEqual(['replicate', BG_REMOVE_SLUG, 'image'])
      expect(x.payload).toEqual(bgRemoveInput(String(x.payload.image)))
      expect(checkPayload(SCHEMA, x.payload), `${c.name} call ${i}`).toEqual([])
      expect(x.usd).toBe(0.0004)
      expect(x.backup).toBeUndefined()
    }
    expect(r.most()).toBeLessThanOrEqual(PER_NODE_IN_FLIGHT)
    const pics = (made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files
    const masks = (made.values[1] as Extract<RunnerValue, { kind: 'mask' }>)
    expect(masks.kind).toBe('mask')
    expect(pics.length).toBe(frames(c))
    expect(masks.files.length).toBe(frames(c))
    // The picture as handed on (round-8; read by nothing: the hand-off's rounding), its channels Python's.
    const all: Uint8Array[] = []
    for (const file of pics) {
      const px = await pixels(r.kept.get(file.filename)!)
      expect(px.channels).toBe(c.image.shape[3])
      all.push(px.data)
    }
    expect(sha(Buffer.concat(all.map(a => Buffer.from(a))))).toBe(c.image.round8_sha256)
    // The mask, 16-bit: exactly alpha / 255.
    const maskF: Float32Array[] = []
    for (const file of masks.files) maskF.push((await decodeMask(r.kept.get(file.filename)!)).data)
    const flat = new Float32Array(maskF.reduce((s, m) => s + m.length, 0))
    let o2 = 0
    for (const m of maskF) { flat.set(m, o2); o2 += m.length }
    expect(shaF32(flat)).toBe(c.mask.f32_sha256)
    // One live preview, the first picture's (save_live_preview(unique=True)), RGBA, compress level 1.
    expect(r.previews.length).toBe(1)
    const pv = await pixels(r.previews[0]!)
    expect([pv.channels, pv.w, pv.h]).toEqual([4, c.preview.w, c.preview.h])
    expect(sha(pv.data)).toBe(c.preview.sha256)
    expect(made.ui).toEqual({ images: [{ filename: 'live_preview_n_00001.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] })
    expect(c.animated).toEqual([false])
  })

  it('more pictures than the start of the run counted: refused before any call (the hold covers no more)', async () => {
    const c = caseNamed('cutout · a clip of three frames · transparent')
    await expect(planOf(c, { held: 2 })).rejects.toThrow(LOCAL_MODEL_WORDS.tooManyFrames)
    await expect(planOf(c)).rejects.toThrow(LOCAL_MODEL_WORDS.tooManyFrames)
  })

  it('an answer that names no picture: not delivered (charged nothing), the node fails plainly', async () => {
    const c = caseNamed('cutout · hard alpha · transparent · edge 0')
    const plan = await planOf(c, { held: 1 })
    const undelivered = vi.fn(async () => {})
    const io = {
      signal: new AbortController().signal,
      call: async () => ({ result: { output: null }, raw: null, urls: [] }),
      undelivered,
    } as unknown as PipelineIO
    await expect(plan.run(io)).rejects.toThrow(LOCAL_MODEL_WORDS.noAnswer)
    expect(undelivered).toHaveBeenCalledWith('cut-0', 'no-file')
    expect(LOCAL_MODEL_WORDS.noAnswer).not.toMatch(/Node|_|Replicate/)
  })
})

// ── Through the engine ──────────────────────────────────────────────────────

function replicateServing() {
  let n = 0
  const replicate = createFakeReplicate({ answer: () => ANSWER_URL(n++) })
  return replicate
}

async function kitRun(c: CutoutCase, prompt: ApiPrompt, o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; files?: Record<string, Uint8Array>; dir?: string } = {}) {
  const replicate = replicateServing()
  const gets: string[] = []
  const download = vi.fn(async (url: string) => {
    gets.push(url)
    const i = Number(/\/(\d+)\.png$/.exec(url)![1])
    return { bytes: b64(c.answers[i % c.answers.length]!), contentType: 'image/png' }
  })
  const dir = o.dir ?? mkdtempSync(join(scratch, 'kit-'))
  const k = makeKit({ hosted: o.hosted, dir, replicate, deps: { families: () => o.families ?? ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
  for (const [name, bytes] of Object.entries(o.files ?? { 'image.png': b64(c.pictures[0]!) })) writeFileSync(join(k.root, 'input', name), bytes)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const take = (await k.store.get(runId))!.takes[0]!
  return { k, take, replicate, gets }
}

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

describe('the acceptance chains, with ComfyUI off', () => {
  const c = caseNamed('cutout · soft alpha · transparent · edge 0')

  it('Load image → Background remove → Save image: one call, the cut-out keeps its alpha; Image to mask reads its alpha', async () => {
    const prompt: ApiPrompt = { l: LOAD, n: bgNode(c), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    expect(isRunnerEligible(prompt, ON)).toBe(true)
    expect(runnerTakesNode({ ...prompt, m: { class_type: 'ImageToMask', inputs: { image: ['n', 0], channel: 'alpha' } } }, 'm', ON)).toBe(true)
    const { k, take, replicate } = await kitRun(c, prompt)
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG])
    expect(checkPayload(SCHEMA, replicate.submitted()[0]!.payload)).toEqual([])
    const saved = take.nodes.s!.outputs[0]!
    const px = await pixels(new Uint8Array(readFileSync(join(k.root, saved.type, saved.subfolder, saved.filename))))
    expect(px.channels).toBe(4)
    // Saved as Python's Save image writes the cut-out: trunc-8 of its float (k for every k / 255).
    expect(sha(px.data)).toBe(c.image.trunc8_sha256)
    const shown = ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')?.output
    expect(shown.images[0].filename).toMatch(/^live_preview_n_\d{5}\.png$/)
  })

  it('Image card → Background remove → Image card (the saved projects\' chain): taken, and the card shows the cut-out', async () => {
    const prompt: ApiPrompt = {
      a: { class_type: 'Image', inputs: { image: 'image.png', export: false, batch_index: -1 } },
      n: bgNode(c, ['a', 0]),
      b: { class_type: 'Image', inputs: { image: '', export: false, images: ['n', 0], batch_index: -1 } },
    }
    expect(isRunnerEligible(prompt, ON)).toBe(true)
    const { take } = await kitRun(c, prompt)
    for (const id of ['a', 'n', 'b']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
  })

  it('hosted: held and charged one call (1 credit) plus the render credit; a picture that isn\'t the user\'s is refused before the hold', async () => {
    const prompt: ApiPrompt = { l: LOAD, n: bgNode(c), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    const { k, take } = await kitRun(c, prompt, { hosted: true })
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    expect(take.measured?.n?.seconds.frames).toBe(1)
    expect(take.nodes.n!.credits).toBe(1)
    expect(charged(k)).toEqual([[2, 2]])
    const replicate = replicateServing()
    const k2 = makeKit({ hosted: true, replicate, deps: { families: () => ON, ownership: { ownsInput: async () => false, ownsOutput: async () => false } } })
    writeFileSync(join(k2.root, 'input', 'image.png'), b64(c.pictures[0]!))
    await expect(k2.engine.startRun({ userId: k2.userId, takes: [prompt], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k2.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
  })

  it('a batch of three pictures (Empty image): three calls, held and charged 3 credits', async () => {
    const prompt: ApiPrompt = {
      e: { class_type: 'EmptyImage', inputs: { width: 24, height: 16, batch_size: 3, color: 0 } },
      n: bgNode(c, ['e', 0]),
      s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } },
    }
    expect(pictureBound(prompt, ['e', 0], ON)).toBe(3)
    const { k, take, replicate } = await kitRun(c, prompt, { hosted: true })
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    expect(replicate.submitted().length).toBe(3)
    // Three frames' dollars added up and marked up once (USER ruling): 3 × $0.0004 = $0.0012 → 1 credit (+ render).
    expect(take.nodes.n!.credits).toBe(1)
    expect(charged(k)).toEqual([[2, 2]])
    expect((take.nodes.n!.values![1] as { files: unknown[] }).files.length).toBe(3)
  })

  it('a provider call that fails: nothing charged, the hold released', async () => {
    const prompt: ApiPrompt = { l: LOAD, n: bgNode(c), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    const replicate = replicateServing()
    replicate.failNext(1)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: async () => ({ bytes: b64(c.answers[0]!), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'image.png'), b64(c.pictures[0]!))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(charged(k)).toEqual([[2, 0]])
  })
})

describe('a clip, one call per frame (ruling (f))', () => {
  const c = caseNamed('cutout · a clip of three frames · premultiplied')
  const clip = 'v_stereo_aac.mp4'
  const lvf = { class_type: 'LoadVideoFrames', inputs: { file: clip, max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
  const saveFrames = (from: [string, number]) => ({ class_type: 'SaveVideoFrames', inputs: { frames: from, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })

  it('the batch is a frame batch on slot 0 while the family is on (a picture stays a picture); the frame readers take it', () => {
    const p: ApiPrompt = { v: lvf, n: bgNode(c, ['v', 0]), s: saveFrames(['n', 0]) }
    expect(outputKind(p, ['n', 0], outputKindsFor(ON_CLIP))).toBe('frames')
    expect(outputKind(p, ['n', 1], outputKindsFor(ON_CLIP))).toBe('mask')
    expect(outputKind({ l: LOAD, n: bgNode(c) }, ['n', 0], outputKindsFor(ON_CLIP))).toBe('files')
    expect(isRunnerEligible(p, ON_CLIP)).toBe(true)
    // A clip's batch into a picture reader is left to the engine (the value kinds).
    expect(runnerTakesNode({ ...p, s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }, 's', ON_CLIP)).toBe(false)
    // A video file (not a batch) into it is left to the engine.
    expect(runnerTakesNode({ f: { class_type: 'LoadVideo', inputs: { file: clip } }, n: bgNode(c, ['f', 0]), s: saveFrames(['n', 0]) }, 'n', ON_CLIP)).toBe(false)
    expect(FRAMES_LINK_SOURCES.map(x => x.join(':'))).toContain(`${BG_REMOVE_CLASS}:0`)
    expect(KEPT_MEDIA_MAKERS.has(BG_REMOVE_CLASS)).toBe(true)
  })

  it('Load video frames → Background remove → Save video frames, hosted: three calls, held 3 + render, a batch of three frames and three masks', LONG, async () => {
    await requireMediaTools()
    const prompt: ApiPrompt = { v: lvf, n: bgNode(c, ['v', 0]), s: saveFrames(['n', 0]) }
    const files = { [clip]: new Uint8Array(readFileSync(clipPath(clip))) }
    const { k, take, replicate } = await kitRun(c, prompt, { hosted: true, families: ON_CLIP, files })
    for (const id of ['v', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds.frames).toBe(3)
    expect(replicate.submitted().length).toBe(3)
    for (const x of replicate.submitted()) expect(checkPayload(SCHEMA, x.payload)).toEqual([])
    const out = take.nodes.n!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect(out.kind).toBe('frames')
    expect(out.count).toBe(3)
    expect((take.nodes.n!.values![1] as { files: unknown[] }).files.length).toBe(3)
    // Three frames' dollars added up and marked up once (USER ruling): 3 × $0.0004 = $0.0012 → 1 credit (+ render).
    expect(take.nodes.n!.credits).toBe(1)
    expect(charged(k)).toEqual([[2, 2]])
  })

  it('Stop mid-clip: the calls in flight cancelled, nothing charged, no tool process left within a second, no partial batch kept', LONG, async () => {
    await requireMediaTools()
    const prompt: ApiPrompt = { v: lvf, n: bgNode(c, ['v', 0]), s: saveFrames(['n', 0]) }
    const replicate = replicateServing()
    replicate.holdNext(3)
    const dir = mkdtempSync(join(scratch, 'stop-'))
    const k = makeKit({ hosted: true, dir, replicate, deps: { families: () => ON_CLIP, download: async () => ({ bytes: b64(c.answers[0]!), contentType: 'image/png' }), kept: createFileKeptBytes(join(dir, 'kept')) } })
    writeFileSync(join(k.root, 'input', clip), readFileSync(clipPath(clip)))
    const before = PROCS.pids.length
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    for (let i = 0; i < 4000 && replicate.submitted().length < 3; i++) await new Promise(r => setTimeout(r, 5))
    expect(replicate.submitted().length).toBe(3)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    const t0 = Date.now()
    const pids = PROCS.pids.slice(before)
    expect(pids.length, 'the clip was decoded by a tool').toBeGreaterThan(0)
    for (const pid of pids) {
      while (Date.now() - t0 < 1000) {
        try { process.kill(pid, 0) }
        catch { break }
        await new Promise(r => setTimeout(r, 10))
      }
      expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    }
    expect(replicate.submitted().every(x => x.cancelled)).toBe(true)
    expect(charged(k)).toEqual([[2, 0]])
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.values).toBeUndefined()
    // Only Load video frames' batch is kept: the cut-out's partial batch was removed.
    const keptFiles = readdirSync(join(dir, 'kept'), { recursive: true }).map(String).filter(x => x.endsWith('.mkv'))
    expect(keptFiles.length).toBe(1)
  })

  it('over the frame cap, or a count that can\'t be known: the workflow is left to the engine before anything is held', async () => {
    const p: ApiPrompt = { v: lvf, n: bgNode(c, ['v', 0]), s: saveFrames(['n', 0]) }
    const shapes = (count: number) => async () => new Map([['v:0', { count, w: 64, h: 36, exact: false }]])
    expect(await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted) })).toMatchObject({ counts: { n: LOCAL_MODEL_MAX_FRAMES.hosted }, problem: null })
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted + 1) })).problem?.message).toBe(LOCAL_MODEL_WORDS.overCap)
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: false, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted + 1) })).problem).toBeNull()
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: async () => new Map() })).problem?.message).toBe(LOCAL_MODEL_WORDS.unknownCount)
    // The batches kept while it runs (the clip's, the cut-out's) and the masks, for the run's kept room (hosted 4 GiB):
    // 300 frames of 1080p are past it (the engine says so before the hold), 100 are not.
    const full = (count: number) => async () => new Map([['v:0', { count, w: 1920, h: 1080, exact: false }], ['n:0', { count, w: 1920, h: 1080, exact: false }]])
    const big = await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: full(300) })
    expect(big.keptBytes).toBeGreaterThanOrEqual(2 * keptBatchBound({ count: 300, w: 1920, h: 1080, exact: false }) + maskBytesBound({ count: 300, w: 1920, h: 1080, exact: false }))
    expect(big.keptBytes).toBeGreaterThan(MEDIA_CAPS.hosted.keptBytesPerRun)
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: full(100) })).keptBytes).toBeLessThan(MEDIA_CAPS.hosted.keptBytesPerRun)
    // A picture's node keeps no batch.
    expect((await localModelStartProblems({ l: LOAD, n: bgNode(c) }, ON, { hosted: true, shapes: full(1) })).keptBytes).toBe(0)
    // A picture source whose count can't be known (Smart Layout's list): to the engine too.
    expect(pictureBound({ s: { class_type: 'SmartLayout', inputs: {} } }, ['s', 0], ON)).toBeNull()
  })
})

// ── Prices, families, tooltip ───────────────────────────────────────────────

describe('what the canvas shows covers what is held (fix round 1, Critical)', () => {
  /** A canvas node as the Vue canvas has it: its class, its widgets in order, its inputs by name. */
  const vn = (id: string, nodeType: string, widgets: [string, unknown][], inputs: string[] = []) => ({
    id, data: { nodeType, title: nodeType, widgetDefs: widgets.map(([name]) => ({ name })), widgetsValues: widgets.map(([, v]) => v), inputs: inputs.map(name => ({ name })) },
  })
  const wire = (source: string, target: string, port: number) => ({ source, target, targetHandle: `input-${port}` })
  const bg = vn('n', BG_REMOVE_CLASS, [['output', 'transparent'], ['edge_softness', 0]], ['frames'])
  const clipCanvas = {
    nodes: [vn('v', 'LoadVideoFrames', [['file', 'a.mp4'], ['max_seconds', 10], ['max_frames', 300], ['max_size', 1080], ['start_frame', 0], ['stride', 1]]), bg, vn('s', 'SaveVideoFrames', [['fps', 30]], ['frames'])],
    edges: [wire('v', 'n', 0), wire('n', 's', 0)],
  }
  const batchCanvas = {
    nodes: [vn('e', 'EmptyImage', [['width', 24], ['height', 16], ['batch_size', 3], ['color', 0]]), bg, vn('s', 'SaveImage', [['filename_prefix', 'ComfyUI']], ['images'])],
    edges: [wire('e', 'n', 0), wire('n', 's', 0)],
  }
  const values = { output: 'transparent', edge_softness: 0, frames: ['v', 0] }

  it('a 300-frame hosted clip: the canvas can\'t count it, so the badge and the run-confirm show the frame cap, "up to", never below the hold', () => {
    expect(upstreamPictureCount(bg, clipCanvas.nodes, clipCanvas.edges)).toBeNull()
    const secs = upstreamInputSeconds(bg, clipCanvas.nodes, clipCanvas.edges)
    expect(secs).toEqual({ seconds: { frames: LOCAL_MODEL_MAX_FRAMES.hosted }, upTo: true })
    // The badge: "up to 19 cr" (300 × $0.0004 = $0.12 → 18 credits, + the render credit).
    expect(nodeCreditEstimate(BG_REMOVE_CLASS, values, { inputSeconds: secs!.seconds, families: ON_CLIP })).toBe(19)
    // The run-confirm and the cost gate (hosted): the same ceiling, marked "up to".
    const est = estimateUsdForNodes(vueNodesToEstimateInput(clipCanvas.nodes, clipCanvas.edges, ON_CLIP), { hosted: true, families: ON_CLIP })!
    expect(est.usd).toBe(0.12)
    expect(est.hostedCredits).toBe(19)
    expect(est.breakdown).toEqual([{ id: 'n', label: `${BG_REMOVE_CLASS} (up to)`, usd: 0.12, upTo: true }])
    // What the engine holds for that clip once it has counted 300 frames: the same 18 + 1, never more.
    const prompt: ApiPrompt = { v: { class_type: 'LoadVideoFrames', inputs: {} }, n: bgNode(caseNamed('cutout · a clip of three frames · transparent'), ['v', 0]), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0] } } }
    expect(stageEstimate(prompt, ['n'], true, ON_CLIP, { n: { seconds: { frames: 300 } } })).toBe(19)
    // Locally (ruling (a)): this computer's cap, "up to".
    const local = estimateUsdForNodes(vueNodesToEstimateInput(clipCanvas.nodes, clipCanvas.edges, ON_CLIP), { families: ON_CLIP })!
    expect(local.usd).toBe(0.36)
    expect(local.breakdown[0]!.upTo).toBe(true)
  })

  it('an Empty image batch of 3: counted on the canvas, 3 pictures (1 credit + render), not "up to"; with the family off, nothing priced', () => {
    expect(upstreamPictureCount(bg, batchCanvas.nodes, batchCanvas.edges)).toBe(3)
    const secs = upstreamInputSeconds(bg, batchCanvas.nodes, batchCanvas.edges)
    expect(secs).toEqual({ seconds: { frames: 3 }, upTo: false })
    expect(nodeCreditEstimate(BG_REMOVE_CLASS, values, { inputSeconds: secs!.seconds, families: ON })).toBe(2)
    const est = estimateUsdForNodes(vueNodesToEstimateInput(batchCanvas.nodes, batchCanvas.edges, ON), { hosted: true, families: ON })!
    expect(est.usd).toBe(0.0012)
    expect(est.hostedCredits).toBe(2)
    expect(est.breakdown[0]!.upTo).toBeUndefined()
    expect(estimateUsdForNodes(vueNodesToEstimateInput(batchCanvas.nodes, batchCanvas.edges, new Set(['cards'])), { hosted: true, families: new Set(['cards']) })).toBeNull()
    // A loaded picture: one.
    expect(upstreamPictureCount(bg, [vn('l', 'LoadImage', [['image', 'x.png']]), bg], [wire('l', 'n', 0)])).toBe(1)
  })
})

describe('a frame that fails partway (fix round 1, Important)', () => {
  it('frame 2 of 6 fails with 3 in flight: those 3 are cancelled at once, only the 2 frames delivered are charged', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('cutout · a clip of three frames · premultiplied')
    const clip = 'g_video_smooth.mp4'
    const lvf6 = { class_type: 'LoadVideoFrames', inputs: { file: clip, max_seconds: 10, max_frames: 6, max_size: 64, start_frame: 0, stride: 1 } }
    const prompt: ApiPrompt = { v: lvf6, n: bgNode(c, ['v', 0]), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0], fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } } }
    // Frame 2's call is held until frames 3, 4 and 5 are sent (and held), then fails at the provider: three calls
    // are in flight when the node learns of it. (A clip whose frames all differ, so each hand-off is its own link.)
    let n = 0
    const replicate = createFakeReplicate({ answer: () => ANSWER_URL(n++) })
    const submit = replicate.client.submit
    const frameOf = (p: Record<string, unknown>) => Number(/frame_(\d+)/.exec(String(p.image))?.[1] ?? -1)
    let failing: string | null = null
    const held = new Set<number>()
    replicate.client.submit = (async (slug: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      const i = frameOf(payload)
      if (i >= 2) replicate.holdNext(1)
      const r = await (submit as (...a: unknown[]) => Promise<{ requestId: string }>)(slug, payload, ...rest)
      if (i === 2) failing = r.requestId
      if (i >= 3) held.add(i)
      if (failing && held.size === 3) {
        const f = replicate.reqs.get(failing)!
        f.failWith = 'The input or output was flagged as sensitive'
        f.held = false
      }
      return r
    }) as typeof submit
    const dir = mkdtempSync(join(scratch, 'fail-'))
    const k = makeKit({ hosted: true, dir, replicate, deps: { families: () => ON_CLIP, download: async () => ({ bytes: b64(c.answers[0]!), contentType: 'image/png' }), kept: createFileKeptBytes(join(dir, 'kept')) } })
    writeFileSync(join(k.root, 'input', clip), readFileSync(clipPath(clip)))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.measured?.n?.seconds.frames).toBe(6)
    const rec = take.nodes.n!
    expect(rec.status).toBe('error')
    const byKey = Object.fromEntries((rec.calls ?? []).map(x => [x.key, x.status]))
    // Six calls sent: two delivered, one failed, three in flight and cancelled at once (none finished).
    expect(replicate.submitted().length).toBe(6)
    const statuses = Object.values(byKey)
    expect(statuses.filter(x => x === 'done').length).toBe(2)
    expect(statuses.filter(x => x === 'error').length).toBeGreaterThanOrEqual(1)
    expect(replicate.submitted().map(x => frameOf(x.payload)).sort()).toEqual([0, 1, 2, 3, 4, 5])
    const inFlight = replicate.submitted().filter(x => frameOf(x.payload) >= 3)
    expect(inFlight.every(x => x.cancelled)).toBe(true)
    expect(byKey['cut-2']).toBe('error')
    for (const key of ['cut-3', 'cut-4', 'cut-5']) expect(byKey[key]).not.toBe('done')
    // Held 6 frames (1 credit + render); charged the 2 delivered frames, added up and marked up once: 1 credit.
    expect(charged(k)).toEqual([[2, perFrameCredits([{ usd: 0.0004 }, { usd: 0.0004 }])]])
    expect(rec.values).toBeUndefined()
  })
})

describe('a clip\'s cut-out batch is kept to the run\'s end (fix round 1, Minor 2)', () => {
  it('never let go (a revive would fetch expired answers again); an effect\'s batch is, as before', () => {
    const file = (name: string) => ({ filename: name, subfolder: 'r', type: 'kept' as const })
    const run = (classType: string) => ({
      takes: [{
        prompt: { n: { class_type: classType, inputs: {} } },
        nodes: { n: { classType, status: 'done', values: { 0: { kind: 'frames', file: file('b.mkv'), count: 1, w: 2, h: 2 } } } },
      }],
    }) as never
    expect(spentKeptMedia(run(BG_REMOVE_CLASS))).toEqual([])
    expect(spentKeptMedia(run('VideoReverse')).map(x => x.file.filename)).toEqual(['b.mkv'])
  })
})

describe('prices (R7 rule 4)', () => {
  it('the remover\'s card is R3.5\'s estimate (one live check serves both); no flat row; the price book version stands', () => {
    expect(PAID_RATES[BG_REMOVE_SLUG]).toMatchObject({ unit: 'gpu_ceiling', usd: 0.0004, confidence: 'estimate', service: 'replicate' })
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, BG_REMOVE_CLASS)).toBe(false)
    expect(PAID_NODE_CLASSES).not.toContain(BG_REMOVE_CLASS)
    expect(Object.prototype.hasOwnProperty.call(FAMILY_PRICED_CLASSES, BG_REMOVE_CLASS)).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-sound-in')
  })

  it('priced only while its family is on: frames × one call (1 credit each); one picture when nothing was counted', () => {
    const inputs = { frames: ['l', 0], output: 'transparent', edge_softness: 0 }
    expect('refused' in priceNode(BG_REMOVE_CLASS, inputs)).toBe(true)
    expect('refused' in priceNode(BG_REMOVE_CLASS, inputs, { families: new Set(['bg-remove']) })).toBe(true)
    expect(priceNode(BG_REMOVE_CLASS, inputs, { families: ON })).toEqual({ usd: 0.0004, credits: 1 })
    // USER ruling (fix round 1): the frames' dollars added up, marked up and rounded up to credits ONCE per node.
    expect(priceNode(BG_REMOVE_CLASS, inputs, { families: ON, inputSeconds: { frames: 300 } })).toEqual({ usd: 0.12, credits: creditsForUsd(0.12) })
    expect(creditsForUsd(0.12)).toBe(18)
    expect(priceNode(BG_REMOVE_CLASS, inputs, { families: ON, inputSeconds: { frames: 3 } })).toEqual({ usd: 0.0012, credits: 1 })
    expect((priceNode(BG_REMOVE_CLASS, inputs, { families: ON, inputSeconds: { frames: 900 } }) as { credits: number }).credits).toBe(creditsForUsd(0.36))
    // The charge: the same rule over the frames delivered (a failed or undelivered frame costs nothing).
    expect(perFrameCredits(Array.from({ length: 100 }, () => ({ usd: 0.0004 })))).toBe(creditsForUsd(0.04))
    expect(perFrameCredits([])).toBe(0)
    expect(localModelCalls(BG_REMOVE_CLASS, 3)).toEqual({ steps: [{ call: { endpoint: BG_REMOVE_SLUG }, times: 3 }] })
    // The ComfyUI path: nothing with the family off (as before: it was free); the same calculation with it on.
    expect(priceGraph({ 1: { class_type: BG_REMOVE_CLASS, inputs } }).nodes['1']).toBeUndefined()
    expect(priceGraph({ 1: { class_type: BG_REMOVE_CLASS, inputs } }, { families: ON }).nodes['1']).toBe(1)
    expect(priceGraph({ 1: { class_type: BG_REMOVE_CLASS, inputs } }, { families: ON, inputSeconds: { 1: { frames: 300 } } }).nodes['1']).toBe(18)
  })

  it('sends no text: nothing to moderate', () => {
    expect(Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, BG_REMOVE_CLASS)).toBe(false)
  })

  it('the price\'s tooltip names the service while the family is on (ruling (b)); nothing otherwise', () => {
    expect(SERVICE_OF[BG_REMOVE_CLASS]).toBe('replicate')
    expect(serviceTooltip(BG_REMOVE_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(BG_REMOVE_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(BG_REMOVE_CLASS, new Set(['cards']))).toBeNull()
    expect(nodePriceTooltip('GenerateImageNode', ON)).toBeNull()
  })
})

describe('the R7 families (shared pieces)', () => {
  it('nine families, each off by default, kept apart from RUNNER_FAMILIES; their requirements; the tool families', () => {
    expect(LOCAL_MODEL_FAMILIES).toEqual(['bg-remove', 'upscale-2x', 'object-remove', 'sam-3-masks', 'subject-mask', 'slow-motion-ai', 'whisper-captions', 'vocal-split', 'lens-blur'])
    // Known to parseFamilies, but outside every pinned "every family on" set.
    for (const fam of LOCAL_MODEL_FAMILIES) {
      expect(RUNNER_FAMILIES).not.toContain(fam)
      expect(ALL_RUNNER_FAMILIES).not.toContain(fam)
    }
    expect(LOCAL_MODEL_REQUIRES).toMatchObject({ 'bg-remove': 'cards', 'slow-motion-ai': 'media-video', 'whisper-captions': 'media-sound', 'vocal-split': 'media-sound' })
    expect(LOCAL_MODEL_TOOL_FAMILIES).toEqual(['slow-motion-ai', 'whisper-captions', 'vocal-split'])
    expect([...parseFamilies('bg-remove')]).toEqual([])
    expect([...parseFamilies('bg-remove,cards')].sort()).toEqual(['bg-remove', 'cards'])
    expect([...parseFamilies('cards,whisper-captions')]).toEqual(['cards'])
    expect(LOCAL_MODEL_FAMILY_OF).toEqual({ [BG_REMOVE_CLASS]: 'bg-remove', UpscaleImage: 'upscale-2x' })
  })

  it('the row: a provider class, its widgets as ComfyUI validates them; out of range or wired settings go to the engine', () => {
    expect(RUNNER_NODE_RULES[BG_REMOVE_CLASS]!.family).toBe('bg-remove')
    expect(PROVIDER_TYPES.has(BG_REMOVE_CLASS)).toBe(true)
    expect(SWITCHED_CLASSES[BG_REMOVE_CLASS]).toBe('bg-remove')
    expect(RUNNER_OUTPUT_CLASSES.has(BG_REMOVE_CLASS)).toBe(true)
    const c = CASES[0]!
    const p = (w: Record<string, unknown>): ApiPrompt => ({ l: LOAD, n: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['l', 0], ...c.widgets, ...w } } })
    expect(runnerTakesNode(p({}), 'n', ON)).toBe(true)
    for (const w of [{ output: 'alpha' }, { edge_softness: 10.5 }, { edge_softness: -1 }, { edge_softness: ['x', 0] }, { output: ['x', 0] }]) {
      expect(runnerTakesNode(p(w), 'n', ON), JSON.stringify(w)).toBe(false)
    }
  })
})

describe('with every R7 family off, nothing changes (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === BG_REMOVE_CLASS ? { ...n, class_type: 'BackgroundRemoveBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== BG_REMOVE_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[BG_REMOVE_CLASS]).toBeUndefined()
    }
  }
  const c = CASES[0]!

  it('the class goes to the engine and is named; on, the runner takes it', () => {
    const p: ApiPrompt = { l: LOAD, n: bgNode(c), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    // Its Save image too: it reads no picture the runner knows of while the family is off.
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n', 's'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id })).toEqual([])
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
  })

  it('over one synthetic graph per chain (picture, clip, Image cards, a Frame, frames readers)', () => {
    sameAsBefore({ l: LOAD, n: bgNode(c), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }, 'picture → Save image')
    sameAsBefore({ l: LOAD, n: bgNode(c), f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, '→ Frame')
    sameAsBefore({
      a: { class_type: 'Image', inputs: { image: 'x.png', export: false, batch_index: -1 } }, n: bgNode(c, ['a', 0]),
      b: { class_type: 'Image', inputs: { image: '', export: false, images: ['n', 0], batch_index: -1 } },
    }, 'Image card chain')
    const lvf = { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
    sameAsBefore({ v: lvf, n: bgNode(c, ['v', 0]), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0], fps: 24, filename_prefix: 'v', audio_file: '(none)', preset: 'veryfast', crf: 20 } } }, 'clip → Save video frames')
    sameAsBefore({ v: lvf, n: bgNode(c, ['v', 0]), m: { class_type: 'ImageToMask', inputs: { image: ['n', 0], channel: 'alpha' } } }, 'clip → Image to mask')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (27 use Background remove)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let withIt = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        if (Object.values(p).some(n => n.class_type === BG_REMOVE_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    expect(withIt).toBeGreaterThan(0)
    console.info(`bg-remove families-off invariant: ${graphs} saved graphs, ${withIt} with Background remove`)
  }, 600_000)
})
