/**
 * Step 3, R7.2: Upscale (2×) (family `upscale-2x`) on Replicate's Real-ESRGAN.
 *
 * comfy_extras/nodes_upscale.py:113-136 runs Real-ESRGAN x2plus on every
 * picture (and every frame of a clip), tiled by `tile_size`. The runner makes
 * one call per picture or frame to `nightmareai/real-esrgan` with R3.5's
 * builder at scale 2, keeps the answer as downloaded when it is 2W × 2H, and
 * resizes any other answer to 2W × 2H with R0's bilinear. No Python fixture:
 * nothing around the call computes anything (the brief). The shared R7 pieces
 * (per-frame clips, the frame cap, the per-frame price, cancel on failure,
 * the tooltip) are R7.1's (runner-local-cutout.unit.spec.ts); this spec
 * checks Upscale's use of them.
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
import {
  LOCAL_MODEL_FAMILY_OF, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, SERVICE_OF, UPSCALE_2X_CLASS, UPSCALE_2X_MAX_PIXELS, UPSCALE_2X_SLUG,
  UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_TILED_MAX_TILES, UPSCALE_2X_WORDS, localModelCalls, serviceTooltip,
} from '#shared/runner/localModels'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { FAMILY_PRICED_CLASSES, perFrameCredits, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { nodePriceTooltip } from '~/lib/nodeCreditEstimate'
import { GRAPH_NODE_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { PER_NODE_IN_FLIGHT, resizeRgb8, upscale2xInput } from '~~/server/runner/generators/localModels'
import { localModelStartProblems } from '~~/server/runner/localModelStart'
import { KEPT_MEDIA_MAKERS } from '~~/server/runner/keptRelease'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'upscale-2x'])
const ON_CLIP: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'upscale-2x'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const SAVE_DEFAULTS = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
const SCHEMA = loadProviderSchema('replicate', UPSCALE_2X_SLUG)
const ANSWER_URL = (i: number) => `https://replicate.delivery/up/${i}.png`

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const scratch = mkdtempSync(join(tmpdir(), 'local-upscale-spec-'))

/** A picture of noise, `w` × `h`, RGB, as a PNG (seeded: the same bytes every run). */
async function noisePng(w: number, h: number, seed = 1): Promise<Uint8Array> {
  const px = new Uint8Array(w * h * 3)
  let x = seed * 2654435761 >>> 0
  for (let i = 0; i < px.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    px[i] = x >>> 24
  }
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer())
}

async function pixels(png: Uint8Array) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), w: info.width, h: info.height, channels: info.channels }
}

const LOAD = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
const upNode = (from: [string, number] = ['l', 0], tile = 512) => ({ class_type: UPSCALE_2X_CLASS, inputs: { frames: from, tile_size: tile } })
const PIC = (i: number): OutputFile => ({ filename: `p${i}.png`, subfolder: '', type: 'input' })

// ── The plan, run by hand ───────────────────────────────────────────────────

async function planOf(pictures: Uint8Array[], o: { held?: number; picturePixels?: number } = {}): Promise<Extract<NodePlan, { kind: 'pipeline' }>> {
  const p = await planNode({
    prompt: { l: LOAD, n: upNode() }, nodeId: 'n', gateOpen: false, families: ON,
    filesFrom: link => (link[0] === 'l' ? pictures.map((_x, i) => PIC(i)) : []),
    toUrl: async f2 => `https://fal.storage/${f2.filename}`,
    measured: { frames: o.held ?? pictures.length, ...(o.picturePixels ? { picturePixels: o.picturePixels } : {}) },
  })
  if (p.kind !== 'pipeline') throw new Error('Upscale (2×) is a pipeline')
  return p
}

