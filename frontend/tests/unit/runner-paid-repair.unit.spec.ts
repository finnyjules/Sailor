/**
 * R3.5: upscale, enhance, restore and remove background (family
 * `image-repair`) — Upscale an image (five engines), Enhance detail (three
 * engines), Restore an old photo and Remove background, and the hidden twins
 * of the last two — against what their real Python sends and returns
 * (fixtures/runner-paid-repair.json, scripts/runner_paid_fixtures.py --group
 * repair), priced on both paths: Upscale and Enhance by the picture's size
 * (the line-up's cards, unchanged), the other four per call (Replicate's pages).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit, ofType } from './__runner__/kit'
import { normalizeSent, readerFor, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  ENHANCE_ENGINES, REPAIR_CLASSES, REPAIR_PER_CALL_CLASSES, REPAIR_PER_CALL_ENDPOINTS, RESTORE_SAFETY_DIGITS, UPSCALE_ENGINES,
  restoreTwinSafety, type RepairClass,
} from '#shared/runner/repair'
import { PAID_RATES, otherCardFor } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { ENHANCE_ENGINE_SLUGS, LARGEST_INPUT_PIXELS, UPSCALE_ENGINE_SLUGS } from '#shared/pricing/editSettings'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { MODEL_PRICED_NODE_CLASSES, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { graphInputSizes } from '~~/server/utils/graphInputPixels'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { firstOutputUrl } from '~~/server/runner/generators/repair'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { ENHANCE_DETAIL_TOO_LARGE, UPSCALE_TOO_LARGE, pictureChangedWords, pictureOverMarginWords, requestProblems, unsizedInputWords } from '~~/server/runner/requestRules'
import { predictedHoldPixels, startPictureSizes } from '~~/server/runner/repairSizes'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-repair.json'), 'utf8')) as { cases: PaidCase[] }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'image-repair'])
const OUT = 'https://r.test/repaired.png'

/**
 * The FLOAT settings (and Enhance's constant `scale_factor: 1.0`) Python
 * writes as `2.0` where the runner's JSON writes `2`: the same JSON number to
 * Replicate's schemas (`number`), R3.3 ruling 1. Every other key's wire text
 * is Python's byte for byte.
 */
const FLOAT_KEYS = ['scale_factor', 'creativity', 'resemblance', 'scale', 'face_enhancement_creativity', 'face_enhancement_strength']
function pythonWire(payloadJson: string): string {
  return payloadJson.replace(new RegExp(`"(${FLOAT_KEYS.join('|')})": (-?\\d+)\\.0([,}])`, 'g'), '"$1": $2$3')
}

/** The runner's refusals where Python sends (or raises): the twin's safety in digits that aren't 0–9. */
function expectedRefusal(c: PaidCase): string | null {
  return c.name === 'restore twin · safety superscript' || c.name === 'restore twin · safety arabic-indic' ? RESTORE_SAFETY_DIGITS : null
}

/** A LoadImage feeding the node's picture, as the kit's cases do. */
function withPicture(c: PaidCase): ApiPrompt {
  return {
    p_image: { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } },
    n: { class_type: c.class_type, inputs: { ...c.widgets, image: ['p_image', 0] } },
    // A card shows the result: only what an output reads runs (R3.8 fix round 1).
    ...readerFor(c.class_type, 'n'),
  }
}

