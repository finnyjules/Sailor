/**
 * Step 3, R7.4: Mask by text and Mask extractor (family `sam-3-masks`) on
 * fal's SAM 3 (`fal-ai/sam-3/image`, the call /api/inpaint/segment makes).
 *
 * comfy_extras/nodes_matte_ml.py runs CLIPSeg (text) and SAM ViT-base (clicks)
 * on the first picture, then thresholds (text), feathers, inverts and previews
 * the mask. The runner sends the picture to SAM 3, takes the union of every
 * mask (text) or the one mask (clicks), and does the rest exactly as Python
 * does. The fixture (scripts/runner_paid_fixtures.py --group local-masks) runs
 * the real execute with both models swapped for stand-ins, so what follows the
 * model is Python's own on a recorded mask, and the clicks are what Python's
 * processor received. The shared R7 pieces are R7.1's (runner-local-cutout).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  LOCAL_MODEL_FAMILY_OF, MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS, OBJECT_REMOVE_CLASS, OBJECT_REMOVE_SLUG, OBJECT_REMOVE_WORDS, SAM_3_SLUG,
  SAM_MASK_WORDS, SERVICE_OF, localModelCalls, serviceTooltip,
} from '#shared/runner/localModels'
import { SAM_3_MAX_MASKS, buildSamInput, parseMaskPoints, samPointsInput, samTextInput } from '#shared/runner/samInput'
import { PAID_RATES } from '#shared/pricing/paidRates'
import { FAMILY_PRICED_CLASSES, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { nodePriceTooltip } from '~/lib/nodeCreditEstimate'
import { upstreamPictureCount } from '~/lib/costEstimate'
import { GRAPH_NODE_CREDITS, MODEL_COSTS, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { localModelStartProblems } from '~~/server/runner/localModelStart'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { maskByTextPrompt, samAnswerMask, samMaskUrls } from '~~/server/runner/generators/localModels'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { samMaskCore } from '~~/server/runner/pixels/samMask'
import { effectCores } from '~~/server/runner/effects/cores'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { maxFilterL } from '~~/server/runner/pixels/maxFilter'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile } from '~~/server/runner/types'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'sam-3-masks'])
const ON_ERASE: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'sam-3-masks', 'object-remove'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const SCHEMA = loadProviderSchema('fal', SAM_3_SLUG)
const USD = 0.005
const LAMA_USD = 0.0007

interface MaskRecord { shape: number[]; f32_sha256: string; f32?: string }
interface PreviewRecord { filename: string; subfolder: string; type: string; mode: string; w: number; h: number; sha256: string; pixels?: string; animated: boolean[] }
interface MaskCase {
  name: string; class_type: string; node_id: string; pictures: string[]; widgets: Record<string, any>; error?: string
  answer?: string; logits_dims?: number; sent_text?: string[]; sent_size?: number[]
  scores?: number[]; best?: number; sent_coords?: number[][]; sent_labels?: number[]
  mask?: MaskRecord; preview?: PreviewRecord
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-masks.json'), 'utf8')) as {
  cases: MaskCase[]; size: [number, number]; answers: Record<string, string>; candidates: string[]
}
const [W, H] = FX.size

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const f32Of = (s: string) => {
  const b = b64(s)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const bytesOf = (f: Float32Array) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
const core = samMaskCore(effectCores.kn, effectCores.px)
const texts = FX.cases.filter(c => c.class_type === MASK_BY_TEXT_CLASS)
const clicks = FX.cases.filter(c => c.class_type === MASK_EXTRACTOR_CLASS)
const caseNamed = (name: string) => FX.cases.find(c => c.name === name)!
const scratch = mkdtempSync(join(tmpdir(), 'local-masks-spec-'))
const rgbOf = async (png: Uint8Array) => new Uint8Array((await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data)
/** The given mask of a case: the CLIPSeg stand-in's sigmoid, or SAM's best candidate. */
const givenOf = (c: MaskCase) => (c.class_type === MASK_BY_TEXT_CLASS ? f32Of(FX.answers[c.answer!]!) : f32Of(FX.candidates[c.best!]!))
/** A float32 0/1 mask as SAM 3 answers it: an 8-bit grey PNG, white = selected. */
const maskPngOf = async (m: Float32Array, w = W, h = H) => new Uint8Array(await sharp(Buffer.from(Array.from(m, v => Math.round(v * 255))), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer())
/** The largest difference between two float32 masks. */
const most = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0)
/** torchvision's gaussian_blur is LIBRARY (R2.2): within 2⁻⁸ on the 255 scale. */
const BAND = 2 ** -8 / 255

