/**
 * Step 3, R7.3: Object removal (family `object-remove`) on Replicate's LaMa
 * (`zylim0702/remove-object`, USER ruling (c): R3.7's fill call).
 *
 * comfy_extras/_inpaint.py lama_inpaint truncates the mask to 8 bits, grows
 * it with cv2.dilate (3 × 3, `mask_grow` times), runs LaMa at 512 × 512 and
 * composites the fill back over the picture. The runner sends the picture and
 * the grown mask at full size, and composites the answer exactly as Python
 * does. The fixture (scripts/runner_paid_fixtures.py --group local-erase)
 * records cv2.dilate directly, and runs the real execute with LaMa's session
 * and its resizes swapped for stand-ins, so the composite is of a recorded
 * full-size fill. The shared R7 pieces (per-frame clips, the frame cap, the
 * per-frame price, cancel on failure, the tooltip) are R7.1's
 * (runner-local-cutout.unit.spec.ts).
 *
 * Also R7.3's fix to R7.1: Background remove's `premultiplied` and
 * `matte_only` pictures are saved as Python's RGB, not RGBA.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { FRAMES_LINK_SOURCES } from '#shared/runner/mediaEffects'
import { PHOTO_FILL_SLUGS } from '#shared/runner/layers'
import {
  BG_REMOVE_SLUG, LOCAL_MODEL_FAMILY_OF, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS, OBJECT_REMOVE_GROW, OBJECT_REMOVE_SLUG,
  OBJECT_REMOVE_WORDS, SERVICE_OF, localModelCalls, serviceTooltip,
} from '#shared/runner/localModels'
import { PAID_RATES } from '#shared/pricing/paidRates'
import { FAMILY_PRICED_CLASSES, perFrameCredits, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { nodePriceTooltip } from '~/lib/nodeCreditEstimate'
import { GRAPH_NODE_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { localModelStartProblems } from '~~/server/runner/localModelStart'
import { KEPT_MEDIA_MAKERS } from '~~/server/runner/keptRelease'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { fillInput } from '~~/server/runner/generators/splitLayers'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { maxFilterL } from '~~/server/runner/pixels/maxFilter'
import { eraseCore } from '~~/server/runner/pixels/erase'
import { effectCores } from '~~/server/runner/effects/cores'
import { encodeMask } from '~~/server/runner/pictures/mask'
import { maskTensorBytes } from '~~/server/runner/effects/tensorFiles'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'object-remove'])
const ON_BG: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'bg-remove', 'object-remove'])
const ON_CLIP: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'bg-remove', 'object-remove'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const SCHEMA = loadProviderSchema('replicate', OBJECT_REMOVE_SLUG)
// R7.11: LaMa's card raised from $0.0007 after the live check measured 3.14–3.20 s on T4 ($0.00072).
const USD = 0.0015

interface TensorRecord { shape: number[]; f32_sha256: string; round8_sha256: string; trunc8_sha256: string }
interface DilateCase { name: string; w: number; h: number; grow: number; mask_f32: string; m8: string; grown: string }
interface EraseCase {
  name: string; node_id: string; mask_grow: number; pictures: string[]; mask_shape: number[]; mask_f32: string; fills: string[]; calls: number
  image: TensorRecord; preview: { filename: string; mode: string; w: number; h: number; sha256: string }; animated: boolean[]
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-erase.json'), 'utf8')) as { dilate: DilateCase[]; cases: EraseCase[]; size: [number, number] }
const [W, H] = FX.size

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const f32Of = (s: string) => {
  const b = b64(s)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const erase = eraseCore()
const unit = (k: number) => Math.fround(k / 255)
const caseNamed = (name: string) => FX.cases.find(c => c.name === name)!
const scratch = mkdtempSync(join(tmpdir(), 'local-erase-spec-'))

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height, channels: info.channels }
}
const rgbOf = async (png: Uint8Array) => (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data

/** A case's masks, one [H × W] float32 each. */
function masksOf(c: EraseCase): Float32Array[] {
  const all = f32Of(c.mask_f32)
  const n = c.mask_shape.length === 3 ? c.mask_shape[0]! : 1
  const [h, w] = c.mask_shape.slice(-2) as [number, number]
  return Array.from({ length: n }, (_x, i) => all.slice(i * w * h, (i + 1) * w * h))
}

/** Python's work given the same fills, frame by frame: the float32 batch, and how many calls it made. */
async function expected(c: EraseCase): Promise<{ f32: Float32Array; calls: number; grown: Uint8Array[] }> {
  const masks = masksOf(c)
  const out: Float32Array[] = []
  const grown: Uint8Array[] = []
  let fill = 0
  for (const [t, p] of c.pictures.entries()) {
    const rgb = new Uint8Array(await rgbOf(b64(p)))
    const m8 = erase.mask8(masks[masks.length === 1 ? 0 : t]!)
    const g = c.mask_grow > 0 ? maxFilterL(m8, W, H, 2 * c.mask_grow + 1) : m8
    grown.push(g)
    if (erase.empty(m8)) out.push(Float32Array.from(rgb, unit))
    else out.push(erase.composite(rgb, new Uint8Array(await rgbOf(b64(c.fills[fill++]!))), g, W, H))
  }
  const f32 = new Float32Array(out.reduce((s, x) => s + x.length, 0))
  let at = 0
  for (const x of out) { f32.set(x, at); at += x.length }
  return { f32, calls: fill, grown }
}

const bytesOf = (f: Float32Array) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength)