/** The pipeline with its calls answered by key, its downloads served (`answers` by index), its saves kept. */
async function runByHand(pictures: Uint8Array[], answers: Uint8Array[], o: { held?: number } = {}) {
  const plan = await planOf(pictures, o)
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
      return { result: { output: ANSWER_URL(Number(/^up-(\d+)$/.exec(x.key)![1])) }, raw: null, urls: [] }
    },
    download: async (url: string) => ({ bytes: answers[Number(/\/(\d+)\.png$/.exec(url)![1])]!, contentType: 'image/png' }),
    keep: async (bytes: Uint8Array, ext: string) => {
      const file: OutputFile = { filename: `${sha(bytes)}.${ext}`, subfolder: 'run', type: 'kept' }
      kept.set(file.filename, bytes)
      return file
    },
    read: async (file: OutputFile) => (file.type === 'input' ? pictures[Number(/^p(\d+)\.png$/.exec(file.filename)![1])]! : kept.get(file.filename)!),
    savedOnce: async (_call: string, _key: string, make: () => Promise<OutputFile>) => make(),
    savePreview: async (bytes: Uint8Array, s: { nodeId?: string }) => {
      previews.push(bytes)
      return { filename: `live_preview_${s.nodeId}_00001.png`, subfolder: '', type: 'temp' } as OutputFile
    },
    handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
  } as unknown as PipelineIO
  return { run: () => plan.run(io), calls, kept, previews, most: () => most }
}

describe('the call (R3.5\'s Real-ESRGAN builder at scale 2)', () => {
  it('the saved schema is the model page\'s; the payload passes it; tile_size is not sent', () => {
    expect(SCHEMA.endpoint).toBe(UPSCALE_2X_SLUG)
    expect(upscale2xInput('https://fal.storage/p0.png')).toEqual({ image: 'https://fal.storage/p0.png', scale: 2, face_enhance: false })
    expect(checkPayload(SCHEMA, upscale2xInput('https://fal.storage/p0.png'))).toEqual([])
  })
})

describe('a picture (the plan, run by hand)', () => {
  it('a 1000 × 750 answer to a 500 × 375 picture is kept as it is; one call to the schema; Python\'s preview', async () => {
    const pic = await noisePng(500, 375, 1)
    const answer = await noisePng(1000, 750, 2)
    const r = await runByHand([pic], [answer])
    const made = await r.run()
    expect(r.calls.length).toBe(1)
    const x = r.calls[0]!
    // R7.11: each call at its own picture's size: 0.19 MP sent, the card's $0.003 floor.
    expect([x.key, x.provider, x.endpoint, x.media, x.usd, x.backup]).toEqual(['up-0', 'replicate', UPSCALE_2X_SLUG, 'image', 0.003, undefined])
    expect(x.payload).toEqual(upscale2xInput('https://fal.storage/p0.png'))
    expect(checkPayload(SCHEMA, x.payload)).toEqual([])
    const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    expect(out.kind).toBe('files')
    expect(out.files.length).toBe(1)
    // Kept byte for byte as downloaded.
    expect(sha(r.kept.get(out.files[0]!.filename)!)).toBe(sha(answer))
    // The live preview: save_live_preview(unique=True)'s ui shape, the first picture as RGB.
    expect(made.ui).toEqual({ images: [{ filename: 'live_preview_n_00001.png', subfolder: '', type: 'temp' }], animated: [false] })
    expect(r.previews.length).toBe(1)
    const pv = await pixels(r.previews[0]!)
    expect([pv.channels, pv.w, pv.h]).toEqual([3, 1000, 750])
    expect(sha(pv.data)).toBe(sha((await pixels(answer)).data))
  })

  it('a 900 × 700 answer is resized to 1000 × 750 with R0\'s bilinear, so later nodes see Python\'s size', async () => {
    const pic = await noisePng(500, 375, 3)
    const answer = await noisePng(900, 700, 4)
    const r = await runByHand([pic], [answer])
    const made = await r.run()
    const out = made.values[0] as Extract<RunnerValue, { kind: 'files' }>
    const px = await pixels(r.kept.get(out.files[0]!.filename)!)
    expect([px.w, px.h, px.channels]).toEqual([1000, 750, 3])
    // Read by nothing: the hand-off's rounding.
    const want = resizeRgb8((await pixels(answer)).data, 900, 700, 1000, 750, 'round')
    expect(sha(px.data)).toBe(sha(want))
  })

  it('R0\'s bilinear: a same-size resize gives the picture back; a 2 × 1 → 4 × 2 matches torch\'s taps', () => {
    const rgb = new Uint8Array([0, 10, 20, 255, 245, 235])
    expect([...resizeRgb8(rgb, 2, 1, 2, 1, 'round')]).toEqual([...rgb])
    // torch F.interpolate([0, 255], size=4, bilinear, align_corners=False): 0, 63.75, 191.25, 255 (×255/255).
    const grey = new Uint8Array([0, 0, 0, 255, 255, 255])
    const up = resizeRgb8(grey, 2, 1, 4, 2, 'trunc')
    expect([...up].filter((_v, i) => i % 3 === 0)).toEqual([0, 63, 191, 255, 0, 63, 191, 255])
  })

  it('more pictures than the start counted: refused before any call; an answer with no picture: undelivered, a plain failure', async () => {
    const pic = await noisePng(8, 6)
    await expect(planOf([pic, pic], { held: 1 })).rejects.toThrow(LOCAL_MODEL_WORDS.tooManyFrames)
    const plan = await planOf([pic])
    const undelivered = vi.fn(async () => {})
    const io = {
      signal: new AbortController().signal,
      read: async () => pic,
      call: async () => ({ result: { output: null }, raw: null, urls: [] }),
      undelivered,
    } as unknown as PipelineIO
    await expect(plan.run(io)).rejects.toThrow(UPSCALE_2X_WORDS.noAnswer)
    expect(undelivered).toHaveBeenCalledWith('up-0', 'no-file')
    for (const w of Object.values(UPSCALE_2X_WORDS)) expect(w).not.toMatch(/Node|_|Replicate|ESRGAN/)
  })

  it('a picture over the service\'s largest (1440p) with no tiles held is refused at the turn before any call (R11.6: tiles are held at the start)', async () => {
    const big = await noisePng(2600, 1440)
    // Measured at the start at 1440p (one tile held); not measured at all, the plan holds the most tiles (R11.6 fix round 1).
    const plan = await planOf([big], { picturePixels: UPSCALE_2X_MAX_PIXELS })
    const call = vi.fn()
    const io = { signal: new AbortController().signal, read: async () => big, call } as unknown as PipelineIO
    await expect(plan.run(io)).rejects.toThrow(UPSCALE_2X_WORDS.moreThanHeld)
    expect(call).not.toHaveBeenCalled()
    // R11.6 fix round 2: under the service's stated GPU limit (2 096 704, 2026-10-01), not the page's 1440p; LC4: 75% of
    // it (1536 × 1024), after a 2 046 000-px tile ran out of GPU memory at the service (2026-10-02).
    expect(UPSCALE_2X_MAX_PIXELS).toBe(1_572_864)
  })

  it('three pictures: three calls, at most PER_NODE_IN_FLIGHT at once, in order', async () => {
    const pics = await Promise.all([1, 2, 3].map(i => noisePng(10, 8, i)))
    const answers = await Promise.all([1, 2, 3].map(i => noisePng(20, 16, 10 + i)))
    const r = await runByHand(pics, answers)
    const made = await r.run()
    expect(r.calls.map(c => c.key).sort()).toEqual(['up-0', 'up-1', 'up-2'])
    expect(r.most()).toBeLessThanOrEqual(PER_NODE_IN_FLIGHT)
    const files = (made.values[0] as Extract<RunnerValue, { kind: 'files' }>).files
    expect(files.map(f => sha(r.kept.get(f.filename)!))).toEqual(answers.map(a => sha(a)))
  })
})