describe('the fixture', () => {
  it('covers every threshold, feather and invert edge on hard and soft masks, three prompts, a batch, a feather wider than the picture; the click texts Python reads and fails on', () => {
    expect(texts.length).toBe(29)
    expect(clicks.length).toBe(27)
    expect(caseNamed('text · feather 30 on 24 × 16 (Python fails)').error).toBe('RuntimeError')
    expect(clicks.filter(c => c.error).map(c => c.error)).toEqual(['TypeError', 'KeyError', 'ValueError', 'TypeError', 'ValueError', 'OverflowError', 'ValueError'])
    // Python's `prompt or "object"`: an empty prompt sends "object"; spaces are sent as they are.
    expect(new Set(texts.filter(c => !c.error).map(c => `${JSON.stringify(c.widgets.prompt)}→${c.sent_text![0]}`))).toEqual(new Set(['""→object', '"the dog"→the dog', '"  "→  ', '"sky"→sky']))
    for (const c of FX.cases.filter(x => !x.error)) {
      expect(c.preview!.filename).toBe(`live_preview_${c.node_id}.png`)
      expect([c.preview!.mode, c.preview!.w, c.preview!.h, c.preview!.type]).toEqual(['RGB', W, H, 'temp'])
      expect(c.preview!.animated).toEqual([false])
      expect(c.mask!.shape).toEqual([1, H, W])
    }
  })
})

describe('the clicks (#shared/runner/samInput parseMaskPoints): exactly what Python\'s processor receives', () => {
  it('every click text: the pixel points and labels, or Python\'s failure, or a label SAM 3 doesn\'t take', () => {
    for (const c of clicks) {
      const r = parseMaskPoints(c.widgets.points, W, H)
      if (c.error) {
        expect(r, c.name).toEqual({ ok: false, why: c.widgets.points.includes('NaN') ? 'unreadable' : 'fails' })
        continue
      }
      if (c.sent_labels!.some(l => l !== 0 && l !== 1)) {
        expect(r, c.name).toEqual({ ok: false, why: 'label' })
        continue
      }
      expect(r, c.name).toEqual({ ok: true, points: c.sent_coords!.map(([x, y], i) => ({ x, y, label: c.sent_labels![i] })) })
      expect(c.sent_size).toEqual([W, H])
    }
  })

  it('the click call is /api/inpaint/segment\'s (one builder), without sync_mode; it passes the saved schema', () => {
    const pts = [{ x: 3, y: 4, label: 1 as const }, { x: 9, y: 2, label: 0 as const }]
    const payload = samPointsInput('https://fal.storage/p.png', pts)
    expect(payload).toEqual({ image_url: 'https://fal.storage/p.png', prompt: '', apply_mask: false, output_format: 'png', return_multiple_masks: false, max_masks: 1, point_prompts: pts })
    const { sync_mode: sync, ...rest } = buildSamInput({ image: 'https://fal.storage/p.png', points: pts })
    expect(sync).toBe(true)
    expect(rest).toEqual(payload)
    expect(checkPayload(SCHEMA, payload)).toEqual([])
    expect(checkPayload(SCHEMA, buildSamInput({ image: 'data:x', xPx: 1, yPx: 2 }))).toEqual([])
  })

  it('the text call: the words as Python sends them, every mask asked for (the schema\'s most); it passes the saved schema', () => {
    expect(maskByTextPrompt('')).toBe('object')
    expect(maskByTextPrompt(undefined)).toBe('object')
    expect(maskByTextPrompt('  ')).toBe('  ')
    const payload = samTextInput('https://fal.storage/p.png', 'the dog')
    expect(payload).toEqual({ image_url: 'https://fal.storage/p.png', prompt: 'the dog', apply_mask: false, output_format: 'png', return_multiple_masks: true, max_masks: 32 })
    expect(checkPayload(SCHEMA, payload)).toEqual([])
    const props = (SCHEMA as any).components.schemas.Sam3ImageInput.properties
    expect(props.max_masks.maximum).toBe(SAM_3_MAX_MASKS)
    expect(props.point_prompts.items.$ref).toBe('#/components/schemas/PointPrompt')
  })
})