async function planOf(c: PaidCase): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  return await planNode({
    prompt: withPicture(c), nodeId: 'n', gateOpen: false,
    filesFrom: link => (link[0] === 'p_image' ? [{ filename: 'image.png', subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  }) as Extract<NodePlan, { kind: 'provider' }>
}

/** Python's `IMG:image` is the handed-off picture. */
const asPython = (payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], ['image'])[0]!.payload

/** Python's ui for a case: save_generation_output's prefix, or none. */
function pythonPrefix(c: PaidCase): string | null {
  const ui = c.ui as { images?: { prefix: string }[] } | null
  return ui?.images?.[0]?.prefix ?? null
}

/** A PNG of w × h (one colour: small on disk however large). */
async function png(w: number, h: number, channels: 3 | 4 = 3): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels, background: channels === 4 ? { r: 10, g: 20, b: 30, alpha: 0.5 } : { r: 10, g: 20, b: 30 } } }).png().toBuffer()
}

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const uri = { type: 'string', format: 'uri' }
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  'philz1337x/clarity-upscaler': publishedInput({
    mask: uri, seed: { type: 'integer', default: 1337 }, image: uri, prompt: { type: 'string' },
    dynamic: { type: 'number', default: 6, maximum: 50, minimum: 1 },
    handfix: { enum: ['disabled', 'hands_only', 'image_and_hands'], type: 'string' }, pattern: { type: 'boolean' },
    sharpen: { type: 'number', maximum: 10, minimum: 0 }, sd_model: { type: 'string' }, scheduler: { type: 'string' },
    creativity: { type: 'number', default: 0.35, maximum: 1, minimum: 0 }, lora_links: { type: 'string' }, downscaling: { type: 'boolean' },
    resemblance: { type: 'number', default: 0.6, maximum: 3, minimum: 0 }, scale_factor: { type: 'number', default: 2 },
    tiling_width: { type: 'integer' }, output_format: { enum: ['webp', 'jpg', 'png'], type: 'string', default: 'png' },
    tiling_height: { type: 'integer' }, custom_sd_model: { type: 'string' }, negative_prompt: { type: 'string' },
    num_inference_steps: { type: 'integer', default: 18, maximum: 100, minimum: 1 }, downscaling_resolution: { type: 'integer' },
  }, ['image']),
  'philz1337x/crystal-upscaler': publishedInput({
    image: uri, creativity: { type: 'number', default: 0, maximum: 10, minimum: 0 }, scale_factor: { type: 'number', default: 2 },
    output_format: { enum: ['png', 'jpg'], type: 'string', default: 'png' },
  }, ['image']),
  'nightmareai/real-esrgan': publishedInput({
    image: uri, scale: { type: 'number', default: 4, maximum: 10, minimum: 0 }, face_enhance: { type: 'boolean', default: false },
  }, ['image']),
  'recraft-ai/recraft-crisp-upscale': publishedInput({ image: uri }, ['image']),
  'topazlabs/image-upscale': publishedInput({
    image: uri,
    enhance_model: { enum: ['Standard V2', 'Low Resolution V2', 'CGI', 'High Fidelity V2', 'Text Refine'], type: 'string', default: 'Standard V2' },
    output_format: { enum: ['jpg', 'png'], type: 'string', default: 'jpg' },
    upscale_factor: { enum: ['None', '2x', '4x', '6x'], type: 'string', default: 'None' },
    face_enhancement: { type: 'boolean', default: false },
    subject_detection: { enum: ['None', 'All', 'Foreground', 'Background'], type: 'string', default: 'None' },
    face_enhancement_strength: { type: 'number', default: 0.8, maximum: 1, minimum: 0 },
    face_enhancement_creativity: { type: 'number', default: 0, maximum: 1, minimum: 0 },
  }, ['image']),
  'fermatresearch/magic-image-refiner': publishedInput({
    hdr: { type: 'number', default: 0, maximum: 1, minimum: 0 }, mask: uri, seed: { type: 'integer' }, image: uri,
    steps: { type: 'integer', default: 20 }, prompt: { type: 'string' },
    scheduler: { enum: ['DDIM', 'DPMSolverMultistep', 'K_EULER_ANCESTRAL', 'K_EULER'], type: 'string', default: 'DDIM' },
    creativity: { type: 'number', default: 0.25, maximum: 1, minimum: 0 }, guess_mode: { type: 'boolean', default: false },
    resolution: { enum: ['original', '1024', '2048'], type: 'string', default: 'original' },
    resemblance: { type: 'number', default: 0.75, maximum: 1, minimum: 0 },
    guidance_scale: { type: 'number', default: 7, maximum: 30, minimum: 0.1 }, negative_prompt: { type: 'string' },
  }, []),
  '851-labs/background-remover': publishedInput({
    image: uri, format: { type: 'string', default: 'png' }, reverse: { type: 'boolean', default: false },
    threshold: { type: 'number', default: 0 }, background_type: { type: 'string', default: 'rgba' },
  }, ['image']),
  'flux-kontext-apps/restore-image': publishedInput({
    seed: { type: 'integer' }, input_image: uri,
    output_format: { enum: ['jpg', 'png'], type: 'string', default: 'png' },
    safety_tolerance: { type: 'integer', default: 2, maximum: 2, minimum: 0 },
  }, ['input_image']),
}
/** The saved schema where the controller has snapshotted it, else the published inputs above. */
function schemaOf(slug: string): ProviderSchemaFixture {
  const file = join(__dirname, 'fixtures', 'provider-schemas', 'replicate', `${slug.replace('/', '__')}.json`)
  return existsSync(file) ? loadProviderSchema('replicate', slug) : PUBLISHED[slug]!
}

