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
 *
 * R7.5: Subject mask (family `subject-mask`) on the same SAM 3 call, one click
 * per picture or frame (a clip runs here, one call a frame: the user's
 * direction). nodes_subject_track.py runs MobileSAM on every frame and picks
 * one of three candidates (best / largest / smallest), then grows or shrinks
 * it and makes the cutout. The fixture's `subject` part runs the real execute
 * with MobileSAM swapped for stand-ins that answer recorded candidates.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  BG_REMOVE_SLUG, LOCAL_MODEL_FAMILY_OF, MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS, OBJECT_REMOVE_CLASS, OBJECT_REMOVE_SLUG, OBJECT_REMOVE_WORDS, SAM_3_SLUG,
  SAM_MASK_WORDS, SERVICE_OF, SUBJECT_MASK_CLASS, SUBJECT_MASK_WORDS, localModelCalls, overCapWords, serviceTooltip,
} from '#shared/runner/localModels'
import { SAM_3_MAX_MASKS, SAM_3_SUBJECT_MASKS, buildSamInput, parseMaskPoints, samPointsInput, samSubjectInput, samTextInput, subjectCallKinds, subjectClick } from '#shared/runner/samInput'
import { outputKind } from '#shared/runner/values'
import { FRAMES_LINK_SOURCES } from '#shared/runner/mediaEffects'
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
import { bgRemoveInput, maskByTextPrompt, samAnswerMask, samMaskScores, samMaskUrls } from '~~/server/runner/generators/localModels'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { subjectCutout8, subjectForeground, subjectGrow, subjectGrowSteps, subjectMask8, subjectMaskFloat, subjectPickIndex, subjectRegion, type SubjectPick } from '~~/server/runner/pixels/subjectMask'
import { KEPT_MEDIA_MAKERS } from '~~/server/runner/keptRelease'
import { keptPeak } from '~~/server/runner/video/start'
import { batchSlotOf } from '~~/server/runner/video/shapes'
import { pixelsInWorker } from '~~/server/runner/compositor/worker'
import { samMaskCore } from '~~/server/runner/pixels/samMask'
import { effectCores } from '~~/server/runner/effects/cores'
import { decodeMask } from '~~/server/runner/pictures/mask'
import { maxFilterL } from '~~/server/runner/pixels/maxFilter'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

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

/** `answer`: a call's answer, by its payload (R7.5's fix rounds); default SAM 3's, naming every one of `answers` (`mask_<i>.png`). */
async function runByHand(node: { class_type: string; inputs: Record<string, unknown> }, picture: Uint8Array, answers: Uint8Array[], families: ReadonlySet<RunnerFamily> = ON, answer?: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const plan: NodePlan = await planNode({
    prompt: { l: LOAD, n: node }, nodeId: 'n', gateOpen: false, families,
    filesFrom: () => [PIC],
    valueFrom: () => ({ kind: 'files', files: [PIC] }),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
  if (plan.kind !== 'pipeline') throw new Error('A mask class is a pipeline')
  const calls: PipelineCall[] = []
  const files = new Map<string, Uint8Array>()
  const previews: { bytes: Uint8Array; name: string }[] = []
  const downloads: string[] = []
  const undelivered: string[] = []
  const io = {
    signal: new AbortController().signal,
    call: async (x: PipelineCall) => {
      calls.push(x)
      return { result: answer ? answer(x.payload) : { image: { url: ANSWER_URL(99) }, masks: answers.map((_a, i) => ({ url: ANSWER_URL(i) })) }, raw: null, urls: [] }
    },
    undelivered: async (key: string) => {
      undelivered.push(key)
    },
    keep: async (bytes: Uint8Array, ext: string) => {
      const file: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      files.set(file.filename, bytes)
      return file
    },
    read: async (file: OutputFile) => (file.type === 'input' ? picture : files.get(file.filename)!),
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
    download: async (url: string) => {
      downloads.push(url)
      return { bytes: answers[Number(/mask_(\d+)\.png$/.exec(url)![1])]!, contentType: 'image/png' }
    },
    savePreviewAs: async (bytes: Uint8Array, s: { filename: string }) => {
      previews.push({ bytes, name: s.filename })
      return { filename: s.filename, subfolder: '', type: 'temp' } as OutputFile
    },
    handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, files, previews, downloads, undelivered }
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

  it('Subject mask\'s tooltip names the services its mode calls', () => {
    for (const mode of ['best', 'largest', undefined]) {
      expect(serviceTooltip(SUBJECT_MASK_CLASS, ON_SUBJECT, { output_mode: mode })).toBe('Runs on Replicate and fal')
      expect(nodePriceTooltip(SUBJECT_MASK_CLASS, ON_SUBJECT, { output_mode: mode })).toBe('Runs on Replicate and fal')
    }
    expect(serviceTooltip(SUBJECT_MASK_CLASS, ON_SUBJECT, { output_mode: 'smallest' })).toBe('Runs on fal')
    expect(serviceTooltip(SUBJECT_MASK_CLASS, new Set(['cards']), { output_mode: 'best' })).toBeNull()
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
  const OURS = new Set([MASK_BY_TEXT_CLASS, MASK_EXTRACTOR_CLASS, SUBJECT_MASK_CLASS])
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
    // R7.5: Subject mask, its mask into Object removal, its cutout saved; on a clip into Save video frames.
    sameAsBefore({ l: LOAD, m: subjectNode(), n: eraseNode(['m', 0]), s: save(['m', 1]) }, 'Subject mask → Object removal, cutout saved')
    sameAsBefore({ v: LVF, m: subjectNode({}, ['v', 0]), s: saveFrames(['m', 1]) }, 'Load video frames → Subject mask → Save video frames')
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
    console.info(`sam-3-masks / subject-mask families-off invariant: ${graphs} saved graphs, ${withIt} with a SAM 3 mask class or Subject mask`)
  }, 600_000)
})

// ── R7.5: Subject mask ──────────────────────────────────────────────────────

const ON_SUBJECT: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'subject-mask'])
const ON_SUBJECT_ERASE: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'subject-mask', 'object-remove'])
const ON_SUBJECT_CLIP: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'subject-mask'])
const subjectNode = (w: Record<string, unknown> = {}, from: [string, number] = ['l', 0]) =>
  ({ class_type: SUBJECT_MASK_CLASS, inputs: { frames: from, point_x: 0.5, point_y: 0.5, output_mode: 'best', mask_grow: 0, ...w } })