describe('after the model (../pixels/samMask.ts): exact against Python given the same mask', () => {
  it('every case: the mask (float32, exact; a feathered one within torchvision\'s band) and the preview', async () => {
    for (const c of FX.cases.filter(x => !x.error)) {
      const t = c.class_type === MASK_BY_TEXT_CLASS ? c.widgets.threshold as number : null
      const m = core.finish(givenOf(c), W, H, t, c.widgets.feather, c.widgets.invert)
      const rgb = await rgbOf(b64(c.pictures[0]!))
      const pv = core.preview(rgb, m)
      if (c.widgets.feather > 0) {
        expect(most(m, f32Of(c.mask!.f32!)), c.name).toBeLessThanOrEqual(BAND)
        const py = b64(c.preview!.pixels!)
        expect(pv.reduce((s, v, i) => Math.max(s, Math.abs(v - py[i]!)), 0), c.name).toBeLessThanOrEqual(1)
      }
      else {
        expect(sha(bytesOf(m)), c.name).toBe(c.mask!.f32_sha256)
        expect(sha(pv), c.name).toBe(c.preview!.sha256)
      }
    }
  })

  it('the threshold compares in float32 (a mask value of exactly 0.5 is not above 0.5)', () => {
    const c = caseNamed('text · soft · prompt \'the dog\' · threshold 0.5 · feather 0.0 · invert False')
    const given = givenOf(c)
    expect(given.some(v => v === 0.5)).toBe(true)
    expect(sha(bytesOf(core.finish(given, W, H, 0.5, 0, false)))).toBe(c.mask!.f32_sha256)
  })

  it('the answer read as SAM 3 sends it: masks as grey PNGs, each k / 255, their union; one of another size fitted to the picture', async () => {
    const hard = givenOf(caseNamed('text · hard · prompt \'\' · threshold 0.0 · feather 0.0 · invert False'))
    // Split in two masks (left and right halves): their union is the mask.
    const left = hard.map((v, i) => (i % W < W / 2 ? v : 0))
    const right = hard.map((v, i) => (i % W >= W / 2 ? v : 0))
    const masks = [await samAnswerMask(await maskPngOf(left)), await samAnswerMask(await maskPngOf(right))]
    expect(sha(bytesOf(core.union(masks, W, H)))).toBe(sha(bytesOf(hard)))
    // RGB and RGBA answers read as PIL's L.
    const rgbPng = new Uint8Array(await sharp(Buffer.from([255, 255, 255, 0, 0, 0]), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer())
    expect([...(await samAnswerMask(rgbPng)).l]).toEqual([255, 0])
    // No mask: all black.
    expect(core.union([], W, H).every(v => v === 0)).toBe(true)
    // An answer of half the size: fitted with R0's bilinear (every value inside 0..1, the size the picture's).
    const small = { l: new Uint8Array((W / 2) * (H / 2)).fill(255), w: W / 2, h: H / 2 }
    const fitted = core.union([small], W, H)
    expect(fitted.length).toBe(W * H)
    expect(fitted.every(v => v === 1)).toBe(true)
  })

  it('a feather wider than the picture: Python fails in torchvision\'s padding; the runner narrows it (fix-bugs rule)', () => {
    const c = caseNamed('text · feather 30 on 24 × 16 (Python fails)')
    const m = core.finish(givenOf(c), W, H, 0, 30, false)
    expect(m.every(v => v >= 0 && v <= 1)).toBe(true)
    expect(core.finish(new Float32Array(1).fill(1), 1, 1, 0, 30, false)[0]).toBe(1)
  })

  it('on the Frame\'s worker, the same mask and preview', async () => {
    const c = caseNamed('clicks · feather 2.5 · invert True')
    const rgb = await rgbOf(b64(c.pictures[0]!))
    const masks = [{ l: Uint8Array.from(givenOf(c), v => v * 255), w: W, h: H }]
    const here = core.samMask({ masks, w: W, h: H, threshold: null, feather: 2.5, invert: true, rgb })
    const there = await pixelsInWorker(new AbortController().signal, worker => worker.samMask({ masks: masks.map(m => ({ ...m, l: m.l.slice() })), w: W, h: H, threshold: null, feather: 2.5, invert: true, rgb: rgb.slice() }), 'slow')
    expect(sha(bytesOf(there.mask))).toBe(sha(bytesOf(here.mask)))
    expect(sha(there.preview)).toBe(sha(here.preview))
  })
})

// ── The plan, run by hand ───────────────────────────────────────────────────

const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const textNode = (w: Record<string, unknown> = {}, from: [string, number] = ['l', 0]) =>
  ({ class_type: MASK_BY_TEXT_CLASS, inputs: { image: from, prompt: 'the dog', threshold: 0, feather: 0, invert: false, ...w } })
const clickNode = (w: Record<string, unknown> = {}, from: [string, number] = ['l', 0]) =>
  ({ class_type: MASK_EXTRACTOR_CLASS, inputs: { image: from, points: '[{"x":0.5,"y":0.5,"label":1}]', feather: 0, invert: false, ...w } })
const PIC: OutputFile = { filename: 'p.png', subfolder: '', type: 'input' }
const ANSWER_URL = (i: number) => `https://v3.fal.media/files/mask_${i}.png`

async function runByHand(node: { class_type: string; inputs: Record<string, unknown> }, picture: Uint8Array, answers: Uint8Array[]) {
  const plan: NodePlan = await planNode({
    prompt: { l: LOAD, n: node }, nodeId: 'n', gateOpen: false, families: ON,
    filesFrom: () => [PIC],
    valueFrom: () => ({ kind: 'files', files: [PIC] }),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
  if (plan.kind !== 'pipeline') throw new Error('A mask class is a pipeline')
  const calls: PipelineCall[] = []
  const files = new Map<string, Uint8Array>()
  const previews: { bytes: Uint8Array; name: string }[] = []
  const io = {
    signal: new AbortController().signal,
    call: async (x: PipelineCall) => {
      calls.push(x)
      return { result: { image: { url: ANSWER_URL(99) }, masks: answers.map((_a, i) => ({ url: ANSWER_URL(i) })) }, raw: null, urls: [] }
    },
    download: async (url: string) => ({ bytes: answers[Number(/mask_(\d+)\.png$/.exec(url)![1])]!, contentType: 'image/png' }),
    keep: async (bytes: Uint8Array, ext: string) => {
      const file: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      files.set(file.filename, bytes)
      return file
    },
    read: async (file: OutputFile) => (file.type === 'input' ? picture : files.get(file.filename)!),
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
    savePreviewAs: async (bytes: Uint8Array, s: { filename: string }) => {
      previews.push({ bytes, name: s.filename })
      return { filename: s.filename, subfolder: '', type: 'temp' } as OutputFile
    },
    handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, files, previews }
}

describe('one picture (the plan, run by hand)', () => {
  it('text: one call to the saved schema; the union of every mask; Python\'s mask and preview', async () => {
    const c = caseNamed('text · hard · prompt \'\' · threshold 0.0 · feather 0.0 · invert True')
    const hard = givenOf(c)
    const left = hard.map((v, i) => (i % W < W / 2 ? v : 0))
    const right = hard.map((v, i) => (i % W >= W / 2 ? v : 0))
    const r = await runByHand(textNode({ prompt: '', invert: true }), b64(c.pictures[0]!), [await maskPngOf(left), await maskPngOf(right)])
    const out = await r.run()
    expect(r.calls.map(x => [x.provider, x.endpoint, x.usd])).toEqual([['fal', SAM_3_SLUG, USD]])
    expect(r.calls[0]!.payload).toEqual(samTextInput('https://fal.storage/p.png', 'object'))
    expect(checkPayload(SCHEMA, r.calls[0]!.payload)).toEqual([])
    const v = out.values![0] as { kind: string; files: OutputFile[]; tensors?: OutputFile[] }
    expect(v.kind).toBe('mask')
    // Read by nothing that takes the float: no tensor kept; the 16-bit PNG is exact for 0 and 1.
    expect(v.tensors).toBeUndefined()
    const m = await decodeMask(r.files.get(v.files[0]!.filename)!)
    expect([m.w, m.h]).toEqual([W, H])
    expect(sha(bytesOf(m.data))).toBe(c.mask!.f32_sha256)
    expect(r.previews.map(p => p.name)).toEqual(['live_preview_n.png'])
    expect(sha(await rgbOf(r.previews[0]!.bytes))).toBe(c.preview!.sha256)
    expect(out.ui).toEqual({ images: [{ filename: 'live_preview_n.png', subfolder: '', type: 'temp' }], animated: [false] })
  })

  it('clicks: the points read at the picture\'s size and sent as the route sends them; masks[0] only; Python\'s mask and preview', async () => {
    const c = caseNamed('clicks · \'[{"x":0.1,"y":0.2,"label":1},{"x":0.9,"y":0.8,"label":0},{"x":0.5,"y":0.5}]\'')
    const best = givenOf(c)
    const r = await runByHand(clickNode({ points: c.widgets.points }), b64(c.pictures[0]!), [await maskPngOf(best), await maskPngOf(new Float32Array(W * H).fill(1))])
    const out = await r.run()
    expect(r.calls.length).toBe(1)
    expect(r.calls[0]!.payload).toEqual(samPointsInput('https://fal.storage/p.png', c.sent_coords!.map(([x, y], i) => ({ x: x!, y: y!, label: c.sent_labels![i] as 0 | 1 }))))
    expect(checkPayload(SCHEMA, r.calls[0]!.payload)).toEqual([])
    const v = out.values![0] as { files: OutputFile[] }
    expect(sha(bytesOf((await decodeMask(r.files.get(v.files[0]!.filename)!)).data))).toBe(c.mask!.f32_sha256)
    expect(sha(await rgbOf(r.previews[0]!.bytes))).toBe(c.preview!.sha256)
  })

  it('an answer with no mask: an all-black mask, the call made (charged, ruling (k))', async () => {
    const c = clicks[0]!
    const r = await runByHand(clickNode(), b64(c.pictures[0]!), [])
    const out = await r.run()
    expect(r.calls.length).toBe(1)
    const v = out.values![0] as { files: OutputFile[] }
    expect((await decodeMask(r.files.get(v.files[0]!.filename)!)).data.every(x => x === 0)).toBe(true)
    expect(samMaskUrls({ masks: [] })).toEqual([])
    expect(samMaskUrls(null)).toEqual([])
    expect(samMaskUrls({ masks: [{ url: 'a' }, {}, { url: 'b' }] })).toEqual(['a', 'b'])
  })

  it('wired clicks Python can\'t read, or a label SAM 3 doesn\'t take: refused in plain words before any call', async () => {
    const pic = b64(clicks[0]!.pictures[0]!)
    for (const [points, words] of [['[1, 2]', SAM_MASK_WORDS.pointsFail], ['[{"x":0.5,"y":0.5,"label":2}]', SAM_MASK_WORDS.pointsLabel], ['[{"x":NaN,"y":0}]', SAM_MASK_WORDS.pointsUnreadable]] as const) {
      const r = await runByHand(clickNode({ points }), pic, [])
      await expect(r.run(), points).rejects.toThrow(words)
      expect(r.calls).toEqual([])
    }
  })
})

// ── Through the engine, with ComfyUI off ────────────────────────────────────

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])
const save = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, ...SAVE_DEFAULTS } })
const eraseNode = (mask: [string, number], from: [string, number] = ['l', 0]) => ({ class_type: OBJECT_REMOVE_CLASS, inputs: { frames: from, mask, mask_grow: 1 } })