describe('the fixture', () => {
  it('covers every engine at its default and every setting the brief names', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(REPAIR_CLASSES))
    for (const e of UPSCALE_ENGINES) expect(names.has(`upscale · ${e} default`), e).toBe(true)
    for (const s of ['seed 0', 'seed 42', 'scale 1.0', 'scale 10.0']) expect(names.has(`upscale · Clarity ${s}`), s).toBe(true)
    for (const f of ['None', '2x', '4x', '6x']) for (const face of ['on', 'off']) expect(names.has(`upscale · Topaz ${f} face ${face}`), f).toBe(true)
    for (const f of ['png', 'jpg']) expect(names.has(`upscale · Crystal ${f}`), f).toBe(true)
    expect(names.has('upscale · Real-ESRGAN face on')).toBe(true)
    for (const e of ENHANCE_ENGINES) for (const d of ['0.0', '0.4', '1.0']) expect(names.has(`enhance · ${e} detail ${d}`), `${e} ${d}`).toBe(true)
    for (const f of ['png', 'jpg']) for (const t of ['restore', 'restore twin']) expect(names.has(`${t} · ${f}`), `${t} ${f}`).toBe(true)
    // Every endpoint is reached, and each class makes at most one call.
    const endpoints = new Set([...Object.values(UPSCALE_ENGINE_SLUGS), ...Object.values(ENHANCE_ENGINE_SLUGS), ...Object.values(REPAIR_PER_CALL_ENDPOINTS)])
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(endpoints)
    expect(CASES.every(c => c.calls.length <= 1)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(55)
  })

  it('the engine lists are Python\'s (and the price module\'s)', () => {
    expect([...UPSCALE_ENGINES]).toEqual(Object.keys(UPSCALE_ENGINE_SLUGS))
    expect([...ENHANCE_ENGINES]).toEqual(Object.keys(ENHANCE_ENGINE_SLUGS))
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const refused: string[] = []
  const wholeFloat: string[] = []
  const offSchema: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the picture', async (_n, c) => {
    const want = expectedRefusal(c)
    if (want) {
      refused.push(c.name)
      await expect(planOf(c)).rejects.toThrow(want)
      expect(requestProblems(withPicture(c), { runner: true }).map(p => p.message)).toEqual([want])
      // The ComfyUI path is Python's own: nothing refused there.
      expect(requestProblems(withPicture(c))).toEqual([])
      return
    }
    expect(c.error).toBeUndefined()
    expect(requestProblems(withPicture(c), { runner: true })).toEqual([])
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c)
    expect(plan.kind).toBe('provider')
    expect(plan.media).toBe('image')
    expect(plan.take).toBe('first')
    expect(plan.backup).toBeUndefined()
    const py = c.calls[0]!
    expect({ provider: plan.provider, endpoint: plan.endpoint, payload: asPython(plan.payload) }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    const pw = pythonWire(py.payload_json!)
    if (pw !== py.payload_json) wholeFloat.push(c.name)
    expect(wireText(asPython(plan.payload))).toBe(pw)
    const errs = checkPayload(schemaOf(plan.endpoint), plan.payload)
    if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
    // The picture: Python's `_first_output_url`, and its ui (save_generation_output's prefix, or none).
    const answer = c.answers[0] as { output: unknown }
    expect(firstOutputUrl(answer)).toEqual([(c.output as { image: string }[])[0]!.image])
    const prefix = pythonPrefix(c)
    const files = [{ filename: 'x.png', subfolder: '', type: 'output' as const }]
    if (prefix) {
      expect(plan.prefix).toBe(prefix)
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
    else {
      expect(c.ui).toBeNull()
      expect(plan.uiFor(files)).toBeNull()
    }
  })

  it('the deviations: only the twin\'s safety in digits that aren\'t 0–9 (Python raises on ², sends 3 for ٣)', () => {
    expect(refused.sort()).toEqual(['restore twin · safety arabic-indic', 'restore twin · safety superscript'])
    const sup = CASES.find(c => c.name === 'restore twin · safety superscript')!
    expect(sup.error?.type).toBe('ValueError')
    expect(sup.calls).toEqual([])
    expect(CASES.find(c => c.name === 'restore twin · safety arabic-indic')!.calls[0]!.payload.safety_tolerance).toBe(3)
  })

  it('whole-number FLOAT settings are the only wire difference (R3.3 ruling 1)', () => {
    expect(wholeFloat.length).toBeGreaterThan(20)
    for (const name of wholeFloat) expect(CASES.find(c => c.name === name)!.class_type, name).toMatch(/^(UpscaleImageNode|EnhanceDetailNode)$/)
  })

  it('every payload fits its published schema but Restore at safety 6 (the node offers 1–6, Replicate 0–2: the live check decides)', () => {
    expect(offSchema).toEqual(['restore · safety 6: safety_tolerance: 6 is above the maximum 2'])
  })
})