// ── Through the engine ──────────────────────────────────────────────────────

const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
  [...k.ledger.holds.values()].map(h => [h.credits, h.state === 'released' ? 0 : h.actual])

async function kitRun(prompt: ApiPrompt, answer: (i: number) => Uint8Array, o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily>; files: Record<string, Uint8Array> }) {
  let n = 0
  const replicate = createFakeReplicate({ answer: () => ANSWER_URL(n++) })
  const download = vi.fn(async (url: string) => ({ bytes: answer(Number(/\/(\d+)\.png$/.exec(url)![1])), contentType: 'image/png' }))
  const dir = mkdtempSync(join(scratch, 'kit-'))
  const k = makeKit({ hosted: o.hosted, dir, replicate, deps: { families: () => o.families ?? ON, download, kept: createFileKeptBytes(join(dir, 'kept')) } })
  for (const [name, bytes] of Object.entries(o.files)) writeFileSync(join(k.root, 'input', name), bytes)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const take = (await k.store.get(runId))!.takes[0]!
  return { k, take, replicate }
}

describe('the acceptance chains, with ComfyUI off', () => {
  it('Load image → Upscale (2×) → Save image, hosted: one call to the schema, held and charged one picture plus the render credit', async () => {
    const pic = await noisePng(50, 30)
    const answer = await noisePng(100, 60, 7)
    const prompt: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    expect(isRunnerEligible(prompt, ON)).toBe(true)
    const { k, take, replicate } = await kitRun(prompt, () => answer, { hosted: true, files: { 'image.png': pic } })
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(x => x.endpoint)).toEqual([UPSCALE_2X_SLUG])
    const sent = replicate.submitted()[0]!.payload
    expect(checkPayload(SCHEMA, sent)).toEqual([])
    expect(sent).toMatchObject({ scale: 2, face_enhance: false })
    expect(take.measured?.n?.seconds.frames).toBe(1)
    const credits = creditsForUsd(0.002)
    expect(take.nodes.n!.credits).toBe(credits)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    const saved = take.nodes.s!.outputs[0]!
    const px = await pixels(new Uint8Array(readFileSync(join(k.root, saved.type, saved.subfolder, saved.filename))))
    expect([px.w, px.h]).toEqual([100, 60])
    // Python's tensor has 3 channels: Save image writes RGB, the answer's pixels.
    expect(px.channels).toBe(3)
    expect(sha(px.data)).toBe(sha((await pixels(answer)).data))
    const shown = ofType(k.seen, 'executed').map(m => (m as any).data).find((d: any) => d.node === 'n')?.output
    expect(shown.images[0].filename).toMatch(/^live_preview_n_\d{5}\.png$/)
    expect(shown.animated).toEqual([false])
  })

  it('a picture known to be past the largest tiled (R11.6): the workflow is left to the engine before anything is held; one whose size can\'t be known is held at the largest tiled (R11.8)', async () => {
    // One colour: a small file of 4400 × 4400 (past UPSCALE_2X_TILED_MAX_PIXELS, 12288 × 1536).
    const big = new Uint8Array(await sharp({ create: { width: 4400, height: 4400, channels: 3, background: '#808080' } }).png().toBuffer())
    const prompt: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    const replicate = createFakeReplicate()
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), big)
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).rejects.toThrow(UPSCALE_2X_WORDS.tooLarge)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
    // The start pass by hand: exact at the cap passes; a file known to be larger leaves it; R11.8 (ruling (k)): a
    // reader that can't size the file, or none, holds it at the largest tiled (its most tiles), never the engine.
    const shapes = async () => new Map()
    const at = await noisePng(2560, 1440)
    expect((await localModelStartProblems(prompt, ON, { hosted: true, shapes, read: async () => at })).problem).toBeNull()
    expect((await localModelStartProblems(prompt, ON, { hosted: true, shapes, read: async () => big })).problem?.message).toBe(UPSCALE_2X_WORDS.tooLarge)
    expect(await localModelStartProblems(prompt, ON, { hosted: true, shapes })).toMatchObject({
      problem: null, pictures: { n: UPSCALE_2X_TILED_MAX_PIXELS }, tiles: { n: UPSCALE_2X_TILED_MAX_TILES },
    })
    // Empty image is sized from its widgets; a Frame with a size set too.
    const empty: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 5000, height: 4000, batch_size: 1, color: 0 } }, n: upNode(['e', 0]) }
    expect((await localModelStartProblems(empty, ON, { hosted: true, shapes })).problem?.message).toBe(UPSCALE_2X_WORDS.tooLarge)
    const small: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 2, color: 0 } }, n: upNode(['e', 0]) }
    expect(await localModelStartProblems(small, ON, { hosted: true, shapes })).toMatchObject({ counts: { n: 2 }, problem: null })
  })

  it('a provider call that fails: nothing charged, the hold released', async () => {
    const pic = await noisePng(20, 10)
    const prompt: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    const replicate = createFakeReplicate()
    replicate.failNext(1)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), pic)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('error')
    const credits = creditsForUsd(0.002)
    expect(charged(k)).toEqual([[credits + 1, 0]])
  })
})