async function picturePng(w: number, h: number, v: number) {
  return new Uint8Array(await sharp(Buffer.alloc(w * h * 3, v), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer())
}

async function kitRun(prompt: ApiPrompt, o: { masks: Uint8Array[]; fill?: Uint8Array; files: Record<string, Uint8Array>; families?: ReadonlySet<RunnerFamily>; moderate?: (t: string) => Promise<{ ok: true } | { ok: false; categories: string[] }> }) {
  const fal = createFakeFal({ answer: () => ({ image: { url: 'https://v3.fal.media/files/overlay.png' }, masks: o.masks.map((_m, i) => ({ url: ANSWER_URL(i) })) }) })
  const replicate = createFakeReplicate({ answer: () => 'https://replicate.delivery/fill/0.png' })
  const download = vi.fn(async (url: string) => {
    const m = /mask_(\d+)\.png$/.exec(url)
    return { bytes: m ? o.masks[Number(m[1])]! : o.fill!, contentType: 'image/png' }
  })
  const dir = mkdtempSync(join(scratch, 'kit-'))
  const k = makeKit({ hosted: true, dir, fal, replicate, moderate: o.moderate, deps: { families: () => o.families ?? ON_ERASE, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
  for (const [name, bytes] of Object.entries(o.files)) writeFileSync(join(k.root, 'input', name), bytes)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  return { k, take: (await k.store.get(runId))!.takes[0]!, fal, replicate }
}

describe('the acceptance chains, with ComfyUI off', () => {
  it('Load image → Mask extractor → Object removal → Save image, hosted: two calls, both held and charged; the fill composited under SAM 3\'s mask', async () => {
    const w = 20
    const h = 12
    const mask = new Float32Array(w * h).map((_v, i) => (i % w >= 5 && i % w < 12 && Math.floor(i / w) >= 3 && Math.floor(i / w) < 9 ? 1 : 0))
    const prompt: ApiPrompt = { l: LOAD, x: clickNode({ points: '[{"x":0.4,"y":0.5,"label":1}]' }), n: eraseNode(['x', 0]), s: save(['n', 0]) }
    expect(isRunnerEligible(prompt, ON_ERASE)).toBe(true)
    const { k, take, fal, replicate } = await kitRun(prompt, { masks: [await maskPngOf(mask, w, h)], fill: await picturePng(w, h, 200), files: { 'image.png': await picturePng(w, h, 40) } })
    for (const id of ['l', 'x', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(fal.submitted().map(x => x.endpoint)).toEqual([SAM_3_SLUG])
    expect(fal.submitted()[0]!.payload).toMatchObject({ point_prompts: [{ x: 8, y: 6, label: 1 }], prompt: '', return_multiple_masks: false, max_masks: 1 })
    expect(checkPayload(SCHEMA, fal.submitted()[0]!.payload)).toEqual([])
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([OBJECT_REMOVE_SLUG])
    const credits = creditsForUsd(USD) + creditsForUsd(LAMA_USD)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    // The saved picture: 200 inside the mask grown by one, 40 outside.
    const px = new Uint8Array(await sharp(readFileSync(join(k.root, 'output', take.nodes.s!.outputs[0]!.subfolder, take.nodes.s!.outputs[0]!.filename))).raw().toBuffer())
    const grown = maxFilterL(Uint8Array.from(mask, v => v * 255), w, h, 3)
    for (let i = 0; i < w * h; i++) expect(px[i * 3], `pixel ${i}`).toBe(grown[i] ? 200 : 40)
  })

  it('Load image → Mask by text → Object removal, hosted: the words moderated; the union of the masks removed', async () => {
    const w = 16
    const h = 10
    const a = new Float32Array(w * h).map((_v, i) => (i % w < 4 ? 1 : 0))
    const b = new Float32Array(w * h).map((_v, i) => (i % w >= 12 ? 1 : 0))
    const seen: string[] = []
    const prompt: ApiPrompt = { l: LOAD, t: textNode({ prompt: 'the posts' }), n: eraseNode(['t', 0]), s: save(['n', 0]) }
    expect(extraPromptTexts(prompt)).toContain('the posts')
    const { k, take, fal } = await kitRun(prompt, {
      masks: [await maskPngOf(a, w, h), await maskPngOf(b, w, h)], fill: await picturePng(w, h, 9), files: { 'image.png': await picturePng(w, h, 100) },
      moderate: async (t) => { seen.push(t); return { ok: true } },
    })
    for (const id of ['l', 't', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(seen).toContain('the posts')
    expect(fal.submitted()[0]!.payload).toMatchObject({ prompt: 'the posts', return_multiple_masks: true, max_masks: SAM_3_MAX_MASKS })
    const px = new Uint8Array(await sharp(readFileSync(join(k.root, 'output', take.nodes.s!.outputs[0]!.subfolder, take.nodes.s!.outputs[0]!.filename))).raw().toBuffer())
    for (let i = 0; i < w * h; i++) expect(px[i * 3], `pixel ${i}`).toBe(i % w < 5 || i % w >= 11 ? 9 : 100)
    expect(charged(k).length).toBe(1)
  })

  it('a SAM 3 mask of another size than Object removal\'s picture: refused before the hold, nothing sent (its maskShapes row)', async () => {
    const prompt: ApiPrompt = {
      l: LOAD, b: { class_type: 'LoadImage', inputs: { image: 'other.png', upload: 'image' } },
      t: textNode(), n: eraseNode(['t', 0], ['b', 0]), s: save(['n', 0]),
    }
    const fal = createFakeFal()
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON_ERASE } })
    writeFileSync(join(k.root, 'input', 'image.png'), await picturePng(24, 16, 1))
    writeFileSync(join(k.root, 'input', 'other.png'), await picturePng(30, 20, 1))
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toThrow(OBJECT_REMOVE_WORDS.maskSize)
    expect(k.ledger.holds.size).toBe(0)
    expect(fal.submitted()).toEqual([])
    // The start pass by hand: the same sizes pass.
    const same = { ...prompt, n: eraseNode(['t', 0], ['l', 0]) }
    const read = async (f: OutputFile) => new Uint8Array(readFileSync(join(k.root, 'input', f.filename)))
    expect((await localModelStartProblems(same, ON_ERASE, { hosted: true, shapes: async () => new Map(), read })).refused).toBeUndefined()
    expect((await localModelStartProblems(prompt, ON_ERASE, { hosted: true, shapes: async () => new Map(), read })).refused?.message).toBe(OBJECT_REMOVE_WORDS.maskSize)
  })

  it('a provider call that fails: nothing charged, the hold released', async () => {
    const fal = createFakeFal()
    fal.failNext(1)
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), await picturePng(8, 8, 3))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ l: LOAD, x: clickNode() }], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.x!.status).toBe('error')
    expect(charged(k)).toEqual([[creditsForUsd(USD), 0]])
  })
})