describe('every fixture case through the engine (cards and image-repair on)', () => {
  const calling = CASES.filter(c => c.calls.length && !expectedRefusal(c))

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, saved and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    expect(normalizeSent(run.sent, ['image'])).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(normalizeSent(run.sent, ['image'])[0]!.payload)).toBe(pythonWire(c.calls[0]!.payload_json!))
    expect(run.values).toBeUndefined()
    expect(run.files.length).toBe(1)
    // Charged the node's price: per call, or (Upscale, Enhance) by the picture measured at its turn (8 × 6).
    const inputs = { ...c.widgets, image: ['p_image', 0] }
    const price = priceNode(c.class_type, inputs, { inputPixels: 8 * 6 })
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
  })
})

describe('the picture kept', () => {
  it('Remove background\'s cut-out is saved as downloaded (alpha kept), shown under remove_bg; the first of two URLs', async () => {
    const cut = await png(8, 6, 4)
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT, 'https://r.test/second.png'] }) })
    const download = vi.fn(async (url: string) => ({ bytes: new Uint8Array(url === OUT ? cut : await png(2, 2)), contentType: 'image/png' }))
    const k = makeKit({ replicate, deps: { families: () => ON, download } })
    writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
    const p: ApiPrompt = withPicture({ ...CASES.find(c => c.name === 'remove background · list')! })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(download.mock.calls.map(x => x[0])).toEqual([OUT])
    expect(rec.outputs.length).toBe(1)
    expect(rec.outputs[0]!.filename).toMatch(/^remove_bg/)
    const kept = readFileSync(join(k.root, 'output', rec.outputs[0]!.subfolder, rec.outputs[0]!.filename))
    expect(Buffer.compare(kept, cut)).toBe(0)
    expect((await sharp(kept).metadata()).channels).toBe(4)
    const executed = ofType(k.seen, 'executed').map(m => (m as any).data)
    expect(executed.find((d: any) => d.node === 'n')?.output).toEqual({ images: rec.outputs, animated: [false] })
  })

  it('an answer with no picture fails the node plainly (Python\'s download fails)', () => {
    expect(firstOutputUrl({ output: [] })).toEqual([])
    expect(firstOutputUrl({ output: [3, OUT] })).toEqual([])
    expect(firstOutputUrl({ output: null })).toEqual([])
    expect(firstOutputUrl({ output: OUT })).toEqual([OUT])
  })

  it('Upscale → Remove background: the upscaled picture is handed off as its own file', async () => {
    const replicate = createFakeReplicate({ bodyText: ({ model }) => JSON.stringify({ id: 'p', status: 'succeeded', output: [`https://r.test/${model.replace('/', '_')}.png`] }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(16, 12)), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
    const p: ApiPrompt = {
      p_image: { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } },
      u: { class_type: 'UpscaleImageNode', inputs: { ...CASES.find(c => c.name === 'upscale · Real-ESRGAN default')!.widgets, image: ['p_image', 0] } },
      r: { class_type: 'RemoveBackgroundRemoteNode', inputs: { image: ['u', 0] } },
      ...readerFor('RemoveBackgroundRemoteNode', 'r'),
    }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.r!.status, nodes.r!.error ?? '').toBe('done')
    const made = nodes.u!.outputs[0]!
    expect(made.filename).toMatch(/^upscale/)
    expect(replicate.submitted().map(r => [r.endpoint, r.payload])).toEqual([
      ['nightmareai/real-esrgan', { image: 'https://fal.storage/image.png', scale: 2, face_enhance: false }],
      ['851-labs/background-remover', { image: `https://fal.storage/${made.filename}` }],
    ])
  })
})