const CLIP = 'v_stereo_aac.mp4'
const LVF = { class_type: 'LoadVideoFrames', inputs: { file: CLIP, max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
const saveFrames = (from: [string, number]) => ({ class_type: 'SaveVideoFrames', inputs: { frames: from, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const LONG = { timeout: 120_000 }
const REMOVER_SCHEMA = loadProviderSchema('replicate', BG_REMOVE_SLUG)
const REM_USD = paidCallUsd({ endpoint: BG_REMOVE_SLUG })!
/** A cut-out as the remover answers it: an RGBA PNG (grey picture, `alpha` its alpha). */
const rgbaPng = async (alpha: Uint8Array, w: number, h: number) => new Uint8Array(await sharp(Buffer.from(Uint8Array.from({ length: w * h * 4 }, (_v, i) => (i % 4 === 3 ? alpha[i >> 2]! : 120))), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer())

interface SubjectCase {
  name: string; pictures: string[]; sets: string[]
  widgets: { point_x: number; point_y: number; output_mode: SubjectPick; mask_grow: number }
  sent_coords: number[][]; sent_labels: number[][]; sent_orig: number[][]; scale: number
  mask: { shape: number[]; f32_sha256: string; u8: string }
  cutout: { shape: number[]; f32_sha256: string; trunc8: string }
  ui: null
}
const SUB = (FX as unknown as { subject: { cases: SubjectCase[]; size: [number, number]; sets: Record<string, { candidates: string[]; scores: number[] }> } }).subject
const subjectNamed = (name: string) => SUB.cases.find(c => c.name === name)!
/** A set's candidates as SAM 3 answers them: grey masks (white = selected), best first (SAM 3 orders its answer by score). */
function answerOf(set: string): { l: Uint8Array; w: number; h: number }[] {
  const s = SUB.sets[set]!
  const order = s.scores.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).map(x => x[1])
  return order.map(i => ({ l: Uint8Array.from(f32Of(s.candidates[i]!), v => (v > 0 ? 255 : 0)), w: W, h: H }))
}
const greyPng = async (l: Uint8Array, w = W, h = H) => new Uint8Array(await sharp(Buffer.from(l), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer())
const unit = (k: number) => Math.fround(k / 255)

/** Python's outputs from the runner's steps on the same candidates, frame by frame: the float32 mask and cutout, and the cutout's 8 bits. */
async function subjectBy(c: SubjectCase) {
  const masks: Float32Array[] = []
  const cut8: Uint8Array[] = []
  for (const [t, set] of c.sets.entries()) {
    const m8 = subjectMask8(answerOf(set), c.widgets.output_mode, W, H)
    const grown = await subjectGrow(m8, W, H, c.widgets.mask_grow, maxFilterL)
    masks.push(subjectMaskFloat(grown))
    cut8.push(subjectCutout8(await rgbOf(b64(c.pictures[t]!)), grown))
  }
  const join = <T extends Float32Array | Uint8Array>(xs: T[], make: (n: number) => T) => {
    const out = make(xs.reduce((n, x) => n + x.length, 0))
    let at = 0
    for (const x of xs) { out.set(x as never, at); at += x.length }
    return out
  }
  const mask = join(masks, n => new Float32Array(n))
  const cut = join(cut8, n => new Uint8Array(n))
  return { mask, cut, cutF32: Float32Array.from(cut, k => unit(k)) }
}

describe('Subject mask: the fixture', () => {
  it('three modes × grow −32 / −1 / 0 / 3 / 32 × three candidate sets, Python\'s half-to-even grows, clicks at the edges, two clips; no ui', () => {
    expect(SUB.cases.length).toBe(55)
    expect(new Set(SUB.cases.map(c => c.widgets.mask_grow))).toEqual(new Set([-32, -1, 0, 3, 32, 2.5, -2.5, 0.5, -1.5, 1, -2]))
    for (const c of SUB.cases) {
      expect(c.ui, c.name).toBeNull()
      expect(c.mask.shape).toEqual([c.sets.length, H, W])
      expect(c.cutout.shape).toEqual([c.sets.length, H, W, 3])
      // One positive point a frame (the −1 is the decoder's padding), the same click on every frame.
      expect(c.sent_labels.every(l => l[0] === 1 && l[1] === -1)).toBe(true)
      expect(c.sent_orig.every(o => o[0] === H && o[1] === W)).toBe(true)
    }
  })
})

describe('Subject mask: the call (#shared/runner/samInput samSubjectInput)', () => {
  it('one positive click at Python\'s point, rounded to whole pixels and kept on the picture; every candidate back; it passes the saved schema', () => {
    for (const c of SUB.cases) {
      const px = c.widgets.point_x * W
      const py = c.widgets.point_y * H
      // What the decoder received is Python's point in its 1024 space.
      expect(Math.abs(c.sent_coords[0]![0]! / c.scale - px), c.name).toBeLessThan(1e-3)
      expect(Math.abs(c.sent_coords[0]![1]! / c.scale - py), c.name).toBeLessThan(1e-3)
      const payload = samSubjectInput('https://fal.storage/p.png', c.widgets.point_x, c.widgets.point_y, W, H)
      const x = Math.min(W - 1, Math.round(px))
      const y = Math.min(H - 1, Math.round(py))
      const common = { image_url: 'https://fal.storage/p.png', prompt: '', apply_mask: false, output_format: 'png', return_multiple_masks: true, max_masks: SAM_3_SUBJECT_MASKS, include_scores: true }
      expect(payload, c.name).toEqual({ ...common, point_prompts: [{ x, y, label: 1 }] })
      expect(checkPayload(SCHEMA, payload)).toEqual([])
      expect(subjectClick(c.widgets.point_x, c.widgets.point_y, W, H)).toEqual({ x, y })
    }
    // The calls a mode may make, the hold's worst case (fix round 2): smallest SAM 3's click; best and largest the
    // background remover, and SAM 3's click when the click is off its foreground (known only from its answer: held).
    expect(subjectCallKinds('smallest')).toEqual(['click'])
    expect(subjectCallKinds('best')).toEqual(['cutout', 'click'])
    expect(subjectCallKinds(undefined)).toEqual(['cutout', 'click'])
    expect(subjectCallKinds('largest')).toEqual(['cutout', 'click'])
    expect(subjectCallKinds(['p', 0])).toEqual(['cutout', 'click'])
    // The remover's call is R7.1's, against its saved schema.
    expect(checkPayload(REMOVER_SCHEMA, bgRemoveInput('https://fal.storage/p.png'))).toEqual([])
    expect(samMaskScores({ scores: [0.2, null], metadata: [{ index: 0, score: 0.9 }, { index: 1, score: 0.7 }] }, 3)).toEqual([0.2, 0.7, null])
    // A click at 1.0 is the last pixel, not one past it.
    expect(samSubjectInput('u', 1, 1, W, H).point_prompts).toEqual([{ x: W - 1, y: H - 1, label: 1 }])
    expect(SAM_3_SUBJECT_MASKS).toBe(3)
  })
})

describe('Subject mask after the model (../pixels/subjectMask.ts): exact against Python given the candidates', () => {
  it('every case: the float32 mask, the cutout\'s float32 and its 8 bits', async () => {
    for (const c of SUB.cases) {
      const r = await subjectBy(c)
      expect(sha(bytesOf(r.mask)), c.name).toBe(c.mask.f32_sha256)
      expect(sha(bytesOf(r.cutF32)), c.name).toBe(c.cutout.f32_sha256)
      expect(sha(r.cut), c.name).toBe(sha(b64(c.cutout.trunc8)))
    }
  })

  it('the pick: best is the first answer; largest / smallest by pixels > 0, the first on a tie; none: an all-black mask', () => {
    const m = (n: number) => ({ l: Uint8Array.from({ length: 4 }, (_v, i) => (i < n ? 9 : 0)), w: 2, h: 2 })
    expect(subjectPickIndex([m(1), m(3), m(2)], 'best')).toBe(0)
    expect(subjectPickIndex([m(1), m(3), m(3)], 'largest')).toBe(1)
    expect(subjectPickIndex([m(2), m(0), m(0)], 'smallest')).toBe(1)
    expect(subjectPickIndex([m(2)], 'smallest')).toBe(0)
    expect(subjectPickIndex([], 'largest')).toBeNull()
    expect(subjectMask8([], 'best', 3, 2)).toEqual(new Uint8Array(6))
    // A candidate of another size: fitted to the picture (R0's bilinear), then > 0.
    expect(subjectMask8([{ l: new Uint8Array(4).fill(255), w: 2, h: 2 }], 'best', 4, 4)).toEqual(new Uint8Array(16).fill(255))
  })

  it('the grow rounds as Python\'s round() does (half to even)', () => {
    expect([2.5, -2.5, 0.5, -1.5, 3, -32].map(subjectGrowSteps)).toEqual([
      { dilate: 2, erode: 0 }, { dilate: 0, erode: 2 }, { dilate: 0, erode: 0 }, { dilate: 0, erode: 2 }, { dilate: 3, erode: 0 }, { dilate: 0, erode: 32 },
    ])
  })
})

describe('Subject mask: one picture (the plan, run by hand)', () => {
  it('smallest: SAM 3\'s click alone, to the saved schema, every candidate read; Python\'s mask (slot 0) and cutout (slot 1); no preview', async () => {
    const c = subjectNamed('subject · set a · smallest · grow 3.0')
    const answers = await Promise.all(answerOf('a').map(m => greyPng(m.l)))
    const r = await runByHand(subjectNode({ output_mode: 'smallest', mask_grow: 3 }), b64(c.pictures[0]!), answers, ON_SUBJECT)
    const out = await r.run()
    expect(r.calls.map(x => [x.provider, x.endpoint, x.usd, x.key])).toEqual([['fal', SAM_3_SLUG, USD, 'subject-0']])
    expect(r.calls[0]!.payload).toEqual(samSubjectInput('https://fal.storage/p.png', 0.5, 0.5, W, H))
    expect(r.downloads.length).toBe(3)
    const m = out.values![0] as { kind: string; files: OutputFile[] }
    expect(m.kind).toBe('mask')
    expect(sha(bytesOf((await decodeMask(r.files.get(m.files[0]!.filename)!)).data))).toBe(c.mask.f32_sha256)
    const p = out.values![1] as { kind: string; files: OutputFile[] }
    expect(p.kind).toBe('files')
    const png = r.files.get(p.files[0]!.filename)!
    expect((await sharp(png).metadata()).channels).toBe(3)
    expect(sha(await rgbOf(png))).toBe(sha(b64(c.cutout.trunc8)))
    expect(out.ui).toBeNull()
    expect(r.previews).toEqual([])
  })

  it('the click off the remover\'s foreground (best): SAM 3\'s click, the highest-scoring candidate kept (Python\'s argmax); an answer with no mask is an all-black mask and cutout, the calls made', async () => {
    const c = subjectNamed('subject · set c · best · grow 0.0')
    // The candidates in Python's own order, with Python's scores: the highest wins, whatever SAM 3's order.
    const set = SUB.sets.c!
    const answers = await Promise.all(set.candidates.map(x => greyPng(Uint8Array.from(f32Of(x), v => (v > 0 ? 255 : 0)))))
    // The remover's answer: an empty cut-out (nothing in front), index 3.
    answers.push(await rgbaPng(new Uint8Array(W * H), W, H))
    const answer = (payload: Record<string, unknown>) => (payload.background_type ? { output: ANSWER_URL(3) } : { masks: [0, 1, 2].map(i => ({ url: ANSWER_URL(i) })), scores: set.scores })
    const r = await runByHand(subjectNode(), b64(c.pictures[0]!), answers, ON_SUBJECT, answer)
    const out = await r.run()
    expect(r.calls.map(x => [x.provider, x.endpoint, x.key])).toEqual([['replicate', BG_REMOVE_SLUG, 'subject-cut-0'], ['fal', SAM_3_SLUG, 'subject-0']])
    expect(r.calls[0]!.payload).toEqual(bgRemoveInput('https://fal.storage/p.png'))
    expect(r.calls[0]!.usd).toBe(REM_USD)
    expect(sha(bytesOf((await decodeMask(r.files.get((out.values![0] as { files: OutputFile[] }).files[0]!.filename)!)).data))).toBe(c.mask.f32_sha256)
    const none = await runByHand(subjectNode({ output_mode: 'smallest' }), b64(c.pictures[0]!), [], ON_SUBJECT)
    const o2 = await none.run()
    expect(none.calls.map(x => x.payload)).toEqual([samSubjectInput('https://fal.storage/p.png', 0.5, 0.5, W, H)])
    expect((await decodeMask(none.files.get((o2.values![0] as { files: OutputFile[] }).files[0]!.filename)!)).data.every(x => x === 0)).toBe(true)
    expect((await rgbOf(none.files.get((o2.values![1] as { files: OutputFile[] }).files[0]!.filename)!)).every(x => x === 0)).toBe(true)
  })

  it('the click on the remover\'s foreground (largest): its region under the click is the subject, no SAM 3 call; a remover answer naming no file falls back to SAM 3 (undelivered)', async () => {
    const pic = b64(SUB.cases[0]!.pictures[0]!)
    // Two blobs 3 pixels apart (not joined by the one-pixel grow): the click (12, 8) is on the left one.
    const alpha = new Uint8Array(W * H).map((_v, i) => (i % W <= 13 || i % W >= 17 ? (i % W === 13 ? 128 : 255) : 0))
    const answers = [await rgbaPng(alpha, W, H)]
    const r = await runByHand(subjectNode({ output_mode: 'largest' }), pic, answers, ON_SUBJECT, () => ({ output: ANSWER_URL(0) }))
    const out = await r.run()
    expect(r.calls.map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG])
    const m = await decodeMask(r.files.get((out.values![0] as { files: OutputFile[] }).files[0]!.filename)!)
    for (let i = 0; i < W * H; i++) expect(m.data[i], `pixel ${i}`).toBe(i % W <= 13 ? 1 : 0)
    const noFile = await runByHand(subjectNode({ output_mode: 'largest' }), pic, [], ON_SUBJECT, p => (p.background_type ? { output: null } : { masks: [] }))
    await noFile.run()
    expect(noFile.calls.map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG, SAM_3_SLUG])
    expect(noFile.undelivered).toEqual(['subject-cut-0'])
  })
})

describe('Subject mask through the engine, with ComfyUI off', () => {
  it('Load image → Subject mask → Object removal → Save image, hosted: two calls, both held and charged; the fill under the subject', async () => {
    const w = 20
    const h = 12
    const subject = new Float32Array(w * h).map((_v, i) => (i % w >= 6 && i % w < 13 && Math.floor(i / w) >= 2 && Math.floor(i / w) < 8 ? 1 : 0))
    const prompt: ApiPrompt = { l: LOAD, m: subjectNode({ point_x: 0.45, point_y: 0.4, output_mode: 'smallest' }), n: eraseNode(['m', 0]), s: save(['n', 0]) }
    expect(isRunnerEligible(prompt, ON_SUBJECT_ERASE)).toBe(true)
    const { k, take, fal, replicate } = await kitRun(prompt, { masks: [await maskPngOf(new Float32Array(w * h).fill(1), w, h), await maskPngOf(subject, w, h)], fill: await picturePng(w, h, 200), files: { 'image.png': await picturePng(w, h, 40) }, families: ON_SUBJECT_ERASE })
    for (const id of ['l', 'm', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(fal.submitted().map(x => x.endpoint)).toEqual([SAM_3_SLUG])
    expect(fal.submitted()[0]!.payload).toMatchObject({ point_prompts: [{ x: 9, y: 5, label: 1 }], return_multiple_masks: true, max_masks: 3 })
    expect(checkPayload(SCHEMA, fal.submitted()[0]!.payload)).toEqual([])
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([OBJECT_REMOVE_SLUG])
    const credits = creditsForUsd(USD) + creditsForUsd(LAMA_USD)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    const px = new Uint8Array(await sharp(readFileSync(join(k.root, 'output', take.nodes.s!.outputs[0]!.subfolder, take.nodes.s!.outputs[0]!.filename))).raw().toBuffer())
    const grown = maxFilterL(Uint8Array.from(subject, v => v * 255), w, h, 3)
    for (let i = 0; i < w * h; i++) expect(px[i * 3], `pixel ${i}`).toBe(grown[i] ? 200 : 40)
  })

  it('best, hosted: the remover\'s region under the click is the subject (one call, no SAM 3); held for both calls, charged for the one sent; its cutout → Save image an RGB file', async () => {
    const w = 10
    const h = 6
    // Two blobs: columns 0–5 (the click, (5, 3), is on it) and column 9, three columns apart.
    const alpha = new Uint8Array(w * h).map((_v, i) => (i % w <= 5 || i % w === 9 ? 255 : 0))
    const prompt: ApiPrompt = { l: LOAD, m: subjectNode(), s: save(['m', 1]) }
    const { k, take, fal, replicate } = await kitRun(prompt, { masks: [], fill: await rgbaPng(alpha, w, h), files: { 'image.png': await picturePng(w, h, 77) }, families: ON_SUBJECT })
    for (const id of ['l', 'm', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG])
    expect(checkPayload(REMOVER_SCHEMA, replicate.submitted()[0]!.payload)).toEqual([])
    expect(fal.submitted()).toEqual([])
    const file = readFileSync(join(k.root, 'output', take.nodes.s!.outputs[0]!.subfolder, take.nodes.s!.outputs[0]!.filename))
    expect((await sharp(file).metadata()).channels).toBe(3)
    const px = new Uint8Array(await sharp(file).raw().toBuffer())
    for (let i = 0; i < w * h; i++) expect(px[i * 3], `pixel ${i}`).toBe(i % w <= 5 ? 77 : 0)
    expect(charged(k)).toEqual([[creditsForUsd(USD + REM_USD) + 1, creditsForUsd(REM_USD) + 1]])
  })

  it('best, hosted, the click off the foreground: the remover, then SAM 3\'s click; both charged', async () => {
    const w = 10
    const h = 6
    const alpha = new Uint8Array(w * h).map((_v, i) => (i % w <= 3 ? 255 : 0))
    const subject = new Float32Array(w * h).map((_v, i) => (i % w >= 6 ? 1 : 0))
    const prompt: ApiPrompt = { l: LOAD, m: subjectNode({ point_x: 0.8 }), s: save(['m', 1]) }
    const { k, take, fal, replicate } = await kitRun(prompt, { masks: [await maskPngOf(subject, w, h)], fill: await rgbaPng(alpha, w, h), files: { 'image.png': await picturePng(w, h, 77) }, families: ON_SUBJECT })
    for (const id of ['l', 'm', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([BG_REMOVE_SLUG])
    expect(fal.submitted().map(x => x.payload.point_prompts)).toEqual([[{ x: 8, y: 3, label: 1 }]])
    const px = new Uint8Array(await sharp(readFileSync(join(k.root, 'output', take.nodes.s!.outputs[0]!.subfolder, take.nodes.s!.outputs[0]!.filename))).raw().toBuffer())
    for (let i = 0; i < w * h; i++) expect(px[i * 3], `pixel ${i}`).toBe(i % w >= 6 ? 77 : 0)
    expect(charged(k)).toEqual([[creditsForUsd(USD + REM_USD) + 1, creditsForUsd(USD + REM_USD) + 1]])
  })

  it('a Subject mask of another size than Object removal\'s picture: refused before the hold, nothing sent (its maskShapes row)', async () => {
    const prompt: ApiPrompt = {
      l: LOAD, b: { class_type: 'LoadImage', inputs: { image: 'other.png', upload: 'image' } },
      m: subjectNode(), n: eraseNode(['m', 0], ['b', 0]), s: save(['n', 0]),
    }
    const fal = createFakeFal()
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON_SUBJECT_ERASE } })
    writeFileSync(join(k.root, 'input', 'image.png'), await picturePng(24, 16, 1))
    writeFileSync(join(k.root, 'input', 'other.png'), await picturePng(30, 20, 1))
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toThrow(OBJECT_REMOVE_WORDS.maskSize)
    expect(k.ledger.holds.size).toBe(0)
    expect(fal.submitted()).toEqual([])
  })
})

describe('Subject mask on a clip: one call per frame, in Sailor', () => {
  it('the cutout is a frame batch on slot 1 and the masks a mask list on slot 0 while the family is on; the frame readers take it', () => {
    const p: ApiPrompt = { v: LVF, m: subjectNode({}, ['v', 0]), s: saveFrames(['m', 1]) }
    expect(outputKind(p, ['m', 1], outputKindsFor(ON_SUBJECT_CLIP))).toBe('frames')
    expect(outputKind(p, ['m', 0], outputKindsFor(ON_SUBJECT_CLIP))).toBe('mask')
    expect(outputKind({ l: LOAD, m: subjectNode() }, ['m', 1], outputKindsFor(ON_SUBJECT_CLIP))).toBe('files')
    expect(isRunnerEligible(p, ON_SUBJECT_CLIP)).toBe(true)
    // A clip's cutout into a picture reader is left to the engine (the value kinds), as R7.1's.
    expect(runnerTakesNode({ ...p, s: save(['m', 1]) }, 's', ON_SUBJECT_CLIP)).toBe(false)
    expect(FRAMES_LINK_SOURCES.map(x => x.join(':'))).toContain(`${SUBJECT_MASK_CLASS}:1`)
    expect(KEPT_MEDIA_MAKERS.has(SUBJECT_MASK_CLASS)).toBe(true)
    expect(batchSlotOf(SUBJECT_MASK_CLASS)).toBe(1)
    // The kept room counts its batch from its own slot.
    const shapes = new Map([['v:0', { count: 3, w: 64, h: 36, exact: true }], ['m:1', { count: 3, w: 64, h: 36, exact: true }]])
    const peak = keptPeak(p, ON_SUBJECT_CLIP, shapes, { release: false })
    expect(peak).not.toBeNull()
    expect(peak!.bytes).toBeGreaterThan(keptPeak({ v: LVF, s: saveFrames(['v', 0]) }, ON_SUBJECT_CLIP, new Map([['v:0', shapes.get('v:0')!]]), { release: false })!.bytes)
  })

  it('Load video frames → Subject mask → Save video frames, hosted, largest: the remover on each frame (its answer fitted to the frame), held for both calls a frame, charged for the three sent; a batch of three and three masks', LONG, async () => {
    await requireMediaTools()
    const prompt: ApiPrompt = { v: LVF, m: subjectNode({ output_mode: 'largest', mask_grow: 1 }, ['v', 0]), s: saveFrames(['m', 1]) }
    // The cut-out is any size: each is fitted to the frame; the click (the middle) is on its disc.
    const disc = new Uint8Array(16 * 9).map((_v, i) => (Math.hypot(i % 16 - 8, Math.floor(i / 16) - 4) < 4 ? 255 : 0))
    const { k, take, fal, replicate } = await kitRun(prompt, { masks: [], fill: await rgbaPng(disc, 16, 9), files: { [CLIP]: new Uint8Array(readFileSync(clipPath(CLIP))) }, families: ON_SUBJECT_CLIP })
    for (const id of ['v', 'm', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.m?.seconds.frames).toBe(3)
    expect(fal.submitted().length).toBe(0)
    expect(replicate.submitted().length).toBe(3)
    for (const x of replicate.submitted()) expect(checkPayload(REMOVER_SCHEMA, x.payload)).toEqual([])
    const out = take.nodes.m!.values![1] as Extract<RunnerValue, { kind: 'frames' }>
    expect(out.kind).toBe('frames')
    expect(out.count).toBe(3)
    expect((take.nodes.m!.values![0] as { kind: string; files: unknown[] })).toMatchObject({ kind: 'mask' })
    expect((take.nodes.m!.values![0] as { files: unknown[] }).files.length).toBe(3)
    const held = creditsForUsd(3 * (USD + REM_USD))
    expect(take.nodes.m!.credits).toBe(held)
    expect(charged(k)).toEqual([[held + 1, creditsForUsd(3 * REM_USD) + 1]])
  })

  it('over the frame cap on an uncounted bound: held at the cap (R11.8), never the engine; its own words past the cap', async () => {
    const p: ApiPrompt = { v: LVF, m: subjectNode({}, ['v', 0]), s: saveFrames(['m', 1]) }
    const shapes = (count: number) => async () => new Map([['v:0', { count, w: 64, h: 36, exact: false }]])
    expect(await localModelStartProblems(p, ON_SUBJECT_CLIP, { hosted: true, shapes: shapes(300) })).toMatchObject({ counts: { m: 300 }, problem: null })
    expect(await localModelStartProblems(p, ON_SUBJECT_CLIP, { hosted: true, shapes: shapes(301) })).toMatchObject({ counts: { m: 300 }, problem: null })
    expect(overCapWords(SUBJECT_MASK_CLASS, 300)).toBe(`${SUBJECT_MASK_WORDS.overCap} Use a clip of 300 frames or fewer.`)
    expect(overCapWords(SUBJECT_MASK_CLASS)).toBe(SUBJECT_MASK_WORDS.overCap)
  })
})

describe('Subject mask: price, family, rows', () => {
  it('held per picture or frame at the worst case of its mode (smallest SAM 3; best and largest the remover and SAM 3), summed and marked up once; priced only while its family is on; no flat row', () => {
    const inputs = subjectNode().inputs
    const both = Math.round((USD + REM_USD) * 1e8) / 1e8
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, SUBJECT_MASK_CLASS)).toBe(false)
    expect('refused' in priceNode(SUBJECT_MASK_CLASS, inputs, { families: ON })).toBe(true)
    expect(priceNode(SUBJECT_MASK_CLASS, inputs, { families: ON_SUBJECT })).toEqual({ usd: both, credits: creditsForUsd(both) })
    const at300 = Math.round(300 * (USD + REM_USD) * 1e8) / 1e8
    expect(priceNode(SUBJECT_MASK_CLASS, inputs, { families: ON_SUBJECT, inputSeconds: { frames: 300 } })).toEqual({ usd: at300, credits: creditsForUsd(at300) })
    expect(localModelCalls(SUBJECT_MASK_CLASS, 3, { output_mode: 'largest' })).toEqual({ steps: [{ call: { endpoint: BG_REMOVE_SLUG }, times: 3 }, { call: { endpoint: SAM_3_SLUG }, times: 3 }] })
    expect(localModelCalls(SUBJECT_MASK_CLASS, 3, { output_mode: ['p', 0] })).toEqual(localModelCalls(SUBJECT_MASK_CLASS, 3, { output_mode: 'best' }))
    expect(priceNode(SUBJECT_MASK_CLASS, { ...inputs, output_mode: 'smallest' }, { families: ON_SUBJECT, inputSeconds: { frames: 3 } })).toEqual({ usd: 3 * USD, credits: creditsForUsd(3 * USD) })
    expect(priceGraph({ 1: { class_type: SUBJECT_MASK_CLASS, inputs } }).nodes['1']).toBeUndefined()
  })

  it('a fal provider class in family subject-mask, not an output node (Python returns no ui); the tooltip names fal; no backup; settings as ComfyUI validates them', () => {
    expect(LOCAL_MODEL_FAMILY_OF[SUBJECT_MASK_CLASS]).toBe('subject-mask')
    expect(RUNNER_NODE_RULES[SUBJECT_MASK_CLASS]!.family).toBe('subject-mask')
    expect(PROVIDER_TYPES.has(SUBJECT_MASK_CLASS)).toBe(true)
    expect(SWITCHED_CLASSES[SUBJECT_MASK_CLASS]).toBe('subject-mask')
    expect(RUNNER_OUTPUT_CLASSES.has(SUBJECT_MASK_CLASS)).toBe(false)
    expect(outputKindsFor(ON_SUBJECT)[SUBJECT_MASK_CLASS]).toEqual({ 0: 'mask' })
    expect(SERVICE_OF[SUBJECT_MASK_CLASS]).toBe('fal')
    expect(nodePriceTooltip(SUBJECT_MASK_CLASS, ON_SUBJECT)).toBe('Runs on Replicate and fal')
    expect(nodePriceTooltip(SUBJECT_MASK_CLASS, ON_SUBJECT, { output_mode: 'smallest' })).toBe('Runs on fal')
    expect(nodePriceTooltip(SUBJECT_MASK_CLASS, new Set(['cards']))).toBeNull()
    expect(RUNNER_ROUTES[SUBJECT_MASK_CLASS]).toMatchObject({ first: 'replicate', backup: null })
    const pt = (w: Record<string, unknown>): ApiPrompt => ({ l: LOAD, n: subjectNode(w) })
    expect(runnerTakesNode(pt({}), 'n', ON_SUBJECT)).toBe(true)
    expect(runnerTakesNode(pt({ point_x: 1, point_y: 0, output_mode: 'smallest', mask_grow: -32 }), 'n', ON_SUBJECT)).toBe(true)
    for (const w of [{ point_x: 1.5 }, { point_y: -0.1 }, { mask_grow: 33 }, { output_mode: 'all' }, { frames: ['l', 1] }]) expect(runnerTakesNode(pt(w), 'n', ON_SUBJECT), JSON.stringify(w)).toBe(false)
    // The canvas counts the pictures that come in (one from a loader); "up to" the cap for a clip.
    expect(upstreamPictureCount({ id: 'x', data: { nodeType: SUBJECT_MASK_CLASS, inputs: [{ name: 'frames' }] } }, [{ id: 'l', data: { nodeType: 'LoadImage' } }], [{ source: 'l', target: 'x', targetHandle: 'input-0' }])).toBe(1)
    expect(SUBJECT_MASK_WORDS.noPicture).toMatch(/^[A-Z][^_]*\.$/)
  })

  it('with the family off, the class goes to the engine and is named', () => {
    const p: ApiPrompt = { l: LOAD, m: subjectNode() }
    expect(runnerTakesNode(p, 'm', new Set(['cards', 'sam-3-masks']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['m'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON_SUBJECT, titleOf: id => id })).toEqual([])
  })
})