// ── Prices, families, tooltip ───────────────────────────────────────────────

describe('prices (R7 rule 4)', () => {
  it('SAM 3\'s card: $0.005 a request, verified, as fal\'s page and the route\'s row say; no flat row', () => {
    expect(PAID_RATES[SAM_3_SLUG]).toMatchObject({ unit: 'per_call', usd: USD, confidence: 'verified', service: 'fal' })
    expect((SCHEMA as any).pricingText).toContain('$0.005 per request')
    expect(MODEL_COSTS[SAM_3_SLUG]!.usd).toBe(USD)
    for (const cls of [MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS]) {
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, cls)).toBe(false)
      expect(PAID_NODE_CLASSES).not.toContain(cls)
      expect(Object.prototype.hasOwnProperty.call(FAMILY_PRICED_CLASSES, cls)).toBe(false)
    }
  })

  it('priced only while its family is on: one call, however many pictures come in', () => {
    const inputs = textNode().inputs
    expect('refused' in priceNode(MASK_BY_TEXT_CLASS, inputs)).toBe(true)
    expect('refused' in priceNode(MASK_BY_TEXT_CLASS, inputs, { families: new Set(['sam-3-masks']) })).toBe(true)
    expect(priceNode(MASK_BY_TEXT_CLASS, inputs, { families: ON })).toEqual({ usd: USD, credits: creditsForUsd(USD) })
    expect(priceNode(MASK_EXTRACTOR_CLASS, clickNode().inputs, { families: ON, inputSeconds: { frames: 300 } })).toEqual({ usd: USD, credits: creditsForUsd(USD) })
    expect(localModelCalls(MASK_EXTRACTOR_CLASS, 300)).toEqual({ steps: [{ call: { endpoint: SAM_3_SLUG }, times: 1 }] })
    expect(priceGraph({ 1: { class_type: MASK_BY_TEXT_CLASS, inputs } }).nodes['1']).toBeUndefined()
    expect(priceGraph({ 1: { class_type: MASK_BY_TEXT_CLASS, inputs } }, { families: ON }).nodes['1']).toBe(creditsForUsd(USD))
    // The canvas counts one picture (no "up to").
    expect(upstreamPictureCount({ id: 'x', data: { nodeType: MASK_EXTRACTOR_CLASS, inputs: [] } }, [], [])).toBe(1)
  })

  it('Mask by text\'s words are moderated, Mask extractor sends none; the tooltip names fal while the family is on; no backup', () => {
    expect(PAID_TEXT_INPUTS[MASK_BY_TEXT_CLASS]).toEqual(['prompt'])
    expect(Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, MASK_EXTRACTOR_CLASS)).toBe(false)
    for (const cls of [MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS]) {
      expect(SERVICE_OF[cls]).toBe('fal')
      expect(serviceTooltip(cls, ON)).toBe('Runs on fal')
      expect(nodePriceTooltip(cls, ON)).toBe('Runs on fal')
      expect(nodePriceTooltip(cls, new Set(['cards']))).toBeNull()
      expect(RUNNER_ROUTES[cls]).toMatchObject({ first: 'fal', backup: null })
    }
  })
})