describe('a clip, one call per frame (ruling (f))', () => {
  const clip = 'v_stereo_aac.mp4'
  const lvf = { class_type: 'LoadVideoFrames', inputs: { file: clip, max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
  const saveFrames = (from: [string, number]) => ({ class_type: 'SaveVideoFrames', inputs: { frames: from, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })

  it('a frame batch on slot 0 while the family is on (a picture stays a picture); the frame readers take it', () => {
    const p: ApiPrompt = { v: lvf, n: upNode(['v', 0]), s: saveFrames(['n', 0]) }
    expect(outputKind(p, ['n', 0], outputKindsFor(ON_CLIP))).toBe('frames')
    expect(outputKind({ l: LOAD, n: upNode() }, ['n', 0], outputKindsFor(ON_CLIP))).toBe('files')
    expect(isRunnerEligible(p, ON_CLIP)).toBe(true)
    expect(runnerTakesNode({ f: { class_type: 'LoadVideo', inputs: { file: clip } }, n: upNode(['f', 0]), s: saveFrames(['n', 0]) }, 'n', ON_CLIP)).toBe(false)
    expect(FRAMES_LINK_SOURCES.map(x => x.join(':'))).toContain(`${UPSCALE_2X_CLASS}:0`)
    expect(KEPT_MEDIA_MAKERS.has(UPSCALE_2X_CLASS)).toBe(true)
  })

  it('Load video frames → Upscale (2×) → Save video frames, hosted: three calls, a batch of three frames at twice each side', LONG, async () => {
    await requireMediaTools()
    const prompt: ApiPrompt = { v: lvf, n: upNode(['v', 0]), s: saveFrames(['n', 0]) }
    const files = { [clip]: new Uint8Array(readFileSync(clipPath(clip))) }
    // The fake answers a fixed size; frames of another size are resized to 2W × 2H.
    const answer = await noisePng(40, 30, 9)
    const { k, take, replicate } = await kitRun(prompt, () => answer, { hosted: true, families: ON_CLIP, files })
    for (const id of ['v', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.measured?.n?.seconds.frames).toBe(3)
    expect(replicate.submitted().length).toBe(3)
    for (const x of replicate.submitted()) expect(checkPayload(SCHEMA, x.payload)).toEqual([])
    const input = take.nodes.v!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    const out = take.nodes.n!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect(out.kind).toBe('frames')
    expect([out.count, out.w, out.h]).toEqual([3, 2 * input.w, 2 * input.h])
    // Three frames' dollars added up and marked up once (USER ruling).
    const credits = creditsForUsd(0.006)
    expect(take.nodes.n!.credits).toBe(credits)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
  })

  it('a clip past the largest tiled (R11.6): left to the engine before the hold; over the frame cap on an uncounted bound: held at the cap (R11.8)', async () => {
    const p: ApiPrompt = { v: lvf, n: upNode(['v', 0]), s: saveFrames(['n', 0]) }
    const shapes = (count: number, w = 64, h = 36) => async () => new Map([['v:0', { count, w, h, exact: false }]])
    expect(await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted) })).toMatchObject({ counts: { n: LOCAL_MODEL_MAX_FRAMES.hosted }, problem: null })
    expect(await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(LOCAL_MODEL_MAX_FRAMES.hosted + 1) })).toMatchObject({ counts: { n: LOCAL_MODEL_MAX_FRAMES.hosted }, problem: null })
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(3, 2560, 1440) })).problem).toBeNull()
    // R11.6: over the limit in tiles (three for 2561 × 1440 since LC4), past 12288 × 1536's pixels left.
    expect(await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(3, 2561, 1440) })).toMatchObject({ tiles: { n: 3 }, problem: null })
    expect((await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: shapes(3, 4400, 4400) })).problem?.message).toBe(UPSCALE_2X_WORDS.tooLarge)
    // LC2: a 2× batch past R5's batch caps is refused plainly before the hold (it would fail as it is
    // written, after its paid calls): a frame past MEDIA_CAPS' largest, or more pixels than a batch holds.
    const passes = (r: Awaited<ReturnType<typeof localModelStartProblems>>) => { expect(r.problem).toBeNull(); expect(r.refused).toBeUndefined() }
    const refusedOf = async (hosted: boolean, s: () => Promise<Map<string, { count: number; w: number; h: number; exact: boolean }>>) => (await localModelStartProblems(p, ON_CLIP, { hosted, shapes: s }))
    passes(await refusedOf(true, shapes(3, 2048, 2048)))
    expect((await refusedOf(true, shapes(3, 2049, 2048))).refused?.message).toBe(UPSCALE_2X_WORDS.clipTooLarge)
    expect((await refusedOf(true, shapes(3, 3840, 2160))).refused?.message).toBe(UPSCALE_2X_WORDS.clipTooLarge)
    passes(await refusedOf(false, shapes(3, 3840, 2160)))
    passes(await refusedOf(false, shapes(3, 4096, 4096)))
    expect((await refusedOf(false, shapes(3, 4097, 4096))).refused?.message).toBe(UPSCALE_2X_WORDS.clipTooLarge)
    // Hosted, 1080p: 150 frames at 2× fill the batch exactly; 151 counted exactly are refused, 151 as an
    // upper bound only are taken (R11.8): the node's turn refuses the clip itself past the caps, before any call.
    const exact = (count: number) => async () => new Map([['v:0', { count, w: 1920, h: 1080, exact: true }]])
    passes(await refusedOf(true, exact(150)))
    expect((await refusedOf(true, exact(151))).refused?.message).toBe(UPSCALE_2X_WORDS.clipTooLarge)
    const bound = await refusedOf(true, shapes(151, 1920, 1080))
    expect(bound.refused).toBeUndefined()
    expect(bound.problem).toBeNull()
    // No masks of its own: the kept bytes are the batches only (R6's peak).
    const withMasks = await localModelStartProblems(p, ON_CLIP, { hosted: true, shapes: async () => new Map([['v:0', { count: 3, w: 64, h: 36, exact: false }], ['n:0', { count: 3, w: 128, h: 72, exact: false }]]) })
    expect(withMasks.problem).toBeNull()
    expect(withMasks.keptBytes).toBeGreaterThan(0)
  })
})