describe('the fixture', () => {
  it('covers LoadImage\'s, soft, hard and edge masks × grow 0, 1, 4, 64 on three sizes; grow 0 / 4 / 64 through execute; an all-black mask; a clip with one mask and a mask each', () => {
    expect(FX.dilate.length).toBe(60)
    expect(FX.cases.length).toBe(16)
    expect(caseNamed('erase · an all-black mask · grow 4').calls).toBe(0)
    expect(caseNamed('erase · a clip of three frames · a mask per frame, one black').calls).toBe(2)
    // Python's 512 × 512 resize isn't the provider's: the session and resize are stand-ins; the rest is the real execute.
    for (const c of FX.cases) expect(c.animated).toEqual([false])
  })
})

describe('the grow and the composite (../pixels/erase.ts): exact against Python given the same fill', () => {
  it('Python\'s 8 bits of the mask (LoadImage\'s 1 − a/255 truncates one lower), and cv2.dilate as MaxFilter(2·grow + 1), every edge and corner', () => {
    for (const d of FX.dilate) {
      const m8 = erase.mask8(f32Of(d.mask_f32))
      expect(sha(m8), d.name).toBe(sha(b64(d.m8)))
      const g = d.grow > 0 ? maxFilterL(m8, d.w, d.h, 2 * d.grow + 1) : m8
      expect(sha(g), d.name).toBe(sha(b64(d.grown)))
    }
    // The truncation quirk is real: some LoadImage mask levels come out one below k.
    const loader = FX.dilate.find(d => d.name === `dilate · ${W} × ${H} · loader · grow 0`)!
    const m = f32Of(loader.mask_f32)
    const m8 = b64(loader.m8)
    expect([...m].some((v, i) => v > 0 && m8[i] === Math.round(v * 255) - 1)).toBe(true)
  })

  it('every execute case: the float32 batch, both 8-bit forms, the preview, and the calls made', async () => {
    for (const c of FX.cases) {
      const e = await expected(c)
      expect(e.calls, c.name).toBe(c.calls)
      expect(sha(bytesOf(e.f32)), c.name).toBe(c.image.f32_sha256)
      expect(sha(Uint8Array.from(e.f32, erase.round8)), c.name).toBe(c.image.round8_sha256)
      expect(sha(Uint8Array.from(e.f32, erase.trunc8)), c.name).toBe(c.image.trunc8_sha256)
      expect(sha(Uint8Array.from(e.f32.subarray(0, W * H * 3), erase.trunc8)), c.name).toBe(c.preview.sha256)
      expect([c.preview.mode, c.preview.w, c.preview.h]).toEqual(['RGB', W, H])
    }
  })

  it('on the Frame\'s worker, the same pixels; round and trunc both give k back for every k / 255', async () => {
    const c = caseNamed('erase · soft mask · grow 4')
    const rgb = new Uint8Array(await rgbOf(b64(c.pictures[0]!)))
    const fill = new Uint8Array(await rgbOf(b64(c.fills[0]!)))
    const g = maxFilterL(erase.mask8(masksOf(c)[0]!), W, H, 9)
    const here = erase.erase({ rgb, fill, mask: g, w: W, h: H, quant: 'trunc', preview: true })
    const there = await pixelsInWorker(undefined, worker => worker.erase({ rgb: rgb.slice(), fill: fill.slice(), mask: g.slice(), w: W, h: H, quant: 'trunc', preview: true }))
    expect(sha(there.picture)).toBe(sha(here.picture))
    expect(sha(there.preview!)).toBe(c.preview.sha256)
    for (let k = 0; k < 256; k++) expect([erase.round8(unit(k)), erase.trunc8(unit(k))]).toEqual([k, k])
  })
})

// ── The plan, run by hand ───────────────────────────────────────────────────

const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const eraseNode = (grow: number, from: [string, number] = ['l', 0], mask: [string, number] = ['l', 1]) =>
  ({ class_type: OBJECT_REMOVE_CLASS, inputs: { frames: from, mask, mask_grow: grow } })
const PIC = (i: number): OutputFile => ({ filename: `p${i}.png`, subfolder: '', type: 'input' })
const MASK = (i: number): OutputFile => ({ filename: `m${i}.png`, subfolder: 'run', type: 'kept' })
const TENSOR = (i: number): OutputFile => ({ filename: `t${i}.f32`, subfolder: 'run', type: 'kept' })
const ANSWER_URL = (i: number) => `https://replicate.delivery/fill/${i}.png`

interface HandMasks { masks: Float32Array[]; w?: number; h?: number; tensors?: boolean }

async function planOf(pictures: Uint8Array[], m: HandMasks, grow: number, o: { held?: number } = {}): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: { l: LOAD, n: eraseNode(grow) }, nodeId: 'n', gateOpen: false, families: ON,
    filesFrom: link => (link[0] === 'l' && link[1] === 0 ? pictures.map((_x, i) => PIC(i)) : []),
    valueFrom: link => (link[1] === 1
      ? { kind: 'mask', files: m.masks.map((_x, i) => MASK(i)), ...(m.tensors ? { tensors: m.masks.map((_x, i) => TENSOR(i)) } : {}) }
      : { kind: 'files', files: pictures.map((_x, i) => PIC(i)) }),
    toUrl: async f => `https://fal.storage/${f.filename}`,
    measured: { frames: o.held ?? pictures.length },
  })
  if (p.kind !== 'pipeline') throw new Error('Object removal is a pipeline')
  return p
}