describe('the rows and the family', () => {
  it('provider classes in family sam-3-masks, output nodes; the settings as ComfyUI validates them; typed clicks SAM 3 can\'t take or Python can\'t read go to the engine; wired text is taken', () => {
    for (const cls of [MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS]) {
      expect(LOCAL_MODEL_FAMILY_OF[cls]).toBe('sam-3-masks')
      expect(RUNNER_NODE_RULES[cls]!.family).toBe('sam-3-masks')
      expect(PROVIDER_TYPES.has(cls)).toBe(true)
      expect(SWITCHED_CLASSES[cls]).toBe('sam-3-masks')
      expect(RUNNER_OUTPUT_CLASSES.has(cls)).toBe(true)
      expect(outputKindsFor(ON)[cls]).toEqual({ 0: 'mask' })
    }
    const pt = (w: Record<string, unknown>): ApiPrompt => ({ l: LOAD, n: textNode(w) })
    expect(runnerTakesNode(pt({}), 'n', ON)).toBe(true)
    expect(runnerTakesNode(pt({ threshold: 1, feather: 30, invert: true }), 'n', ON)).toBe(true)
    // A text wire into the words or the clicks: read at the node's turn (R0).
    const str = { class_type: 'PrimitiveStringMultiline', inputs: { value: '[1, 2]' } }
    expect(runnerTakesNode({ l: LOAD, p: str, n: textNode({ prompt: ['p', 0] }) }, 'n', ON)).toBe(true)
    expect(runnerTakesNode({ l: LOAD, p: str, n: clickNode({ points: ['p', 0] }) }, 'n', ON)).toBe(true)
    // A picture wire into the words is refused (left to the engine).
    expect(runnerTakesNode({ l: LOAD, n: textNode({ prompt: ['l', 0] }) }, 'n', ON)).toBe(false)
    for (const w of [{ threshold: 1.5 }, { feather: 31 }, { feather: -1 }, { invert: ['x', 0] }, { image: ['l', 1] }]) expect(runnerTakesNode(pt(w), 'n', ON), JSON.stringify(w)).toBe(false)
    const pc = (points: unknown): ApiPrompt => ({ l: LOAD, n: clickNode({ points }) })
    for (const c of clicks) {
      const takes = !c.error && c.sent_labels!.every(l => l === 0 || l === 1)
      expect(runnerTakesNode(pc(c.widgets.points), 'n', ON), c.name).toBe(takes)
    }
  })
})