describe('prices (ruling (a))', () => {
  const restore = { model: 'Flux Kontext · Restore', image: ['p', 0], safety_tolerance: 2, output_format: 'png' }
  const inputsOf: Record<string, Record<string, unknown>> = {
    RestorePhotoNode: restore,
    RestorePhotoRemoteNode: { image: ['p', 0], safety_tolerance: '2', output_format: 'png' },
    RemoveBackgroundNode: { model: '851-labs/bg-remover', image: ['p', 0] },
    RemoveBackgroundRemoteNode: { image: ['p', 0] },
  }

  it('a card per new endpoint, read from its page; the upscalers keep their edit cards', () => {
    expect(PAID_RATES['flux-kontext-apps/restore-image']).toEqual({
      unit: 'per_call', usd: 0.04,
      service: 'replicate', source: 'https://replicate.com/flux-kontext-apps/restore-image', read: '2026-09-27', confidence: 'verified',
    })
    expect(PAID_RATES['851-labs/background-remover']).toMatchObject({
      unit: 'gpu_ceiling', usd: 0.0004, confidence: 'estimate', read: '2026-09-27', source: 'https://replicate.com/851-labs/background-remover',
    })
    for (const slug of ['flux-kontext-apps/restore-image', '851-labs/background-remover']) expect(otherCardFor(slug), slug).toBeNull()
    for (const slug of [...Object.values(UPSCALE_ENGINE_SLUGS), ...Object.values(ENHANCE_ENGINE_SLUGS)]) {
      expect(EDIT_RATES[slug], slug).toBeDefined()
      expect(PAID_RATES[slug], slug).toBeUndefined()
    }
  })

  it('the per-call classes are priced by their calls with no flat row; Upscale and Enhance stay size-priced; the price book moved on', () => {
    for (const c of REPAIR_PER_CALL_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
    }
    for (const c of ['UpscaleImageNode', 'EnhanceDetailNode']) {
      expect(PAID_NODE_CLASSES).not.toContain(c)
      expect(MODEL_PRICED_NODE_CLASSES).toContain(c)
    }
    expect(PRICE_BOOK_VERSION).toBe('r3-restyle-lora')
  })

  it('per call: Restore 8 credits, Remove background 1, on both paths (as before)', () => {
    const want: Record<string, { usd: number; credits: number }> = {
      RestorePhotoNode: { usd: 0.04, credits: 8 }, RestorePhotoRemoteNode: { usd: 0.04, credits: 8 },
      RemoveBackgroundNode: { usd: 0.0004, credits: 1 }, RemoveBackgroundRemoteNode: { usd: 0.0004, credits: 1 },
    }
    for (const [c, p] of Object.entries(want)) {
      expect(priceNode(c, inputsOf[c]), c).toEqual(p)
      expect(priceGraph({ 1: { class_type: c, inputs: inputsOf[c]! } }).nodes!['1'], c).toBe(p.credits)
      // Whatever the settings (and a bare node).
      expect(priceNode(c, {}), c).toEqual(p)
    }
  })

  it('Upscale and Enhance: unchanged, by the output the measured picture makes (the line-up\'s editCalls)', () => {
    const px = 1000 * 1000
    const at = (ct: string, inputs: Record<string, unknown>) => (priceNode(ct, { image: ['p', 0], ...inputs }, { inputPixels: px }) as { credits: number }).credits
    expect(at('UpscaleImageNode', { model: 'Real-ESRGAN', scale_factor: 4 })).toBe(creditsForUsd(0.002))
    expect(at('UpscaleImageNode', { model: 'Recraft Crisp' })).toBe(creditsForUsd(0.006))
    expect(at('UpscaleImageNode', { model: 'Crystal', scale_factor: 2 })).toBe(creditsForUsd(0.05))
    expect(at('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '6x' })).toBe(creditsForUsd(0.16))
    expect(at('UpscaleImageNode', { model: 'Clarity', scale_factor: 2 })).toBe(creditsForUsd(0.20))
    expect(at('EnhanceDetailNode', { model: 'Faithful' })).toBe(creditsForUsd(0.08))
    expect(at('EnhanceDetailNode', { model: 'Diffusion Refine' })).toBe(creditsForUsd(0.10))
    expect(at('EnhanceDetailNode', { model: 'Creative' })).toBe(creditsForUsd(0.20))
    // Unmeasured (the ComfyUI path with no gate): the input cap (19 MP × 4 = 75 MP out: $0.32).
    const cap = priceNode('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '2x', image: ['p', 0] }) as { credits: number }
    expect(cap.credits).toBe(creditsForUsd(0.32))
  })

  it('nothing is ever free: every class makes its call (no no-call branch in Python)', () => {
    for (const c of REPAIR_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
  })
})

describe('the picture\'s size, before the hold (hosted: the G1 walk)', () => {
  const node = (ct: string, inputs: Record<string, unknown>, from: string) => ({ class_type: ct, inputs: { ...inputs, image: [from, 0] } })
  const topaz6 = CASES.find(c => c.name === 'upscale · Topaz 6x face off')!.widgets
  const faithful = CASES.find(c => c.name === 'enhance · Faithful detail 0.4')!.widgets
  const crystal = CASES.find(c => c.name === 'upscale · Crystal png')!.widgets

  it('the gate\'s chained sizing sizes Upscale\'s output as input × factor² (Enhance in place)', async () => {
    const p: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      u: node('UpscaleImageNode', { ...topaz6, topaz_upscale_factor: '4x' }, 'l'),
      e: node('EnhanceDetailNode', faithful, 'u'),
    }
    const sizes = await graphInputSizes(p, async () => ({ pixels: 300 * 200, width: 300, height: 200 }))
    expect(sizes.pixels).toEqual({ u: 300 * 200, e: 300 * 200 * 16 })
    expect(sizes.problems).toEqual([])
  })

  it('a picture above the input cap into Upscale Topaz 6x is refused before the hold (hosted)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'big.png'), await png(4400, 4400))
    expect(4400 * 4400).toBeGreaterThan(LARGEST_INPUT_PIXELS)
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'big.png', upload: 'image' } }, n: node('UpscaleImageNode', topaz6, 'l'), ...readerFor('UpscaleImageNode', 'n') }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(UPSCALE_TOO_LARGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.upload).not.toHaveBeenCalled()
  })

  it('a 4K picture through Upscale Topaz 6x into Enhance detail: Enhance\'s picture (6× each side) is refused before the hold', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', '4k.png'), await png(3840, 2160))
    const p: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: '4k.png', upload: 'image' } },
      u: node('UpscaleImageNode', topaz6, 'l'),
      e: node('EnhanceDetailNode', faithful, 'u'),
      ...readerFor('EnhanceDetailNode', 'e'),
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(ENHANCE_DETAIL_TOO_LARGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // Alone, the 4K picture fits the input cap: Upscale takes it, held at its 6× output's price.
    const alone = await startPictureSizes({ l: p.l!, u: p.u! }, async () => new Uint8Array(await png(3840, 2160)))
    expect(alone).toEqual({ pixels: { u: 3840 * 2160 }, predicted: [], problem: null })
  })

  it('a picture it can\'t size, or can\'t read, is refused before the hold (hosted), in the gate\'s words', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'a.png'), await png(8, 6))
    const unsized: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } },
      m: { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['l', 0] } },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['m', 0], bypass: true } },
      n: node('UpscaleImageNode', crystal, 'g'),
    }
    const sized = await startPictureSizes(unsized, async () => new Uint8Array(await png(8, 6)))
    expect(sized.problem?.message).toBe(unsizedInputWords('UpscaleImageNode'))
    const broken = await startPictureSizes({ l: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: node('UpscaleImageNode', crystal, 'l'), ...readerFor('UpscaleImageNode', 'n') }, async () => new TextEncoder().encode('not a picture'))
    expect(broken.problem?.message).toMatch(/can.t read the size of this picture/)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: the hold is priced on the measured picture, not the cap; the charge the same', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(16, 12)), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'a.png'), await png(2000, 1500))
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, n: node('UpscaleImageNode', crystal, 'l'), ...readerFor('UpscaleImageNode', 'n') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    // Crystal 4× of 3 MP is 48 MP out: $0.80. At the cap (19 MP × 16) it would be $3.20.
    const measured = (priceNode('UpscaleImageNode', p.n!.inputs, { inputPixels: 2000 * 1500 }) as { credits: number }).credits
    const atCap = (priceNode('UpscaleImageNode', p.n!.inputs) as { credits: number }).credits
    expect(measured).toBe(creditsForUsd(0.80))
    expect(atCap).toBeGreaterThan(measured)
    expect(rec.credits).toBe(measured)
    // + the render credit: the Image card that shows the result is an output (R3.8 fix round 1), as on the Python path.
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[measured + BASE_RENDER_CREDITS, measured + BASE_RENDER_CREDITS]])
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.measured).toEqual({ n: { seconds: {}, sha: {}, pixels: 2000 * 1500 } })
  })

  it('local: nothing is sized before the run (nothing is held); the turn measures and charges as before', async () => {
    const k = makeKit({ deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'a.png'), await png(8, 6))
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, n: node('UpscaleImageNode', crystal, 'l'), ...readerFor('UpscaleImageNode', 'n') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.measured).toBeUndefined()
    expect(run.takes[0]!.nodes.n!.credits).toBe((priceNode('UpscaleImageNode', p.n!.inputs, { inputPixels: 48 }) as { credits: number }).credits)
  })

  it('a picture grown since the start is refused at its turn, its hold released', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'a.png'), await png(800, 600))
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, n: node('UpscaleImageNode', crystal, 'l'), ...readerFor('UpscaleImageNode', 'n') }
    // The picture is replaced by a larger one between the start (sized) and the node's turn.
    const larger = await png(3000, 3000)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    writeFileSync(join(k.root, 'input', 'a.png'), larger)
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe(pictureChangedWords('UpscaleImageNode'))
    expect(replicate.client.submit).not.toHaveBeenCalled()
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  // Fix round 1 (ruling 1): a predicted size (an upstream Upscale's factor) is held with 1.1× each side.
  const chain = (answerSide: number) => {
    const esrgan = CASES.find(c => c.name === 'upscale · Real-ESRGAN face off')!.widgets
    return {
      prompt: {
        l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } },
        u: node('UpscaleImageNode', { ...esrgan, scale_factor: 2 }, 'l'),
        c: node('UpscaleImageNode', { ...crystal, scale_factor: 2 }, 'u'),
        ...readerFor('UpscaleImageNode', 'c'),
      } as ApiPrompt,
      answerSide,
    }
  }
  async function runChain(answerSide: number) {
    const { prompt } = chain(answerSide)
    const replicate = createFakeReplicate({ bodyText: ({ model }) => JSON.stringify({ id: 'p', status: 'succeeded', output: [`https://r.test/${model.replace('/', '_')}.png`] }) })
    const answer = new Uint8Array(await png(answerSide, answerSide))
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: async () => ({ bytes: answer, contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'a.png'), await png(524, 524))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
    await k.engine.settled(runId)
    return { k, prompt, replicate, run: (await k.store.get(runId))! }
  }

  it('the reviewer\'s case: Real-ESRGAN 2× predicted 1048², answered 1050²: Crystal runs, charged at the real size', async () => {
    const { k, prompt, run } = await runChain(1050)
    const nodes = run.takes[0]!.nodes
    expect(nodes.c!.status, nodes.c!.error ?? '').toBe('done')
    expect(predictedHoldPixels(1048 * 1048)).toBe(Math.ceil(1048 * 1048 * 121 / 100))
    expect(run.takes[0]!.measured).toEqual({
      u: { seconds: {}, sha: {}, pixels: 524 * 524 },
      c: { seconds: {}, sha: {}, pixels: predictedHoldPixels(1048 * 1048), predicted: true },
    })
    // 1050² × 4 = 4.41 MP: Crystal's $0.10 tier (at 1048² it would be $0.05), within the hold.
    const real = (priceNode('UpscaleImageNode', prompt.c!.inputs, { inputPixels: 1050 * 1050 }) as { credits: number }).credits
    const heldAt = (priceNode('UpscaleImageNode', prompt.c!.inputs, { inputPixels: predictedHoldPixels(1048 * 1048) }) as { credits: number }).credits
    expect(real).toBe(creditsForUsd(0.10))
    expect(nodes.c!.credits).toBe(real)
    expect(real).toBeLessThanOrEqual(heldAt)
    const esrgan = (priceNode('UpscaleImageNode', prompt.u!.inputs, { inputPixels: 524 * 524 }) as { credits: number }).credits
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[esrgan + heldAt + BASE_RENDER_CREDITS, esrgan + real + BASE_RENDER_CREDITS]])
  })

  it('a predicted picture past its margin is refused at its turn (1200² where 1048² was predicted)', async () => {
    const { replicate, run } = await runChain(1200)
    const nodes = run.takes[0]!.nodes
    expect(nodes.u!.status).toBe('done')
    expect(nodes.c!.status).toBe('error')
    expect(nodes.c!.error).toBe(pictureOverMarginWords('UpscaleImageNode'))
    expect(replicate.submitted().map(r => r.endpoint)).toEqual(['nightmareai/real-esrgan'])
  })

  it('the margin never passes the input cap', () => {
    expect(predictedHoldPixels(LARGEST_INPUT_PIXELS - 10)).toBe(LARGEST_INPUT_PIXELS)
    expect(predictedHoldPixels(100)).toBe(121)
  })

  it('the refusals are plain words', () => {
    for (const w of [pictureChangedWords('UpscaleImageNode'), pictureChangedWords('EnhanceDetailNode'), pictureOverMarginWords('EnhanceDetailNode'), RESTORE_SAFETY_DIGITS]) {
      expect(w).not.toMatch(/Node|_|\bid\b/)
    }
  })
})