// ── Prices, families, tooltip ───────────────────────────────────────────────

describe('prices (R7 rule 4)', () => {
  it('R3.5\'s Real-ESRGAN card, re-carded by R7.11\'s live check (GPU time: $0.003 a megapixel sent, at least $0.003, at most 1 572 864 px in, LC4); no flat row', () => {
    expect(EDIT_RATES[UPSCALE_2X_SLUG]).toMatchObject({ unit: 'per_input_megapixel', perMegapixel: 0.003, minUsd: 0.003, maxInputPixels: UPSCALE_2X_MAX_PIXELS, confidence: 'verified', service: 'replicate' })
    // The live check's run: 12.13 s on T4 ($0.000225/s) for 1152² in, $0.00273 — under the card's $0.00398 for it.
    expect(12.13 * 0.000225).toBeLessThan(paidCallUsd({ endpoint: UPSCALE_2X_SLUG, inputPixels: 1152 * 1152 })!)
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, UPSCALE_2X_CLASS)).toBe(false)
    expect(PAID_NODE_CLASSES).not.toContain(UPSCALE_2X_CLASS)
    expect(Object.prototype.hasOwnProperty.call(FAMILY_PRICED_CLASSES, UPSCALE_2X_CLASS)).toBe(false)
  })

  it('priced only while its family is on: frames × the picture\'s price (measured at the start, else up to the largest tiled: fifteen tiles at the limit), marked up once; one picture when nothing was counted', () => {
    const inputs = { frames: ['l', 0], tile_size: 512 }
    // LC4: 1 572 864 px (1536 × 1024, under the 2 096 704 Replicate states) × $0.003 a megapixel; sums rounded to 1e-8.
    const CAP_USD = 0.004718592
    expect('refused' in priceNode(UPSCALE_2X_CLASS, inputs)).toBe(true)
    expect('refused' in priceNode(UPSCALE_2X_CLASS, inputs, { families: new Set(['upscale-2x']) })).toBe(true)
    // R11.6 fix round 1 (H1): the picture's size not measured (the canvas): up to fifteen tiles at the limit each (the largest
    // tiled picture's, with fix round 3's 128-pixel overlaps, at LC4's limit).
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON })).toEqual({ usd: 0.07077885, credits: creditsForUsd(0.07077885) })
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 300 } })).toEqual({ usd: 21.233655, credits: creditsForUsd(21.233655) })
    // Measured at the start of the run (R7.11): the live check's 1152² picture, three of them.
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { frames: 3, picturePixels: 1152 * 1152 } })).toEqual({ usd: 0.01194393, credits: 3 })
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { picturePixels: 500 * 375 } })).toEqual({ usd: 0.003, credits: 1 })
    // Each call never above the service's largest picture; R11.6: a larger one in tiles, each held at that largest
    // (4096 × 4096 with no shape known: the pixel bound's fourteen tiles; runner-upscale-tiles.unit.spec.ts has the rest).
    expect(priceNode(UPSCALE_2X_CLASS, inputs, { families: ON, inputSeconds: { picturePixels: 4096 * 4096 } })).toEqual({ usd: 0.06606026, credits: creditsForUsd(0.06606026) })
    // Fourteen tiles of $0.00471859 (each call's price rounded to 1e-8 dollars).
    expect(14 * CAP_USD).toBeCloseTo(0.06606026, 6)
    expect(perFrameCredits(Array.from({ length: 3 }, () => ({ usd: 0.003 })))).toBe(creditsForUsd(0.009))
    expect(localModelCalls(UPSCALE_2X_CLASS, 3)).toEqual({ steps: [{ call: { endpoint: UPSCALE_2X_SLUG, inputPixels: UPSCALE_2X_MAX_PIXELS }, times: 45 }] })
    expect(priceGraph({ 1: { class_type: UPSCALE_2X_CLASS, inputs } }).nodes['1']).toBeUndefined()
    expect(priceGraph({ 1: { class_type: UPSCALE_2X_CLASS, inputs } }, { families: ON }).nodes['1']).toBe(creditsForUsd(0.07077885))
  })

  it('sends no text; the tooltip names the service while the family is on; its route has no backup', () => {
    expect(Object.prototype.hasOwnProperty.call(PAID_TEXT_INPUTS, UPSCALE_2X_CLASS)).toBe(false)
    expect(SERVICE_OF[UPSCALE_2X_CLASS]).toBe('replicate')
    expect(serviceTooltip(UPSCALE_2X_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(UPSCALE_2X_CLASS, ON)).toBe('Runs on Replicate')
    expect(nodePriceTooltip(UPSCALE_2X_CLASS, new Set(['cards']))).toBeNull()
    expect(RUNNER_ROUTES[UPSCALE_2X_CLASS]).toMatchObject({ first: 'replicate', backup: null })
  })
})