describe('with every R7 family off, nothing changes (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
    ['the other R7 families on, the masks off', ['cards', 'bg-remove', 'upscale-2x', 'object-remove']],
  ]
  const OURS = new Set([MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS])
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, OURS.has(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!OURS.has(p[id]!.class_type)) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      for (const cls of OURS) expect(outputKindsFor(families)[cls]).toBeUndefined()
    }
  }

  it('the classes go to the engine and are named; on, the runner takes them', () => {
    const p: ApiPrompt = { l: LOAD, t: textNode(), x: clickNode() }
    expect(runnerTakesNode(p, 't', new Set(['cards']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['t', 'x'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id })).toEqual([])
  })

  it('over one synthetic graph per class and chain', () => {
    sameAsBefore({ l: LOAD, t: textNode() }, 'Mask by text')
    sameAsBefore({ l: LOAD, x: clickNode() }, 'Mask extractor')
    sameAsBefore({ l: LOAD, x: clickNode(), n: eraseNode(['x', 0]), s: save(['n', 0]) }, 'Mask extractor → Object removal')
    sameAsBefore({ l: LOAD, t: textNode(), m: { class_type: 'MatteGrowShrink', inputs: { mask: ['t', 0], amount: 2, feather: 0 } } }, 'Mask by text → a mask effect')
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
        if (Object.values(p).some(n => OURS.has(n.class_type))) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`sam-3-masks families-off invariant: ${graphs} saved graphs, ${withIt} with a SAM 3 mask class`)
  }, 600_000)
})