describe('Restore photo\'s twin: its safety as text (Python: int(s) if s.isdigit() else 2)', () => {
  it('plain digits are the number; anything else 2; other digits and huge numbers refused', () => {
    expect(restoreTwinSafety('2')).toBe(2)
    expect(restoreTwinSafety('0')).toBe(0)
    expect(restoreTwinSafety('17')).toBe(17)
    for (const s of ['', ' 2', '2.5', '-1', 'strict', '2 ']) expect(restoreTwinSafety(s), s).toBe(2)
    for (const s of ['²', '٣', '１', '99999999999999999999']) expect(restoreTwinSafety(s), s).toEqual({ refused: RESTORE_SAFETY_DIGITS })
  })
})

describe('moderation', () => {
  it('lists Upscale\'s and Enhance\'s prompts; Restore and Remove background send no text', () => {
    for (const c of REPAIR_CLASSES) {
      expect(PAID_TEXT_INPUTS[c] ?? [], c).toEqual(c === 'UpscaleImageNode' || c === 'EnhanceDetailNode' ? ['prompt', 'negative_prompt'] : [])
    }
    expect(extraPromptTexts({ n: { class_type: 'UpscaleImageNode', inputs: { prompt: 'a knife', negative_prompt: 'blur' } } })).toEqual(['a knife', 'blur'])
  })

  it('a hosted Upscale moderates its prompt at the start; a flagged one is refused before the hold', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
    const c = CASES.find(x => x.name === 'upscale · Clarity default')!
    const p = withPicture({ ...c, widgets: { ...c.widgets, negative_prompt: 'a forbidden thing' } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('a Text card wired into the prompt arrives as typed, and a wired prompt is priced as a call', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
    const c = CASES.find(x => x.name === 'enhance · Diffusion Refine detail 0.4')!
    const p: ApiPrompt = { ...withPicture(c), t: { class_type: 'Text', inputs: { text: 'a crisp face' } } }
    p.n!.inputs.prompt = ['t', 0]
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(replicate.submitted()[0]!.payload.prompt).toBe('a crisp face')
    expect(stageEstimate(p, ['n'], false, ON)).toBeGreaterThan(0)
  })
})

describe('with image-repair off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but image-repair', RUNNER_FAMILIES.filter(f => f !== 'image-repair')],
  ]
  const isRepair = (ct: string) => (REPAIR_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.5: the classes had no rule row and were no picture (renamed to one that has neither). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isRepair(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isRepair(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const sample = (c: RepairClass) => CASES.find(x => x.class_type === c && x.calls.length && !expectedRefusal(x))!

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of REPAIR_CLASSES) {
      const p = withPicture(sample(c))
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c), c).toBe(c === 'RemoveBackgroundNode' || c === 'RestorePhotoNode')
      // A picture only while the family is on (PAID_PICTURE_FAMILY), never through IMAGE_OUTPUT_CLASSES (fix round 1).
      expect(IMAGE_OUTPUT_CLASSES.has(c)).toBe(false)
      expect(PAID_PICTURE_FAMILY[c]).toBe('image-repair')
      const rule = RUNNER_NODE_RULES[c]!
      if (c === 'UpscaleImageNode' || c === 'EnhanceDetailNode') expect(new Set(Object.values(rule.models!))).toEqual(new Set(['image-repair']))
      else expect(rule.family).toBe('image-repair')
    }
    for (const key of [...UPSCALE_ENGINES.map(m => `UpscaleImageNode:${m}`), ...ENHANCE_ENGINES.map(m => `EnhanceDetailNode:${m}`), ...REPAIR_PER_CALL_CLASSES]) {
      expect(RUNNER_ROUTES[key], key).toEqual({ first: 'replicate', backup: null, why: 'no same-model twin on fal with the same settings is carded' })
    }
  })

  it('a wire from one of them is a picture only while the family is on', () => {
    const p: ApiPrompt = {
      ...withPicture(sample('RemoveBackgroundNode')),
      u: { class_type: 'UpscaleImageNode', inputs: { ...sample('UpscaleImageNode').widgets, image: ['n', 0] } },
    }
    expect(runnerTakesNode(p, 'u', ON)).toBe(true)
    expect(runnerTakesNode(p, 'u', new Set<RunnerFamily>([...RUNNER_FAMILIES.filter(f => f !== 'image-repair')]))).toBe(false)
  })

  it('over synthetic chains: into a Frame, into another repair node, a Text card into the prompt', () => {
    for (const c of REPAIR_CLASSES) {
      const p = withPicture(sample(c))
      sameAsBefore(p, `${c} alone`)
      sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, `${c} → Frame`)
      sameAsBefore({ ...p, r: { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['n', 0] } } }, `${c} → Remove background`)
      sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, `${c} → Image card`)
      const text = PAID_TEXT_INPUTS[c]?.[0]
      if (text) sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, [text]: ['t', 0] } } }, `Text → ${c}`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Remove background spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({
          ...p,
          d_img: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
          d_rb: { class_type: 'RemoveBackgroundNode', inputs: { model: '851-labs/bg-remover', image: ['d_img', 0] } },
        }, `${uuid} + Remove background`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`image-repair families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})