describe('the row and the family', () => {
  it('a provider class in family upscale-2x; tile_size as ComfyUI validates it; out of range or wired goes to the engine', () => {
    expect(LOCAL_MODEL_FAMILY_OF[UPSCALE_2X_CLASS]).toBe('upscale-2x')
    expect(RUNNER_NODE_RULES[UPSCALE_2X_CLASS]!.family).toBe('upscale-2x')
    expect(PROVIDER_TYPES.has(UPSCALE_2X_CLASS)).toBe(true)
    expect(SWITCHED_CLASSES[UPSCALE_2X_CLASS]).toBe('upscale-2x')
    expect(RUNNER_OUTPUT_CLASSES.has(UPSCALE_2X_CLASS)).toBe(true)
    const p = (w: Record<string, unknown>): ApiPrompt => ({ l: LOAD, n: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0], tile_size: 512, ...w } } })
    expect(runnerTakesNode(p({}), 'n', ON)).toBe(true)
    expect(runnerTakesNode(p({ tile_size: 0 }), 'n', ON)).toBe(true)
    for (const w of [{ tile_size: 2049 }, { tile_size: -1 }, { tile_size: ['x', 0] }]) expect(runnerTakesNode(p(w), 'n', ON), JSON.stringify(w)).toBe(false)
  })
})