/** The pipeline with its calls answered in order, the fills served, its hand-offs and saves kept. */
async function runByHand(pictures: Uint8Array[], m: HandMasks, grow: number, fills: Uint8Array[], o: { held?: number } = {}) {
  const plan = await planOf(pictures, m, grow, o)
  const w = m.w ?? W
  const h = m.h ?? H
  const files = new Map<string, Uint8Array>()
  for (const [i, x] of m.masks.entries()) {
    files.set(MASK(i).filename, await encodeMask({ w, h, data: x }))
    files.set(TENSOR(i).filename, maskTensorBytes({ w, h, data: x }))
  }
  const calls: PipelineCall[] = []
  const handed = new Map<string, Uint8Array>()
  const previews: Uint8Array[] = []
  let n = 0
  const io = {
    signal: new AbortController().signal,
    call: async (x: PipelineCall) => {
      calls.push(x)
      return { result: { output: ANSWER_URL(n++) }, raw: null, urls: [] }
    },
    download: async (url: string) => ({ bytes: fills[Number(/\/(\d+)\.png$/.exec(url)![1])]!, contentType: 'image/png' }),
    keep: async (bytes: Uint8Array, ext: string) => {
      const file: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      files.set(file.filename, bytes)
      return file
    },
    read: async (file: OutputFile) => (file.type === 'input' ? pictures[Number(/^p(\d+)\.png$/.exec(file.filename)![1])]! : files.get(file.filename)!),
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
    savePreview: async (bytes: Uint8Array, s: { nodeId?: string }) => {
      previews.push(bytes)
      return { filename: `live_preview_${s.nodeId}_00001.png`, subfolder: '', type: 'temp' } as OutputFile
    },
    handOff: async (b: Uint8Array, name: string) => {
      handed.set(name, b)
      return `https://fal.storage/${name}`
    },
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, files, handed, previews }
}

describe('one picture (the plan, run by hand)', () => {
  it('every single-picture case, its mask read from the kept tensor: one call to the saved schema, the composite exact (rounded: read by nothing), Python\'s preview', async () => {
    for (const c of FX.cases.filter(x => x.pictures.length === 1)) {
      const r = await runByHand([b64(c.pictures[0]!)], { masks: masksOf(c), tensors: true }, c.mask_grow, c.fills.map(b64))
      const made = await r.run()
      expect(r.calls.length, c.name).toBe(c.calls)
      const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
      const px = await pixels(r.files.get(out.files[0]!.filename)!)
      expect([px.w, px.h, px.channels], c.name).toEqual([W, H, 3])
      expect(sha(px.data), c.name).toBe(c.image.round8_sha256)
      expect(made.ui, c.name).toEqual({ images: [{ filename: 'live_preview_n_00001.png', subfolder: '', type: 'temp' }], animated: [false] })
      expect(sha((await pixels(r.previews[0]!)).data), c.name).toBe(c.preview.sha256)
      if (!c.calls) continue
      const x = r.calls[0]!
      expect([x.key, x.provider, x.endpoint, x.media, x.usd, x.backup], c.name).toEqual(['erase-0', 'replicate', OBJECT_REMOVE_SLUG, 'image', USD, undefined])
      // R3.7's fill call: the picture (a plain RGB PNG: the file itself) and the grown mask, an 8-bit grey PNG.
      expect(x.payload, c.name).toEqual(fillInput('https://fal.storage/p0.png', 'https://fal.storage/erase_mask.png'))
      expect(checkPayload(SCHEMA, x.payload), c.name).toEqual([])
      const sentPng = r.handed.get('erase_mask.png')!
      // An 8-bit greyscale PNG (IHDR: depth 8, colour type 0), its pixels the grown mask.
      expect([sentPng[24], sentPng[25]], c.name).toEqual([8, 0])
      const sent = await sharp(sentPng).extractChannel(0).raw().toBuffer()
      expect(sha(sent), c.name).toBe(sha((await expected(c)).grown[0]!))
    }
  })

  it('a mask read from its 16-bit PNG (no tensor kept): exact for every k / 255', async () => {
    const c = caseNamed('erase · hard mask · grow 4')
    const r = await runByHand([b64(c.pictures[0]!)], { masks: masksOf(c) }, 4, c.fills.map(b64))
    const made = await r.run()
    const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    expect(sha((await pixels(r.files.get(out.files[0]!.filename)!)).data)).toBe(c.image.round8_sha256)
  })

  it('an all-black mask: no call, the picture handed on unchanged — even when its size differs (Python hands it on before OpenCV sees the sizes)', async () => {
    const pic = b64(caseNamed('erase · an all-black mask · grow 4').pictures[0]!)
    for (const m of [{ masks: [new Float32Array(W * H)] }, { masks: [new Float32Array(64 * 64)], w: 64, h: 64 }]) {
      const r = await runByHand([pic], m, 4, [])
      const made = await r.run()
      expect(r.calls).toEqual([])
      const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
      expect(sha((await pixels(r.files.get(out.files[0]!.filename)!)).data)).toBe(sha(new Uint8Array(await rgbOf(pic))))
    }
  })

  it('refused before any call: a mask of another size with something in it; two masks for three pictures; more pictures than the start counted; a call that names no picture is undelivered', async () => {
    const c = caseNamed('erase · hard mask · grow 0')
    const pic = b64(c.pictures[0]!)
    const other = new Float32Array(30 * 19).fill(1)
    const r = await runByHand([pic], { masks: [other], w: 30, h: 19 }, 0, [])
    await expect(r.run()).rejects.toThrow(OBJECT_REMOVE_WORDS.maskSize)
    expect(r.calls).toEqual([])
    await expect(planOf([pic, pic, pic], { masks: [other, other] }, 0)).rejects.toThrow(OBJECT_REMOVE_WORDS.maskCount)
    await expect(planOf([pic, pic], { masks: [other] }, 0, { held: 1 })).rejects.toThrow(LOCAL_MODEL_WORDS.tooManyFrames)
    const plan = await planOf([pic], { masks: masksOf(c) }, 0)
    const undelivered = vi.fn(async () => {})
    const files = new Map([[MASK(0).filename, await encodeMask({ w: W, h: H, data: masksOf(c)[0]! })]])
    const io = {
      signal: new AbortController().signal,
      read: async (f: OutputFile) => (f.type === 'input' ? pic : files.get(f.filename)!),
      call: async () => ({ result: { output: null }, raw: null, urls: [] }),
      handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
      undelivered,
    } as unknown as PipelineIO
    await expect(plan.run(io)).rejects.toThrow(OBJECT_REMOVE_WORDS.noAnswer)
    expect(undelivered).toHaveBeenCalledWith('erase-0', 'no-file')
    for (const w of Object.values(OBJECT_REMOVE_WORDS)) expect(w).not.toMatch(/Node|_|Replicate|LaMa/)
  })

  it('an answer of another size is fitted to the picture (the provider answers full size; Python resizes LaMa\'s 512 back)', async () => {
    const c = caseNamed('erase · hard mask · grow 4')
    const big = new Uint8Array(await sharp(b64(c.fills[0]!)).resize(W * 2, H * 2, { kernel: 'nearest' }).png().toBuffer())
    const r = await runByHand([b64(c.pictures[0]!)], { masks: masksOf(c) }, 4, [big])
    const made = await r.run()
    const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    const px = await pixels(r.files.get(out.files[0]!.filename)!)
    expect([px.w, px.h, px.channels]).toEqual([W, H, 3])
  })
})

// ── Through the engine ──────────────────────────────────────────────────────

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

/** A picture with an alpha (LoadImage's mask is 1 − alpha): random RGB, the alpha 0 inside a disc and soft at its edge. */
async function alphaPicture(w: number, h: number, seed: number): Promise<{ png: Uint8Array; rgb: Uint8Array; mask: Float32Array }> {
  const px = new Uint8Array(w * h * 4)
  const rgb = new Uint8Array(w * h * 3)
  const mask = new Float32Array(w * h)
  let x = seed * 2654435761 >>> 0
  for (let i = 0; i < w * h; i++) {
    for (let ch = 0; ch < 3; ch++) {
      x = (x * 1664525 + 1013904223) >>> 0
      px[i * 4 + ch] = rgb[i * 3 + ch] = x >>> 24
    }
    const r = Math.hypot((i % w) - w / 2, Math.floor(i / w) - h / 2) / (Math.min(w, h) / 2)
    const a = r < 0.3 ? 0 : r < 0.5 ? Math.round((r - 0.3) / 0.2 * 255) : 255
    px[i * 4 + 3] = a
    // LoadImage: 1 − float32(a / 255), in float32.
    mask[i] = Math.fround(1 - Math.fround(a / 255))
  }
  return { png: new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()), rgb, mask }
}

/** A fake Replicate answering by model, and the downloads served by URL. */
function serving(answers: Record<string, (i: number) => Uint8Array>) {
  const seq = new Map<string, number>()
  const replicate = createFakeReplicate({
    answer: (req) => {
      const i = seq.get(req.model) ?? 0
      seq.set(req.model, i + 1)
      return `https://replicate.delivery/${req.model.replace('/', '_')}/${i}.png`
    },
  })
  const download = vi.fn(async (url: string) => {
    const m = /delivery\/([^/]+)\/(\d+)\.png$/.exec(url)!
    return { bytes: answers[m[1]!.replace('_', '/')]!(Number(m[2])), contentType: 'image/png' }
  })
  return { replicate, download }
}