describe('with every R7 family off, nothing changes (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
    ['Background remove on, Upscale off', ['cards', 'bg-remove']],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === UPSCALE_2X_CLASS ? { ...n, class_type: 'UpscaleImageBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== UPSCALE_2X_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[UPSCALE_2X_CLASS]).toBeUndefined()
    }
  }

  it('the class goes to the engine and is named; on, the runner takes it', () => {
    const p: ApiPrompt = { l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n', 's'])
    expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id })).toEqual([])
  })

  it('over one synthetic graph per chain (picture, clip, Image cards, a Frame)', () => {
    sameAsBefore({ l: LOAD, n: upNode(), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE_DEFAULTS } } }, 'picture → Save image')
    sameAsBefore({ l: LOAD, n: upNode(), f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, '→ Frame')
    sameAsBefore({
      a: { class_type: 'Image', inputs: { image: 'x.png', export: false, batch_index: -1 } }, n: upNode(['a', 0]),
      b: { class_type: 'Image', inputs: { image: '', export: false, images: ['n', 0], batch_index: -1 } },
    }, 'Image card chain')
    const lvf = { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
    sameAsBefore({ v: lvf, n: upNode(['v', 0]), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0], fps: 24, filename_prefix: 'v', audio_file: '(none)', preset: 'veryfast', crf: 20 } } }, 'clip → Save video frames')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/assets/nodeCatalog.json.gz'))).toString('utf8'))
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
        if (Object.values(p).some(n => n.class_type === UPSCALE_2X_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`upscale-2x families-off invariant: ${graphs} saved graphs, ${withIt} with Upscale (2×)`)
  }, 600_000)
})