async function kitRun(prompt: ApiPrompt, answers: Record<string, (i: number) => Uint8Array>, o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; files: Record<string, Uint8Array> }) {
  const { replicate, download } = serving(answers)
  const dir = mkdtempSync(join(scratch, 'kit-'))
  const k = makeKit({ hosted: o.hosted, dir, replicate, deps: { families: () => o.families ?? ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
  for (const [name, bytes] of Object.entries(o.files)) writeFileSync(join(k.root, 'input', name), bytes)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const take = (await k.store.get(runId))!.takes[0]!
  return { k, take, replicate }
}

const savedPixels = async (k: { root: string }, f: OutputFile) => pixels(new Uint8Array(readFileSync(join(k.root, f.type, f.subfolder, f.filename))))
const save = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })

describe('the acceptance chains, with ComfyUI off', () => {
  it('Load image (its own mask) → Object removal → Save image, hosted: one call, held and charged one call plus the render credit; saved exactly as Python (LoadImage\'s mask read as its float)', async () => {
    const pic = await alphaPicture(40, 30, 3)
    const fillPng = new Uint8Array(await sharp(Buffer.alloc(40 * 30 * 3, 200), { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer())
    const prompt: ApiPrompt = { l: LOAD, n: eraseNode(2), s: save(['n', 0]) }
    expect(isRunnerEligible(prompt, ON)).toBe(true)
    const { k, take, replicate } = await kitRun(prompt, { [OBJECT_REMOVE_SLUG]: () => fillPng }, { hosted: true, files: { 'image.png': pic.png } })
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([OBJECT_REMOVE_SLUG])
    expect(checkPayload(SCHEMA, replicate.submitted()[0]!.payload)).toEqual([])
    expect(take.measured?.n?.seconds.frames).toBe(1)
    const credits = creditsForUsd(USD)
    expect(take.nodes.n!.credits).toBe(credits)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    // Python: LoadImage's RGB and its float mask, truncated and grown, the fill composited; Save image truncates.
    const g = maxFilterL(erase.mask8(pic.mask), 40, 30, 5)
    const want = erase.erase({ rgb: pic.rgb, fill: new Uint8Array(40 * 30 * 3).fill(200), mask: g, w: 40, h: 30, quant: 'trunc', preview: false }).picture
    const px = await savedPixels(k, take.nodes.s!.outputs[0]!)
    expect([px.w, px.h, px.channels]).toEqual([40, 30, 3])
    expect(sha(px.data)).toBe(sha(want))
    const shown = ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')?.output
    expect(shown.images[0].filename).toMatch(/^live_preview_n_\d{5}\.png$/)
    expect(shown.animated).toEqual([false])
  })

  it('an opaque picture (LoadImage\'s 64 × 64 black mask): no call, nothing charged, the picture saved unchanged', async () => {
    const png = new Uint8Array(await sharp(Buffer.alloc(20 * 10 * 3, 90), { raw: { width: 20, height: 10, channels: 3 } }).png().toBuffer())
    const prompt: ApiPrompt = { l: LOAD, n: eraseNode(4), s: save(['n', 0]) }
    const { k, take, replicate } = await kitRun(prompt, {}, { hosted: true, files: { 'image.png': png } })
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted()).toEqual([])
    expect(take.nodes.n!.calls).toEqual([])
    const held = creditsForUsd(USD) + 1
    const [[h, actual]] = charged(k) as [[number, number]]
    expect(h).toBe(held)
    // The node is charged nothing; only the render credit for the saved picture, if any.
    expect(actual).toBeLessThanOrEqual(1)
    const px = await savedPixels(k, take.nodes.s!.outputs[0]!)
    expect(sha(px.data)).toBe(sha(new Uint8Array(20 * 10 * 3).fill(90)))
  })

  it('Background remove\'s mask → Object removal → Save image (a mask made in the run, as Subject mask will hand one on): two calls, both charged', async () => {
    const pic = await alphaPicture(24, 16, 5)
    const opaque = new Uint8Array(await sharp(pic.rgb, { raw: { width: 24, height: 16, channels: 3 } }).png().toBuffer())
    const cut = await alphaPicture(24, 16, 6)
    const fillPng = new Uint8Array(await sharp(Buffer.alloc(24 * 16 * 3, 7), { raw: { width: 24, height: 16, channels: 3 } }).png().toBuffer())
    const prompt: ApiPrompt = {
      l: LOAD,
      b: { class_type: 'BackgroundRemove', inputs: { frames: ['l', 0], output: 'transparent', edge_softness: 0 } },
      n: eraseNode(1, ['l', 0], ['b', 1]),
      s: save(['n', 0]),
    }
    expect(isRunnerEligible(prompt, ON_BG)).toBe(true)
    expect(runnerTakesNode(prompt, 'n', ON)).toBe(false)
    const { k, take, replicate } = await kitRun(prompt, { [BG_REMOVE_SLUG]: () => cut.png, [OBJECT_REMOVE_SLUG]: () => fillPng }, { hosted: true, families: ON_BG, files: { 'image.png': opaque } })
    for (const id of ['l', 'b', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG, OBJECT_REMOVE_SLUG])
    // Background remove's mask is the cut-out's alpha / 255 (exact through its 16-bit PNG).
    const alpha = new Float32Array(24 * 16)
    const cutPx = await pixels(cut.png)
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.fround(cutPx.data[i * 4 + 3]! / 255)
    const want = erase.erase({ rgb: pic.rgb, fill: new Uint8Array(24 * 16 * 3).fill(7), mask: maxFilterL(erase.mask8(alpha), 24, 16, 3), w: 24, h: 16, quant: 'trunc', preview: false }).picture
    expect(sha((await savedPixels(k, take.nodes.s!.outputs[0]!)).data)).toBe(sha(want))
    const credits = creditsForUsd(0.0008) + creditsForUsd(USD)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
  })

  it('a provider call that fails: nothing charged, the hold released', async () => {
    const pic = await alphaPicture(20, 10, 8)
    const prompt: ApiPrompt = { l: LOAD, n: eraseNode(0), s: save(['n', 0]) }
    const replicate = createFakeReplicate()
    replicate.failNext(1)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), pic.png)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('error')
    expect(charged(k)).toEqual([[creditsForUsd(USD) + 1, 0]])
  })
})

describe('a mask of another size is refused before the hold (fix round 1)', () => {
  const loadOf = (image: string) => ({ class_type: 'LoadImage', inputs: { image, upload: 'image' } })
  const bgOf = (from: [string, number]) => ({ class_type: 'BackgroundRemove', inputs: { frames: from, output: 'transparent', edge_softness: 0 } })

  it('Background remove\'s mask of picture A → Object removal on picture B of another size: refused in plain words before the hold, nothing sent, nothing charged', async () => {
    const a = await alphaPicture(24, 16, 12)
    const b = await alphaPicture(30, 20, 13)
    const prompt: ApiPrompt = { a: loadOf('a.png'), b: bgOf(['a', 0]), c: loadOf('b.png'), n: eraseNode(2, ['c', 0], ['b', 1]), s: save(['n', 0]) }
    expect(isRunnerEligible(prompt, ON_BG)).toBe(true)
    const replicate = createFakeReplicate()
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON_BG } })
    writeFileSync(join(k.root, 'input', 'a.png'), a.png)
    writeFileSync(join(k.root, 'input', 'b.png'), b.png)
    const err = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(OBJECT_REMOVE_WORDS.maskSize)
    // A plain refusal, not a hand-off to the engine.
    expect(err.data).toEqual({ nodeId: 'n', classType: OBJECT_REMOVE_CLASS })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
  })

  it('the same chain with two pictures of one size runs: both calls made and charged', async () => {
    const a = await alphaPicture(24, 16, 14)
    const b = await alphaPicture(24, 16, 15)
    const cut = await alphaPicture(24, 16, 16)
    const fillPng = new Uint8Array(await sharp(Buffer.alloc(24 * 16 * 3, 50), { raw: { width: 24, height: 16, channels: 3 } }).png().toBuffer())
    const prompt: ApiPrompt = { a: loadOf('a.png'), b: bgOf(['a', 0]), c: loadOf('b.png'), n: eraseNode(2, ['c', 0], ['b', 1]), s: save(['n', 0]) }
    const { k, take, replicate } = await kitRun(prompt, { [BG_REMOVE_SLUG]: () => cut.png, [OBJECT_REMOVE_SLUG]: () => fillPng }, { hosted: true, families: ON_BG, files: { 'a.png': a.png, 'b.png': b.png } })
    for (const id of ['a', 'b', 'c', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG, OBJECT_REMOVE_SLUG])
    const credits = creditsForUsd(0.0008) + creditsForUsd(USD)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
  })

  it('LoadImage\'s mask: another size with an alpha is refused before the hold; with no alpha (a black 64 × 64 mask) it runs and makes no call, as Python', async () => {
    const big = await alphaPicture(30, 20, 17)
    const opaque = new Uint8Array(await sharp(Buffer.alloc(30 * 20 * 3, 9), { raw: { width: 30, height: 20, channels: 3 } }).png().toBuffer())
    const small = await alphaPicture(24, 16, 18)
    const prompt: ApiPrompt = { a: loadOf('a.png'), c: loadOf('b.png'), n: eraseNode(2, ['c', 0], ['a', 1]), s: save(['n', 0]) }
    const replicate = createFakeReplicate()
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'a.png'), big.png)
    writeFileSync(join(k.root, 'input', 'b.png'), small.png)
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toThrow(OBJECT_REMOVE_WORDS.maskSize)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    const { take, replicate: r2 } = await kitRun(prompt, {}, { hosted: true, files: { 'a.png': opaque, 'b.png': small.png } })
    for (const id of ['a', 'c', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(r2.submitted()).toEqual([])
  })

  it('the start pass by hand: sized makers compared; a maker it can\'t size is left to the turn\'s check (the backstop)', async () => {
    const a = await alphaPicture(24, 16, 19)
    const b = await alphaPicture(30, 20, 20)
    const files: Record<string, Uint8Array> = { 'a.png': a.png, 'b.png': b.png }
    const read = async (f: OutputFile) => files[f.filename]!
    const shapes = async () => new Map()
    const viaBg: ApiPrompt = { a: loadOf('a.png'), b: bgOf(['a', 0]), c: loadOf('b.png'), n: eraseNode(2, ['c', 0], ['b', 1]) }
    expect((await localModelStartProblems(viaBg, ON_BG, { hosted: true, shapes, read })).refused?.message).toBe(OBJECT_REMOVE_WORDS.maskSize)
    const same: ApiPrompt = { a: loadOf('a.png'), b: bgOf(['a', 0]), n: eraseNode(2, ['a', 0], ['b', 1]) }
    expect((await localModelStartProblems(same, ON_BG, { hosted: true, shapes, read })).refused).toBeUndefined()
    // Image to mask: its picture's size.
    const viaI2m: ApiPrompt = { a: loadOf('a.png'), m: { class_type: 'ImageToMask', inputs: { image: ['a', 0], channel: 'red' } }, c: loadOf('b.png'), n: eraseNode(2, ['c', 0], ['m', 0]) }
    expect((await localModelStartProblems(viaI2m, ON, { hosted: true, shapes, read })).refused?.message).toBe(OBJECT_REMOVE_WORDS.maskSize)
    // No reader (sizes unknown): nothing refused here.
    expect((await localModelStartProblems(viaBg, ON_BG, { hosted: true, shapes })).refused).toBeUndefined()
  })
})

describe('R7.1\'s Background remove saved as Python saves it (R7.3\'s fix)', () => {
  it('premultiplied and matte only are saved RGB (Python\'s 3-channel tensor); transparent keeps its alpha', async () => {
    const pic = await alphaPicture(24, 16, 9)
    const cut = await alphaPicture(24, 16, 10)
    for (const [output, channels] of [['premultiplied', 3], ['matte_only', 3], ['transparent', 4]] as const) {
      const prompt: ApiPrompt = {
        l: LOAD,
        b: { class_type: 'BackgroundRemove', inputs: { frames: ['l', 0], output, edge_softness: 0 } },
        s: save(['b', 0]),
      }
      const { k, take } = await kitRun(prompt, { [BG_REMOVE_SLUG]: () => cut.png }, { families: ON_BG, files: { 'image.png': pic.png } })
      for (const id of ['l', 'b', 's']) expect(take.nodes[id]!.status, `${output} ${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
      const px = await savedPixels(k, take.nodes.s!.outputs[0]!)
      expect(px.channels, output).toBe(channels)
      // Save image truncates Python's tensor: R7.1's cut-out work on the answer, with its own channels.
      const rgba = (await pixels(cut.png)).data
      const want = effectCores.cut.cutout({ rgba, w: 24, h: 16, mode: output, sigma: 0, quant: 'trunc', channels, preview: false }).picture
      expect(sha(px.data), output).toBe(sha(want))
    }
  })
})

describe('a clip, one call per frame (ruling (f))', () => {
  const clip = 'v_stereo_aac.mp4'
  const lvf = { class_type: 'LoadVideoFrames', inputs: { file: clip, max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
  const saveFrames = (from: [string, number]) => ({ class_type: 'SaveVideoFrames', inputs: { frames: from, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
  const bg = { class_type: 'BackgroundRemove', inputs: { frames: ['v', 0], output: 'transparent', edge_softness: 0 } }

  it('a frame batch on slot 0 while the family is on (a picture stays a picture); the frame readers take it; its batch is kept to the run\'s end', () => {
    const p: ApiPrompt = { v: lvf, b: bg, n: eraseNode(2, ['v', 0], ['b', 1]), s: saveFrames(['n', 0]) }
    expect(outputKind(p, ['n', 0], outputKindsFor(ON_CLIP))).toBe('frames')
    expect(outputKind({ l: LOAD, n: eraseNode(2) }, ['n', 0], outputKindsFor(ON_CLIP))).toBe('files')
    expect(isRunnerEligible(p, ON_CLIP)).toBe(true)
    expect(FRAMES_LINK_SOURCES.map(x => x.join(':'))).toContain(`${OBJECT_REMOVE_CLASS}:0`)
    expect(KEPT_MEDIA_MAKERS.has(OBJECT_REMOVE_CLASS)).toBe(true)
  })

  it('Load video frames → Background remove (a mask per frame) → Object removal → Save video frames, hosted: a call per frame each, a batch of three frames', LONG, async () => {
    await requireMediaTools()
    const prompt: ApiPrompt = { v: lvf, b: bg, n: eraseNode(2, ['v', 0], ['b', 1]), s: saveFrames(['n', 0]) }
    const files = { [clip]: new Uint8Array(readFileSync(clipPath(clip))) }
    // The fakes answer a fixed size: fitted to the frame's.
    const cut = await alphaPicture(40, 30, 11)
    const fillPng = new Uint8Array(await sharp(Buffer.alloc(40 * 30 * 3, 128), { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer())
    const { k, take, replicate } = await kitRun(prompt, { [BG_REMOVE_SLUG]: () => cut.png, [OBJECT_REMOVE_SLUG]: () => fillPng }, { hosted: true, families: ON_CLIP, files })
    for (const id of ['v', 'b', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds.frames).toBe(3)
    const sent = replicate.submitted().filter(x => x.endpoint === OBJECT_REMOVE_SLUG)
    expect(sent.length).toBe(3)
    for (const x of sent) expect(checkPayload(SCHEMA, x.payload)).toEqual([])
    const input = take.nodes.v!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    const out = take.nodes.n!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect(out.kind).toBe('frames')
    expect([out.count, out.w, out.h]).toEqual([3, input.w, input.h])
    // Three frames' dollars added up and marked up once (USER ruling).
    expect(take.nodes.n!.credits).toBe(creditsForUsd(3 * USD))
    const credits = creditsForUsd(3 * 0.0008) + creditsForUsd(3 * USD)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
  })

  it('a clip over the frame cap: left to the engine before the hold, in Object removal\'s words', async () => {
    const p: ApiPrompt = { v: lvf, b: bg, n: eraseNode(2, ['v', 0], ['b', 1]), s: saveFrames(['n', 0]) }
    const shapes = (count: number) => async () => new Map([['v:0', { count, w: 64, h: 36, exact: false }], ['b:0', { count, w: 64, h: 36, exact: false }], ['n:0', { count, w: 64, h: 36, exact: false }]])
    const at = await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted) })
    expect(at.problem).toBeNull()
    expect(at.counts.n).toBe(LOCAL_MODEL_MAX_FRAMES.hosted)
    const over = await localModelStartProblems({ v: lvf, n: eraseNode(2, ['v', 0], ['l', 1]), l: LOAD }, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted + 1) })
    expect(over.problem?.message).toBe(OBJECT_REMOVE_WORDS.overCap)
  })
})

// ── Prices, families, tooltip ───────────────────────────────────────────────

describe('prices (R7 rule 4)', () => {
  it('LaMa\'s card is R3.7\'s estimate (one live check serves both); the slug is Separate background and foreground\'s fill; no flat row', () => {
    expect(OBJECT_REMOVE_SLUG).toBe(PHOTO_FILL_SLUGS['LaMa (fast)'])
    expect(PAID_RATES[OBJECT_REMOVE_SLUG]).toMatchObject({ unit: 'gpu_ceiling', usd: USD, confidence: 'verified', service: 'replicate' })
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, OBJECT_REMOVE_CLASS)).toBe(false)
    expect(PAID_NODE_CLASSES).not.toContain(OBJECT_REMOVE_CLASS)
    expect(Object.prototype.hasOwnProperty.call(FAMILY_PRICED_CLASSES, OBJECT_REMOVE_CLASS)).toBe(false)
  })

  it('priced only while its family is on: frames × $0.0015, marked up once; one picture when nothing was counted', () => {
    const inputs = { frames: ['l', 0], mask: ['l', 1], mask_grow: 4 }
    expect('refused' in priceNode(OBJECT_REMOVE_CLASS, inputs)).toBe(true)
    expect('refused' in priceNode(OBJECT_REMOVE_CLASS, inputs, { families: new Set(['object-remove']) })).toBe(true)
    expect(priceNode(OBJECT_REMOVE_CLASS, inputs, { families: ON })).toEqual({ usd: USD, credits: creditsForUsd(USD) })
    expect(priceNode(OBJECT_REMOVE_CLASS, inputs, { families: ON, inputSeconds: { frames: 300 } })).toEqual({ usd: 0.45, credits: creditsForUsd(0.45) })
    expect(perFrameCredits(Array.from({ length: 3 }, () => ({ usd: USD })))).toBe(creditsForUsd(3 * USD))
    expect(localModelCalls(OBJECT_REMOVE_CLASS, 3)).toEqual({ steps: [{ call: { endpoint: OBJECT_REMOVE_SLUG }, times: 3 }] })
    expect(priceGraph({ 1: { class_type: OBJECT_REMOVE_CLASS, inputs } }).nodes['1']).toBeUndefined()
    expect(priceGraph({ 1: { class_type: OBJECT_REMOVE_CLASS, inputs } }, { families: ON }).nodes['1']).toBe(creditsForUsd(USD))
  })

  it('sends no text; the tooltip names the service while the family is on; its route has no backup', () => {
    expect(Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, OBJECT_REMOVE_CLASS)).toBe(false)
    expect(SERVICE_OF[OBJECT_REMOVE_CLASS]).toBe('replicate')
    expect(serviceTooltip(OBJECT_REMOVE_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(OBJECT_REMOVE_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(OBJECT_REMOVE_CLASS, new Set(['cards']))).toBeNull()
    expect(RUNNER_ROUTES[OBJECT_REMOVE_CLASS]).toMatchObject({ first: 'replicate', backup: null })
  })
})

describe('the row and the family', () => {
  it('a provider class in family object-remove; mask_grow as ComfyUI validates it; the mask must be a mask wire; out of range or wired settings go to the engine', () => {
    expect(LOCAL_MODEL_FAMILY_OF[OBJECT_REMOVE_CLASS]).toBe('object-remove')
    expect(RUNNER_NODE_RULES[OBJECT_REMOVE_CLASS]!.family).toBe('object-remove')
    expect(PROVIDER_TYPES.has(OBJECT_REMOVE_CLASS)).toBe(true)
    expect(SWITCHED_CLASSES[OBJECT_REMOVE_CLASS]).toBe('object-remove')
    expect(RUNNER_OUTPUT_CLASSES.has(OBJECT_REMOVE_CLASS)).toBe(true)
    expect(OBJECT_REMOVE_GROW).toEqual({ default: 4, min: 0, max: 64 })
    const p = (w: Record<string, unknown>): ApiPrompt => ({ l: LOAD, n: { class_type: OBJECT_REMOVE_CLASS, inputs: { frames: ['l', 0], mask: ['l', 1], mask_grow: 4, ...w } } })
    expect(runnerTakesNode(p({}), 'n', ON)).toBe(true)
    expect(runnerTakesNode(p({ mask_grow: 0 }), 'n', ON)).toBe(true)
    expect(runnerTakesNode(p({ mask_grow: 64 }), 'n', ON)).toBe(true)
    for (const w of [{ mask_grow: 65 }, { mask_grow: -1 }, { mask_grow: ['x', 0] }, { mask: ['l', 0] }, { mask: undefined }]) expect(runnerTakesNode(p(w), 'n', ON), JSON.stringify(w)).toBe(false)
  })
})

describe('with every R7 family off, nothing changes (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
    ['Background remove and Upscale on, Object removal off', ['cards', 'bg-remove', 'upscale-2x']],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === OBJECT_REMOVE_CLASS ? { ...n, class_type: 'ObjectRemoveBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== OBJECT_REMOVE_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[OBJECT_REMOVE_CLASS]).toBeUndefined()
    }
  }

  it('the class goes to the engine and is named; on, the runner takes it', () => {
    const p: ApiPrompt = { l: LOAD, n: eraseNode(4), s: save(['n', 0]) }
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n', 's'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id })).toEqual([])
  })

  it('over one synthetic graph per chain (picture, clip, Image cards, a Frame, a made mask)', () => {
    sameAsBefore({ l: LOAD, n: eraseNode(4), s: save(['n', 0]) }, 'picture → Save image')
    sameAsBefore({ l: LOAD, n: eraseNode(4), f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, '→ Frame')
    sameAsBefore({
      a: { class_type: 'Image', inputs: { image: 'x.png', export: false, batch_index: -1 } }, l: LOAD, n: eraseNode(4, ['a', 0]),
      b: { class_type: 'Image', inputs: { image: '', export: false, images: ['n', 0], batch_index: -1 } },
    }, 'Image card chain')
    sameAsBefore({
      l: LOAD, b: { class_type: 'BackgroundRemove', inputs: { frames: ['l', 0], output: 'transparent', edge_softness: 0 } },
      n: eraseNode(4, ['l', 0], ['b', 1]), s: save(['n', 0]),
    }, 'Background remove mask')
    const lvf = { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
    sameAsBefore({ v: lvf, l: LOAD, n: eraseNode(4, ['v', 0]), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0], fps: 24, filename_prefix: 'v', audio_file: '(none)', preset: 'veryfast', crf: 20 } } }, 'clip → Save video frames')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph', async () => {
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
        if (Object.values(p).some(n => n.class_type === OBJECT_REMOVE_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`object-remove families-off invariant: ${graphs} saved graphs, ${withIt} with Object removal`)
  }, 600_000)
})
